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
| **unit** | `npm test` (vitest, `tests/`) — the always-green gate; **372 tests on `main` @ `c6dfefa`**. State the baseline count you started from, and never let it drop | pure logic: time parsing, ISO weeks, billing rounding, markdown round-trip, the vault block codec | anything HTTP or rendered |
| **api** | `curl` against `localhost:3001` with a cookie jar (login → act → assert JSON/status). Role checks are the canon: employee gets 403 on catalog writes, rates come back null | server behavior incl. auth, roles, persistence, mirror writes | anything the user sees |
| **browser** | **two instruments, one rung** (DD-013, amended 2026-07-27) — `npm run test:browser` (playwright, chromium, headless, against the real built client the API server already serves) · `cmux browser` on a surface **you** opened at `localhost:5173` — click through the real flow, read console (`cmux browser <s> console list`), screenshot the result | it renders, the interaction completes, state survives reload — and, for a committed Playwright flow, keeps doing so | feel, ergonomics-in-daily-use |
| **terje** | a playable question: *Question / Least build / ≤5-min session / Answer feeds* | feel, keyboard ergonomics, legibility, pitch-readiness | — (the only Track F oracle) |

**Choosing the browser instrument.** **cmux for _does this read right_** — a visual verdict on a real session, where the answer is a human-readable observation and a cropped screenshot (SB-085's mirror-blocked row is the example). **Playwright for _does this still work_** — repeatable, parallel-safe, headless, and, unlike an observation, it can go **red later**. If the check has a definite pass/fail the machine can state, commit it to `test:browser`; if the check is "look at it and tell me", that is cmux, and its output is evidence in a report, not a gate.

**Driving cmux — the rules that stop it disturbing a shared machine.** Terje does not use Chrome, so the visual instrument is a browser surface in the cmux workspace he already has open; nothing has to be kept alive for an agent's benefit.

```bash
cmux tree --all                                   # find the pane the app surfaces live in FIRST
cmux browser open http://localhost:5173/ --focus false
cmux move-surface --surface <new> --pane <pane> --after <sibling>   # `open` lands in the CALLER's pane
cmux browser <s> eval '<js>'                      # click/read; prefer textContent over painted text
cmux browser <s> get styles <sel> --property <p>  # measure, don't eyeball
cmux browser <s> viewport 390 844                 # exact-pixel responsive check
cmux browser <s> screenshot --out <path>
cmux close-surface --surface <s>                  # always, when the verdict is recorded
```

- **Only ever drive a surface you opened.** Terje's surfaces are his live screen; navigating one mid-session is the browser equivalent of `pkill -f`.
- `wait --text` matches **painted** text, so it misses CSS-uppercased labels — wait on a selector, or `eval` against `textContent`.
- **WKWebView, not Chromium.** `network route|requests`, `trace`, `screencast`, `offline`, `geolocation` all return `not_supported`. Anything needing a mocked API response is Playwright's, not cmux's — and cmux is never a Chrome-fidelity check.

Playwright lives in `tests-browser/`, **never** in `npm test` — that gate stays fast and always green. Commit only what is structurally invisible below the browser: commit-boundary and mirror-bytes shaped flows, and controls that can lie about their own state (a rejected rename that leaves the refused value on screen). A browser test that only asserts JSON is an api test wearing a DOM — move it to `tests/api.test.js`.

**Neither instrument replaces the `terje` rung.** Playwright can prove the mirror reads `ballestad-studios`; it cannot prove the settings table feels right. Track F still has exactly one oracle.

`api` and the cmux instrument need both dev servers up (`npm run dev`; API :3001, app :5173). `npm run test:browser` needs neither — it builds the client and serves it from a throwaway API server on a free port. The markdown round-trip is the house golden test: `serialize(parse(md)) === md` pins the data model through any refactor.

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
- Known quirk: the pinned sidebar-bottom (sync status, user row) can fall outside screenshot capture; verify via `cmux browser <s> get box <sel>` (or `eval` + `getBoundingClientRect`) instead of concluding it's missing.
