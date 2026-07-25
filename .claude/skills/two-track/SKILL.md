---
name: two-track
description: The two-track classification (V/F) — decide whether work is agent-verifiable (Track V) or feel-judged (Track F) before planning or building anything. Load at the start of any planning, brainstorming, or build-routing step.
---

# Two-Track Gate

**Agents can verify; only use can validate.** Route every piece of work to the cheapest judge that can actually validate it, and never let a plan outrun its judge.

## The classification question

> Can an agent tell whether this work succeeded?

- **Yes → Track V (verifiable):** API endpoints, role enforcement, data model, markdown round-trip, migrations, refactors, build tooling, bug fixes with reproducible symptoms. Plan normally (`/plan` dial), judges from the `judge-ladder`.
- **No — the criterion is feel → Track F (feelable):** keyboard-flow ergonomics (the grid IS the product), information density, visual design, what belongs in the employee vs admin view, anything about whether the app is pleasant to log hours in daily, pitch-readiness.
- **Mixed (most feature work): split it.** The substrate is V; the feel is F. Plan only the substrate; name the feel surface as playable questions.

## Track F rules

1. Cheapest probe first — a static HTML mock, a behind-a-flag variant, or a rough branch build, readable in ~30 seconds.
2. Then the smallest usable thing — whatever lets Terje actually log real hours with it soonest.
3. **Terje uses it. That's the review.** No screenshot or reviewer artifact substitutes. Feel-gates are human-only.
4. Tune as a phase (use → tweak → use).
5. **Hard rule: Track F plans never run deeper than the next feedback session.** Light plans (PM comments, 1–3 tasks) are the ceiling.
6. Once the question is answered, the settled remainder reclassifies as Track V.

## The unit of Track F work: a playable question

> **Question:** does X make daily logging faster or add friction?
> **Least build:** thinnest thing that lets the question be answered (fake the rest).
> **Session:** Terje, ≤5 minutes, in the real app against real data where possible.
> **Answer feeds:** the next design decision — file it as a PM comment on the owning SDD/ticket.
