---
name: brainstorming
description: Explore ideas and turn them into SDDs filed in the PM dashboard. Use this skill BEFORE any creative or feature work — designing new features, rethinking systems, adding functionality, or modifying behavior. Triggers for any "build X", "add Y", "redesign Z", "what if we...", or exploratory conversation about the app. Also use when the user says "brainstorm", "design", "explore", or "let's think about". This skill OVERRIDES any generic brainstorming skill for this project.
---

# Brainstorming Into SDDs

Turn ideas into validated designs filed as SDDs in the PM dashboard (localhost:3335). Designs live as SDDs in the dashboard, not as markdown files in `docs/` — this skill ensures brainstorming flows into that system instead of creating orphaned documents.

## Project Context

When the conversation references a PM project (SPRINT-NNN) or starts from a project dossier:

1. **Fetch project detail**: `pm project SPRINT-NNN` — items, designs, plans.
2. **Scope the brainstorm to that project's destination.** Attach `sprintId` when filing the SDD and any new items.

Otherwise fall through to the general process below.

## Process

### Quick-take mode (skip the interrogation)

Sometimes the user wants a fast opinion, not an SDD — "quick take", "gut check", "what do you think", or a narrow architectural question. Do NOT run Phase 1. Read the relevant code, give your recommendation with reasoning in a few sentences, and stop. Offer the full brainstorm only if they want depth. Forcing the full interrogation onto a quick question is a known way to make the user bail.

### Phase 1: Interrogate the Idea

The goal is **genuine shared understanding** — the agent's mental model of the solution matches the user's. Discrepancies caught here save days of wasted implementation.

#### Preparation (before asking anything) — MANDATORY

Most questions you're tempted to ask are **already answered somewhere**. Before the first question, mine all three sources:

1. **The code** — read the files this idea touches and recent commits (`git log`). Key seams: `shared/core.js` (data model + markdown format), `server/src/index.js` (roles/API), `client/src/app.js` (sync). If a question can be answered by reading code, read the code instead.
2. **The PM dashboard** — `pm list project`, `pm list`, `pm get <ID>`. The source of truth for what's already decided and in-flight; avoid duplicating it.
3. **Claude memories** — recalled memories already in context (stack decisions, company-pitch intent, past feedback). Check before asking about design intent or prior choices.

After mining, **answer every question you CAN yourself** — surface it out loud when it challenges an assumption. What remains — a genuine preference, a judgment call, a decision only the user can make — is what you ask.

#### The Interrogation

Walk down the **design tree** — resolve one decision branch fully before opening the next.

- **One question at a time.** Multiple choice ONLY when the design space is genuinely enumerable AND the frame is already agreed. Premise ("why does this belong in the app?"), feel, and workflow-shape questions go as plain prose — they have no clean option set.
- **Summary and context go in their OWN message, before any AskUserQuestion call** — text in the same turn as the tool doesn't render.
- **A rejected question batch means the frame is wrong, not the wording.** Drop to open dialogue on the user's terms; never reformulate a second batch.
- **Ask as few questions as possible — there is NO minimum.** A question earns its place only when (a) the answer isn't in code/PM/memories AND (b) it's a decision only the user can make. Facts are lookups, not questions.
- **Don't accept surface answers.** "It should work like the pm cli" → *What specifically? Which parts? What would you change?*
- **Follow up before moving on.**

What to question: the problem itself · assumptions · prior art (in this repo and in tools Terje already uses — Obsidian, pm cli, Toggl-alikes) · constraints (two deployment shapes: personal localhost vs company server — designs must say which they serve) · success criteria · edge cases · the uncomfortable questions ("what's the 10x simpler version?").

#### Codebase-Informed Challenges

- **"You said X, but the code does Y"** — flag mismatches immediately.
- **"This would also affect Z"** — surface ripple effects as questions (the md round-trip format and the role model are the two easiest things to silently break).
- **"The current pattern is P — follow it or diverge?"** — make divergence a conscious choice.

#### Contradiction Surfacing

When a new answer conflicts with an earlier one, stop and resolve it. Contradictions left unresolved become bugs.

#### Exit Criteria

Ready for Phase 2 when: you can articulate the vision back and the user agrees · boundaries are known · riskiest technical decisions discussed · no new major question in the last 2–3 exchanges. Summarize in 3–5 sentences and ask: "Is this right, or am I missing something?"

### Phase 2: Explore Approaches

1. **Propose 2–3 approaches** with trade-offs. Lead with your recommendation and why.
2. **Check against locked decisions** — `pm list --type DD` (and the role-model/storage decisions in memory/README).
3. **Get the user's pick** before detailed design.

### Phase 3: Design

Present incrementally, scaled to complexity: architecture/API changes · data model + markdown-format impact · role-model impact (what does an employee see?) · UI changes · testing approach (judge stanzas per `judge-ladder`) · edge cases. Ask for confirmation per section. YAGNI ruthlessly.

Note in the SDD which parts are Track V vs Track F (load `two-track` if unsure) — it saves the planner a classification pass.

### Phase 4: File the SDD

```bash
pm design create "<descriptive title>" \
  --body "<the full design in markdown>" \
  --items SB-NNN \
  --sprint SPRINT-NNN
```

Link existing issues/gaps (`--items`, check the dashboard first); file new issues/gaps the design surfaced. Print the SDD ID and a summary.

### Phase 5: Transition

> "SDD filed as SDD-NNN. Want me to break this into an implementation plan now, or save that for later?"

If yes, invoke `/plan` with the SDD ID (it runs the two-track gate and picks the dial). If no, stop.

## Principles

- One question at a time · depth before breadth · the code is evidence · contradictions are gifts · YAGNI
- **Dashboard is truth** — everything through localhost:3335, not markdown files
- Check before creating (duplicates) · design decisions are law · open questions by default
- Rejection = reframe, not rephrase
