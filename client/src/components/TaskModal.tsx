import React from 'react';
import TT from '../i18n';
import { Button, Modal, FormRow, Input, Select } from '../ds';
import type { AppState } from '../../../shared/types';
import type { UiActions, TaskModalInit } from '../types';

interface TaskModalProps {
  state: AppState;
  ui: UiActions;
  init: TaskModalInit;
  onClose: () => void;
}

// SDD-002: a task is a per-user template — just a (label, project) stamp. No
// billable control: that default lives on the project (admin-owned).
export function TaskModal({ state, ui, init, onClose }: TaskModalProps) {
  const [name, setName] = React.useState(init.name);
  const [project, setProject] = React.useState(state.projects[0] ? state.projects[0].code : '');
  const save = () => {
    if (name.trim()) ui.createTask({ label: name.trim(), project: project || null }, init.entryId);
  };
  return (
    <Modal
      title={TT.t('New task')}
      onClose={onClose}
      style={{ width: 'min(400px, 92vw)' }}
      footer={[
        <Button key="c" variant="ghost" size="sm" onClick={onClose}>
          {TT.t('cancel')}
        </Button>,
        <Button key="s" variant="primary" size="sm" onClick={save} disabled={!name.trim()}>
          {TT.t('create task')}
        </Button>,
      ]}
    >
      <div
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            save();
          }
        }}
      >
        <FormRow label={TT.t('Task name *')}>
          <Input
            autoFocus={true}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={TT.t('e.g. Checkout flow')}
          />
        </FormRow>
        <FormRow label={TT.t('Project')}>
          <Select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            options={[{ value: '', label: '— ' + TT.t('no project') }].concat(
              // SDD-002 ruling 7: an archived project is hidden from this creation picker —
              // you cannot stamp a NEW template onto it (history still resolves elsewhere).
              state.projects
                .filter((project) => !project.archived)
                .map((project) => {
                  const client = TT.clientOf(state, project);
                  return {
                    value: project.code,
                    label: project.code + ' · ' + project.name + (client ? ' (' + client.name + ')' : ''),
                  };
                }),
            )}
          />
        </FormRow>
      </div>
    </Modal>
  );
}
