import React from 'react';
import TT from '../../i18n';
import { Chip, StatusDot } from '../../ds';
import { isAdmin } from '../../roles';
import { sumMin } from './viewUtils';
import vs from './views.module.css';
import sh from '../shared.module.css';
import pp from './ProjectPage.module.css';
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface ProjectPageProps {
  state: AppState;
  ui: UiActions;
  code: string;
}

export function ProjectPage({ state, ui, code }: ProjectPageProps) {
  const admin = isAdmin(state);
  const project = TT.projectOf(state, code);
  if (!project)
    return (
      <div className={vs.page}>
        <p className={vs.notFound}>{TT.t('Project not found — it may have been removed.')}</p>
      </div>
    );
  const client = TT.clientOf(state, project);
  const entries = state.entries
    .filter((entry) => TT.entryProjectCode(state, entry) === code)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const min = sumMin(entries),
    // SDD-002 ruling 8: committed entries read their frozen snapshot (shared reader).
    amount = entries.reduce((sum, entry) => sum + TT.effectiveAmount(state, entry), 0);
  return (
    <div className={vs.page}>
      <div className={vs.projHead}>
        <StatusDot state="solid" color={TT.projColor(state, code)} size={9} style={{ alignSelf: 'center' }} />
        <span className={vs.projCode} style={{ color: TT.projColor(state, code) }}>
          {code}
        </span>
        <h1 className={vs.h1}>{project.name}</h1>
      </div>
      <div className={vs.chipRow}>
        {client && <Chip>{client.name}</Chip>}
        <Chip mono={true}>{TT.fmtHours(min) + TT.t('h') + ' ' + TT.t('total')}</Chip>
        {admin && (
          <Chip mono={true} tone="green">
            {TT.fmtMoney(amount, state.settings.currency)}
          </Chip>
        )}
        {admin && (
          <Chip mono={true}>{TT.fmtMoney(TT.rateOf(state, code), state.settings.currency) + '/' + TT.t('h')}</Chip>
        )}
      </div>
      <div className={vs.table}>
        {entries.length === 0 && <div className={vs.empty}>{TT.t('No hours on this project yet.')}</div>}
        {entries.map((entry) => {
          return (
            <div key={entry.id} className={[vs.bodyRow, pp.cols].join(' ')}>
              <span className={[vs.td, vs.mono, vs.cSecondary].join(' ')}>{entry.date.slice(5)}</span>
              <span
                className={[vs.td, vs.mono].join(' ')}
                style={{ color: TT.isRunning(entry) ? 'var(--green)' : 'var(--text)' }}
              >
                {TT.fmtTimeCell(entry)}
              </span>
              <span className={[vs.td, vs.fs12, sh.ellipsis].join(' ')}>{entry.label || ''}</span>
              <span className={[vs.td, vs.cSecondary, sh.ellipsis].join(' ')}>{entry.note || ''}</span>
              <span className={pp.billCell}>
                <Chip
                  mono={true}
                  tone={entry.billable ? 'green' : 'neutral'}
                  style={entry.billable ? {} : { color: 'var(--text-4)' }}
                >
                  {entry.billable ? 'bill' : 'nb'}
                </Chip>
              </span>
              <span className={[vs.td, vs.mono, vs.right].join(' ')}>{TT.fmtHours(TT.entryMinutes(entry))}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
