/**
 * DeepSeek Context Engine — Prefix-stable context management for OpenClaw
 *
 * Implements OpenClaw's ContextEngine interface.
 * Uses native AgentMessage type (UserMessage | AssistantMessage | ToolResultMessage).
 *
 * Three layers:
 *   Layer 1 — LOCKED PREFIX (system + early history, never changes)
 *   Layer 2 — ACTIVE TAIL (recent messages, append-only between compactions)
 *   Layer 3 — COMPRESSED MIDDLE (summary of older messages, only layer that changes)
 */

import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
  IngestBatchResult,
  BootstrapResult,
  ContextEngineRuntimeContext,
  ContextEngineMaintenanceResult,
  SubagentSpawnPreparation,
  SubagentEndReason,
} from "openclaw/plugin-sdk";

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

import type { DeepSeekHarnessConfig, ResolvedConfig } from "./types.js";
import { DEFAULT_CONFIG, estimateTotalTokens, estimateTextTokens, extractContent, extractToolCallNames } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find a safe compaction boundary.
 *
 * Never split a tool-call/result pair:
 * - ToolResultMessage (role: "toolResult") references a toolCallId from an AssistantMessage
 * - If boundary lands on a toolResult, walk backward
 */
function findSafeBoundary(messages: AgentMessage[], target: number): number {
  let boundary = target;
  while (boundary > 0 && messages[boundary]?.role === "toolResult") {
    boundary--;
  }
  return boundary;
}

/** Build a readable transcript of messages for the summary prompt. */
function buildTranscript(messages: AgentMessage[]): string {
  return messages.map((m) => {
    const content = extractContent(m);
    let line = `[${m.role}]`;
    if (m.role === "toolResult") {
      line = `[tool ${m.toolName} result]`;
    }
    line += `: ${content.slice(0, 500)}`;
    if (m.role === "assistant") {
      const toolNames = extractToolCallNames(m);
      if (toolNames.length > 0) {
        line += ` [called: ${toolNames.join(", ")}]`;
      }
    }
    return line;
  }).join("\n");
}

/** Fallback summary when LLM is unavailable. */
function fallbackSummary(messages: AgentMessage[]): string {
  const tools = new Set<string>();
  const snippets: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const name of extractToolCallNames(m)) tools.add(name);
      const content = extractContent(m);
      if (content) snippets.push(content.slice(0, 200));
    }
    if (m.role === "user") {
      const content = extractContent(m);
      if (content) snippets.push(`User: ${content.slice(0, 100)}`);
    }
  }
  const parts: string[] = [];
  if (tools.size > 0) parts.push(`Tools used: ${[...tools].join(", ")}`);
  if (snippets.length > 0) parts.push(`Key content:\n${snippets.join("\n")}`);
  return parts.join("\n\n") || "(conversation segment archived)";
}

// ── Model detection ─────────────────────────────────────────────────────────

/**
 * Check if the current model benefits from prefix-stable context management.
 *
 * Matches when:
 *   - Model string contains "deepseek" (case-insensitive)
 *   - Model matches any entry in targetModels config
 *   - Model is undefined (safe default)
 */
function isDeepSeekModel(model: string | undefined, targetModels: string[]): boolean {
  if (!model) return true;
  const lower = model.toLowerCase();
  if (lower.includes("deepseek")) return true;
  return targetModels.some((m) => lower.includes(m.toLowerCase()));
}

// ── Cross-turn state persistence ────────────────────────────────────────────

/**
 * Module-level state map survives PI's dispose/recreate cycle.
 * PI calls dispose() then creates a new engine instance per turn,
 * but the module (and this Map) stays loaded in the Node process.
 */
interface SessionLayers {
  prefix: AgentMessage[];
  tail: AgentMessage[];
  compressedSummary: string | null;
  ingestedCount: number;
  lastModel: string | undefined;
}

const sessionStateMap = new Map<string, SessionLayers>();

/** Clear saved session state (for testing only). */
export function _clearSessionState(sessionId?: string): void {
  if (sessionId) {
    sessionStateMap.delete(sessionId);
  } else {
    sessionStateMap.clear();
  }
}

// ── Context Engine ──────────────────────────────────────────────────────────

export class DeepSeekContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "deepseek-prefix-stable",
    name: "DeepSeek Prefix-Stable Context Engine",
    version: "0.1.0",
    ownsCompaction: true,
  };

  private config: ResolvedConfig;
  private sessionId: string | null = null;

  // The three layers
  private prefix: AgentMessage[] = [];
  private tail: AgentMessage[] = [];
  private compressedSummary: string | null = null;

  // Track ingested message count for diffing
  private ingestedCount = 0;

  // Track last model to guard compact()
  private lastModel: string | undefined = undefined;

  // Archive directory
  private archiveDir: string | null = null;

  constructor(config: DeepSeekHarnessConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    console.log(`[deepseek-harness] context engine created`);
  }

  // ── State persistence helpers ───────────────────────────────────────────────

  private saveState(): void {
    if (!this.sessionId) return;
    sessionStateMap.set(this.sessionId, {
      prefix: this.prefix,
      tail: this.tail,
      compressedSummary: this.compressedSummary,
      ingestedCount: this.ingestedCount,
      lastModel: this.lastModel,
    });
    console.log(`[deepseek-harness] saveState: sessionId=${this.sessionId}, prefix=${this.prefix.length}, tail=${this.tail.length}`);
  }

  private restoreState(sessionId: string): boolean {
    const saved = sessionStateMap.get(sessionId);
    if (saved) {
      this.prefix = saved.prefix;
      this.tail = saved.tail;
      this.compressedSummary = saved.compressedSummary;
      this.ingestedCount = saved.ingestedCount;
      this.lastModel = saved.lastModel;
      console.log(`[deepseek-harness] restoreState: sessionId=${sessionId}, prefix=${this.prefix.length}, tail=${this.tail.length}`);
      return true;
    }
    console.log(`[deepseek-harness] restoreState: no saved state for ${sessionId}`);
    return false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<BootstrapResult> {
    this.archiveDir = `${process.env.HOME || "/tmp"}/.openclaw/deepseek-harness/archive`;

    // Clean up previous session's state from module-level map
    if (this.sessionId && this.sessionId !== params.sessionId) {
      sessionStateMap.delete(this.sessionId);
    }

    this.sessionId = params.sessionId;

    // Try to restore state from module-level map
    if (!this.restoreState(params.sessionId)) {
      // New session — clear layers
      this.prefix = [];
      this.tail = [];
      this.compressedSummary = null;
      this.ingestedCount = 0;
    }

    console.log(`[deepseek-harness] bootstrap: sessionId=${params.sessionId}, prefix=${this.prefix.length}, tail=${this.tail.length}`);
    return { bootstrapped: true };
  }

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  async ingestBatch(_params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    return { ingestedCount: _params.messages.length };
  }

  // ── Assemble (core method — called before every prompt) ───────────────────

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    citationsMode?: unknown;
    model?: string;
    prompt?: string;
  }): Promise<AssembleResult> {
    const { messages, tokenBudget, model } = params;

    // Non-DeepSeek model: pass through unchanged
    if (!isDeepSeekModel(model, this.config.targetModels)) {
      this.lastModel = model;
      console.log(`[deepseek-harness] assemble: model=${model}, passthrough (non-DeepSeek)`);
      return { messages, estimatedTokens: estimateTotalTokens(messages) };
    }
    this.lastModel = model;
    console.log(`[deepseek-harness] assemble: model=${model}, prefix-stable active (messages=${messages.length}, prefix=${this.prefix.length}, tail=${this.tail.length})`);

    // First call: split into prefix + tail
    if (this.prefix.length === 0 && messages.length > 0) {
      const lockIdx = Math.min(this.config.prefixLockCount, messages.length);
      this.prefix = messages.slice(0, lockIdx);
      this.tail = messages.slice(lockIdx);
      this.ingestedCount = messages.length;
    } else if (messages.length >= this.ingestedCount) {
      // Normal growth: append only new messages to tail
      const newCount = messages.length - this.ingestedCount;
      if (newCount > 0) {
        const newMessages = messages.slice(this.ingestedCount);
        this.tail = [...this.tail, ...newMessages];
        this.ingestedCount = messages.length;
      }
    }
    // messages.length < this.ingestedCount → ignore (PI may pass subsets
    // for mid-turn operations like tool results; the tail already covers them)

    const assembled = this.compose();
    const estimatedTokens = estimateTotalTokens(assembled);

    // Pre-trim old tool results to delay full compaction
    const budget = tokenBudget || 1_000_000;
    const threshold = budget * this.config.compactRatio - this.config.outputReservedTokens;
    if (estimatedTokens > threshold) {
      this.trimOldToolResults();
    }

    // Save state so next turn's engine instance can restore it
    this.saveState();

    return {
      messages: this.compose(),
      estimatedTokens: estimateTotalTokens(this.compose()),
    };
  }

  /** Compose the three layers into the final message array. */
  private compose(): AgentMessage[] {
    const result: AgentMessage[] = [...this.prefix];

    if (this.compressedSummary) {
      // Inject summary as a user message (system messages can't be freely added
      // in the middle of the agent-core message array)
      result.push({
        role: "user",
        content: `[Context Summary]\nThe following is a summary of earlier conversation history:\n${this.compressedSummary}`,
        timestamp: Date.now(),
      } as AgentMessage);
    }

    result.push(...this.tail);
    return result;
  }

  /**
   * Trim old tool results in the tail to free space without full compaction.
   */
  private trimOldToolResults(): void {
    const keepFrom = Math.max(0, this.tail.length - this.config.recentKeepCount);
    for (let i = keepFrom; i < this.tail.length; i++) {
      const msg = this.tail[i];
      if (msg.role === "toolResult") {
        const content = extractContent(msg);
        if (content.length > 2000) {
          const truncated = content.slice(0, 2000) + "\n...(truncated by context engine)";
          this.tail[i] = {
            ...msg,
            content: [{ type: "text" as const, text: truncated }],
          } as AgentMessage;
        }
      }
    }
  }

  // ── Compact (the key innovation) ──────────────────────────────────────────

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
    abortSignal?: AbortSignal;
  }): Promise<CompactResult> {
    // Non-DeepSeek model: skip prefix-stable compaction
    if (!isDeepSeekModel(this.lastModel, this.config.targetModels)) {
      console.log(`[deepseek-harness] compact: model=${this.lastModel}, skipped (non-DeepSeek)`);
      return { ok: true, compacted: false, reason: "non-DeepSeek model, using default compaction" };
    }

    if (this.tail.length <= this.config.recentKeepCount) {
      console.log(`[deepseek-harness] compact: tail=${this.tail.length}, skipped (too short)`);
      return { ok: true, compacted: false, reason: "tail too short" };
    }

    console.log(`[deepseek-harness] compact: prefix-stable compaction triggered (tail=${this.tail.length})`);

    // Split tail into [toCompact] | [toKeep]
    const keepStart = this.tail.length - this.config.recentKeepCount;
    const boundary = findSafeBoundary(this.tail, keepStart);
    const toCompact = this.tail.slice(0, boundary);
    const toKeep = this.tail.slice(boundary);

    if (toCompact.length === 0) {
      return { ok: true, compacted: false, reason: "safe boundary collapsed" };
    }

    const tokensBefore = estimateTotalTokens(this.compose());

    // Generate summary using the runtime's LLM capability
    let summary: string;
    const runtimeLlm = params.runtimeContext?.llm;
    if (runtimeLlm) {
      try {
        const result = await runtimeLlm.complete({
          messages: [{
            role: "user",
            content:
              `You are a conversation summarizer. Summarize concisely, preserving:\n` +
              `1. Key decisions and conclusions\n2. Important facts discovered\n` +
              `3. Tools used and outcomes\n4. Unresolved questions\n\n` +
              `Keep under 500 words.\n\n` +
              `Conversation segment:\n${buildTranscript(toCompact)}\n\nSummary:`,
          }],
          maxTokens: 1000,
          temperature: 0.3,
        });
        summary = result.text || fallbackSummary(toCompact);
      } catch {
        summary = fallbackSummary(toCompact);
      }
    } else {
      summary = fallbackSummary(toCompact);
    }

    // Archive dropped messages
    if (this.config.archiveDropped) {
      await this.archive(toCompact);
    }

    // APPLY COMPACTION: PREFIX NEVER CHANGES
    this.tail = toKeep;
    this.compressedSummary = this.compressedSummary
      ? `${this.compressedSummary}\n\n---\n\n${summary}`
      : summary;

    const tokensAfter = estimateTotalTokens(this.compose());

    // Save state after compaction
    this.saveState();

    return {
      ok: true,
      compacted: true,
      result: {
        summary,
        tokensBefore,
        tokensAfter,
      },
    };
  }

  // ── Transcript rewrite support ─────────────────────────────────────────────

  async maintain(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<ContextEngineMaintenanceResult> {
    return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
  }

  // ── Optional lifecycle ─────────────────────────────────────────────────────

  async prepareSubagentSpawn(): Promise<SubagentSpawnPreparation | undefined> {
    return undefined;
  }

  async onSubagentEnded(_params: { childSessionKey: string; reason: SubagentEndReason }): Promise<void> {}

  async dispose(): Promise<void> {
    // Save state to module-level map so next turn's engine can restore it
    this.saveState();
    console.log(`[deepseek-harness] dispose: state saved, prefix=${this.prefix.length}, tail=${this.tail.length}`);
    // DO NOT clear layers — the module-level map holds them across PI's dispose/recreate cycle
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private async archive(messages: AgentMessage[]): Promise<void> {
    if (!this.archiveDir) return;
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      await fs.promises.mkdir(this.archiveDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = path.join(this.archiveDir, `${timestamp}.jsonl`);
      const lines = messages.map((m) => JSON.stringify(m)).join("\n");
      await fs.promises.writeFile(filePath, lines, "utf-8");
    } catch (err) {
      console.error(`[deepseek-harness] Archive failed:`, err);
    }
  }

  /** Get cache statistics for monitoring. */
  getCacheStats(): {
    prefixTokens: number;
    tailTokens: number;
    summaryTokens: number;
    totalTokens: number;
    cacheHitEstimate: number;
  } {
    const prefixTokens = estimateTotalTokens(this.prefix);
    const tailTokens = estimateTotalTokens(this.tail);
    const summaryTokens = this.compressedSummary ? estimateTextTokens(this.compressedSummary) : 0;
    const totalTokens = prefixTokens + tailTokens + summaryTokens;
    return {
      prefixTokens,
      tailTokens,
      summaryTokens,
      totalTokens,
      cacheHitEstimate: totalTokens > 0 ? prefixTokens / totalTokens : 0,
    };
  }
}
