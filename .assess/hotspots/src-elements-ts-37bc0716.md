<!-- assess:run_id=20260908145107-5ed23362 artifact_schema_version=1.0.0 -->
# Hotspot: `src/elements.ts`

_First flagged: 2026-09-08. Last seen: 2026-09-08. Status: persistent._

## Current metrics

| Metric | Value |
|--------|-------|
| LOC | 408 |
| Cyclomatic complexity (file max) | 141.0 |
| Commits in churn window | 1 |
| Has test file | yes |

## History across runs

| Run date | LOC | CCN | Commits | Status |
|----------|-----|-----|---------|--------|
| 2026-09-08 | 408 | 141.0 | 1 | persistent |

## Briefing for editing this file

Use this briefing when about to modify `src/elements.ts`:

Hotspot (persistent). 408 LOC, max cyclomatic complexity 141.0, 1 commits in churn window. (Briefing refined by LLM via assess_finalize - see Suggested actions below.)

## Suggested actions

- Strengthen assertions in src/elements.test.ts at the stryker survivors: arrow edge-point maths (lines 257, 299-305, 337-338) and the summariser (436-454); characterization-style, exact coordinates and strings
- Target: npm run mutate reports elements.ts mutation score >= 80% (from 55.6%)
- Only then consider splitting buildElements (fn ccn 67) per spec type behind the new tests

