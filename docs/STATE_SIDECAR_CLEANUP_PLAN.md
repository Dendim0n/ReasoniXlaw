# State Sidecar Cleanup Plan

**Goal:** Treat ReasoniXlaw sidecars as rebuildable per-session cache and remove stale sidecars when a new session starts.

## Scope

- Keep the current session's sidecar readable for resume/restart within that session.
- When bootstrap cannot restore the requested session, treat it as a new session and clean older sidecars in the same session directory.
- Clean both `.reasonixlaw-state.json` and legacy `.deepseek-harness-state.json` sidecars.
- Clear old in-memory session projections when starting a new session.
- Do not delete the current session's sidecar paths.

## Steps

- [x] Add failing tests for stale sidecar cleanup on new session bootstrap.
- [x] Add failing tests for stale in-memory projection cleanup.
- [x] Implement sidecar path scanning and deletion.
- [x] Wire cleanup only to new-session bootstrap, after restore attempts fail.
- [x] Update README and architecture docs.
- [x] Run verification, graphify update, sec-code, and commit.

## Verification Notes

- RED: `npm test -- -t "new session bootstrap removes stale sidecars|new session bootstrap drops stale in-memory"` failed because stale sidecars still existed and old in-memory projections restored.
- GREEN: the same targeted command passes after implementation.
- Full verification: `npm test`, `npm run lint`, `npm run build`, and `git diff --check` pass.
- Repository maintenance: `graphify update .` passes; sec-code reports `NONE` for modified code and test files.
