# ReasoniXlaw

<p align="center">
  <img src="./docs/reasonixlaw-logo.png" alt="ReasoniXlaw Logo" width="600">
</p>

**Prefix-cache stable context engine for DeepSeek models — an OpenClaw plugin.**

> Inspired by [Reasonix](https://github.com/esengine/DeepSeek-Reasonix) — thanks to the project author for the prefix-stable context management concept.

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

```bash
cd ~/.openclaw/plugins
git clone https://github.com/YOUR_USER/openclaw-deepseek-harness.git
cd openclaw-deepseek-harness
npm install
npm run build
```

## Configuration

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    entries: {
      "deepseek-harness": { enabled: true }
    },
    slots: {
      contextEngine: "deepseek-prefix-stable"
    }
  }
}
```

That's it. When a DeepSeek model is in use, PI will automatically use our prefix-stable context engine.

### Custom model targets

By default, `deepseek-v4-flash` and `deepseek-v4-pro` trigger prefix-stable mode. To add your own models:

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    entries: {
      "deepseek-harness": {
        enabled: true,
        config: {
          targetModels: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v3", "my-custom-deepseek"]
        }
      }
    },
    slots: {
      contextEngine: "deepseek-prefix-stable"
    }
  }
}
```

`targetModels` **replaces** the default — include the defaults if you want to keep them.

### Model Detection

The engine activates **only** for DeepSeek models. It checks the model string:

| Model | Prefix-stable mode |
|-------|-------------------|
| `deepseek-v4-flash` | ✅ Active |
| `deepseek-v4-pro` | ✅ Active |
| `deepseek/deepseek-v4-pro` | ✅ Active (provider/model format) |
| `deepseek-v3`, `deepseek-r1` | ✅ Active |
| `gemini-2.5-flash` | ❌ Passthrough (PI default) |
| `gpt-4o` | ❌ Passthrough (PI default) |
| unknown/undefined | ✅ Active (safe default) |

Non-DeepSeek models get PI's default context management — no overhead, no interference.

### Optional tuning

The context engine reads config from the plugin entry (future: `plugins.entries.deepseek-harness.config`):

| Option | Default | Description |
|--------|---------|-------------|
| `prefixLockCount` | 2 | Messages to lock into prefix layer |
| `recentKeepCount` | 8 | Recent messages to keep verbatim in tail |
| `compactRatio` | 0.8 | Context ratio that triggers compaction |
| `archiveDropped` | true | Archive dropped messages to disk |
| `targetModels` | `["deepseek-v4-flash", "deepseek-v4-pro"]` | Model name patterns that activate prefix-stable mode |

## How It Works

1. **First `assemble()` call**: System prompt + first N messages → locked into Layer 1 (prefix)
2. **Subsequent calls**: New messages → appended to Layer 2 (tail) only
3. **Compaction**: When context fills → only Layer 3 changes → prefix stays stable
4. **DeepSeek sees identical prefix** → cached tokens at 10% price

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

## Token Economics

| Scenario | Default PI | This Engine |
|----------|-----------|-------------|
| 100K conversation, cache hit rate | ~10% | ~80%+ |
| Cost per turn (V4 Pro, 1M ctx) | ~$0.15 | ~$0.03 |
| Long session (50 turns) | ~$7.50 | ~$1.50 |

*Based on DeepSeek pricing: $0.14/M input, $0.028/M cached.*

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

## License

MIT
