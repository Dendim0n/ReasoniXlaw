# Runtime Context and Cache Telemetry Plan

**Goal:** Keep ReasoniXlaw session prefixes stable while handling OpenClaw runtime context correctly and reporting real prompt-cache telemetry.

## Scope

- Treat `openclaw.runtime-context` custom messages as current-turn ephemeral context.
- Keep runtime custom messages out of locked prefix, persistent tail, compaction summaries, and sidecar state.
- Reinsert current-turn runtime custom messages into the assembled prompt before the active user message.
- Record runtime `promptCache` telemetry exposed through ContextEngine `afterTurn`.
- Detect same-session locked prefix divergence and re-lock the projection when the incoming transcript prefix changes.

## Steps

- [x] Add tests for runtime custom message filtering and current-turn reinsertion.
- [x] Add tests for prompt-cache telemetry being exposed by `getCacheStats()`.
- [x] Add tests for prefix divergence resetting the locked projection.
- [x] Implement custom-message content extraction and token estimation.
- [x] Implement runtime custom message splitting and reinsertion.
- [x] Implement prompt-cache telemetry state and sidecar persistence.
- [x] Implement prefix fingerprinting and reset stats.
- [x] Update project docs.
- [x] Run verification, graphify update, sec-code, and commit.

## Verification Notes

- RED: targeted tests failed before implementation for persisted runtime context, accumulated runtime context, missing `afterTurn()`, and stale locked prefix.
- GREEN: `npm test -- -t "runtime context custom|afterTurn records|prefix divergence"` passes after implementation.
- Full verification: `npm test`, `npm run lint`, `npm run build`, and `git diff --check` pass.
- Repository maintenance: `graphify update .` passes in `/Users/dxm/Documents/openclaw/ReasoniXlaw`; sec-code reports `NONE` for modified code and test files.
