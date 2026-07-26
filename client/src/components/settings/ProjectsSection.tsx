import React from 'react';
import TT from '../../i18n';
import { SectionLabel, Button, Select, Input, SegToggle } from '../../ds';
import st from './settings.module.css';
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface SettingsProps {
  state: AppState;
  ui: UiActions;
}

// DC-005 (PLAN-006): the project CODE is edited through a DELIBERATE commit, not a
// per-keystroke rewrite. A per-keystroke change would fire the server rename — a cross-user
// transaction — for every character typed. Local state holds the in-progress edit; it
// commits on blur or Enter (via ui.renameProject → the server endpoint), and resets to the
// server truth if the edit is empty/unchanged/rejected. The display NAME stays live (plain
// updateProject); only the code takes the server path.
function ProjectCodeInput({
  code,
  color,
  onCommit,
}: {
  code: string;
  color: string;
  onCommit: (next: string) => void;
}) {
  const [value, setValue] = React.useState(code);
  // resync when the server truth changes (e.g. after a successful rename reload)
  React.useEffect(() => setValue(code), [code]);
  const commit = () => {
    const next = value.trim().toUpperCase();
    // Snap back to the CURRENT server code in every case, then ask for the rename. The
    // useEffect above only fires when `code` actually CHANGES, so on a rejected rename (a
    // taken code) it never fires and the field would keep showing the refused code —
    // `renameProject`'s reload cannot fix that on its own. Found by SB-087's browser pass
    // against the identical seam in ClientIdInput; fixed here too rather than left to rot.
    setValue(code);
    if (next && next !== code) onCommit(next);
  };
  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value.toUpperCase())}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setValue(code);
          e.currentTarget.blur();
        }
      }}
      className={[st.small, st.codeInput].join(' ')}
      style={{ color }}
    />
  );
}

export function ProjectsSection({ state, ui }: SettingsProps) {
  // SDD-002 ruling 7: archived projects leave the active list (they live in the Archive
  // surface); archived clients leave the client picker (you cannot log NEW work on them).
  const activeProjects = state.projects.filter((project) => !project.archived);
  const activeClients = state.clients.filter((client) => !client.archived);
  return (
    <div className={st.section}>
      <SectionLabel
        style={{ marginBottom: 10 }}
        action={
          <Button variant="ghost" size="sm" onClick={() => ui.addProject()}>
            {TT.t('+ project')}
          </Button>
        }
      >
        {TT.t('Projects')}
      </SectionLabel>
      <div className={[st.row, st.rowHead, st.colsProjects].join(' ')}>
        {['code', 'name', 'client', 'rate', 'bill'].map((header) => (
          <span key={header} className={st.th}>
            {TT.t(header)}
          </span>
        ))}
        <span></span>
      </div>
      {activeProjects.map((project) => (
        <div key={project.code} className={[st.row, st.colsProjects].join(' ')}>
          <ProjectCodeInput
            code={project.code}
            color={TT.projColor(state, project.code)}
            onCommit={(next) => ui.renameProject(project.code, next)}
          />
          <Input
            value={project.name}
            onChange={(e) => ui.updateProject(project.code, { name: e.target.value })}
            className={st.small}
          />
          <Select
            value={project.clientId || ''}
            onChange={(e) => ui.updateProject(project.code, { clientId: e.target.value || null })}
            options={[{ value: '', label: '— ' + TT.t('no client') }].concat(
              activeClients.map((client) => ({ value: client.id, label: client.name })),
            )}
            className={st.small}
          />
          <Input
            value={project.rate != null ? project.rate : ''}
            placeholder={TT.t('client rate')}
            onChange={(e) =>
              ui.updateProject(project.code, { rate: e.target.value === '' ? null : +e.target.value || 0 })
            }
            className={st.smallMono}
          />
          <SegToggle
            options={[
              { value: 'bill', label: TT.t('bill') },
              { value: 'nb', label: 'nb' },
            ]}
            value={project.billable === false ? 'nb' : 'bill'}
            onChange={(v) => ui.updateProject(project.code, { billable: v === 'bill' })}
          />
          <button onClick={() => ui.archiveProject(project.code)} className={st.delBtn} title={TT.t('Archive')}>
            ⤓
          </button>
        </div>
      ))}
      <div className={st.hint}>
        {TT.t('rate — overrides the client default. bill — the billable default new hours on this project inherit.')}
      </div>
    </div>
  );
}
