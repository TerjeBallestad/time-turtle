---
description: Create a new backlog issue outside the normal project cycle
argument-hint: "<title> [--priority critical|robustness|feature|polish] [--type issue|decision|concern|gap] [--related SB-NNN]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# File Issue

Create a new item in the PM dashboard (localhost:3335) outside the normal project cycle. Use when you spot a bug, design concern, or gap while working on something else.

## Arguments

`$ARGUMENTS` — Required: short title. Optional flags.

| Flag | Behavior |
| --- | --- |
| `--priority critical\|robustness\|feature\|polish` | Explicit priority (default: inferred) |
| `--type issue\|decision\|concern\|gap` | Item type (default: issue) |
| `--related SB-NNN` | Link to related item(s) |

## Workflow

### Step 1: Check for duplicates

```bash
pm list
```

Scan for items with similar titles or affected files. Likely duplicate → tell the user and offer to comment on the existing item instead.

### Step 2: Gather context

From the current conversation: **what happened** (symptom/observation), **where** (affected files — grep to find them), **body** (1–2 paragraphs with evidence and handoff context).

### Step 3: Classify priority

If `--priority` given, use it. Otherwise infer:
- Data loss, wrong billing math, or role/permission leak (rates visible to employees) → **critical**
- Reliability of sync/mirror/auth, migration debt, missing tests → **robustness**
- New capability → **feature**
- Nice-to-have → **polish**

### Step 4: Create

```bash
pm create <issue|decision|concern|gap> "<title>" \
  --priority <priority> \
  --body "<description with evidence and handoff context>" \
  --files client/src/app.js,server/src/index.js
```

Print the new ID. Then return to what you were doing — filing is a side quest, never a context switch.
