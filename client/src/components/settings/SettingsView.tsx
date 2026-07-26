// Settings: clients, projects, tasks, users (admin), general, vault, markdown mirror
import React from 'react';
import TT from '../../i18n';
import { isAdmin } from '../../roles';
import vs from '../views/views.module.css';
import { ClientsSection } from './ClientsSection';
import { ProjectsSection } from './ProjectsSection';
import { ArchiveSection } from './ArchiveSection';
import { TasksSection } from './TasksSection';
import { UsersSection } from './UsersSection';
import { PasswordSection } from './PasswordSection';
import { GeneralSection } from './GeneralSection';
import { MarkdownSection } from './MarkdownSection';
import { MirrorSection } from './MirrorSection';
import { VaultSection } from './VaultSection';
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface SettingsProps {
  state: AppState;
  ui: UiActions;
}

export function SettingsView({ state, ui }: SettingsProps) {
  const admin = isAdmin(state);
  // SB-098 item 3: read off the same capability table the commit and mirror gates read, never a
  // second `state.shape === 'personal'` test. False under `personal` — one human, so the two
  // sections below that exist to manage OTHER humans, or to prove you are one, are ABSENT.
  const identity = TT.shapeCapabilities(state.shape).identity;
  return (
    <div className={[vs.page, vs.settingsPage].join(' ')}>
      <h1 className={[vs.h1, vs.mb24].join(' ')}>{TT.t('Settings')}</h1>
      {admin && <ClientsSection state={state} ui={ui} />}
      {admin && <ProjectsSection state={state} ui={ui} />}
      {admin && <ArchiveSection state={state} ui={ui} />}
      <TasksSection state={state} ui={ui} />
      {/* SB-098 item 3: Users is the surface that most obviously presupposes more than one human,
          and Password is the one that presupposes a login to hold it back — `requireUser` resolves
          the personal session with no cookie, so a password there guards nothing and a form for
          changing it is a control with no effect. Both are gone, not greyed. The user RECORD and
          its hash stay in SQLite untouched (DD-015 depth 2), which is what lets a `personal → team`
          switch put both surfaces back with a working account behind them. */}
      {admin && identity && <UsersSection state={state} ui={ui} />}
      {identity && <PasswordSection ui={ui} />}
      <GeneralSection state={state} ui={ui} admin={admin} />
      {/* SB-056: the vault surface sits ABOVE the markdown one, because the shape selector
          decides whether that section still has a working paste-back at all. */}
      {admin && <VaultSection state={state} ui={ui} />}
      {/* SB-095: NOT gated on `admin`, and that is the point. A mirror refusal is about one
          person's own file, so the notice and the adopt action sit in a row every user sees,
          while the mirror PATH — one setting for the whole install — stays admin-only in
          MarkdownSection below. The section draws nothing at all unless something is blocked,
          so a healthy install gains no empty row. */}
      <MirrorSection state={state} ui={ui} admin={admin} />
      {admin && <MarkdownSection state={state} ui={ui} />}
    </div>
  );
}
