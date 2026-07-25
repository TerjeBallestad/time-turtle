---
name: plan
description: Plan Time Turtle work from SDDs, PM items, concerns, gaps, or task descriptions into a PM-native plan. Single planning entry point. Classifies work per two-track, then picks a scaffold dial — D0 inline, D1 requirements+gates (default) — sized to blast radius.
disable-model-invocation: true
---

# Plan

Turn a source (SDD, SB, gap, concern, bounded description) into a PM-native plan. Planning only — never implement here. Fetch source via `pm get <ID>`; never edit `.pm/data/` directly.

**Source authority precedence:** current PM item body → linked current PM decisions/concerns/gaps/plans → `README.md`/repo docs → current code/tests → prior plans/artifacts → older notes. Older artifacts explain intent; they never overrule current scope.

## 0. Claim the source

`pm claim <ID> --as "plan: <short label>"` before reading anything else — see AGENTS.md for the claim rules (409 → stop; release when your phase ends). Planning is a long, quiet occupation of a ticket.

Plan-specific: the claim covers planning only, so **release when you file** (§3.8) — the ticket must be claimable by `/execute-plan` or `/fix` immediately after. Stopping at the Track F gate (§1) also releases; that branch files a gate ticket instead of a plan, and the source is then waiting on Terje, not on you.

## 1. Track gate first

Load the `two-track` skill and classify: can an agent tell whether this work succeeded?
- **Track F** (feel): do NOT plan deep. Output = a playable question + least build, never deeper than the next feedback session — filed as a `[grill]` or `[probe]` gate ticket (see §3.4), never as a plan. Stop here.
- **Mixed:** plan only the verifiable substrate; name the feel surface as playable questions.
- **Track V:** continue to the dial.

## 2. Pick the dial

| Dial | When | Machinery |
|---|---|---|
| **D0** | 1–2 tasks, settled design | No plan artifact — plan inline as PM comments on the source item |
| **D1** (default) | settled-enough design; fits one session or one serial `/execute-plan` run | This skill alone. No researcher fleets, no plan-reviewer fleets. |

**Escalation rule:** the moment D1 hits a real unknown — vague source, unclear mechanism, unproven user-visible beat — split the unknown out as a `[grill]`/`[research]` ticket or route the question to Terje. Never guess. (Lifelines' D2 diamond ceremony is not ported here; if a plan genuinely needs parallel-wave machinery, say so and ask.)

## 3. D1 protocol — requirements + gates

The point is the **app working**, not the plan artifact. The executor gets freedom and responsibility to make the feature actually work for the user.

1. **Read the code yourself.** Trace the paths the work touches (facts-before-writing). Verify the source's code assumptions; note discrepancies. Key seams: `shared/core.js` (data model + md format, used by BOTH sides), `server/src/index.js` (role rules), `client/src/app.js` (sync engine).
2. **Write requirements, not task+test pairs.** Each requirement is a *user outcome*: what the user visibly does/reads afterwards — "an employee opens Reports and sees hours but no money columns" — never "implement `stripRates()` and make test Y green."
3. **Chunk big.** Prefer few, large requirements — each as big as fits one executor context window.
4. **Bind every requirement to a judge.** Load the `judge-ladder` skill; per requirement write a judge stanza in `verification`:
   ```
   judge: build | unit | api | browser | terje
   command: <exact invocation, or playable-question for the terje rung>
   proves: <what this rung actually proves>
   fake_evidence: <what would look like proof but is not>
   ```
   Route to the cheapest judge that can actually validate. Anything the user sees needs a rung above `api`. Role/permission claims need an employee-session check.

   **Terje rungs never live as plan tasks.** Any `judge: terje` requirement is delivered as a **gate ticket** on the board: the last agent task preps the gate (build runnable, playable question written), then files it and stops —
   ```
   pm create issue "[grill] <the judgment question>"     # ruling/design-tension gates
   pm create issue "[probe] feel-gate: <the question>"   # usage-session/feel gates
   pm patch SB-NNN --related <PLAN-ID> --body "Question / Least build / how to start / answer feeds"
   ```
   Terje's answer lands as a PM comment on that ticket; follow-up work is its own ticket(s) with `blockedBy: [SB-NNN]`, never a resumed task inside this plan.
5. **Tests are the executor's instrument, not the deliverable.** The executor authors its own tests to get hands-on with the behavior; red-green and honest-tests rules apply, but a green test is never the success criterion — the judge stanza is. Refactoring belongs to the end-gate review, not the red-green loop.
6. **Prescription level.** Strong executor: destination + constraints + judges, near-zero steps (over-prescription reduces quality). If the work needs step scripts to be safe, the plan is too big — split it.
7. **Self-check before filing:**
   - *User-visible:* does the app get more real? Every visible beat has a requirement; evidence is not just tests/logs. If user-facing and all judges are `unit`/`api` → fix or justify.
   - *Mechanism fidelity:* the user approved the source's approach, not an alternative. Any deviation → `## Deviations` in `setupNotes` (MECHANISM_DEVIATION: what/source-says/plan-does/reason). Ambiguity → route to Terje, never resolve by guessing.
   - *Split smell:* a requirement mixing >1 ownership boundary (client/server/shared), migration+wiring, or broad verbs (integrate/migrate/wire/cleanup) hiding several seams — split it or justify.
   - *Role-safety:* anything touching rates, clients/projects writes, or entries ownership names its employee-session check explicitly.
8. **File** per `references/pm-plan-contract.md`. Essential requirements live ONLY in PM-supported fields (`setupNotes`, `relevantFiles`, `designDecisions`, task `description/steps/verification/blockedBy`) — executors cannot read anything else. File autonomously; ask only for NEEDS_DECISION-grade ambiguity, scope change without source support, or risk of clobbering others' PM records. Verify `blockedBy` resolved to TASK-NNN after create, then `pm release <source-ID>` (§0) so the ticket is claimable by whoever executes.

## 4. Non-goals

- No implementation. No full ceremony for tiny changes — and no D1 plan for a Track F question.
- Do not accept a plan merely because artifacts exist; post-run reconciliation lives in `/execute-plan`.
