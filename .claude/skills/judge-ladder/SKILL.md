---
name: judge-ladder
description: The Time Turtle quality-gauging toolset — the ladder of judges (build → unit → api → browser → terje) with exact invocations, what each rung proves and cannot prove, and evidence-honesty rules. Load whenever binding work to verification, writing a judge stanza in a plan, choosing how to prove a change, or claiming something is done.
---

# Judge Ladder

Route every piece of work to the **cheapest judge that can actually validate it** — and never claim a higher rung's verdict from a lower rung's evidence.

## The rungs

| Rung | Invocation | Proves | Cannot prove |
|---|---|---|---|
| **build** | `npm run build` (client bundles) · `node --check server/src/*.js shared/*.js` | it parses and bundles | any behavior |
| **unit** | `npm test` (vitest) — **suite not yet set up (see backlog)**; until it lands, targeted `node -e` scripts over `shared/core.js` | pure logic: time parsing, ISO weeks, billing rounding, markdown round-trip | anything HTTP or rendered |
| **api** | `curl` against `localhost:3001` with a cookie jar (login → act → assert JSON/status). Role checks are the canon: employee gets 403 on catalog writes, rates come back null | server behavior incl. auth, roles, persistence, mirror writes | anything the user sees |
| **browser** | claude-in-chrome on `localhost:5173` — click through the real flow, read console (`read_console_messages`), screenshot the result | it renders, the interaction completes, state survives reload | feel, ergonomics-in-daily-use |
| **terje** | a playable question: *Question / Least build / ≤5-min session / Answer feeds* | feel, keyboard ergonomics, legibility, pitch-readiness | — (the only Track F oracle) |

Both dev servers must be up for `api`/`browser` (`npm run dev`; API :3001, app :5173). The markdown round-trip is the house golden test: `serialize(parse(md)) === md` pins the data model through any refactor.

**Delivering the terje rung:** always as a **gate ticket** on the board — `pm create issue "[grill] …"` (ruling) or `"[probe] feel-gate: …"` (usage session), `--related` the plan/SDD it gates — never as a plan task waiting on him. His answer arrives as a PM comment on the ticket; downstream work is `blockedBy` that ticket.

## Evidence honesty

- **Gate triple-check:** the gate *ran*, the gate *can fail* (a gate that can't fail proves nothing), the gate *passed*. "Task done" ≠ "gate passed."
- **Verifier honesty:** never promise evidence the tooling can't produce. A green unit test cannot prove the user sees a thing; a screenshot cannot prove it feels right. Name the **fake evidence** per requirement — what would look like proof but isn't (a 200 response for a UI beat, a console.log for a user-facing change, a screenshot of the admin view for an employee-role claim).
- **Role claims need role evidence:** anything asserting "employees can't see/do X" is proven by an *employee-session* api or browser check, never by reading the code.
- **Feature reality:** a feature that exists only in code/tests is unfinished. User-facing work needs a rung above `api`.
- **Red-green:** every new test is verified red-green (break production, watch it fail, restore) and stamped (`## Verified red-green: YYYY-MM-DD`). Never weaken an assertion to pass — skip + file `pm issue`, leave the body intact.
- **Tests are instruments.** A test exists so the agent can get hands-on with the behavior; making it green is a means, never the goal.

## Screenshot conventions

Pixels are the most expensive evidence — spend them last and small:

- Assert on **API/JSON state first**; use pixels only for final visual verdicts.
- **Crop to the region under discussion** (zoom action) — never paste a full-viewport screenshot per tweak.
- **One screenshot per verdict round**, not per tweak.
- Verify at 100%: the design system is dense (10–13px type) — check nothing became unreadable.
- Known quirk: the pinned sidebar-bottom (sync status, user row) can fall outside screenshot capture; verify via `read_page`/JS `getBoundingClientRect` instead of concluding it's missing.
