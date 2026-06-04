# ReasoniXlaw Optimization Plan

## Scope

Implemented optimizations for ReasoniXlaw while keeping the existing model detection behavior unchanged. The runtime code lives in `src/context-engine.ts`, config defaults in `src/types.ts`, plugin registration in `src/index.ts`, and the manifest contract in `openclaw.plugin.json`.

## Current Status

| Area | Status | Evidence |
|------|--------|----------|
| Observability | Implemented | `getCacheStats()` now exposes layer tokens, compaction counters, and stuck state |
| Runtime ids | Implemented | Plugin entry id is `reasonixlaw`; context engine id is `reasonixlaw-prefix-stable` |
| Token-aware tail | Implemented | `findTokenAwareTailBoundary()` keeps recent messages by token budget and safe boundaries |
| Stuck guard | Implemented | Repeated over-threshold compactions set `compactStuck` and pause automatic compaction |
| Structured summaries | Implemented | Summary prompt preserves goal, decisions, files, commands, errors, and next step |
| Sidecar state | Implemented | Layer state persists to `<sessionFile>.deepseek-harness-state.json` |
| Tool-result trimming | Implemented | Older tool results are trimmed with an explicit length marker |
| Tests | Implemented | `tests/context-engine.test.ts` covers the behaviors above and manifest fields |

The `deepseek-harness` name still appears in archive paths, sidecar suffixes, logs, and the legacy config fallback. That is intentional compatibility, not the public plugin id.

## 1. Observability

**Principle:** Prefix-cache optimization must be measured, not inferred. Cache hit gains depend on prompt shape, tool schemas, system prompt stability, and provider telemetry.

**Technical measures:**

- Extend cache stats with prefix, summary, tail, total token estimates, compaction count, and stuck state.
- Keep the existing public `getCacheStats()` API compatible while adding fields.
- Update tests to assert stats change when compaction runs.

## 2. Manifest and Slot Contract Cleanup

**Principle:** The plugin should advertise the capability it provides so OpenClaw can classify and activate it consistently.

**Technical measures:**

- Change `openclaw.plugin.json` from `kind: "plugin"` to `kind: "context-engine"`.
- Use `reasonixlaw-prefix-stable` as the runtime context engine id.
- Use `reasonixlaw` as the plugin entry id, while accepting `deepseek-harness` as a legacy config fallback.
- Keep `openclaw.plugin.json` config schema aligned with the TypeScript config surface, because `additionalProperties: false` rejects unknown tuning keys.

## 3. Token-Aware Recent Tail

**Principle:** Recent context should be bounded by tokens, not only message count. One large tool result can be larger than many text turns.

**Technical measures:**

- Add configurable `tailTokenBudget`.
- During compaction, choose the kept tail by walking newest-to-oldest until adding another message would exceed `tailTokenBudget`, while still keeping at least `recentKeepCount` messages.
- Align the boundary backward off tool result messages so the tail does not start with an orphan tool result.

## 4. Compaction Stuck Guard

**Principle:** If compaction cannot reduce the prompt below the trigger threshold, repeating it every turn wastes tokens and latency.

**Technical measures:**

- Track consecutive compactions that still leave the assembled prompt above the compaction threshold.
- After two such compactions, pause automatic compaction and report `compactStuck` in stats.
- Reset the guard when the assembled prompt falls below threshold.

## 5. Structured Summary and Summary Recompaction

**Principle:** A compacted context summary must preserve operational state, not just prose. It should also remain bounded.

**Technical measures:**

- Replace the generic summary prompt with a structured prompt covering goal, decisions, files/code, commands/outcomes, errors/fixes, and pending next step.
- Wrap summary content with explicit summary tags.
- Add configurable `maxSummaryTokens`.
- When the accumulated summary grows beyond `maxSummaryTokens`, summarize the old summary together with the new segment instead of appending indefinitely.

## 6. Persistent Session Layer State

**Principle:** Prefix stability should survive engine instance churn and process restarts when the host provides a session file.

**Technical measures:**

- Keep the current in-memory session map for fast same-process restores.
- Add a small JSON state sidecar derived from the OpenClaw session file path.
- Persist prefix, tail, compressed summary, ingested count, last model, compaction counters, and stats.
- Load sidecar state during bootstrap before treating the session as new.

## 7. Safer Tool Output Handling

**Principle:** Truncating tool output saves tokens but can remove the evidence needed to continue a task.

**Technical measures:**

- Add configurable `toolResultTrimChars`.
- Add a metadata-style marker that records original length and retained prefix length.
- Only trim older tail messages outside the recent kept window.
- Preserve tool result identity fields and text content shape.

## 8. Documentation and Tests

**Principle:** The plugin should explain the cache/accuracy tradeoff and make the intended behavior executable.

**Technical measures:**

- Add tests for token-aware tail selection, stuck guard, summary recompaction, sidecar persistence, and manifest kind.
- Update README and architecture docs with the new tradeoffs and tuning knobs.

## Operational Costs and Failure Modes

- **Sticky prefix:** The first `prefixLockCount` messages are intentionally preserved. This is good for cache hits, but bad early context stays until the session is reset.
- **Lossy middle:** Structured summaries reduce drift compared with free-form summaries, but they still compress detail.
- **Extra compaction work:** Runtime LLM summarization can add latency and token cost. The fallback avoids the model call but is less precise.
- **Approximate accounting:** Token estimates are CJK-aware character estimates, not exact provider tokenizer counts.
- **Local retention:** Archives and sidecars keep local context data. `archiveDropped: false` disables dropped-message archives, but sidecar state remains part of restart recovery.
- **Trimmed evidence:** Old tool results can be shortened. The marker records original length and retained length so the model can see that evidence was truncated.
- **Paused compaction:** `compactStuck` prevents repeated failed compactions from burning turns. It also means the host may need to apply another pressure strategy if the prompt is still too large.

## Verification Commands

```bash
npm test
npm run lint
npm run build
git diff --check
```

After code changes in this repository, also run:

```bash
graphify update .
```
