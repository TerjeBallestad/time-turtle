// App shell: login, sidebar, topbar, routing, server sync
import React from 'react';
import TT, { preSessionLang } from '../i18n';
import { Toast, ToastStack } from '../ds';
import styles from './App.module.css';
import { api } from '../api';
import { isAdmin } from '../roles';
import { nextClientId, derivedClientId, makeClientId } from '../clientIds';
import { TodayView } from './views/TodayView';
import { WeekView } from './views/WeekView';
import { ReportsView } from './views/ReportsView';
import { InvoiceView } from './views/InvoiceView';
import { ReviewView } from './views/ReviewView';
import { ProjectPage } from './views/ProjectPage';
import { SettingsView } from './settings/SettingsView';
import { Login } from './Login';
import { ShapeChoice } from './ShapeChoice';
import { FirstRun } from './FirstRun';
import { TaskModal } from './TaskModal';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useSession } from '../hooks/useSession';
import { useToasts } from '../hooks/useToasts';
import { useServerSync } from '../hooks/useServerSync';
import type { AppState, MirrorBlock, Shape, VaultPaths } from '../../../shared/types';
import type { UiActions, Route, TaskModalInit } from '../types';

/** Same refusal? Path + first-detection instant identify a block; nothing else changes. */
function sameBlock(a: MirrorBlock | null | undefined, b: MirrorBlock | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.path === b.path && a.detectedAt === b.detectedAt;
}

export function App() {
  const { state, setState, firstRun, load } = useSession();
  const { toasts, toast } = useToasts();
  // SB-085: the save response is where a mirror refusal first shows up. Fold it into the
  // session state (`mirrorBlocked` is NOT one of useServerSync's SYNC_KEYS, so this cannot
  // bounce back at the server as a patch) and bail out when nothing changed, so an
  // unblocked install re-renders exactly never.
  const setMirrorBlocked = React.useCallback(
    (block: MirrorBlock | null) =>
      setState((current) => {
        if (!current) return current;
        return sameBlock(current.mirrorBlocked, block) ? current : { ...current, mirrorBlocked: block };
      }),
    [setState],
  );
  const sync = useServerSync(state, toast, load, setMirrorBlocked);
  const [route, setRoute] = React.useState<Route>({ view: 'today' });
  const [taskModal, setTaskModal] = React.useState<TaskModalInit | null>(null);
  const [lang, setLang] = React.useState<string | null>(localStorage.getItem('tt_lang') || null);
  const [, tick] = React.useState(0);

  React.useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);

  // SDD-002 ruling 5 (SB-025): the awaiting-approval nav badge — the count of committed-
  // but-not-approved segments across every OTHER user, from Task 1's month rollup. Admin-
  // only and best-effort (a user we cannot read is skipped); refreshed after an approve/
  // release/correction via reviewNonce. isAdminSession is a stable boolean so this does not
  // re-run on every keystroke the way depending on the whole `state` object would.
  // SB-098: AND the install has an identity surface at all. Under `personal` this whole effect
  // is dead weight — it lists users to count somebody else's pending segments, and there is
  // nobody else — but more to the point it would fetch for a badge that is no longer rendered.
  const isAdminSession =
    !!state && (state as AppState).user?.role === 'admin' && TT.shapeCapabilities((state as AppState).shape).identity;
  const [reviewPending, setReviewPending] = React.useState<number | null>(null);
  const [reviewNonce, setReviewNonce] = React.useState(0);
  React.useEffect(() => {
    if (!isAdminSession) {
      setReviewPending(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { users } = await api.listUsers();
        let count = 0;
        for (const u of users) {
          if (state && u.id === (state as AppState).user.id) continue;
          try {
            const sheet = await api.getUserTimesheet(u.id);
            const months = [...new Set(sheet.entries.map((e) => e.date.slice(0, 7)))];
            for (const month of months)
              count += TT.monthSegments(sheet, month).filter((s) => s.committed && !s.approved).length;
          } catch {
            /* skip a user we cannot read */
          }
        }
        if (!cancelled) setReviewPending(count);
      } catch {
        if (!cancelled) setReviewPending(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminSession, reviewNonce]);

  // DD-024: BEFORE the early returns, because the two screens below them render with no session
  // and therefore with no `settings.language` to read. Until this plan that cost four words on a
  // login form; now it is the whole first run, which has to be legible to the person meeting it.
  // The line after the returns still has the last word once a session exists — the stored setting
  // beats a browser default, as it should.
  TT.lang = preSessionLang(lang);
  if (state === null) return null;
  // DD-024 / SB-158: a 401 is no longer one thing. On a fresh install it means "nobody has said
  // what this install IS yet", and the answer to that question is what removes the login — so the
  // question goes FIRST. `firstRun.open` is the SERVER's verdict on the open state, never a client
  // re-derivation of it, and a caller the server will not serve the first run to (not on this
  // machine) gets `null` and the login it always got.
  const reload = () => {
    setState(null);
    load();
  };
  if (state === false)
    return firstRun?.open ? (
      <FirstRun info={firstRun} onDone={reload} />
    ) : (
      <Login onLogin={reload} defaultLogin={firstRun?.defaultLogin ?? null} />
    );

  TT.lang = lang || state.settings.language || 'en';
  // SB-098 item 3: whether this install has more than one human in it, read off the SAME
  // capability table the commit and mirror gates read (DD-011's rule: a capability is a property
  // of the shape, not of a path captured at switch time). Under `personal` the identity surfaces
  // are ABSENT, not disabled — a greyed-out Users section still asserts that other users are a
  // thing here, which is exactly what depth 2 of DD-015 removes.
  const identity = TT.shapeCapabilities(state.shape).identity;
  // Role gating is unchanged and still real (the server strips and 403s regardless); it is just
  // meaningless under `personal`, where the one user is the admin by construction. Everything
  // below reads `admin && identity` rather than either alone, so a shape with no identity never
  // renders an admin-only surface and a team employee never gains one.
  const admin = isAdmin(state);
  const updateState = (fn: (current: AppState) => AppState) => setState((current) => fn(current as AppState));
  // SB-098 / SB-139: storing a shape, once, for both surfaces that can choose one. NOT the
  // optimistic debounced diff the other settings use — the server can REFUSE this (the lock,
  // DD-006's single-user guard), so an optimistic flip would show a state that was rejected,
  // and half the UI below is derived from the EFFECTIVE shape the server reports, which the env
  // and the lock can both decide. Reload after, never guess.
  const chooseShape = (shape: Shape) => {
    void api
      .setShape(shape)
      .then((res) => {
        toast(TT.t('instance shape: ') + res.shape);
        load();
      })
      .catch((err: Error) => {
        toast(err.message);
        load(); // re-sync the control back to the server truth on a refusal
      });
  };
  const ui: UiActions = {
    toast,
    update: (id, patch) =>
      updateState((current) => ({
        ...current,
        entries: current.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
      })),
    remove: (id) => {
      updateState((current) => ({ ...current, entries: current.entries.filter((entry) => entry.id !== id) }));
      toast(TT.t('Entry removed'));
    },
    add: (date, parsed) => {
      const entry = TT.newEntry(date, parsed);
      // Continue the day's last logged project + label (the copied-at-birth stamp).
      const prev = state.entries.filter((candidate) => candidate.date === date && candidate.project);
      if (prev.length) {
        entry.project = prev[prev.length - 1].project;
        entry.label = prev[prev.length - 1].label;
      }
      // SDD-002 derive-once: the entry inherits its project's billable default here,
      // at birth, and is frozen after — mirrored by the server's employee branch.
      entry.billable = TT.projectBillable(state, entry.project);
      updateState((current) => ({ ...current, entries: [...current.entries, entry] }));
      if (parsed.kind === 'running') toast(TT.t('Timer started'));
      return entry.id;
    },
    stop: (id) => {
      updateState((current) => ({
        ...current,
        entries: current.entries.map((entry) => (entry.id === id ? { ...entry, end: TT.nowMin() } : entry)),
      }));
      toast(TT.t('Timer stopped'));
    },
    openTaskModal: (name, entryId) => setTaskModal({ name: name || '', entryId: entryId || null }),
    createTask: ({ label, project }, entryId) => {
      updateState((current) => {
        // SB-111: same de-collision rule as client ids and project codes, and the suffix fits
        // inside TT.slug's cap. Derived INSIDE the updater so a re-run sees the current tasks.
        const id = TT.uniqueId(TT.slug(label), (c) => current.tasks.some((task) => task.id === c), TT.ID_CAP);
        const tasks = [...current.tasks, { id, label, project: project || null }];
        // Creating a template from the task cell STAMPS it onto the entry (copy at
        // birth) and derives billable from the project the one moment a projectless
        // entry first gets a project — the same moment TaskCell.pick derives at.
        const entries = entryId
          ? current.entries.map((entry) =>
              entry.id === entryId
                ? {
                    ...entry,
                    project: project || null,
                    label,
                    billable: entry.project == null ? TT.projectBillable(current, project || null) : entry.billable,
                  }
                : entry,
            )
          : current.entries;
        return { ...current, tasks, entries };
      });
      setTaskModal(null);
      toast(TT.t('Task created'));
    },
    updateTask: (id, patch) =>
      updateState((current) => ({
        ...current,
        tasks: current.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)),
      })),
    removeTask: (id) => {
      // SDD-002: templates are never referenced by entries (label + project are
      // copied at birth), so deleting one touches nothing else — safe by construction.
      updateState((current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== id) }));
      toast(TT.t('Task removed'));
    },
    addClient: () =>
      updateState((current) => ({
        ...current,
        clients: [
          ...current.clients,
          {
            id: nextClientId(current.clients),
            name: TT.t('New client'),
            rounding: 'exact',
            rate: null,
            archived: false,
          },
        ],
      })),
    updateClient: (id, patch) =>
      updateState((current) => ({
        ...current,
        clients: current.clients.map((client) => (client.id === id ? { ...client, ...patch } : client)),
      })),
    // SB-067: the name is edited live (per keystroke, above); the ID is derived once, at the
    // deliberate commit boundary — blur — mirroring ProjectCodeInput's onCommit. Per keystroke
    // would freeze the id on the first character typed and remount the row (key={client.id})
    // under the user's cursor. `derivedClientId` returns null unless the client is still on its
    // minted id AND unreferenced, so this is a no-op for everything else; returning `current`
    // unchanged means React bails out and useServerSync never sees a diff.
    commitClientName: (id) =>
      updateState((current) => {
        const next = derivedClientId(current.clients, current.projects, id, TT.t('New client'));
        if (!next) return current;
        return {
          ...current,
          clients: current.clients.map((client) => (client.id === id ? { ...client, id: next } : client)),
        };
      }),
    // SB-087 (SB-067 fix 3): once a client is REFERENCED, its id can no longer be swapped
    // by an ordinary catalog PUT — dropping the old id while projects still point at it is
    // a referenced delete and comes back 409. So a rename is a DELIBERATE, server-reconciled
    // commit (blur/Enter on the id field, mirroring renameProject below): the endpoint swaps
    // the client row AND re-points every project's client_id in one transaction. Reload
    // afterwards, because local state went stale in TWO places at once — the client row and
    // every project's clientId.
    //
    // `makeClientId` normalizes here as well as in the input, so the id the rename asks for
    // is always the same shape the name-blur derive produces; the server re-validates the
    // charset anyway, and an out-of-charset id is rejected before anything writes.
    renameClient: (id, next) => {
      const to = makeClientId(next);
      if (!to || to === id) return;
      void api
        .renameClient(id, to)
        .then(() => {
          toast(id + ' → ' + to);
          load();
        })
        .catch((err: Error) => {
          toast(err.message);
          load(); // re-sync the id input back to the server truth on a rejected rename
        });
    },
    // SDD-002 ruling 7: archive, never delete. Archiving a client hides it from the
    // creation pickers but leaves its projects' clientId INTACT (the old removeClient
    // nulled them — dropped) and keeps history resolving. Restore just un-archives.
    archiveClient: (id) => {
      updateState((current) => ({
        ...current,
        clients: current.clients.map((client) => (client.id === id ? { ...client, archived: true } : client)),
      }));
      toast(TT.t('Client archived'));
    },
    restoreClient: (id) => {
      updateState((current) => ({
        ...current,
        clients: current.clients.map((client) => (client.id === id ? { ...client, archived: false } : client)),
      }));
      toast(TT.t('Client restored'));
    },
    addProject: () =>
      updateState((current) => {
        const code = TT.uniqueId('NEW', (c) => current.projects.some((project) => project.code === c), TT.CODE_CAP); // prettier-ignore
        return {
          ...current,
          projects: [
            ...current.projects,
            { code, name: TT.t('New project'), clientId: null, rate: null, billable: true, archived: false },
          ],
        };
      }),
    createProject: (name) => {
      updateState((current) => {
        // SB-111: one de-collision rule, and the suffix fits inside the code's cap — `SOR-NORG`,
        // `SOR-NO-2`, `SOR-NO-3`, never the old unbounded `SOR-NORG2` / `SOR-NORG22`. Derived
        // INSIDE the updater, so a re-run sees the current catalog rather than a stale `code`.
        const code = TT.uniqueId(TT.projectCode(name), (c) => current.projects.some((project) => project.code === c), TT.CODE_CAP); // prettier-ignore
        return {
          ...current,
          projects: [...current.projects, { code, name, clientId: null, rate: null, billable: true, archived: false }],
        };
      });
      toast(TT.t('Project created'));
    },
    updateProject: (code, patch) =>
      updateState((current) => ({
        ...current,
        projects: current.projects.map((project) => (project.code === code ? { ...project, ...patch } : project)),
      })),
    // DC-005 (PLAN-006): a code rename is now a DELIBERATE, server-reconciled commit — the
    // endpoint rewrites EVERY user's entries + templates in one transaction (the old local
    // rewrite touched only this admin's own data, orphaning everyone else's history). Fire
    // the server call, then reload so our now-stale projects/entries/tasks refresh.
    renameProject: (code, next) => {
      const to = next.trim().toUpperCase();
      if (!to || to === code) return;
      void api
        .renameProject(code, to)
        .then(() => {
          toast(code + ' → ' + to);
          load();
        })
        .catch((err: Error) => {
          toast(err.message);
          load(); // re-sync the code input back to the server truth on a rejected rename
        });
    },
    // SDD-002 ruling 7: archive, never delete. Archiving a project hides it from creation
    // pickers/templates but keeps history resolving; templates keep their project (a
    // template on an archived project is simply hidden from the pickers). Restore un-archives.
    archiveProject: (code) => {
      updateState((current) => ({
        ...current,
        projects: current.projects.map((project) => (project.code === code ? { ...project, archived: true } : project)),
      }));
      toast(code + ' ' + TT.t('archived'));
    },
    restoreProject: (code) => {
      updateState((current) => ({
        ...current,
        projects: current.projects.map((project) =>
          project.code === code ? { ...project, archived: false } : project,
        ),
      }));
      toast(code + ' ' + TT.t('restored'));
    },
    setLanguage: (language) => {
      localStorage.setItem('tt_lang', language);
      setLang(language);
      if (admin) updateState((current) => ({ ...current, settings: { ...current.settings, language } }));
    },
    setCurrency: (currency) => updateState((current) => ({ ...current, settings: { ...current.settings, currency } })),
    setMdDir: (dir) => updateState((current) => ({ ...current, settings: { ...current.settings, mdDir: dir } })),
    // SB-100: the shape switch does NOT go through the optimistic debounced diff the other
    // settings use. It goes straight to the server and then reloads — the renameProject /
    // renameClient shape — for two reasons the others do not have. The server can REFUSE it
    // (TT_SHAPE_LOCK, or the single-user guard with more than one user), so an optimistic
    // toggle would sit there showing a state that was rejected; and half the UI below is
    // derived from the EFFECTIVE shape the server reports, which the env and the lock can
    // both decide, so guessing it locally is guessing.
    setShape: (shape) => {
      // Compare against the EFFECTIVE shape — the one the toggle is showing — not the stored
      // one. They differ exactly when `TT_SHAPE` supplied the shape and nothing is stored,
      // which is the configuration this plan names most often ("an install switched by
      // TT_SHAPE alone never fires a settings write"): `state.shape` reads `personal` while
      // `settings.shape` reads its `team` default, so guarding on the stored value made
      // clicking Team a no-op — no request, no toast, no way out of `personal` from the UI.
      //
      // SB-133 LOOKED AT THIS LINE AND LEFT IT ALONE, which is worth saying because the ticket
      // named it. It is not what swallowed the repair: an install wrongly stamped `team` has an
      // EFFECTIVE `team`, so clicking Personal differs from it, fires, and moves the install —
      // pinned by 'an install wrongly stamped team can be moved back' in tests/shape-echo.test.js,
      // which passed before the fix as well as after. The one gesture this does swallow is
      // clicking the shape you are ALREADY effectively on, to pin it against the env — and that
      // is the first-run question SB-098 owns (DD-015 keeps the OPEN state deliberately open, so
      // writing a row here would answer it on the user's behalf). `state.settings.shape` now
      // carries the STORED shape and is absent when nothing was chosen, so SB-098 has the
      // distinction it needs the day it wants to offer that.
      //
      // SB-098 LEFT THE EARLY RETURN AND MOVED THE TRANSPORT. The guard is still right for a
      // toggle — clicking the segment that is already lit should not fire a write — and the
      // ticket that owns the one gesture it swallows is this one, which answers it with a
      // separate action (`chooseShape` below) rather than by loosening the toggle. What did
      // change is where the write goes: `POST /api/shape` instead of a whole-settings PUT, so
      // there is exactly ONE channel that can store a shape from the client (SB-139).
      if (shape === (state.shape ?? 'team')) return;
      chooseShape(shape);
    },
    // SB-098 item 4: the first-run answer. The SAME channel as the toggle and deliberately
    // WITHOUT its early return, because the open state resolves to an effective `team`
    // (DD-015: `team` is the safe row) — so a user answering "my company's" is choosing the
    // shape they are already effectively on, and a compare-first gesture would silently store
    // nothing, leave `shapeOpen` true and ask them again. The `personal` half would have
    // worked, which is exactly what makes that failure easy to ship.
    chooseShape: (shape) => chooseShape(shape),
    setVaultPaths: (patch) =>
      updateState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          vaultPaths: { ...(current.settings.vaultPaths as VaultPaths), ...patch },
        },
      })),
    setVaultTimeSeparator: (separator) =>
      updateState((current) => ({ ...current, settings: { ...current.settings, vaultTimeSeparator: separator } })),
    // DD-026 clause 5: the heading is a SETTING, not a path. It used to ride `setVaultPaths`, and
    // `vaultPaths` is how a MACHINE finds the vault — a heading written there is a heading the
    // other machine never sees, which is two blocks in one note.
    setTimeLogHeading: (heading) =>
      updateState((current) => ({ ...current, settings: { ...current.settings, timeLogHeading: heading } })),
    // SB-065/SB-085: consent to overwrite. The server adopts the bytes on disk as its stamp
    // and clears the block; nothing is written until the next save. Deliberately NOT a
    // reload — `load()` hands useServerSync a fresh object for every synced key, which would
    // PUT the whole state straight back and turn "acknowledge" into "overwrite now".
    //
    // SB-095: with a `userId` this is an ADMIN clearing someone else's block. Only the
    // session's own block is mirrored into local state — clearing `mirrorBlocked` for an
    // employee's adoption would erase the admin's own standing refusal from the screen while
    // the server still holds it.
    acknowledgeMirror: (userId) =>
      api
        .acknowledgeMirror(userId)
        .then(() => {
          if (userId === undefined || userId === state.user.id) setMirrorBlocked(null);
          toast(TT.t('mirror unblocked — the next save overwrites the file'));
          return true;
        })
        .catch((err: Error) => {
          toast(err.message);
          return false;
        }),
    // SB-095: admin-only. A 403/500 resolves [] rather than throwing — the section is an
    // extra affordance, and a failed read should leave it drawing nothing, not break Settings.
    mirrorBlocks: () =>
      api
        .mirrorBlocks()
        .then((r) => r.mirrorBlocks)
        .catch(() => []),
    importMd: (md) => {
      try {
        const parsed = TT.parseMd(md);
        setState((current) => ({
          ...(current as AppState),
          settings: parsed.settings,
          clients: parsed.clients,
          projects: parsed.projects,
          tasks: parsed.tasks,
          entries: parsed.entries,
        }));
        toast(TT.t('Markdown applied'));
        return true;
      } catch (err) {
        toast(TT.t('Could not parse markdown'));
        return false;
      }
    },
    openProject: (code) => setRoute({ view: 'project', code }),
    // SDD-002 ruling 4: commit/un-commit a (week∩month) segment. The client only tracks
    // WHICH keys are committed — committedAt is provisional and the money snapshot is
    // server-owned (empty here). The server reconciles on the debounced PUT: a new key
    // gets a stamped committedAt + a derived snapshot; a removed key is discarded.
    commitSegment: (key) => {
      updateState((current) => {
        if ((current.commits ?? []).some((commit) => commit.key === key)) return current;
        const segment = { key, committedAt: new Date().toISOString(), snapshot: {} };
        return { ...current, commits: [...(current.commits ?? []), segment] };
      });
      toast(TT.t('Segment committed'));
    },
    uncommitSegment: (key) => {
      updateState((current) => ({
        ...current,
        commits: (current.commits ?? []).filter((commit) => commit.key !== key),
      }));
      toast(TT.t('Reopened for edits'));
    },
    users: {
      list: () => api.listUsers().then((r) => r.users),
      create: (user) =>
        api
          .createUser(user)
          .then((r) => {
            toast(TT.t('User created'));
            return r.user;
          })
          .catch((err: Error) => {
            toast(err.message);
            throw err;
          }),
      remove: (id) =>
        api
          .deleteUser(id)
          .then(() => toast(TT.t('User removed')))
          .catch((err: Error) => toast(err.message)),
      setPassword: (id, password) =>
        api
          .setUserPassword(id, password)
          .then(() => {
            toast(TT.t('Password updated'));
            return true;
          })
          .catch((err: Error) => {
            toast(err.message);
            return false;
          }),
    },
    changePassword: (currentPassword, newPassword) =>
      api.changePassword(currentPassword, newPassword).then(() => toast(TT.t('Password changed'))),
    logout: () => {
      void api.logout().then(() => setState(false));
    },
  };

  const today = TT.todayStr();
  const todayEntries = state.entries.filter((entry) => entry.date === today);
  const running = state.entries.find((entry) => TT.isRunning(entry) && entry.date === today);
  const runningCode = running ? TT.entryProjectCode(state, running) : null;
  const todayMin = todayEntries.reduce((sum, entry) => sum + TT.entryMinutes(entry), 0);
  const titles: Record<'today' | 'week' | 'reports' | 'invoice' | 'review' | 'settings', string> = {
    today: TT.t('Today'),
    week: TT.t('This week'),
    reports: TT.t('Reports'),
    invoice: TT.t('Invoice'),
    review: TT.t('Review'),
    settings: TT.t('Settings'),
  };
  const title = route.view === 'project' ? route.code : titles[route.view];
  let view = null;
  if (route.view === 'today') view = <TodayView state={state} ui={ui} />;
  else if (route.view === 'week') view = <WeekView state={state} ui={ui} />;
  else if (route.view === 'reports') view = <ReportsView state={state} ui={ui} />;
  else if (route.view === 'invoice' && admin) view = <InvoiceView state={state} ui={ui} />;
  // SB-098 item 3: the review surface presupposes somebody to review, so `personal` has no
  // route to it — not a hidden nav item with a live route behind it. The fallback below turns
  // a stale `review` route into Today, which is exactly the right landing.
  else if (route.view === 'review' && admin && identity)
    view = <ReviewView state={state} ui={ui} onReviewChanged={() => setReviewNonce((n) => n + 1)} />;
  else if (route.view === 'settings') view = <SettingsView state={state} ui={ui} />;
  else if (route.view === 'project') view = <ProjectPage state={state} ui={ui} code={route.code} />;
  // An admin-only route left over from a prior session (e.g. an admin signed out on Review,
  // an employee signed in) resolves to null above — fall back to Today rather than a blank.
  if (view === null) view = <TodayView state={state} ui={ui} />;

  // SB-134: the sidebar's sync line is a STATUS INDICATOR, so it may only claim a write that is
  // actually happening. Under `personal` the v2 markdown mirror is off by construction — DD-011
  // retires it, and DD-015/SB-100 derive the `vault` backend instead — so `synced → md` was a
  // positive claim about a write that does not occur. Same species as SB-113 (a surface still
  // speaking the previous architecture), but worse than stale vocabulary: someone watching this
  // line to know their hours are safe was reading a reassurance that meant nothing.
  //
  // THE GATE IS THE CAPABILITY TABLE, never `shape === 'personal'`. DD-011's rule is that a
  // capability is a property of the SHAPE, and `mirror` is the exact bit that decides whether a
  // mirror byte is written — so a third shape gets an honest label by adding a row to the table
  // in shared/core.js, not by finding this line.
  //
  // The vault-side state is `state.vaultQuarantined` — the array SB-057 task 8 already puts on
  // /api/state and renders in Settings → Vault. READ, never re-derived: this line and that panel
  // are two views of one fact, and a second derivation is how two views come to disagree. The
  // wording is that panel's own ('Notes paused'), so the sidebar and the place that explains it
  // use one phrase.
  const mirrors = TT.shapeCapabilities(state.shape).mirror;
  const paused = mirrors ? 0 : (state.vaultQuarantined ?? []).length;
  const settled = paused
    ? TT.t('Notes paused') + ' (' + paused + ')'
    : mirrors
      ? TT.t('synced') + ' → md'
      : TT.t('synced → vault');
  const syncLabel = sync === 'saving' ? TT.t('saving…') : sync === 'error' ? TT.t('offline — retrying') : settled;
  const syncColor = sync === 'error' || paused ? 'var(--orange)' : 'var(--green)';

  return (
    <div className={styles.app}>
      <Sidebar
        state={state}
        route={route}
        setRoute={setRoute}
        ui={ui}
        running={running}
        todayEntries={todayEntries}
        admin={admin}
        identity={identity}
        reviewPending={reviewPending}
        syncLabel={syncLabel}
        syncColor={syncColor}
      />
      <div className={styles.content}>
        <TopBar title={title} running={running} runningCode={runningCode} todayMin={todayMin} ui={ui} />
        <main className={styles.main}>{view}</main>
      </div>
      <ToastStack>
        {toasts.map((item) => (
          <Toast key={item.id}>{item.msg}</Toast>
        ))}
      </ToastStack>
      {taskModal && <TaskModal state={state} ui={ui} init={taskModal} onClose={() => setTaskModal(null)} />}
      {/* SB-098 item 4: LAST, so its scrim covers everything including an open task modal, and
          rendered off `state.shapeOpen` — the server's verdict on whether the question is owed,
          never a client re-derivation of it (see AppState.shapeOpen).

          DD-024 MOVED THE ORDINARY PATH OUT FROM UNDER THIS. A fresh install now meets the question
          as `<FirstRun>` before any session exists, so this branch is the AUTHENTICATED FALLBACK: it
          is what an admin sees if a session somehow exists while the open state still stands. It is
          kept rather than deleted because nothing here proves that is unreachable — `shapeOpen` is
          the server's own condition and this is the surface that answers it. If it is ever proven
          dead, delete it then. */}
      {state.shapeOpen && <ShapeChoice onAnswer={ui.chooseShape} />}
    </div>
  );
}
