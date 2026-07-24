import React from 'react';
import TT from '../../i18n';
import { Chip, Button, Select } from '../../ds';
import vs from './views.module.css';
import sh from '../shared.module.css';
import iv from './InvoiceView.module.css';
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface ViewProps {
  state: AppState;
  ui: UiActions;
}

export function InvoiceView({ state, ui }: ViewProps) {
  const months = [...new Set(state.entries.map((entry) => entry.date.slice(0, 7)))].sort().reverse();
  const [clientId, setClientId] = React.useState(state.clients[0] ? state.clients[0].id : '');
  const [month, setMonth] = React.useState(months[0] || TT.todayStr().slice(0, 7));
  const client = state.clients.find((candidate) => candidate.id === clientId);
  const entries = state.entries
    .filter((entry) => {
      if (!entry.date.startsWith(month) || !entry.billable) return false;
      const project = TT.projectOf(state, TT.entryProjectCode(state, entry));
      return project && project.clientId === clientId && !TT.isRunning(entry);
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  // SDD-002 ruling 8: read the FROZEN snapshot for a committed entry and live money
  // otherwise, via the shared snapshot-preferring readers — so a rate renegotiation
  // moves an uncommitted month but never a committed one. This admin view carries full
  // snapshots (an admin's money is never stripped).
  const totBill = entries.reduce((sum, entry) => sum + TT.effectiveBillMinutes(state, entry), 0);
  const totAmt = entries.reduce((sum, entry) => sum + TT.effectiveAmount(state, entry), 0);
  const currency = state.settings.currency;
  const copyMd = () => {
    const lines = [
      '# Invoice — ' + (client ? client.name : '') + ' — ' + TT.fmtMonth(month),
      '',
      '| date | project | note | hours | amount |',
      '|---|---|---|---:|---:|',
    ];
    entries.forEach((entry) => {
      lines.push(
        '| ' +
          entry.date +
          ' | ' +
          (entry.label || '') +
          ' | ' +
          (entry.note || '') +
          ' | ' +
          TT.fmtHours(TT.effectiveBillMinutes(state, entry)) +
          ' | ' +
          TT.fmtMoney(TT.effectiveAmount(state, entry), currency) +
          ' |',
      );
    });
    lines.push('| | | **total** | **' + TT.fmtHours(totBill) + '** | **' + TT.fmtMoney(totAmt, currency) + '** |');
    navigator.clipboard.writeText(lines.join('\n')).then(() => ui.toast(TT.t('Invoice copied as markdown')));
  };
  return (
    <div className={vs.page}>
      <div className={vs.headerRow}>
        <h1 className={vs.h1}>{TT.t('Invoice')}</h1>
        <span className={vs.controlsCenter}>
          <Select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            options={state.clients.map((clientOption) => ({ value: clientOption.id, label: clientOption.name }))}
            className={iv.sel170}
          />
          <Select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            options={months.map((monthKey) => ({ value: monthKey, label: TT.fmtMonth(monthKey) }))}
            className={iv.sel130}
          />
          <Button variant="secondary" size="sm" onClick={copyMd} disabled={!entries.length}>
            {TT.t('copy as markdown')}
          </Button>
        </span>
      </div>
      {client && (
        <div className={vs.chipRow}>
          <Chip mono={true}>
            {TT.t('round: ') + (client.rounding === 'exact' ? TT.t('exact') : client.rounding + ' min ↑')}
          </Chip>
          <Chip mono={true}>
            {TT.t('rate: ') +
              (client.rate != null ? TT.fmtMoney(client.rate, currency) + '/' + TT.t('h') : TT.t('per project'))}
          </Chip>
        </div>
      )}
      <div className={vs.table}>
        <div className={[vs.headRow, iv.cols].join(' ')}>
          {['date', 'task', 'note'].map((header) => (
            <span key={header} className={vs.th}>
              {TT.t(header)}
            </span>
          ))}
          <span className={[vs.th, vs.right].join(' ')}>{TT.t('hours')}</span>
          <span className={[vs.th, vs.right].join(' ')}>{TT.t('amount')}</span>
        </div>
        {entries.length === 0 && (
          <div className={vs.empty}>
            {TT.t('No billable hours for ') + (client ? client.name : '?') + TT.t(' in ') + TT.fmtMonth(month) + '.'}
          </div>
        )}
        {entries.map((entry) => {
          const code = TT.entryProjectCode(state, entry);
          return (
            <div key={entry.id} className={[vs.bodyRow, iv.cols].join(' ')}>
              <span className={[vs.td, vs.mono, vs.cSecondary].join(' ')}>{entry.date.slice(5)}</span>
              <span className={iv.taskCell}>
                <span className={vs.code} style={{ color: TT.projColor(state, code) }}>
                  {code}
                </span>
                <span className={[sh.ellipsis, vs.fs12].join(' ')}>{entry.label || ''}</span>
              </span>
              <span className={[vs.td, vs.cSecondary, sh.ellipsis].join(' ')}>{entry.note || ''}</span>
              <span className={[vs.td, vs.mono, vs.right].join(' ')}>
                {TT.fmtHours(TT.effectiveBillMinutes(state, entry))}
              </span>
              <span className={[vs.td, vs.mono, vs.right].join(' ')}>
                {TT.fmtMoney(TT.effectiveAmount(state, entry), currency)}
              </span>
            </div>
          );
        })}
        <div className={[vs.totalRow, iv.cols].join(' ')}>
          <span className={[vs.td, vs.bold, iv.totalLabel].join(' ')}>
            {TT.t('total') + ' — ' + (client ? client.name : '') + ' · ' + TT.fmtMonth(month)}
          </span>
          <span className={[vs.td, vs.mono, vs.right, vs.bold].join(' ')}>{TT.fmtHours(totBill)}</span>
          <span className={[vs.td, vs.mono, vs.right, vs.bold].join(' ')}>{TT.fmtMoney(totAmt, currency)}</span>
        </div>
      </div>
    </div>
  );
}
