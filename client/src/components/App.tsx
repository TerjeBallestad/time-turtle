// App shell: login, sidebar, topbar, routing, server sync
import React from 'react';
import TT from '../i18n';
import { Toast, ToastStack } from '../ds';
import styles from './App.module.css';
import { api } from '../api';
import { isAdmin } from '../roles';
import { TodayView } from './views/TodayView';
import { WeekView } from './views/WeekView';
import { ReportsView } from './views/ReportsView';
import { InvoiceView } from './views/InvoiceView';
import { ReviewView } from './views/ReviewView';
import { ProjectPage } from './views/ProjectPage';
import { SettingsView } from './settings/SettingsView';
import { Login } from './Login';
import { TaskModal } from './TaskModal';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useSession } from '../hooks/useSession';
import { useToasts } from '../hooks/useToasts';
import { useServerSync } from '../hooks/useServerSync';
import type { AppState } from '../../../shared/types';
import type { UiActions, Route, TaskModalInit } from '../types';

function makeCode(name: string): string {
  const words = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .split(/\s+/);
  let code =
    words.length > 1
      ? words
          .map((word) => word.slice(0, 4))
          .slice(0, 2)
          .join('-')
      : words[0].slice(0, 8);
  return code || 'PROJ';
}

export function App() {
  const { state, setState, load } = useSession();
  const { toasts, toast } = useToasts();
  const sync = useServerSync(state, toast, load);
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
  const isAdminSession = !!state && (state as AppState).user?.role === 'admin';
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

  if (state === null) return null;
  if (state === false)
    return (
      <Login
        onLogin={() => {
          setState(null);
          load();
        }}
      />
    );

  TT.lang = lang || state.settings.language || 'en';
  const admin = isAdmin(state);
  const updateState = (fn: (current: AppState) => AppState) => setState((current) => fn(current as AppState));
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
      let id = TT.slug(label);
      updateState((current) => {
        while (current.tasks.some((task) => task.id === id)) id = id + '2';
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
            id: 'client' + (current.clients.length + 1),
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
        let code = 'NEW';
        while (current.projects.some((project) => project.code === code)) code += '2';
        return {
          ...current,
          projects: [
            ...current.projects,
            { code, name: TT.t('New project'), clientId: null, rate: null, billable: true, archived: false },
          ],
        };
      }),
    createProject: (name) => {
      let code = makeCode(name);
      updateState((current) => {
        while (current.projects.some((project) => project.code === code)) code = code + '2';
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
  else if (route.view === 'review' && admin)
    view = <ReviewView state={state} ui={ui} onReviewChanged={() => setReviewNonce((n) => n + 1)} />;
  else if (route.view === 'settings') view = <SettingsView state={state} ui={ui} />;
  else if (route.view === 'project') view = <ProjectPage state={state} ui={ui} code={route.code} />;
  // An admin-only route left over from a prior session (e.g. an admin signed out on Review,
  // an employee signed in) resolves to null above — fall back to Today rather than a blank.
  if (view === null) view = <TodayView state={state} ui={ui} />;

  const syncLabel =
    sync === 'saving' ? TT.t('saving…') : sync === 'error' ? TT.t('offline — retrying') : TT.t('synced') + ' → md';
  const syncColor = sync === 'error' ? 'var(--orange)' : 'var(--green)';

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
    </div>
  );
}
