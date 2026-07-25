# PM PLAN Contract

`/plan` outputs PM-native JSON (both D1 and D2). Do not invent a parallel schema and do not use harness sprint JSON as the planning artifact.

## D1 verification field: the judge stanza

In D1 plans, each task is a requirement (a user outcome) and `verification` carries a judge stanza per the `judge-ladder` skill:

```text
judge: compiler | gath | ui_driver | playtest | terje
command: <exact invocation, or playable-question for the terje rung>
proves: <what this rung actually proves>
fake_evidence: <what would look like proof but is not>
```

## Required shape

```json
{
  "title": "PLAN-NNN — Short title",
  "sddId": "SDD-NNN",
  "sprintId": "SPRINT-NNN",
  "linkedItems": ["SB-NNN", "SDD-NNN"],
  "context": {
    "setupNotes": "...",
    "relevantFiles": ["path/to/file.js"],
    "designDecisions": ["DD summary or source decision"]
  },
  "tasks": [
    {
      "title": "Task 1: Specific action-oriented title",
      "description": "What this task changes and why, including boundaries.",
      "steps": ["Concrete action", "Concrete action"],
      "verification": "Command-ready checks and expected evidence.",
      "blockedBy": []
    }
  ]
}
```

PM may add `id`, `passes`, `status`, and `progressNotes`. Do not depend on unsupported fields for essential requirements.

## Plan rules

- `title` names the production goal.
- `sddId` should be set when planning from an SDD.
- `sprintId` should be set when known.
- `linkedItems` should include source PM items that matter to execution.
- `context.setupNotes` carries design summary, SDD deviations, sprint grouping, evidence strategy, and global cautions.
- `context.relevantFiles` lists common files likely needed across tasks.
- `context.designDecisions` lists compact decisions, not long essays.

## Task rules

Each task must be executable by a cold agent reading `pm next-task PLAN-NNN`.

Required qualities:

- File paths are exact.
- Steps are actions, not goals.
- Verification is mechanical and command-ready.
- Same-file edits are serialized through `blockedBy`.
- Hidden state dependencies are explicit through `blockedBy` or `description`.
- New GATH tests include red-green verification requirements.
- Gameplay/presentation tasks name visual/manual/player-facing evidence or explicitly state why source authority defers it.
- Tasks stay small enough for spec and code review.

Bad task:

```json
{
  "title": "Improve matlevering",
  "steps": ["Refactor code", "Make it work"],
  "verification": "Check it works"
}
```

Good task:

```json
{
  "title": "Task 2: Move matlevering once-per-day state to TiltakRuntimeDirector ledger",
  "description": "Introduce the production owner for daily attempt state without moving doorbell/domain rules into the director. Delivery-specific behavior remains in the delivery handler; MatleveringSimTick may remain only as a compatibility facade while tests migrate.",
  "steps": [
    "Add a focused GATH test proving two matlevering ticks on the same day produce only one delivery attempt through the new ledger owner.",
    "Run the focused test and confirm it fails against the current MatleveringSimTick-owned state.",
    "Add the minimal TiltakRuntimeDirector ledger shape needed for matlevering daily attempt tracking.",
    "Route the matlevering attempt through the ledger without moving doorbell rules into TiltakRuntimeDirector.",
    "Run the focused test and confirm it passes.",
    "Temporarily break the ledger duplicate guard, confirm the test fails, restore, and add red-green note."
  ],
  "verification": "./tests/run_tests.sh -- --filter matlevering; then full ./tests/run_tests.sh. New focused test has red-green verification note.",
  "blockedBy": ["Task 1"]
}
```

`blockedBy` note: the `"Task N"` ordinal form is acceptable in the draft — current pm resolves ordinals to real `TASK-NNN` ids at `pm plan create`. Always verify after filing (`pm plan PLAN-NNN` must show `TASK-NNN` ids); older pm versions left ordinals unresolved, which silently stranded every dependent task.

## SDD deviations

If the plan intentionally diverges from the SDD mechanism, write it in `context.setupNotes`:

```markdown
## SDD Deviations

1. **MECHANISM_DEVIATION:** <what changed>
   - SDD says: ...
   - Plan does: ...
   - Reason: ...
   - Requires human decision: yes/no
```

A task merely existing is not enough. The plan must cover the requirement using the approved mechanism or surface the deviation.

## Sprint/evidence grouping inside PM fields

PM does not currently have native sprint/evidence subfields. Put grouping in `context.setupNotes` and task descriptions.

Example:

```markdown
## Implementation Slices

### Slice 1 — Contract tests
Evidence: focused GATH tests with red-green.
Tasks: 1–3.

### Slice 2 — Runtime seam hardening
Evidence: focused tests + ownership review.
Tasks: 4–6.
```

Do not put essential requirements only into comments or unsupported JSON keys that RALPH will ignore.
