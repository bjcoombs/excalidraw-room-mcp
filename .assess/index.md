<!-- assess:run_id=20260908145107-5ed23362 artifact_schema_version=1.0.0 -->
# Assess Wiki Index

_Last updated: 2026-09-08_

Catalog of every hotspot ever flagged by `/assess` in this repo. Status reflects the most recent run.

| File | First Flagged | Last Seen | Status | Latest CCN | Latest LOC |
|------|---------------|-----------|--------|------------|------------|
| `src/elements.ts` | 2026-09-08 | 2026-09-08 | persistent | 141.0 | 408 |
| `src/room.ts` | 2026-09-08 | 2026-09-08 | persistent | 86.0 | 248 |
| `src/index.ts` | 2026-09-08 | 2026-09-08 | persistent | 21.0 | 218 |
| `src/elements.test.ts` | 2026-09-08 | 2026-09-08 | persistent | 33.0 | 120 |
| `src/reconcile.ts` | 2026-09-08 | 2026-09-08 | persistent | 17.0 | 55 |
| `src/firebase.ts` | 2026-09-08 | 2026-09-08 | persistent | 10.0 | 74 |
| `src/e2e.ts` | 2026-09-08 | 2026-09-08 | persistent | 9.0 | 60 |
| `src/firebase.test.ts` | 2026-09-08 | 2026-09-08 | new | 17.0 | 83 |
| `src/crypto.ts` | 2026-09-08 | 2026-09-08 | persistent | 8.0 | 57 |
| `src/reconcile.test.ts` | 2026-09-08 | 2026-09-08 | persistent | 8.0 | 34 |
| `src/crypto.test.ts` | 2026-09-08 | 2026-09-08 | graduated | - | - |

## Legend

- **active** - in the latest top hotspots list
- **new** - newly entered the hotspot list this run
- **graduated** - was a hotspot, no longer is (good)
- **regressed** - still a hotspot, and getting worse
- **persistent** - still a hotspot, roughly unchanged

## How this gets updated

Each `/assess` run reads this file, the prior `complexity-stats.json`, and the latest run output, then rewrites this index. Per-file detail lives in `hotspots/<slug>.md`. Run history lives in `log.md`.
