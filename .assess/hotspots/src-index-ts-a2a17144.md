<!-- assess:run_id=20260908145107-5ed23362 artifact_schema_version=1.0.0 -->
# Hotspot: `src/index.ts`

_First flagged: 2026-09-08. Last seen: 2026-09-08. Status: persistent._

## Current metrics

| Metric | Value |
|--------|-------|
| LOC | 218 |
| Cyclomatic complexity (file max) | 21.0 |
| Commits in churn window | 1 |
| Has test file | no |

## History across runs

| Run date | LOC | CCN | Commits | Status |
|----------|-----|-----|---------|--------|
| 2026-09-08 | 218 | 21.0 | 1 | persistent |

## Briefing for editing this file

Use this briefing when about to modify `src/index.ts`:

Hotspot (persistent). 218 LOC, max cyclomatic complexity 21.0, 1 commits in churn window. (Briefing refined by LLM via assess_finalize - see Suggested actions below.)

## Suggested actions

- Spawn dist/index.js over stdio with the MCP SDK client in a test and assert room_status / read_scene before joining return the 'not in a room' text
- Add the ESLint no-console rule (allow error) so stdout stays protocol-only

