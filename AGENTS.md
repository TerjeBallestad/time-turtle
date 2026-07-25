# Working in this repo

## PM is the store

All work state lives on the PM board (`pm` CLI, dashboard on localhost:3335) — issues, designs, plans, decisions. Never edit `.pm/data/` directly, and never keep a shadow markdown copy of something PM already holds.

## Claim before you occupy a ticket

Several sessions share this checkout at once. Any command that occupies a ticket for more than a couple of minutes — planning it, fixing it, resolving it, executing against it — claims it first:

```
pm claim <ID> --as "<command>: <short label>"
```

- **409 means another session holds it. Stop.** Do not do the work anyway; two sessions against one ticket is worse than none. Report who holds it, then pick different work or ask.
- **Release the moment your phase ends** — `pm release <ID>` — so the next phase can claim it. A plan releases when it files, not when it stops thinking; an abandoned attempt releases immediately. Closing a ticket releases automatically.
- An unreleased claim reads as work-in-progress that nobody is doing. Claims self-expire after 4h, but don't rely on that.
- Nothing to claim (a bare description with no PM item) → skip it.

Refer to tickets by name, never bare ID, so a reader knows what you're talking about without a lookup.

## Git

Agents share this checkout, so **commit straight to `main`** — branching yanks every other session onto your branch. If you need real isolation, use a worktree (`.claude/worktrees/`).

## Verification

Claims about work being done are bound to evidence, not vibes. Load the `judge-ladder` skill before asserting something works; load `two-track` before planning or building anything, to decide whether the work is agent-verifiable at all.
