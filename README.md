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
(Obsidian vault, Dropbox, …) in **Settings → Markdown backend → Mirror folder** (`~` works;
admin only). The setting overrides the `TT_MD_DIR` env var and re-targets on the next save.
On a shared server, where "admin" is not the machine owner, set `TT_MD_DIR_LOCK=1`: the mirror
is then frozen at `TT_MD_DIR`, the setting is ignored, and changing it is rejected (403).

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

First run creates an admin user — **admin@timeturtle.local / turtle** — and seeds demo
data. Change the password by deleting `server/data/` and restarting with env vars, or
just make a real admin user in Settings → Users and delete the default one.

### Environment

| var                                    | default                             | purpose                                                                                   |
| -------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `PORT`                                 | `3001`                              | API port                                                                                  |
| `TT_DATA_DIR`                          | `server/data`                       | DB + secret location                                                                      |
| `TT_MD_DIR`                            | `<data>/markdown`                   | markdown mirror dir fallback (Settings → Mirror folder wins)                              |
| `TT_MD_DIR_LOCK`                       | unset                               | `1` freezes the mirror at `TT_MD_DIR` — Settings → Mirror folder is ignored and read-only |
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
