import React from 'react';
import TT from '../../i18n';
import { SectionLabel, Button, Select, Input } from '../../ds';
import { makeClientId } from '../../clientIds';
import st from './settings.module.css';
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface SettingsProps {
  state: AppState;
  ui: UiActions;
}

// SB-087 (SB-067 fix 3): the client ID, finally reachable. It used to be write-once and
// invisible — this section rendered name, rounding and rate and nothing else — so a client
// that picked up a wrong id (or a `client7` that was already referenced when its name was
// first committed, which `derivedClientId` deliberately declines to touch) was stuck with it.
//
// Edited through a DELIBERATE commit, exactly like ProjectCodeInput: local state holds the
// in-progress edit and commits on blur or Enter, Escape resets, and a useEffect resyncs to
// the server truth after the reload a successful rename triggers. Per keystroke would fire
// the server rename — a transaction that re-points every project — for every character typed,
// and would remount the row (key={client.id}) under the user's cursor.
//
// REUSE, DO NOT RE-DERIVE: what is typed is normalized through `makeClientId`, the very
// function the name-blur derive uses (SB-067 fix 2), so the two paths can never disagree
// about what a readable id looks like. It also guarantees no `|` — which matters because
// this string is a cell in the mirror's `## clients` table AND the join key in every
// `## projects` row.
function ClientIdInput({ id, onCommit }: { id: string; onCommit: (next: string) => void }) {
  const [value, setValue] = React.useState(id);
  // resync when the server truth changes (e.g. after a successful rename reload)
  React.useEffect(() => setValue(id), [id]);
  const commit = () => {
    const next = makeClientId(value);
    // Snap back to the CURRENT server id in EVERY case, then ask for the rename. On success
    // the reload changes `id` and the effect above paints the new one; on a REJECTED rename
    // (a taken id) `id` never changes, so the effect never fires — without this reset the
    // field would go on showing the id the server just refused, a control lying about what
    // it holds while the store says otherwise. Found at the browser rung, not reasoned about.
    setValue(id);
    if (next && next !== id) onCommit(next);
  };
  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setValue(id);
          e.currentTarget.blur();
        }
      }}
      className={[st.small, st.codeInput].join(' ')}
    />
  );
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
        {['id', 'name', 'rounding', 'default rate'].map((header) => (
          <span key={header} className={st.th}>
            {TT.t(header)}
          </span>
        ))}
        <span></span>
      </div>
      {activeClients.map((client) => (
        <div key={client.id} className={[st.row, st.colsClients].join(' ')}>
          <ClientIdInput id={client.id} onCommit={(next) => ui.renameClient(client.id, next)} />
          <Input
            value={client.name}
            onChange={(e) => ui.updateClient(client.id, { name: e.target.value })}
            // SB-067: the id is derived from the name at this commit boundary (see App.commitClientName).
            onBlur={() => ui.commitClientName(client.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
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
