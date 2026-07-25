---
description: Execute a PM plan. Serial single-session — one mind implements every task in order, commits per task, stops at human gates.
argument-hint: "[PLAN-NNN]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Agent
---

# Execute Plan

`$ARGUMENTS` — PLAN-NNN (required). If empty, list plans with pending tasks (`pm plans`) and ask.

**SERIAL only.** YOU implement every task yourself, in dependency order, in this one session. One mind = accumulated taste: the decision you make in task 3 carries to task 15. (Parallel-wave execution is deliberately not ported from Lifelines; if a plan is mechanical bulk that begs for it, say so and ask.)

## Stage

1. `pm health` — unreachable → tell user to run `pm serve`, stop.
2. `pm get PLAN-NNN` — read title, context/setupNotes IN FULL (they carry load-bearing constraints), and all tasks with `status`/`blockedBy`/`progressNotes`.
3. `git status` — require a clean tree. Dirty → stop and ask.
4. **Compute the serial order** from `blockedBy` (topological; done tasks are satisfied dependencies — naturally resumable mid-plan).
5. **Mark the human gates:** any task whose description says HUMAN / feel-gate / Terje verdict. These SEGMENT the run — implement up to a gate, prepare it, then STOP the whole run and report. Never implement past an unpassed human gate, never self-certify one.
6. Print the run plan: ordered task list, human gates marked as hard stops.

## Per task — implement

Tasks are D1 requirements (user outcome + judge stanza): you own the how — the requirement names WHAT must become real and which judge proves it. Load the `judge-ladder` skill. The point is the app working, never the test being green — the judge stanza (`proves` / `fake_evidence`) is the success criterion.

House rules:

- **Re-read hot files fresh** before editing — line anchors drift as earlier tasks land.
- **Visual self-verification is mandatory** for anything user-visible: open it on localhost:5173, look at it, screenshot the verdict. Match the design system's established grammar (dense, mono metadata, 1px borders) — do not invent a new style per view. Role-touching work gets an employee-session check.
- **Tests:** new tests get red-green verification + `## Verified red-green: <date>` stamp. Never weaken an assertion; skip + `pm create issue` instead.
- **Suite green before every commit** (`npm test` once it exists; `npm run build` always).
- **Atomic commit per task**, explicit paths.
- **`pm task-done PLAN-NNN TASK-NNN "<note>"`** after each commit — the note is the handoff for a resumed session.
- **Deviations:** small + faithful to intent → do it, record in the note. Changes design intent → STOP and surface; do not guess.

## At a human gate

1. Finish everything the gate blocks on; verify the gate's prep (app runs, playable question written).
2. Write the gate a briefing in its progress note: how to start it, the concrete usage-questions.
3. STOP the run. Report: tasks done (commits), the gate that's waiting, how Terje starts it.

## Close out

1. **End-gate review** (maker≠checker — this is where refactoring belongs, NOT the red-green loop). For any non-trivial plan, spawn two parallel review sub-agents over the full run diff; don't merge findings across axes:
   - **Spec axis:** does the diff deliver each requirement via the approved mechanism? Judge stanzas honest (ran / can fail / passed)? Any silent MECHANISM_DEVIATION?
   - **Standards axis:** repo conventions (shared/core.js owns the data model; role checks server-side; md round-trip preserved) plus the Fowler smell baseline. Named smells are judgment calls, not verdicts.
   Apply the fixes that survive triage; commit as its own review commit.
2. **Post-run reconciliation:** build green · tree clean · every gate actually ran and can fail · user-visible requirements have above-`api` evidence rendered and LOOKED AT · role claims have employee-session evidence.
3. All tasks done → `pm patch PLAN-NNN --stage done`.
4. Final report: tasks with commits, review findings applied/skipped, verification evidence, issues/gaps filed, deviations, anything awaiting human review.
5. Partial run → report exactly where you stopped and why; PM state carries the resume point.

## Ground rules

- Never `git reset --hard` / revert commits; a bad commit gets a forward fix or a stop.
- Escalations you can't resolve from the plan/SDD are the user's: stop and ask rather than guessing design intent.
- Never edit `.pm/data/` directly.
