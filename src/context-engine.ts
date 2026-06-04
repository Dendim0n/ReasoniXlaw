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
import {
  DEFAULT_CONFIG,
  estimateMessageTokens,
  estimateTotalTokens,
  estimateTextTokens,
  extractContent,
  extractToolCallNames,
} from "./types.js";

import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
const ARTIFACT_ID = "reasonixlaw";
const LEGACY_ARTIFACT_ID = "deepseek-harness";
const log = createSubsystemLogger(ARTIFACT_ID);

const STATE_SIDECAR_SUFFIX = `.${ARTIFACT_ID}-state.json`;
const LEGACY_STATE_SIDECAR_SUFFIX = `.${LEGACY_ARTIFACT_ID}-state.json`;
const STATE_SIDECAR_VERSION = 1;
const SUMMARY_TAG_OPEN = "<compaction-summary>";
const SUMMARY_TAG_CLOSE = "</compaction-summary>";
const SUMMARY_HEADING_PROMPT = `Write a terse briefing under these exact headings, omitting a heading only if it has no content:

## Goal
The user's request and intent, including explicit requirements and constraints.

## Decisions & rationale
Key choices made so far and why.

## Files & code
Files read or modified, with concrete identifiers, paths, signatures, data shapes, and exact edits that matter.

## Commands & outcomes
Commands run and the relevant pass/fail results or error text.

## Errors & fixes
Problems encountered and how they were resolved or why they remain unresolved.

## Pending & next step
Unfinished work and the single most concrete next action.

Rules: preserve identifiers, paths, and numbers exactly. Do not invent facts. Use bullets and fragments, not prose.`;

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
  compactionCount: number;
  consecutiveOverThresholdCompactions: number;
  compactStuck: boolean;
  lastCompactionTokensBefore: number | null;
  lastCompactionTokensAfter: number | null;
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
    id: "reasonixlaw-prefix-stable",
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

  // Compaction observability and loop guard
  private compactionCount = 0;
  private consecutiveOverThresholdCompactions = 0;
  private compactStuck = false;
  private lastCompactionTokensBefore: number | null = null;
  private lastCompactionTokensAfter: number | null = null;

  // Session file path used for durable layer sidecar state
  private sessionFile: string | null = null;

  // Archive directory
  private archiveDir: string | null = null;

  constructor(config: DeepSeekHarnessConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info(`[${ARTIFACT_ID}] context engine created`);
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
      compactionCount: this.compactionCount,
      consecutiveOverThresholdCompactions: this.consecutiveOverThresholdCompactions,
      compactStuck: this.compactStuck,
      lastCompactionTokensBefore: this.lastCompactionTokensBefore,
      lastCompactionTokensAfter: this.lastCompactionTokensAfter,
    });
    log.info(`[${ARTIFACT_ID}] saveState: sessionId=${this.sessionId}, prefix=${this.prefix.length}, tail=${this.tail.length}`);
  }

  private applyState(saved: SessionLayers): void {
    this.prefix = saved.prefix;
    this.tail = saved.tail;
    this.compressedSummary = saved.compressedSummary;
    this.ingestedCount = saved.ingestedCount;
    this.lastModel = saved.lastModel;
    this.compactionCount = saved.compactionCount ?? 0;
    this.consecutiveOverThresholdCompactions = saved.consecutiveOverThresholdCompactions ?? 0;
    this.compactStuck = saved.compactStuck ?? false;
    this.lastCompactionTokensBefore = saved.lastCompactionTokensBefore ?? null;
    this.lastCompactionTokensAfter = saved.lastCompactionTokensAfter ?? null;
  }

  private restoreState(sessionId: string): boolean {
    const saved = sessionStateMap.get(sessionId);
    if (saved) {
      this.applyState(saved);
      log.info(`[${ARTIFACT_ID}] restoreState: sessionId=${sessionId}, prefix=${this.prefix.length}, tail=${this.tail.length}`);
      return true;
    }
    log.info(`[${ARTIFACT_ID}] restoreState: no saved state for ${sessionId}`);
    return false;
  }

  private stateSidecarPath(suffix = STATE_SIDECAR_SUFFIX): string | null {
    return this.sessionFile ? `${this.sessionFile}${suffix}` : null;
  }

  private async persistStateSidecar(): Promise<void> {
    const filePath = this.stateSidecarPath();
    if (!filePath || !this.sessionId) return;
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const payload = {
        version: STATE_SIDECAR_VERSION,
        sessionId: this.sessionId,
        state: sessionStateMap.get(this.sessionId),
      };
      await fs.promises.writeFile(filePath, JSON.stringify(payload), "utf-8");
    } catch (err) {
      log.warn(`[${ARTIFACT_ID}] state sidecar persist failed: ${String(err)}`);
    }
  }

  private async restoreStateSidecar(sessionId: string): Promise<boolean> {
    const filePaths = [
      this.stateSidecarPath(),
      this.stateSidecarPath(LEGACY_STATE_SIDECAR_SUFFIX),
    ].filter((path): path is string => Boolean(path));
    try {
      const fs = await import("node:fs");
      for (const filePath of filePaths) {
        try {
          const raw = await fs.promises.readFile(filePath, "utf-8");
          const parsed = JSON.parse(raw) as {
            version?: number;
            sessionId?: string;
            state?: SessionLayers;
          };
          if (parsed.version !== STATE_SIDECAR_VERSION || parsed.sessionId !== sessionId || !parsed.state) {
            continue;
          }
          this.applyState(parsed.state);
          sessionStateMap.set(sessionId, parsed.state);
          log.info(`[${ARTIFACT_ID}] restoreStateSidecar: sessionId=${sessionId}, file=${filePath}, prefix=${this.prefix.length}, tail=${this.tail.length}`);
          return true;
        } catch {
          continue;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<BootstrapResult> {
    this.archiveDir = `${process.env.HOME || "/tmp"}/.openclaw/${ARTIFACT_ID}/archive`;
    this.sessionFile = params.sessionFile;

    // Clean up previous session's state from module-level map
    if (this.sessionId && this.sessionId !== params.sessionId) {
      sessionStateMap.delete(this.sessionId);
    }

    this.sessionId = params.sessionId;

    // Try to restore state from module-level map
    if (!this.restoreState(params.sessionId) && !(await this.restoreStateSidecar(params.sessionId))) {
      // New session — clear layers
      this.prefix = [];
      this.tail = [];
      this.compressedSummary = null;
      this.ingestedCount = 0;
      this.compactionCount = 0;
      this.consecutiveOverThresholdCompactions = 0;
      this.compactStuck = false;
      this.lastCompactionTokensBefore = null;
      this.lastCompactionTokensAfter = null;
    }

    log.info(`[${ARTIFACT_ID}] bootstrap: sessionId=${params.sessionId}, prefix=${this.prefix.length}, tail=${this.tail.length}`);
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

    // Non-target model: pass through unchanged
    if (!isDeepSeekModel(model, this.config.targetModels)) {
      this.lastModel = model;
      log.info(`[${ARTIFACT_ID}] assemble: model=${model}, passthrough (non-target)`);
      return { messages, estimatedTokens: estimateTotalTokens(messages) };
    }
    this.lastModel = model;
    log.info(`[${ARTIFACT_ID}] assemble: model=${model}, prefix-stable active (messages=${messages.length}, prefix=${this.prefix.length}, tail=${this.tail.length})`);

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
    const threshold = this.compactionThreshold(budget);
    if (estimatedTokens > threshold) {
      this.trimOldToolResults();
    } else if (tokenBudget !== undefined) {
      this.resetCompactionGuard();
    }

    // Save state so next turn's engine instance can restore it
    this.saveState();
    await this.persistStateSidecar();

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
        content: `${SUMMARY_TAG_OPEN}\nSummary of earlier conversation history:\n${this.compressedSummary}\n${SUMMARY_TAG_CLOSE}`,
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
    for (let i = 0; i < keepFrom; i++) {
      const msg = this.tail[i];
      if (msg.role === "toolResult") {
        const content = extractContent(msg);
        if (content.length > this.config.toolResultTrimChars) {
          const retained = content.slice(0, this.config.toolResultTrimChars);
          const truncated =
            `${retained}\n` +
            `...[trimmed by context engine; originalLength=${content.length}; retainedChars=${this.config.toolResultTrimChars}]`;
          this.tail[i] = {
            ...msg,
            content: [{ type: "text" as const, text: truncated }],
          } as AgentMessage;
        }
      }
    }
  }

  private compactionThreshold(tokenBudget?: number): number {
    const budget = tokenBudget || 1_000_000;
    return Math.max(0, budget * this.config.compactRatio - this.config.outputReservedTokens);
  }

  private resetCompactionGuard(): void {
    this.consecutiveOverThresholdCompactions = 0;
    this.compactStuck = false;
  }

  private findTokenAwareTailBoundary(): number {
    if (this.tail.length === 0) return 0;

    const minKeep = Math.max(0, this.config.recentKeepCount);
    const budget = Math.max(0, this.config.tailTokenBudget);
    let start = this.tail.length;
    let tokens = 0;

    for (let i = this.tail.length - 1; i >= 0; i--) {
      const messageTokens = estimateMessageTokens(this.tail[i]);
      const keptCountAfterIncluding = this.tail.length - i;
      if (keptCountAfterIncluding > minKeep && tokens + messageTokens > budget) {
        break;
      }
      tokens += messageTokens;
      start = i;
    }

    return findSafeBoundary(this.tail, start);
  }

  private async completeWithRuntime(
    runtimeLlm: ContextEngineRuntimeContext["llm"] | undefined,
    prompt: string,
    fallback: string,
  ): Promise<string> {
    if (!runtimeLlm) return fallback;
    try {
      const result = await runtimeLlm.complete({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 1000,
        temperature: 0.3,
      });
      return result.text || fallback;
    } catch {
      return fallback;
    }
  }

  private async summarizeMessages(
    messages: AgentMessage[],
    runtimeLlm: ContextEngineRuntimeContext["llm"] | undefined,
  ): Promise<string> {
    const prompt =
      `You are compacting the earlier part of a coding agent conversation to save context.\n` +
      `The agent will keep only your summary plus the recent tail, so preserve operational state.\n\n` +
      `${SUMMARY_HEADING_PROMPT}\n\n` +
      `Conversation segment:\n${buildTranscript(messages)}\n\nSummary:`;
    return this.completeWithRuntime(runtimeLlm, prompt, fallbackSummary(messages));
  }

  private async mergeSummary(
    existingSummary: string | null,
    newSummary: string,
    runtimeLlm: ContextEngineRuntimeContext["llm"] | undefined,
  ): Promise<string> {
    if (!existingSummary) {
      return newSummary;
    }

    const combined = `${existingSummary}\n\n${newSummary}`;
    if (estimateTextTokens(combined) <= this.config.maxSummaryTokens) {
      return combined;
    }

    const prompt =
      `You are recompressing accumulated context summaries for a coding agent.\n` +
      `Merge the prior summary and new summary into one bounded briefing.\n\n` +
      `${SUMMARY_HEADING_PROMPT}\n\n` +
      `Prior summary:\n${existingSummary}\n\nNew summary:\n${newSummary}\n\nMerged summary:`;
    return this.completeWithRuntime(runtimeLlm, prompt, newSummary);
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
    // Non-target model: skip prefix-stable compaction
    if (!isDeepSeekModel(this.lastModel, this.config.targetModels)) {
      log.info(`[${ARTIFACT_ID}] compact: model=${this.lastModel}, skipped (non-target)`);
      return { ok: true, compacted: false, reason: "non-DeepSeek model, using default compaction" };
    }

    if (this.compactStuck && !params.force) {
      return {
        ok: true,
        compacted: false,
        reason: "auto-compaction paused: previous compactions did not reduce context below threshold",
      };
    }

    if (this.tail.length <= this.config.recentKeepCount) {
      log.info(`[${ARTIFACT_ID}] compact: tail=${this.tail.length}, skipped (too short)`);
      return { ok: true, compacted: false, reason: "tail too short" };
    }

    log.info(`[${ARTIFACT_ID}] compact: prefix-stable compaction triggered (tail=${this.tail.length})`);

    // Split tail into [toCompact] | [toKeep]
    const boundary = this.findTokenAwareTailBoundary();
    const toCompact = this.tail.slice(0, boundary);
    const toKeep = this.tail.slice(boundary);

    if (toCompact.length === 0) {
      return { ok: true, compacted: false, reason: "safe boundary collapsed" };
    }

    const tokensBefore = estimateTotalTokens(this.compose());

    const runtimeLlm = params.runtimeContext?.llm;
    const summary = await this.summarizeMessages(toCompact, runtimeLlm);

    // Archive dropped messages
    if (this.config.archiveDropped) {
      await this.archive(toCompact);
    }

    // APPLY COMPACTION: PREFIX NEVER CHANGES
    this.tail = toKeep;
    this.compressedSummary = await this.mergeSummary(this.compressedSummary, summary, runtimeLlm);

    const tokensAfter = estimateTotalTokens(this.compose());
    const threshold = this.compactionThreshold(params.tokenBudget);
    this.compactionCount++;
    this.lastCompactionTokensBefore = tokensBefore;
    this.lastCompactionTokensAfter = tokensAfter;
    if (!params.force && tokensAfter > threshold) {
      this.consecutiveOverThresholdCompactions++;
      if (this.consecutiveOverThresholdCompactions >= 2) {
        this.compactStuck = true;
      }
    } else {
      this.resetCompactionGuard();
    }

    // Save state after compaction
    this.saveState();
    await this.persistStateSidecar();

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
    await this.persistStateSidecar();
    log.info(`[${ARTIFACT_ID}] dispose: state saved, prefix=${this.prefix.length}, tail=${this.tail.length}`);
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
      console.error(`[${ARTIFACT_ID}] Archive failed:`, err);
    }
  }

  /** Get cache statistics for monitoring. */
  getCacheStats(): {
    prefixTokens: number;
    tailTokens: number;
    summaryTokens: number;
    totalTokens: number;
    cacheHitEstimate: number;
    prefixMessages: number;
    tailMessages: number;
    compactionCount: number;
    consecutiveOverThresholdCompactions: number;
    compactStuck: boolean;
    lastCompactionTokensBefore: number | null;
    lastCompactionTokensAfter: number | null;
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
      prefixMessages: this.prefix.length,
      tailMessages: this.tail.length,
      compactionCount: this.compactionCount,
      consecutiveOverThresholdCompactions: this.consecutiveOverThresholdCompactions,
      compactStuck: this.compactStuck,
      lastCompactionTokensBefore: this.lastCompactionTokensBefore,
      lastCompactionTokensAfter: this.lastCompactionTokensAfter,
    };
  }
}
