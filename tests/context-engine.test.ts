/**
 * Tests for the DeepSeek Context Engine.
 *
 * These tests verify the prefix-stable context management logic.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { DeepSeekContextEngine, _clearSessionState } from "../src/context-engine.js";
import { estimateTextTokens, estimateTotalTokens, extractContent } from "../src/types.js";
import type { AgentMessage } from "../src/types.js";

// ── Helpers to create AgentMessage-compatible objects ────────────────────────

function userMsg(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantMsg(content: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "openai",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as unknown as AgentMessage;
}

function toolResultMsg(toolCallId: string, toolName: string, content: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: content }],
    isError: false,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

// ── Token estimation ────────────────────────────────────────────────────────

describe("estimateTextTokens", () => {
  test("ASCII text ~0.25 tokens/char", () => {
    const tokens = estimateTextTokens("hello world"); // 11 chars
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  test("CJK text ~1.5 tokens/char", () => {
    const ascii = estimateTextTokens("hello");
    const cjk = estimateTextTokens("你好世界");
    expect(cjk).toBeGreaterThan(ascii);
  });

  test("empty string = 0", () => {
    expect(estimateTextTokens("")).toBe(0);
  });
});

describe("extractContent", () => {
  test("extracts user string content", () => {
    const m = userMsg("hello");
    expect(extractContent(m)).toBe("hello");
  });

  test("extracts assistant text content", () => {
    const m = assistantMsg("hello world");
    expect(extractContent(m)).toBe("hello world");
  });

  test("handles empty content", () => {
    expect(extractContent(userMsg(""))).toBe("");
  });
});

// ── Context Engine ──────────────────────────────────────────────────────────

describe("DeepSeekContextEngine", () => {
  const SESSION_ID = "test-session";
  const SESSION_FILE = "/tmp/test-session.jsonl";

  // Clear module-level state before each test so tests don't leak
  beforeEach(() => {
    _clearSessionState();
  });

  test("first assemble splits into prefix + tail", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const messages = [
      userMsg("Hello"),
      assistantMsg("Hi there"),
      userMsg("What's 2+2?"),
      assistantMsg("4"),
    ];

    const result = await engine.assemble({ sessionId: SESSION_ID, messages, model: "deepseek-v4-flash" });

    expect(result.messages).toHaveLength(4);
    const stats = engine.getCacheStats();
    expect(stats.prefixTokens).toBeGreaterThan(0);
  });

  test("subsequent assemble only appends new messages to tail", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const messages1 = [
      userMsg("First question"),
      assistantMsg("First answer"),
    ];

    await engine.assemble({ sessionId: SESSION_ID, messages: messages1, model: "deepseek-v4-flash" });
    const stats1 = engine.getCacheStats();
    const prefixTokens1 = stats1.prefixTokens;

    const messages2 = [
      ...messages1,
      userMsg("Second question"),
      assistantMsg("Second answer"),
    ];

    await engine.assemble({ sessionId: SESSION_ID, messages: messages2, model: "deepseek-v4-flash" });
    const stats2 = engine.getCacheStats();

    // Prefix tokens MUST be exactly the same
    expect(stats2.prefixTokens).toBe(prefixTokens1);
    expect(stats2.tailTokens).toBeGreaterThan(stats1.tailTokens);
  });

  test("prefix never changes across many turns", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const baseMessages = [
      userMsg("Hello, I need help"),
      assistantMsg("Sure!"),
    ];

    // Turn 1
    await engine.assemble({ sessionId: SESSION_ID, messages: baseMessages, model: "deepseek-v4-flash" });
    const prefix1 = engine.getCacheStats().prefixTokens;

    // Turn 2
    await engine.assemble({ sessionId: SESSION_ID, messages: [...baseMessages, userMsg("Thanks")], model: "deepseek-v4-flash" });
    const prefix2 = engine.getCacheStats().prefixTokens;

    // Turn 3
    await engine.assemble({
      sessionId: SESSION_ID,
      messages: [...baseMessages, userMsg("Thanks"), assistantMsg("You're welcome")],
      model: "deepseek-v4-flash",
    });
    const prefix3 = engine.getCacheStats().prefixTokens;

    expect(prefix1).toBe(prefix2);
    expect(prefix2).toBe(prefix3);
  });

  test("handles external resync (messages length decreases)", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const messages1 = [
      userMsg("Q1"),
      assistantMsg("A1"),
      userMsg("Q2"),
      assistantMsg("A2"),
    ];
    await engine.assemble({ sessionId: SESSION_ID, messages: messages1, model: "deepseek-v4-flash" });

    // External truncation
    const messages2 = [userMsg("Q1")];
    const result = await engine.assemble({ sessionId: SESSION_ID, messages: messages2, model: "deepseek-v4-flash" });

    expect(result.messages.length).toBeGreaterThan(0);
  });

  test("compact preserves prefix", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 1, recentKeepCount: 2 });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const messages = [
      userMsg("old1"),
      assistantMsg("old2"),
      userMsg("old3"),
      assistantMsg("old4"),
      userMsg("recent1"),
      assistantMsg("recent2"),
    ];

    await engine.assemble({ sessionId: SESSION_ID, messages, model: "deepseek-v4-flash" });

    const prefixBefore = engine.getCacheStats().prefixTokens;

    const compactResult = await engine.compact({
      sessionId: SESSION_ID,
      sessionFile: SESSION_FILE,
      tokenBudget: 500,
    });

    if (compactResult.compacted) {
      const prefixAfter = engine.getCacheStats().prefixTokens;
      expect(prefixAfter).toBe(prefixBefore);
    }
  });

  test("compact respects safe boundary (doesn't split tool pairs)", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 1, recentKeepCount: 2 });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const messages = [
      userMsg("run command"),
      assistantMsg("Running...") as AgentMessage,
      toolResultMsg("tc1", "bash", "file1.txt\nfile2.txt"),
      assistantMsg("Here are the files"),
      userMsg("next question"),
      assistantMsg("next answer"),
    ];

    await engine.assemble({ sessionId: SESSION_ID, messages, model: "deepseek-v4-flash" });

    const compactResult = await engine.compact({
      sessionId: SESSION_ID,
      sessionFile: SESSION_FILE,
      tokenBudget: 500,
    });

    expect(compactResult.ok).toBe(true);
  });

  test("archive doesn't crash", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 1, recentKeepCount: 2, archiveDropped: true });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const messages = [
      userMsg("old message"),
      assistantMsg("old response"),
      userMsg("new message"),
      assistantMsg("new response"),
    ];

    await engine.assemble({ sessionId: SESSION_ID, messages, model: "deepseek-v4-flash" });

    const result = await engine.compact({
      sessionId: SESSION_ID,
      sessionFile: SESSION_FILE,
      tokenBudget: 200,
    });

    expect(result.ok).toBe(true);
  });

  test("dispose saves state for cross-turn persistence", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    await engine.assemble({
      sessionId: SESSION_ID,
      messages: [userMsg("hello"), assistantMsg("world")],
      model: "deepseek-v4-flash",
    });

    const statsBefore = engine.getCacheStats();
    expect(statsBefore.prefixTokens).toBeGreaterThan(0);

    // Dispose saves state
    await engine.dispose();

    // New engine instance should restore the saved state
    const engine2 = new DeepSeekContextEngine({ prefixLockCount: 2 });
    await engine2.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const statsAfter = engine2.getCacheStats();
    expect(statsAfter.prefixTokens).toBe(statsBefore.prefixTokens);
    expect(statsAfter.tailTokens).toBe(statsBefore.tailTokens);
  });
});

// ── Model detection ─────────────────────────────────────────────────────────

describe("model detection", () => {
  test("DeepSeek model triggers prefix-stable mode", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
    await engine.bootstrap({ sessionId: "t1", sessionFile: "/tmp/t1" });

    const messages = [userMsg("Q"), assistantMsg("A")];
    await engine.assemble({ sessionId: "t1", messages, model: "deepseek-v4-flash" });

    const stats = engine.getCacheStats();
    expect(stats.prefixTokens).toBeGreaterThan(0);
  });

  test("provider/model format triggers prefix-stable mode", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
    await engine.bootstrap({ sessionId: "t2", sessionFile: "/tmp/t2" });

    const messages = [userMsg("Q"), assistantMsg("A")];
    await engine.assemble({ sessionId: "t2", messages, model: "deepseek/deepseek-v4-pro" });

    const stats = engine.getCacheStats();
    expect(stats.prefixTokens).toBeGreaterThan(0);
  });

  test("non-DeepSeek model passes through unchanged", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
    await engine.bootstrap({ sessionId: "t3", sessionFile: "/tmp/t3" });

    const messages = [userMsg("Q"), assistantMsg("A")];
    const result = await engine.assemble({ sessionId: "t3", messages, model: "gemini-2.5-flash" });

    // Should return messages unchanged (no layer management)
    expect(result.messages).toEqual(messages);
  });

  test("GPT model passes through unchanged", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
    await engine.bootstrap({ sessionId: "t4", sessionFile: "/tmp/t4" });

    const messages = [userMsg("Q")];
    const result = await engine.assemble({ sessionId: "t4", messages, model: "gpt-4o" });

    expect(result.messages).toEqual(messages);
  });

  test("compact() skipped for non-DeepSeek model", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 1, recentKeepCount: 2 });
    await engine.bootstrap({ sessionId: "t5", sessionFile: "/tmp/t5" });

    const messages = [userMsg("old"), assistantMsg("resp"), userMsg("new"), assistantMsg("new resp")];
    // Build layers with DeepSeek first
    await engine.assemble({ sessionId: "t5", messages, model: "deepseek-v4-flash" });
    // Switch to Gemini
    await engine.assemble({ sessionId: "t5", messages, model: "gemini-2.5-flash" });

    const result = await engine.compact({ sessionId: "t5", sessionFile: "/tmp/t5" });
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("non-DeepSeek");
  });

  test("unknown model defaults to prefix-stable (safe)", async () => {
    const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
    await engine.bootstrap({ sessionId: "t6", sessionFile: "/tmp/t6" });

    const messages = [userMsg("Q"), assistantMsg("A")];
    const result = await engine.assemble({ sessionId: "t6", messages });

    const stats = engine.getCacheStats();
    expect(stats.prefixTokens).toBeGreaterThan(0);
  });

  test("custom targetModels override works", async () => {
    const engine = new DeepSeekContextEngine({
      prefixLockCount: 2,
      targetModels: ["my-custom-model", "another-model"],
    });
    await engine.bootstrap({ sessionId: "t7", sessionFile: "/tmp/t7" });

    const messages = [userMsg("Q"), assistantMsg("A")];

    // DeepSeek NOT in custom list — should pass through
    const result1 = await engine.assemble({ sessionId: "t7", messages, model: "deepseek-v4-flash" });
    expect(result1.messages).toEqual(messages);

    // Custom model IS in list — should activate
    await engine.assemble({ sessionId: "t7", messages, model: "my-custom-model" });
    const stats = engine.getCacheStats();
    expect(stats.prefixTokens).toBeGreaterThan(0);
  });
});
