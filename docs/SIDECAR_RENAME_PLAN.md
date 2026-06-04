# ReasoniXlaw Sidecar Rename Plan

**Goal:** Rename new local state artifacts from `deepseek-harness` to `reasonixlaw` while keeping old sidecar files readable.

## Steps

- [x] Add tests that require new sidecar writes to use `<sessionFile>.reasonixlaw-state.json`.
- [x] Add tests that require legacy `<sessionFile>.deepseek-harness-state.json` files to restore existing state.
- [x] Change runtime constants so new sidecars and archive files use `reasonixlaw`.
- [x] Keep a legacy sidecar read fallback for existing sessions.
- [x] Update README, README_CN, architecture docs, and optimization notes.
- [x] Run verification, graphify update, sec-code, and commit with a Chinese message.

## Verification

- RED: `npm test -- -t "sidecar"` failed before implementation because `.reasonixlaw-state.json` was missing.
- GREEN: `npm test -- -t "sidecar"` passed after implementation.
- Full check: `npm test`, `npm run lint`, `npm run build`, `git diff --check`, `graphify update .`, and sec-code submit.
