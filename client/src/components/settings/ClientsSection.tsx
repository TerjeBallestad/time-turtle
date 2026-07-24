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

export function ClientsSection({ state, ui }: SettingsProps) {
  // SDD-002 ruling 7: archived clients leave the active list for the Archive surface.
  const activeClients = state.clients.filter((client) => !client.archived);
  return (
    <div className={st.section}>
      <SectionLabel
        style={{ marginBottom: 10 }}
        action={
          <Button variant="ghost" size="sm" onClick={() => ui.addClient()}>
            {TT.t('+ client')}
          </Button>
        }
      >
        {TT.t('Clients')}
      </SectionLabel>
      <div className={[st.row, st.rowHead, st.colsClients].join(' ')}>
        {['name', 'rounding', 'default rate'].map((header) => (
          <span key={header} className={st.th}>
            {TT.t(header)}
          </span>
        ))}
        <span></span>
      </div>
      {activeClients.map((client) => (
        <div key={client.id} className={[st.row, st.colsClients].join(' ')}>
          <Input
            value={client.name}
            onChange={(e) => ui.updateClient(client.id, { name: e.target.value })}
            className={st.small}
          />
          <Select
            value={String(client.rounding || 'exact')}
            onChange={(e) =>
              ui.updateClient(client.id, { rounding: e.target.value === 'exact' ? 'exact' : +e.target.value })
            }
            options={[
              { value: 'exact', label: TT.t('exact') },
              { value: '15', label: '15 min ↑' },
              { value: '30', label: '30 min ↑' },
            ]}
            className={st.small}
          />
          <Input
            value={client.rate != null ? client.rate : ''}
            placeholder="—"
            onChange={(e) => ui.updateClient(client.id, { rate: e.target.value === '' ? null : +e.target.value || 0 })}
            className={st.smallMono}
          />
          <button onClick={() => ui.archiveClient(client.id)} className={st.delBtn} title={TT.t('Archive')}>
            ⤓
          </button>
        </div>
      ))}
      {activeClients.length === 0 && <div className={st.empty}>{TT.t('No clients yet.')}</div>}
      <div className={st.hint}>{TT.t('rounding — billed time per entry is rounded up to this increment.')}</div>
    </div>
  );
}
