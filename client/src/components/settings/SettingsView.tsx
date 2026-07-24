// Settings: clients, projects, tasks, users (admin), general, markdown backend
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
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface SettingsProps {
  state: AppState;
  ui: UiActions;
}

export function SettingsView({ state, ui }: SettingsProps) {
  const admin = isAdmin(state);
  return (
    <div className={[vs.page, vs.settingsPage].join(' ')}>
      <h1 className={[vs.h1, vs.mb24].join(' ')}>{TT.t('Settings')}</h1>
      {admin && <ClientsSection state={state} ui={ui} />}
      {admin && <ProjectsSection state={state} ui={ui} />}
      {admin && <ArchiveSection state={state} ui={ui} />}
      <TasksSection state={state} ui={ui} />
      {admin && <UsersSection state={state} ui={ui} />}
      <PasswordSection ui={ui} />
      <GeneralSection state={state} ui={ui} admin={admin} />
      {admin && <MarkdownSection state={state} ui={ui} />}
    </div>
  );
}
