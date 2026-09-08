<!-- assess:run_id=20260908145107-5ed23362 artifact_schema_version=1.0.0 -->
# Hotspot: `src/room.ts`

_First flagged: 2026-09-08. Last seen: 2026-09-08. Status: persistent._

## Current metrics

| Metric | Value |
|--------|-------|
| LOC | 248 |
| Cyclomatic complexity (file max) | 86.0 |
| Commits in churn window | 1 |
| Has test file | yes |

## History across runs

| Run date | LOC | CCN | Commits | Status |
|----------|-----|-----|---------|--------|
| 2026-09-08 | 248 | 86.0 | 1 | persistent |

## Briefing for editing this file

Use this briefing when about to modify `src/room.ts`:

Hotspot (persistent). 248 LOC, max cyclomatic complexity 86.0, 1 commits in churn window. (Briefing refined by LLM via assess_finalize - see Suggested actions below.)

## Suggested actions

- Add an in-process test of the socket paths with a stub socket.io server (join, SCENE_INIT reply to new-user, SCENE_UPDATE merge) so the 38% coverage rises past the parse/status paths
- Annotate-first: a header comment naming the three concerns (socket, merge, persist) rather than a split; every function is under ccn 15

