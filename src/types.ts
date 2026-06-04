/**
 * Types for the DeepSeek prefix-cache stable harness.
 *
 * Uses OpenClaw's native AgentMessage type (union of UserMessage | AssistantMessage | ToolResultMessage).
 * Tool calls live inside AssistantMessage.content[] as type: "toolCall" entries.
 * Tool results are ToolResultMessage with role: "toolResult".
 */

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

// Re-export for consumers
export type { AgentMessage };

// Helper type for tool call content blocks in AssistantMessage
type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

// ── Configuration ───────────────────────────────────────────────────────────

export interface DeepSeekHarnessConfig {
  /** Number of messages to lock into the prefix layer. Default: 2. */
  prefixLockCount?: number;
  /** Number of recent messages to keep verbatim in the tail. Default: 8. */
  recentKeepCount?: number;
  /** Token budget for the verbatim tail beyond the minimum recent message count. Default: 16384. */
  tailTokenBudget?: number;
  /** Context window ratio that triggers compaction. Default: 0.8. */
  compactRatio?: number;
  /** Max tokens to reserve for output. Default: 32768. */
  outputReservedTokens?: number;
  /** Max tokens allowed for accumulated compaction summary before it is recompressed. Default: 2000. */
  maxSummaryTokens?: number;
  /** Max characters retained from old tool results before trimming. Default: 2000. */
  toolResultTrimChars?: number;
  /** Whether to archive dropped messages. Default: true. */
  archiveDropped?: boolean;
  /**
   * Model name patterns that trigger prefix-stable mode.
   * Default: ["deepseek-v4-flash", "deepseek-v4-pro", "mimo-v2.5-pro", "mimo-v2.5"]
   * Any model string containing "deepseek" also matches independently of this list.
   */
  targetModels?: string[];
}

export type ResolvedConfig = Required<DeepSeekHarnessConfig>;

export const DEFAULT_CONFIG: ResolvedConfig = {
  prefixLockCount: 2,
  recentKeepCount: 8,
  tailTokenBudget: 16384,
  compactRatio: 0.8,
  outputReservedTokens: 32768,
  maxSummaryTokens: 2000,
  toolResultTrimChars: 2000,
  archiveDropped: true,
  targetModels: ["deepseek-v4-flash", "deepseek-v4-pro", "mimo-v2.5-pro", "mimo-v2.5"],
};

// ── Token Estimation ────────────────────────────────────────────────────────

/**
 * Estimate token count.
 * CJK chars ~1.5 tokens each, ASCII ~0.25 tokens per char.
 */
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    tokens += code > 0x2e80 ? 1.5 : 0.25;
  }
  return Math.ceil(tokens);
}

/** Extract text content from any AgentMessage variant. */
export function extractContent(msg: AgentMessage): string {
  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") return content;
    return content
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { type: string; text?: string }) => p.text ?? "")
      .join("");
  }
  if (msg.role === "assistant") {
    return msg.content
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { type: string; text?: string }) => p.text ?? "")
      .join("");
  }
  if (msg.role === "toolResult") {
    return msg.content
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { type: string; text?: string }) => p.text ?? "")
      .join("");
  }
  return "";
}

/** Extract tool call names from an AssistantMessage. */
export function extractToolCallNames(msg: AgentMessage): string[] {
  if (msg.role !== "assistant") return [];
  return msg.content
    .filter((p): p is ToolCallBlock => p.type === "toolCall")
    .map((tc) => tc.name);
}

/** Estimate tokens for an AgentMessage. */
export function estimateMessageTokens(msg: AgentMessage): number {
  let tokens = 4; // role + formatting overhead
  tokens += estimateTextTokens(extractContent(msg));

  if (msg.role === "assistant") {
    const toolCallParts = msg.content.filter((p): p is ToolCallBlock => p.type === "toolCall");
    for (const tc of toolCallParts) {
      tokens += estimateTextTokens(tc.name) + estimateTextTokens(JSON.stringify(tc.arguments)) + 10;
    }
  }
  if (msg.role === "toolResult") {
    tokens += estimateTextTokens(msg.toolCallId) + estimateTextTokens(msg.toolName) + 4;
  }
  return tokens;
}

export function estimateTotalTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
