import React from 'react';
import TT from '../../i18n';
import { SegToggle, ProgressBar } from '../../ds';
import { api } from '../../api';
import { isAdmin } from '../../roles';
import vs from './views.module.css';
import sh from '../shared.module.css';
import type { AppState, Entry, TeamReportRow } from '../../../../shared/types';
import type { UiActions } from '../../types';

function periodFilter(state: AppState, period: string): (entry: Entry) => boolean {
  const today = TT.todayStr();
  if (period === 'week') {
    const days = TT.weekDates(today);
    return (entry) => days.includes(entry.date);
  }
  if (period === 'month') {
    const month = today.slice(0, 7);
    return (entry) => entry.date.startsWith(month);
  }
  return () => true;
}
// The same period as an inclusive range for the server — kept next to periodFilter
// so the two readings of a period cannot drift apart.
function periodRange(period: string): { from?: string; to?: string } {
  const today = TT.todayStr();
  if (period === 'week') {
    const days = TT.weekDates(today);
    return { from: days[0], to: days[6] };
  }
  if (period === 'month') {
    const month = today.slice(0, 7);
    return { from: month + '-01', to: month + '-31' };
  }
  return {};
}

// Own entries in the shape the team endpoint returns, so one grouping path serves
// both scopes. One row per entry — grouping sums them anyway.
function ownRows(state: AppState, period: string): TeamReportRow[] {
  return state.entries.filter(periodFilter(state, period)).map((entry) => {
    const code = TT.entryProjectCode(state, entry);
    const project = TT.projectOf(state, code);
    return {
      userId: state.user.id,
      userName: state.user.name,
      project: code,
      clientId: project ? project.clientId : null,
      min: TT.entryMinutes(entry),
      // SDD-002 ruling 8: a committed month stays frozen against a rate renegotiation
      // here too, matching the team report + invoice (same shared snapshot-preferring reader).
      bill: TT.effectiveBillMinutes(state, entry),
      amount: TT.effectiveAmount(state, entry),
      entries: 1,
    };
  });
}

interface Group {
  key: string;
  label: string;
  sub: string;
  min: number;
  bill: number;
  amt: number;
  n: number;
}

function groupBy(state: AppState, rows: TeamReportRow[], by: string): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const key = by === 'person' ? String(row.userId) : by === 'client' ? row.clientId || '—' : row.project || '—';
    let group = groups.get(key);
    if (!group) {
      let label = key,
        sub = '';
      if (by === 'person') label = row.userName;
      else if (by === 'client') {
        const client = state.clients.find((candidate) => candidate.id === key);
        label = client ? client.name : TT.t('no client');
      } else {
        const project = TT.projectOf(state, key);
        if (project) {
          label = project.name;
          const client = TT.clientOf(state, project);
          sub = client ? client.name : '';
        } else label = TT.t('no project');
      }
      group = { key, label, sub, min: 0, bill: 0, amt: 0, n: 0 };
      groups.set(key, group);
    }
    group.min += row.min;
    group.bill += row.bill;
    group.amt += row.amount;
    group.n += row.entries;
  }
  return [...groups.values()].sort((a, b) => b.min - a.min);
}

interface ViewProps {
  state: AppState;
  ui: UiActions;
}

export function ReportsView({ state, ui }: ViewProps) {
  const admin = isAdmin(state);
  const [period, setPeriod] = React.useState('week');
  const [by, setBy] = React.useState('project');
  // 'team' pulls the admin aggregate; 'me' stays entirely client-side on own entries.
  const [scope, setScope] = React.useState('me');
  const [team, setTeam] = React.useState<TeamReportRow[] | null>(null);
  const [teamError, setTeamError] = React.useState('');
  const teamScope = admin && scope === 'team';

  React.useEffect(() => {
    if (!teamScope) {
      setTeam(null);
      setTeamError('');
      return;
    }
    let cancelled = false;
    setTeam(null);
    setTeamError('');
    api
      .teamReport(periodRange(period))
      .then((res) => {
        if (!cancelled) setTeam(res.rows);
      })
      .catch((err) => {
        if (!cancelled) {
          setTeam([]);
          setTeamError(err.message || 'could not load the team report');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [teamScope, period]);

  // employees see hours only — billed/amount columns need rates the server never sends them
  const cols = admin ? 'minmax(180px,1fr) 120px 70px 70px 110px' : 'minmax(180px,1fr) 120px 70px';
  const loading = teamScope && team === null && !teamError;
  const rows = groupBy(state, teamScope ? (team ?? []) : ownRows(state, period), by);
  const maxMin = Math.max(1, ...rows.map((row) => row.min));
  const totAmt = rows.reduce((sum, row) => sum + row.amt, 0),
    totMin = rows.reduce((sum, row) => sum + row.min, 0),
    totBill = rows.reduce((sum, row) => sum + row.bill, 0);
  const byOptions = [
    { value: 'project', label: TT.t('by project') },
    { value: 'client', label: TT.t('by client') },
  ];
  if (admin) byOptions.push({ value: 'person', label: TT.t('by person') });
  return (
    <div className={vs.page}>
      <div className={vs.headerRow}>
        <h1 className={vs.h1}>{TT.t('Reports')}</h1>
        <span className={vs.controls}>
          {admin && (
            <SegToggle
              options={[
                { value: 'me', label: TT.t('me') },
                { value: 'team', label: TT.t('team') },
              ]}
              value={scope}
              onChange={setScope}
            />
          )}
          <SegToggle options={byOptions} value={by} onChange={setBy} />
          <SegToggle
            options={[
              { value: 'week', label: TT.t('this week') },
              { value: 'month', label: TT.t('this month') },
              { value: 'all', label: TT.t('all') },
            ]}
            value={period}
            onChange={setPeriod}
          />
        </span>
      </div>
      {teamError && <div className={vs.errLine}>{teamError}</div>}
      <div className={vs.table}>
        <div className={vs.headRow} style={{ gridTemplateColumns: cols }}>
          <span className={vs.th}>{TT.t(by)}</span>
          <span className={vs.th}></span>
          <span className={[vs.th, vs.right].join(' ')}>{TT.t('hours')}</span>
          {admin && <span className={[vs.th, vs.right].join(' ')}>{TT.t('billed')}</span>}
          {admin && <span className={[vs.th, vs.right].join(' ')}>{TT.t('amount')}</span>}
        </div>
        {loading && <div className={vs.empty}>{TT.t('Loading…')}</div>}
        {!loading && rows.length === 0 && <div className={vs.empty}>{TT.t('Nothing tracked in this period.')}</div>}
        {!loading &&
          rows.map((row) => (
            <div key={row.key} className={vs.bodyRow} style={{ gridTemplateColumns: cols }}>
              <span className={vs.tdFlex}>
                {by === 'project' && row.key !== '—' && (
                  <span className={vs.code} style={{ color: TT.projColor(state, row.key) }}>
                    {row.key}
                  </span>
                )}
                <span className={sh.ellipsis}>{row.label}</span>
                {row.sub && <span className={vs.sub}>{row.sub}</span>}
              </span>
              <span className={vs.barCell}>
                <ProgressBar
                  value={row.min}
                  max={maxMin}
                  width={96}
                  color={by === 'project' && row.key !== '—' ? TT.projColor(state, row.key) : 'var(--accent)'}
                />
              </span>
              <span className={[vs.td, vs.mono, vs.right, vs.cBody].join(' ')}>{TT.fmtHours(row.min)}</span>
              {admin && (
                <span className={[vs.td, vs.mono, vs.right, vs.cSecondary].join(' ')}>{TT.fmtHours(row.bill)}</span>
              )}
              {admin && (
                <span className={[vs.td, vs.mono, vs.right, vs.cBody].join(' ')}>
                  {TT.fmtMoney(row.amt, state.settings.currency)}
                </span>
              )}
            </div>
          ))}
        <div className={vs.totalRow} style={{ gridTemplateColumns: cols }}>
          <span className={[vs.td, vs.bold].join(' ')}>{TT.t('total')}</span>
          <span></span>
          <span className={[vs.td, vs.mono, vs.right, vs.bold].join(' ')}>{TT.fmtHours(totMin)}</span>
          {admin && <span className={[vs.td, vs.mono, vs.right, vs.cSecondary].join(' ')}>{TT.fmtHours(totBill)}</span>}
          {admin && (
            <span className={[vs.td, vs.mono, vs.right, vs.bold].join(' ')}>
              {TT.fmtMoney(totAmt, state.settings.currency)}
            </span>
          )}
        </div>
      </div>
      {admin && (
        <div className={vs.note}>
          {TT.t(
            'billed = hours rounded up per entry to the client’s rounding · non-billable entries excluded from billed and amount.',
          )}
        </div>
      )}
      {teamScope && (
        <div className={vs.noteTight}>
          {TT.t('team totals are aggregated on the server — individual entries stay private to each user.')}
        </div>
      )}
    </div>
  );
}
