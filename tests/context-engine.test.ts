/**
 * Tests for the DeepSeek Context Engine.
 *
 * These tests verify the prefix-stable context management logic.
 */

import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function makeSessionFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `reasonixlaw-${name}-`));
  return join(dir, "session.jsonl");
}

async function cleanupSessionFile(sessionFile: string): Promise<void> {
  await rm(sessionFile.replace(/session\.jsonl$/u, ""), { recursive: true, force: true });
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
  beforeEach(async () => {
    _clearSessionState();
    await rm(`${SESSION_FILE}.deepseek-harness-state.json`, { force: true });
    await rm(`${SESSION_FILE}.reasonixlaw-state.json`, { force: true });
    for (const id of ["t1", "t2", "t3", "t4", "t5", "t6", "t7"]) {
      await rm(`/tmp/${id}.deepseek-harness-state.json`, { force: true });
      await rm(`/tmp/${id}.reasonixlaw-state.json`, { force: true });
    }
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

  test("runtime context engine id uses project name", () => {
    const engine = new DeepSeekContextEngine();
    expect(engine.info.id).toBe("reasonixlaw-prefix-stable");
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

  test("compact keeps a token-budgeted tail beyond the minimum recent count", async () => {
    const engine = new DeepSeekContextEngine({
      prefixLockCount: 1,
      recentKeepCount: 2,
      tailTokenBudget: 120,
      archiveDropped: false,
    });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const messages = [
      userMsg("prefix"),
      assistantMsg("old huge " + "x".repeat(800)),
      userMsg("tail one"),
      assistantMsg("tail two"),
      userMsg("tail three"),
      assistantMsg("tail four"),
    ];

    await engine.assemble({ sessionId: SESSION_ID, messages, model: "deepseek-v4-flash" });
    const compactResult = await engine.compact({
      sessionId: SESSION_ID,
      sessionFile: SESSION_FILE,
      tokenBudget: 1000,
    });
    expect(compactResult.compacted).toBe(true);

    const assembled = await engine.assemble({ sessionId: SESSION_ID, messages, model: "deepseek-v4-flash" });
    expect(assembled.messages).toHaveLength(6); // prefix + summary + four-token-budgeted tail messages
    expect(extractContent(assembled.messages.at(-4)!)).toBe("tail one");
  });

  test("compact pauses after repeated compactions cannot get below threshold", async () => {
    const engine = new DeepSeekContextEngine({
      prefixLockCount: 1,
      recentKeepCount: 1,
      tailTokenBudget: 1,
      archiveDropped: false,
    });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const firstMessages = [
      userMsg("prefix " + "p".repeat(200)),
      assistantMsg("old " + "x".repeat(400)),
      userMsg("recent " + "y".repeat(400)),
    ];
    await engine.assemble({ sessionId: SESSION_ID, messages: firstMessages, model: "deepseek-v4-flash" });
    await engine.compact({ sessionId: SESSION_ID, sessionFile: SESSION_FILE, tokenBudget: 200 });

    const secondMessages = [...firstMessages, assistantMsg("more " + "z".repeat(400)), userMsg("latest " + "q".repeat(400))];
    await engine.assemble({ sessionId: SESSION_ID, messages: secondMessages, model: "deepseek-v4-flash" });
    await engine.compact({ sessionId: SESSION_ID, sessionFile: SESSION_FILE, tokenBudget: 200 });

    expect(engine.getCacheStats().compactStuck).toBe(true);

    const thirdMessages = [...secondMessages, assistantMsg("again " + "r".repeat(400))];
    await engine.assemble({ sessionId: SESSION_ID, messages: thirdMessages, model: "deepseek-v4-flash" });
    const third = await engine.compact({ sessionId: SESSION_ID, sessionFile: SESSION_FILE, tokenBudget: 200 });
    expect(third.compacted).toBe(false);
    expect(third.reason).toContain("paused");
  });

  test("summary is structured and recompacted instead of appended indefinitely", async () => {
    const summaries = ["first long summary " + "a".repeat(200), "merged summary"];
    const engine = new DeepSeekContextEngine({
      prefixLockCount: 1,
      recentKeepCount: 1,
      tailTokenBudget: 1,
      maxSummaryTokens: 8,
      archiveDropped: false,
    });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const runtimeContext = {
      llm: {
        complete: async () => ({ text: summaries.shift() ?? "fallback merged summary" }),
      },
    } as never;

    const firstMessages = [userMsg("prefix"), assistantMsg("old one"), userMsg("recent one")];
    await engine.assemble({ sessionId: SESSION_ID, messages: firstMessages, model: "deepseek-v4-flash" });
    await engine.compact({ sessionId: SESSION_ID, sessionFile: SESSION_FILE, runtimeContext });

    const secondMessages = [...firstMessages, assistantMsg("old two"), userMsg("recent two")];
    await engine.assemble({ sessionId: SESSION_ID, messages: secondMessages, model: "deepseek-v4-flash" });
    await engine.compact({ sessionId: SESSION_ID, sessionFile: SESSION_FILE, runtimeContext });

    const assembled = await engine.assemble({ sessionId: SESSION_ID, messages: secondMessages, model: "deepseek-v4-flash" });
    const summaryMessage = assembled.messages.find((m) => extractContent(m).includes("<compaction-summary>"));
    expect(summaryMessage).toBeDefined();
    const summaryContent = extractContent(summaryMessage!);
    expect(summaryContent).toContain("merged summary");
    expect(summaryContent).not.toContain("---");
  });

  test("dispose persists layer state to a reasonixlaw session sidecar", async () => {
    const sessionFile = await makeSessionFile("sidecar");
    try {
      const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
      await engine.bootstrap({ sessionId: "sidecar-session", sessionFile });
      await engine.assemble({
        sessionId: "sidecar-session",
        sessionFile,
        messages: [userMsg("hello"), assistantMsg("world"), userMsg("tail")],
        model: "deepseek-v4-flash",
      } as never);
      const statsBefore = engine.getCacheStats();
      await engine.dispose();

      await expect(access(`${sessionFile}.reasonixlaw-state.json`)).resolves.toBeUndefined();
      await expect(access(`${sessionFile}.deepseek-harness-state.json`)).rejects.toThrow();

      _clearSessionState("sidecar-session");

      const engine2 = new DeepSeekContextEngine({ prefixLockCount: 2 });
      await engine2.bootstrap({ sessionId: "sidecar-session", sessionFile });
      const statsAfter = engine2.getCacheStats();
      expect(statsAfter.prefixTokens).toBe(statsBefore.prefixTokens);
      expect(statsAfter.tailTokens).toBe(statsBefore.tailTokens);
    } finally {
      await cleanupSessionFile(sessionFile);
    }
  });

  test("bootstrap restores legacy deepseek-harness sidecar state", async () => {
    const sessionFile = await makeSessionFile("legacy-sidecar");
    try {
      const sessionId = "legacy-sidecar-session";
      const legacyState = {
        version: 1,
        sessionId,
        state: {
          prefix: [userMsg("legacy prefix"), assistantMsg("legacy answer")],
          tail: [userMsg("legacy tail")],
          compressedSummary: null,
          ingestedCount: 3,
          lastModel: "deepseek-v4-flash",
          compactionCount: 1,
          consecutiveOverThresholdCompactions: 0,
          compactStuck: false,
          lastCompactionTokensBefore: 100,
          lastCompactionTokensAfter: 50,
        },
      };
      await writeFile(`${sessionFile}.deepseek-harness-state.json`, JSON.stringify(legacyState), "utf-8");
      _clearSessionState(sessionId);

      const engine = new DeepSeekContextEngine({ prefixLockCount: 2 });
      await engine.bootstrap({ sessionId, sessionFile });

      const stats = engine.getCacheStats();
      expect(stats.prefixMessages).toBe(2);
      expect(stats.tailMessages).toBe(1);
      expect(stats.compactionCount).toBe(1);
    } finally {
      await cleanupSessionFile(sessionFile);
    }
  });

  test("old tool results are trimmed with a marker while recent tool results stay intact", async () => {
    const engine = new DeepSeekContextEngine({
      prefixLockCount: 1,
      recentKeepCount: 1,
      toolResultTrimChars: 20,
      archiveDropped: false,
    });
    await engine.bootstrap({ sessionId: SESSION_ID, sessionFile: SESSION_FILE });

    const oldTool = "old-tool-" + "x".repeat(100);
    const recentTool = "recent-tool-" + "y".repeat(100);
    const result = await engine.assemble({
      sessionId: SESSION_ID,
      messages: [
        userMsg("prefix"),
        toolResultMsg("old", "bash", oldTool),
        assistantMsg("between"),
        toolResultMsg("recent", "bash", recentTool),
      ],
      model: "deepseek-v4-flash",
      tokenBudget: 100,
    });

    const toolResults = result.messages.filter((m) => m.role === "toolResult");
    expect(extractContent(toolResults[0])).toContain("trimmed by context engine");
    expect(extractContent(toolResults[0])).toContain("originalLength");
    expect(extractContent(toolResults[1])).toBe(recentTool);
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

describe("plugin manifest", () => {
  test("declares reasonixlaw plugin id", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf-8")) as {
      id?: string;
    };
    expect(manifest.id).toBe("reasonixlaw");
  });

  test("declares context-engine kind", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf-8")) as {
      kind?: string;
    };
    expect(manifest.kind).toBe("context-engine");
  });

  test("declares all documented tuning options in config schema", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf-8")) as {
      configSchema?: { properties?: Record<string, unknown> };
    };
    expect(Object.keys(manifest.configSchema?.properties ?? {})).toEqual([
      "targetModels",
      "prefixLockCount",
      "recentKeepCount",
      "tailTokenBudget",
      "compactRatio",
      "outputReservedTokens",
      "maxSummaryTokens",
      "toolResultTrimChars",
      "archiveDropped",
    ]);
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
