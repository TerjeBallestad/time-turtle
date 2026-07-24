import React from 'react';
import TT from '../../i18n';
import { SectionLabel, Button, Select, Input } from '../../ds';
import st from './settings.module.css';
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface SettingsProps {
  state: AppState;
  ui: UiActions;
}

// SDD-002: tasks are per-user templates — private (label, project) stamps. No
// billable column anywhere (the project owns that default), and no cross-user reach.
export function TasksSection({ state, ui }: SettingsProps) {
  return (
    <div className={st.section}>
      <SectionLabel
        style={{ marginBottom: 10 }}
        action={
          <Button variant="ghost" size="sm" onClick={() => ui.openTaskModal('')}>
            {TT.t('+ task')}
          </Button>
        }
      >
        {TT.t('Tasks')}
      </SectionLabel>
      <div className={[st.row, st.rowHead, st.colsTasks].join(' ')}>
        {['name', 'project'].map((header) => (
          <span key={header} className={st.th}>
            {TT.t(header)}
          </span>
        ))}
        <span></span>
      </div>
      {state.tasks.map((task) => (
        <div key={task.id} className={[st.row, st.colsTasks].join(' ')}>
          <Input
            value={task.label}
            onChange={(e) => ui.updateTask(task.id, { label: e.target.value })}
            className={st.small}
          />
          <Select
            value={task.project || ''}
            onChange={(e) => ui.updateTask(task.id, { project: e.target.value || null })}
            options={[{ value: '', label: '— ' + TT.t('no project') }].concat(
              // SDD-002 ruling 7: hide archived projects — a template can't target new work at one.
              state.projects
                .filter((project) => !project.archived)
                .map((project) => ({ value: project.code, label: project.code + ' · ' + project.name })),
            )}
            className={st.small}
          />
          <button onClick={() => ui.removeTask(task.id)} className={st.delBtn}>
            ×
          </button>
        </div>
      ))}
      {state.tasks.length === 0 && (
        <div className={st.empty}>{TT.t('No tasks yet — create one from the time grid.')}</div>
      )}
      <div className={st.hint}>
        {TT.t('templates are your own reusable (label, project) stamps; logging an hour copies them onto the entry.')}
      </div>
    </div>
  );
}
