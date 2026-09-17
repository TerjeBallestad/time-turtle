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

**Storage:** SQLite is the source of truth (`server/data/timeturtle.db`), and it is the only
one. `shared/core.js` still carries a round-trippable markdown (de)serializer, which the demo
seed is written in and parsed from, but the app writes no markdown file and reads none.

**One install type.** Time Turtle is a team app: an admin logs in, people log their hours, an
admin reviews and invoices them. There is nothing to choose at install time and nothing about
the install to configure.

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

### Two instances, side by side

A data dir plus a port **is** an instance. `--data DIR` picks it on `serve`, `stop`,
`restart`, `status` and `logs`; `TT_DATA_DIR` is the fallback when the flag is absent.
So one checkout runs two independent installs at once:

```sh
tt serve --data ~/.time-turtle/live --port 3002   # your real hours
tt serve --port 3001                              # the demo — the existing server/data
```

Stop, inspect or tail either one by naming it again — `tt stop --data ~/.time-turtle/live`,
`tt status --data ~/.time-turtle/live`. Everything is per data dir: DB, pid file, log,
session secret, users, settings. Nothing is shared between instances but the
code, and neither one knows the other exists — `tt status` answers only for the data dir you
named, so a bare `tt status` saying `stopped` means _the default instance_ is stopped. Every
answer prints the data dir it answered for, `tt stop`'s `not running` included.

`tt status` is a read: it **reports** a leftover pid file (`stale pid file (pid N)`) rather than
deleting one, so inspecting an instance never writes to its data dir. The sweep belongs to the
commands that write anyway — `serve`, `stop`, `restart` — and `stop` says so when it happens.

### First run

A fresh install asks one question before it asks for a credential: **"Start with something in
it?"** — a checkbox, and a button that names what it will do (`Start with an empty timesheet`
or `Add the example hours and start`). Answering it lands you on the login screen, which
states the credential nobody ever showed you: **admin@timeturtle.local / turtle**. That note
disappears once the password changes. The question is asked once per data dir and never again.

Change the default password under Settings → Password, or make a real admin in
Settings → Users and delete the default one.

### Environment

| var                                    | default                             | purpose                                                                                                                     |
| -------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                 | `3001`                              | API port                                                                                                                    |
| `TT_HOST`                              | every interface                     | bind address — unset means reachable from other machines on this network                                                    |
| `TT_DATA_DIR`                          | `server/data`                       | DB + secret location — the instance (`tt --data DIR` wins over it)                                                          |
| `TT_ADMIN_EMAIL` / `TT_ADMIN_PASSWORD` | `admin@timeturtle.local` / `turtle` | first-run admin                                                                                                             |
| `TT_SEED_DEMO`                         | unset                               | `1` seeds demo clients/projects/entries at boot — for tests and scripts; a person answers the first run's demo step instead |
| `TT_SECRET`                            | generated → `data/.secret`          | session-signing secret                                                                                                      |

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
