# ReasoniXlaw

<p align="center">
  <img src="./docs/reasonixlaw-logo.png" alt="ReasoniXlaw Logo" width="600">
</p>

**Prefix-cache stable context engine for DeepSeek-compatible models — an OpenClaw plugin.**

> Inspired by [Reasonix](https://github.com/esengine/DeepSeek-Reasonix) — thanks to the project author for the prefix-stable context management concept.

English | [中文](./README_CN.md)

Docs: [Architecture](./docs/ARCHITECTURE.md) | [Optimization notes](./docs/OPTIMIZATION_PLAN.md)

## Problem

DeepSeek's API offers **prefix caching**: if the beginning of your request is identical to a previous one, cached tokens cost ~10% of normal input price — up to 90% savings.

But OpenClaw's default context management compresses/modifies messages wherever it sees fit when context fills up. This **destroys the prefix**, breaking DeepSeek's cache.

## Solution

A **ContextEngine plugin** that manages context in three layers:

```
┌─────────────────────────────────────┐
│  Layer 1: LOCKED PREFIX             │  ← Never modified. Cache hits here.
│  System prompt + early history      │
├─────────────────────────────────────┤
│  Layer 2: ACTIVE TAIL               │  ← Append-only between compactions.
│  Recent messages                    │
├─────────────────────────────────────┤
│  Layer 3: COMPRESSED MIDDLE         │  ← Only layer that ever changes.
│  Summarised older messages          │
└─────────────────────────────────────┘
```

Compaction only touches the middle layer. The prefix is **never modified**.
DeepSeek sees the same prefix every turn → cache hit → 90% cost reduction.

## Architecture

This is a **ContextEngine plugin**, not an AgentHarness. That means:

| Component | Who owns it |
|-----------|-------------|
| Context assembly & compaction | **This plugin** (prefix-stable) |
| Tool execution | OpenClaw PI |
| Auth & API keys | OpenClaw PI |
| Streaming | OpenClaw PI |
| Retries & fallback | OpenClaw PI |
| Transcript persistence | OpenClaw PI |
| Reasoning effort | PI passes through to DeepSeek (your config has `supportsReasoningEffort: true`) |
| Cache stats | Available via `ContextEngineRuntimeContext.promptCache` |

We plug into PI's execution loop at the right points (`assemble`, `compact`) and
let PI handle everything else. No custom HTTP client, no tool bridge, no auth handling.

## Installation

**Via ClawHub (recommended):**

> ⚠️ **Note:** ClawHub currently has a bug that prevents this plugin from being published. Please install from source until the issue is resolved.

```bash
openclaw plugins install clawhub:@dendim0n/reasonixlaw
```

**From source:**

```bash
cd ~/.openclaw/plugins
git clone https://github.com/Dendim0n/ReasoniXlaw.git
cd ReasoniXlaw
npm install
npm run build
```

## Configuration

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    entries: {
      "reasonixlaw": { enabled: true }
    },
    slots: {
      contextEngine: "reasonixlaw-prefix-stable"
    }
  }
}
```

That's it. When a matching DeepSeek-compatible target model is in use, PI will automatically use our prefix-stable context engine.

Use `reasonixlaw` for the plugin entry id and `reasonixlaw-prefix-stable` for the runtime context engine id. The code still reads config from the old `plugins.entries.deepseek-harness.config` key if the new entry has no config, so existing tuning can migrate gradually. The old slot id `deepseek-prefix-stable` is not the current runtime id.

### Custom model targets

By default, any model name containing `deepseek` triggers prefix-stable mode. The additional default target list also covers `mimo-v2.5-pro` and `mimo-v2.5`. To add your own non-DeepSeek model aliases:

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    entries: {
      "reasonixlaw": {
        enabled: true,
        config: {
          targetModels: ["mimo-v2.5-pro", "mimo-v2.5", "my-private-r1"]
        }
      }
    },
    slots: {
      contextEngine: "reasonixlaw-prefix-stable"
    }
  }
}
```

`targetModels` replaces the additional target list, not the built-in `deepseek` substring rule. Include `mimo-v2.5-pro` and `mimo-v2.5` if you still want those aliases to activate after customizing the list.

### Model Detection

The engine activates for DeepSeek-compatible target models. It checks the model string with two rules: any model containing `deepseek` activates, and any model matching `targetModels` activates.

| Model | Prefix-stable mode |
|-------|-------------------|
| `deepseek-v4-flash` | ✅ Active |
| `deepseek-v4-pro` | ✅ Active |
| `mimo-v2.5-pro` | ✅ Active |
| `mimo-v2.5` | ✅ Active |
| `deepseek/deepseek-v4-pro` | ✅ Active (provider/model format) |
| `deepseek-v3`, `deepseek-r1` | ✅ Active |
| `gemini-2.5-flash` | ❌ Passthrough (PI default) |
| `gpt-4o` | ❌ Passthrough (PI default) |
| unknown/undefined | ✅ Active (safe default) |

Non-target models get PI's default context management — no overhead, no interference.

### Optional tuning

The context engine reads config from the plugin entry:

| Option | Default | Description |
|--------|---------|-------------|
| `prefixLockCount` | 2 | Messages to lock into prefix layer |
| `recentKeepCount` | 8 | Minimum recent messages to keep verbatim in tail |
| `tailTokenBudget` | 16384 | Token budget for keeping additional recent tail messages |
| `compactRatio` | 0.8 | Context ratio that triggers compaction |
| `outputReservedTokens` | 32768 | Output budget reserved before considering compaction pressure |
| `maxSummaryTokens` | 2000 | Recompress accumulated summary when it grows past this estimate |
| `toolResultTrimChars` | 2000 | Characters retained from older tool results before trimming |
| `archiveDropped` | true | Archive dropped messages to disk |
| `targetModels` | `["deepseek-v4-flash", "deepseek-v4-pro", "mimo-v2.5-pro", "mimo-v2.5"]` | Model name patterns that activate prefix-stable mode |

#### `prefixLockCount` (default: 2)

Number of messages locked into the prefix layer. These 2 messages (typically the system prompt + first user message) **never change** — they're the core of DeepSeek's cache hit. Too large wastes context space; too small doesn't lock enough prefix. 2 is usually sufficient.

#### `recentKeepCount` (default: 8)

Minimum number of recent messages kept verbatim in the tail layer. These messages are **not summarized** during compaction. The engine can keep more messages when they fit inside `tailTokenBudget`.

#### `tailTokenBudget` (default: 16384)

Token budget for the verbatim tail beyond the minimum recent count. This prevents a few large tool outputs from forcing repeated compaction while still preserving more small recent messages when space allows.

#### `compactRatio` (default: 0.8)

Triggers compaction when token usage reaches 80% of the context window. 0.8 is a sweet spot — too early (0.5) wastes space; too late (0.95) risks PI force-truncating before compaction finishes.

#### `outputReservedTokens` (default: 32768)

Output budget reserved before compaction pressure is calculated. The effective trigger threshold is roughly `tokenBudget * compactRatio - outputReservedTokens`, so large expected outputs compact earlier.

#### `maxSummaryTokens` (default: 2000)

Maximum estimated size for the accumulated summary. When the summary grows past this limit, the engine recompresses the old summary plus the new segment into a bounded structured briefing instead of appending forever.

#### `toolResultTrimChars` (default: 2000)

Large old tool results are trimmed outside the recent kept tail. The trim marker records the original length and retained characters so the model knows evidence was shortened.

#### `archiveDropped` (default: true)

Whether messages dropped during compaction are archived to `~/.openclaw/reasonixlaw/archive/` (JSONL format). Useful for post-hoc auditing; disable to save disk I/O and reduce local retention of tool outputs.

#### `targetModels`

Additional model-name patterns that trigger prefix-stable mode. Any model string containing `deepseek` still activates even if it is not listed here. Customizing this list mainly controls provider aliases such as `mimo-v2.5-pro`, `mimo-v2.5`, or private DeepSeek-compatible names that do not contain `deepseek`.

> **Generally the defaults work fine.** Only tune if: context is tight (lower `prefixLockCount`), you need more precise recent memory (raise `recentKeepCount`), or context overflows frequently (lower `compactRatio`).

## How It Works

1. **First `assemble()` call**: System prompt + first N messages → locked into Layer 1 (prefix)
2. **Subsequent calls**: New messages → appended to Layer 2 (tail) only
3. **Compaction**: When context fills → token-aware tail selection + structured middle summary → prefix stays stable
4. **DeepSeek sees identical prefix** → cached tokens at 10% price
5. **Loop guard**: If repeated compactions cannot reduce context below threshold, auto-compaction pauses instead of wasting turns

## Key Design Decisions

### Why ContextEngine, not AgentHarness?

The AgentHarness interface replaces the **entire** execution loop. That's what Codex needs (it has its own app-server). But we don't want to replace tool execution, auth, streaming, or retries — we only want to manage context differently.

The ContextEngine interface is **exactly** the right abstraction:
- `assemble()` → we control what goes into the prompt
- `compact()` → we control how context is reduced
- PI handles everything else

### Why not a custom API client?

PI's model transport (`params.model`) already:
- Handles auth (API key resolution)
- Supports streaming
- Passes through `reasoning_effort` (DeepSeek's config has `supportsReasoningEffort: true`)
- Reports `promptCache` info (cache hit/miss stats)

Building our own HTTP client would duplicate all of this and lose auth integration.

## Benefits and Tradeoffs

What improves:

- Lower input cost when DeepSeek prefix cache hits the locked prefix.
- Higher cache hit probability because the prefix is not rewritten during compaction.
- Less context churn because recent tail selection is token-aware and old tool output can be trimmed before full compaction.
- Better restart behavior when OpenClaw provides a stable `sessionFile`, because layer state is also persisted to `<sessionFile>.reasonixlaw-state.json`. Existing `<sessionFile>.deepseek-harness-state.json` files are still read as a legacy fallback.
- No duplicated transport code. PI still owns auth, tools, streaming, retries, transcript persistence, and cache telemetry.

What it costs:

- The locked prefix is deliberately hard to change. If the first messages are poor, they stay in the cacheable prefix until the session is reset.
- Summaries are lossy. The structured prompt preserves operational state, but fine-grained detail can still be lost.
- Compaction can add latency and a small extra model call when runtime LLM summarization is available. The extractive fallback is cheaper but less precise.
- Token estimates are approximate, CJK-aware character estimates, not provider tokenizer counts.
- Old tool-result trimming can hide evidence from the model. The marker records what was trimmed, and archives can preserve the original locally.
- Local sidecars and archives retain conversation projection data and dropped messages. Disable `archiveDropped` when disk retention is not acceptable.
- If compaction cannot get below threshold twice in a row, the stuck guard pauses automatic compaction. That avoids repeated waste, but the host may still need to handle the remaining pressure.

## Token Economics

| Scenario | Default PI | This Engine |
|----------|-----------|-------------|
| 100K conversation, cache hit rate | ~10% | ~80%+ |
| Cost per turn (V4 Pro, 1M ctx) | ~$0.15 | ~$0.03 |
| Long session (50 turns) | ~$7.50 | ~$1.50 |

*Illustrative only. Replace the rates with current provider pricing before using these numbers for budgeting.*

## Tests

```bash
npm test
```

## Files

| File | Purpose |
|------|---------|
| `src/types.ts` | Configuration, token estimation |
| `src/context-engine.ts` | ContextEngine implementation (core logic) |
| `src/index.ts` | Plugin entry — registers context engine |
| `tests/context-engine.test.ts` | Unit tests |
| `openclaw.plugin.json` | Plugin manifest |
| `docs/ARCHITECTURE.md` | Integration flow, state persistence, and design tradeoffs |
| `docs/OPTIMIZATION_PLAN.md` | Implemented optimization measures and principles |

## License

MIT
