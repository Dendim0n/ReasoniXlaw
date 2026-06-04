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
| Sidecar state | Implemented | Layer state persists to `<sessionFile>.reasonixlaw-state.json`; legacy `<sessionFile>.deepseek-harness-state.json` files still restore |
| Sidecar cleanup | Implemented | New-session bootstrap clears stale in-memory projections and old sidecars known to the engine or in the current session directory |
| Tool-result trimming | Implemented | Older tool results are trimmed with an explicit length marker |
| Runtime context isolation | Implemented | `openclaw.runtime-context` custom messages are current-turn only and excluded from sidecar state |
| Prompt-cache telemetry | Implemented | `afterTurn()` records the latest PI `promptCache` payload and break codes in `getCacheStats()` |
| Prefix versioning | Implemented | Incoming same-session prefix divergence resets and re-locks the visible projection |
| Tests | Implemented | `tests/context-engine.test.ts` covers the behaviors above and manifest fields |

The `deepseek-harness` name remains only as a legacy config fallback and legacy sidecar read fallback. New local artifacts use the `reasonixlaw` project id.

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
- Load the new ReasoniXlaw sidecar during bootstrap before treating the session as new, with a fallback read from the old `deepseek-harness` sidecar suffix.
- When bootstrap starts a new projection, clear stale in-memory session states and delete old sidecars that are known to the current process or live in the new session file's directory.

## 7. Safer Tool Output Handling

**Principle:** Truncating tool output saves tokens but can remove the evidence needed to continue a task.

**Technical measures:**

- Add configurable `toolResultTrimChars`.
- Add a metadata-style marker that records original length and retained prefix length.
- Only trim older tail messages outside the recent kept window.
- Preserve tool result identity fields and text content shape.

## 8. Runtime Context Isolation

**Principle:** Dynamic host context should help the current turn without becoming part of the locked cache prefix.

**Technical measures:**

- Detect OpenClaw custom runtime context messages with `role: "custom"` and `customType: "openclaw.runtime-context"`.
- Filter those messages out before prefix/tail diffing, compaction summaries, and sidecar persistence.
- Reinsert only the current runtime custom messages immediately before the active user message in the assembled prompt.
- Extend text extraction and token estimation to understand custom text content when those messages are present in the current assembled prompt.

## 9. Real Prompt-Cache Telemetry

**Principle:** Local token ratios are useful estimates, but cache hit/miss truth comes from PI/provider telemetry.

**Technical measures:**

- Add `afterTurn()` handling for `ContextEngineRuntimeContext.promptCache`.
- Persist the latest prompt-cache payload in in-memory state and the session sidecar.
- Expose `promptCache` and flattened `promptCacheBreakCodes` via `getCacheStats()`.
- Keep `cacheHitEstimate` as a local layer-shape estimate, not a replacement for provider telemetry.

## 10. Same-Session Prefix Versioning

**Principle:** Per-session prefix stability should not pretend a cache hit is possible after the visible prefix changes.

**Technical measures:**

- Fingerprint the locked ContextEngine-visible prefix using stable message fields: role, content, tool identity, and custom type.
- Compare the incoming stable transcript prefix on each `assemble()` call.
- When the incoming prefix diverges, clear the old projection, reset compaction state, lock the new prefix, and increment reset stats.
- Preserve the new prefix for subsequent turns instead of chasing cross-session stability.

## 11. Documentation and Tests

**Principle:** The plugin should explain the cache/accuracy tradeoff and make the intended behavior executable.

**Technical measures:**

- Add tests for token-aware tail selection, stuck guard, summary recompaction, sidecar persistence, runtime context isolation, prompt-cache telemetry, prefix reset, and manifest kind.
- Update README and architecture docs with the new tradeoffs and tuning knobs.

## Operational Costs and Failure Modes

- **Sticky prefix:** The first `prefixLockCount` messages are intentionally preserved. This is good for cache hits, but bad early context stays until the session is reset.
- **Lossy middle:** Structured summaries reduce drift compared with free-form summaries, but they still compress detail.
- **Extra compaction work:** Runtime LLM summarization can add latency and token cost. The fallback avoids the model call but is less precise.
- **Approximate accounting:** Token estimates are CJK-aware character estimates, not exact provider tokenizer counts.
- **Local retention:** Archives and sidecars keep local context data. `archiveDropped: false` disables dropped-message archives, but sidecar state remains part of restart recovery.
- **Bounded sidecar cache:** Sidecars are rebuildable from OpenClaw's full session transcript. New-session bootstrap clears old sidecars it can identify safely, but the plugin does not scan arbitrary filesystem locations without a session path.
- **Trimmed evidence:** Old tool results can be shortened. The marker records original length and retained length so the model can see that evidence was truncated.
- **Paused compaction:** `compactStuck` prevents repeated failed compactions from burning turns. It also means the host may need to apply another pressure strategy if the prompt is still too large.
- **Runtime envelope boundary:** Hidden system prompt, tool schemas, and PI runtime envelope are controlled by OpenClaw/PI. ReasoniXlaw optimizes the same-session message projection it receives.
- **Prefix reset miss:** When the visible prefix changes inside a session, the plugin resets and re-locks. That is expected to cost one cache miss, then stabilize.

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
