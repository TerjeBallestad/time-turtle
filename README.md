# Time Turtle

Keyboard-first time registration. Spreadsheet-style daily grid, smart time parsing
(`12:00-13:00`, `12:30→` running timer, `1h30m`), projects → clients → rates → invoicing.

Frontend design by Claude Design.

## Architecture

```
client/   Vite + React + TypeScript SPA (dark PM-board design system)
server/   Express + SQLite (node:sqlite, zero native deps) — auth, roles, REST API
shared/   core.js — the data model + markdown (de)serialization, used by both sides
```

**Storage:** SQLite is the source of truth (`server/data/timeturtle.db`). Every save also
mirrors each user's full timesheet to a human-readable markdown file
(`server/data/markdown/timesheet-<name>.md`) in a round-trippable format — that file can be
pasted back into the app to restore everything. Point the mirror at a cloud-synced folder
(Obsidian vault, Dropbox, …) in **Settings → Markdown mirror → Mirror folder** (`~` works;
admin only). The setting overrides the `TT_MD_DIR` env var and re-targets on the next save.
On a shared server, where "admin" is not the machine owner, set `TT_MD_DIR_LOCK=1`: the mirror
is then frozen at `TT_MD_DIR`, the setting is ignored, and changing it is rejected (403).

**Instance shape (SB-100 / DD-015).** `shape` says what an install _is_: `team` (the default,
and what everything above describes) or `personal`, one human with an Obsidian vault as the
source of truth and SQLite demoted to a derived index. The storage backend — `sqlite` or
`vault` — is **derived** from the shape and is never selected; naming the choice after the
storage engine made the codebase claim that the storage engine decides whether you log in.
`TT_SHAPE` supplies the default, **Settings → Vault → Instance shape** beats it, and
`TT_SHAPE_LOCK=1` freezes it at `TT_SHAPE` — the stored setting is then ignored and changing it
is rejected (403), exactly like the mirror lock. The startup banner names the effective shape,
which source won, and the storage it derives.

The shape is INFERRED, never asked for, when the answer is already obvious: a data dir holding
more than one user boots stamped `team` silently — an install with five users has answered by
existing. One user, unlocked and nothing stored is the open state; `TT_SHAPE_LOCK` means never
ask at all.

Choosing `personal` today turns three shipped things off, and the banner says so: the markdown
mirror stops (and the files already written are retired — see below), committing is off until
the weekly-note rollup lands, and markdown paste-back is off. Nothing yet syncs the SQLite
index from vault files; that is SB-057.

**The cutover (DD-016).** Storing `shape: 'personal'` stamps `vaultCutover` with the instant it
happened. The vault never receives entries dated before it — they stay in SQLite, are never
written to a daily note and never trigger adoption of an existing one — which is what keeps
demo hours and a flipped install's history out of real daily notes. The stamp lands here; the
write filter that enforces it lands with the vault writer (SB-057).

**One vault, one person.** A vault has a single `Calendar/Daily` tree, so there is no answer to
whose daily note a second person's hours would land in. The server refuses to add a user while
`personal` is active, refuses to switch to `personal` while more than one user exists, and —
the case a copied data dir creates — **refuses to start** when it boots into `personal` with
several users already stored. Recover from that with:

```sh
TT_SHAPE_LOCK=1 TT_SHAPE=team tt serve
```

The lock is the load-bearing half: `TT_SHAPE=team` on its own loses to the stored `personal`
setting, so only the locked form gets a wedged install back up.

**Roles:**

- `admin` — everything: clients, projects, rates, invoicing, users, settings.
- `employee` — logs time and manages tasks freely; cannot edit clients/projects;
  hourly rates and amounts are stripped **server-side** (never sent to the browser),
  and the Invoice view is hidden.

## Run it

```sh
npm install
npm run dev        # API on :3001, app on http://localhost:5173 — the EDIT loop (hot reload)
```

### Daily driver — `tt`

`npm run dev` is for hacking on the code. To just _use_ the app, run the built
version as a background service via the `tt` command (linked once with `npm link`):

```sh
npm link           # once — puts `tt` on your PATH (like the pm CLI)
tt serve           # build if needed, run the built app in the background on :3001
tt status          # running · pid … · http://localhost:3001
tt restart --build # rebuild the client and relaunch
tt stop            # stop it
tt logs            # log file path + last lines
```

`tt` serves the built client **and** the API on one origin (`:3001`) and shares
`server/data` with `npm run dev`, so use one at a time. Because the client is served
off disk, `tt build` refreshes the running app with no restart. Everything (pid, log)
lives under `server/data`, which is gitignored.

### Two shapes, two instances

A data dir plus a port **is** an instance. `--data DIR` picks it on `serve`, `stop`,
`restart`, `status` and `logs`; `TT_DATA_DIR` is the fallback when the flag is absent.
So one checkout runs a personal install and a team-demo install side by side:

```sh
tt serve --data ~/.time-turtle/personal --port 3002   # personal — your real hours
tt serve --port 3001                                  # team demo — the existing server/data
```

Stop, inspect or tail either one by naming it again — `tt stop --data ~/.time-turtle/personal`,
`tt status --data ~/.time-turtle/personal`. Everything is per data dir: DB, markdown mirror,
pid file, log, session secret, users, settings. Nothing is shared between instances but the
code, and neither one knows the other exists — `tt status` answers only for the data dir you
named, so a bare `tt status` saying `stopped` means *the default instance* is stopped.

**A shape belongs to an instance; you don't flip it.** The storage backend (`sqlite` vs
`vault`) and everything else in Settings are stored in the data dir, so the personal install
can be a single-user vault install while the team demo stays multi-user SQLite. Switching the
demo over would strand its 5 users (see **One vault, one person** above) — give the other
shape its own data dir instead, and keep both.

First run creates an admin user — **admin@timeturtle.local / turtle** — and seeds demo
data. Change the password by deleting `server/data/` and restarting with env vars, or
just make a real admin user in Settings → Users and delete the default one.

### Environment

| var                                    | default                             | purpose                                                                                   |
| -------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `PORT`                                 | `3001`                              | API port                                                                                  |
| `TT_DATA_DIR`                          | `server/data`                       | DB + secret location — the instance (`tt --data DIR` wins over it)                        |
| `TT_MD_DIR`                            | `<data>/markdown`                   | markdown mirror dir fallback (Settings → Mirror folder wins)                              |
| `TT_MD_DIR_LOCK`                       | unset                               | `1` freezes the mirror at `TT_MD_DIR` — Settings → Mirror folder is ignored and read-only |
| `TT_SHAPE`                             | `team`                              | default instance shape, `team` or `personal` (Settings → Vault → Instance shape wins)     |
| `TT_SHAPE_LOCK`                        | unset                               | `1` freezes the shape at `TT_SHAPE` — the stored setting is ignored and read-only         |
| `TT_ADMIN_EMAIL` / `TT_ADMIN_PASSWORD` | `admin@timeturtle.local` / `turtle` | first-run admin                                                                           |
| `TT_SEED_DEMO`                         | `1`                                 | seed demo clients/projects/entries on first run                                           |
| `TT_SECRET`                            | generated → `data/.secret`          | session-signing secret                                                                    |

### Production

```sh
npm run build      # builds client/dist
npm start          # Express serves API + the built SPA on :3001
```

## Known v1 limitations

- Concurrent saves use optimistic version checks: a save against a stale version is
  rejected with a 409 and the client reloads the latest server state instead of clobbering
  it — conflicts are resolved by reload, not merge.
- No self-service password reset: users change their own password while logged in and an
  admin can set a new one for anyone, but there is no email/forgot-password flow.
- The admin team report shows aggregated totals (grouped by person, project, or client)
  only; individual entries stay private to each user.
