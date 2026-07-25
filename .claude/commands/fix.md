---
description: Fix a backlog issue or work on a plan task. Accepts SB-NNN, PLAN-NNN, or TASK-NNN.
argument-hint: "[SB-NNN | PLAN-NNN | TASK-NNN]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# Fix

Implement one backlog issue or one plan task. The PM dashboard is the source of truth — if `pm health` fails, tell the user to run `pm serve` and stop.

`$ARGUMENTS` — optional issue/plan/task ID. Default: highest-priority open issue.

## Step 1: Select work

| Input | Behavior |
|-------|----------|
| (empty) | `pm list issue --stage inbox` — pick highest priority (critical > robustness > feature > polish). None → print "Backlog clear" and stop. |
| `SB-NNN` | `pm get SB-NNN` |
| `PLAN-NNN` | `pm next-task PLAN-NNN` — pick a `pending` + `unblocked` task. Read completed tasks' progress notes first. |
| `TASK-NNN` | Find the owning plan via `pm plans`, then use that task's spec. |

Print which item you're working on before proceeding.

## Step 2: Understand

The issue body carries symptom, suggested fix, affected files, verification steps. Read every referenced file before changing anything. The spec is guidance, not gospel — the code is the source of truth. Note discrepancies in the commit message.

## Step 3: Implement

Surgical edits, minimal scope. No refactoring of surrounding code, no improvements beyond the item. Touching files the spec didn't list is fine — note it.

## Step 4: Verify

Load the `judge-ladder` skill and run the cheapest rung that actually validates the change:

1. **build**: `npm run build` + `node --check` on touched server/shared files.
2. **unit**: `npm test` once the vitest suite exists; until then targeted `node -e` scripts over `shared/core.js`. New tests get red-green verification (break production, watch it fail, restore, stamp `## Verified red-green: YYYY-MM-DD`). Never weaken an assertion — skip + `pm issue` instead.
3. **api**: both dev servers up (`npm run dev`), curl with a cookie jar. Role-touching changes REQUIRE an employee-session check (403s, null rates), not just an admin one.
4. **browser**: user-visible changes get clicked through on localhost:5173 and screenshotted (crop to the region).

**Iteration cap: 3 fix-verify cycles.** Still failing → do not claim fixed; flag it (Step 6).

## Step 5: Commit

Atomic, explicit paths, never amend. `fix: SB-NNN — <short description>` / `feat: TASK-NNN — <short description>`. Include test changes in the same commit.

## Step 6: Close out

- **Fixed:** `pm patch SB-NNN --stage done`, then `pm comment SB-NNN "<what changed, commit hash, verification evidence>"`
- **Flagged:** leave stage unchanged, `pm comment SB-NNN "FLAGGED: <what was tried, what verification showed>"`. Say so in your summary.
- **Plan task:** `pm task-done PLAN-NNN TASK-NNN "<what you did, files changed, key decisions>"`

## Side findings

Out-of-scope bug → `pm create issue`. Design tension → `pm create concern`. File and move on — never let them block the fix.

## Step 7: Report

Item ID + title, status, files changed, tests added, commit hash, verification evidence. If flagged, what human review should look at.
