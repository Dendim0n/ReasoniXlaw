# ReasoniXlaw Documentation Update Plan

**Goal:** Bring ReasoniXlaw project documentation in sync with the implemented context-engine optimizations and id rename.

**Scope:** Documentation only. No runtime behavior changes.

## Steps

- [x] Audit README.md, README_CN.md, docs/ARCHITECTURE.md, and docs/OPTIMIZATION_PLAN.md against the current diff.
- [x] Update public configuration examples to use plugin id `reasonixlaw` and context engine id `reasonixlaw-prefix-stable`.
- [x] Document the legacy config fallback for `deepseek-harness`.
- [x] Document token-aware tail selection, stuck guard, summary recompression, sidecar persistence, and old tool-result trimming.
- [x] Make docs discoverable from README.md and README_CN.md.
- [x] Run consistency search and project verification commands.

## Notes

- Manifest schema now lists every documented tuning key because `additionalProperties: false` rejects unknown config.
- `deepseek-harness` remains only as a legacy config fallback and legacy sidecar read fallback. New archive and sidecar writes use `reasonixlaw`.
- Verification run: `npm test`, `npm run lint`, `npm run build`, `git diff --check`, `graphify update .`, and sec-code submits for touched code/config files.
