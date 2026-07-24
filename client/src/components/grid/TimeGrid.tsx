// TimeGrid — spreadsheet-style entry grid with smart time cell + task autocomplete
import React from 'react';
import TT from '../../i18n';
import { Chip } from '../../ds';
import styles from './TimeGrid.module.css';
import { EntryRow } from './EntryRow';
import { NewRow } from './NewRow';
import { isAdmin } from '../../roles';
import { isCommitted, isApproved } from '../views/viewUtils';
import type { AppState, Entry } from '../../../../shared/types';
import type { UiActions, GridCell, RegisterCell, NavigateCell } from '../../types';

interface TimeGridProps {
  date: string;
  entries: Entry[];
  state: AppState;
  ui: UiActions;
  compact?: boolean;
}

export function TimeGrid({ date, entries, state, ui, compact }: TimeGridProps) {
  const refs = React.useRef<Record<string, GridCell>>({});
  const pending = React.useRef<string | null>(null);
  const rows = entries;
  const admin = isAdmin(state);
  // SDD-002 ruling 4/5/6: an employee's committed (week∩month) segment is READ-ONLY —
  // the whole day is one segment, so the grid is uniformly locked or not. Admins are
  // exempt (they can still edit committed history), so they never see a locked grid.
  const locked = !admin && isCommitted(state, date);
  // SDD-002 ruling 5 (SB-025): an APPROVED segment is not just committed — it is locked by
  // the admin, so the "reopen from the week header" affordance is gone.
  const lockedByAdmin = locked && isApproved(state, date);
  // A locked grid has no editable cells and no add-row, so keyboard nav has nothing to
  // trap; the ids below drive nav only for the unlocked case.
  const rowIds = rows.map((entry) => entry.id).concat(locked ? [] : ['new']);
  // SB-011/SB-022: the bill cell is column 3 and admin-only; employees have no
  // bill column at all, so their grid ends at note (col 2) and ArrowRight from
  // note has nowhere to go.
  const maxCol = admin ? 3 : 2;
  React.useEffect(() => {
    if (pending.current) {
      const el = refs.current[pending.current];
      if (el) {
        el.focus();
        if ('select' in el) el.select();
      }
      pending.current = null;
    }
  });
  const reg: RegisterCell = (id, col) => (el) => {
    if (el) refs.current[id + ':' + col] = el;
    else delete refs.current[id + ':' + col];
  };
  const nav: NavigateCell = (rowId, col, dir) => {
    const r = rowIds.indexOf(rowId);
    let nr = r,
      nc = col;
    if (dir === 'up') nr = r - 1;
    else if (dir === 'down') nr = r + 1;
    else if (dir === 'left') nc = col - 1;
    else if (dir === 'right') nc = col + 1;
    if (nr < 0 || nr >= rowIds.length || nc < 0 || nc > maxCol) return;
    if (rowIds[nr] === 'new') nc = 0;
    const el = refs.current[rowIds[nr] + ':' + nc];
    if (el) {
      el.focus();
      if ('select' in el) el.select();
    }
  };
  const focusLater = (key: string) => {
    pending.current = key;
  };

  return (
    <div className={[styles.grid, !admin && styles.employee].filter(Boolean).join(' ')}>
      {!compact && (
        <div className={styles.header}>
          {(admin ? ['time', 'task', 'note', 'bill'] : ['time', 'task', 'note']).map((header) => (
            <span key={header} className={styles.headerCell}>
              {TT.t(header)}
            </span>
          ))}
          <span className={styles.headerHours}>{'Σ ' + TT.t('hours')}</span>
          <span></span>
        </div>
      )}
      {locked && (
        <div className={styles.lockedBanner}>
          <Chip tone={lockedByAdmin ? 'accent' : 'green'} mono={true}>
            {lockedByAdmin ? TT.t('locked') : TT.t('committed')}
          </Chip>
          <span className={styles.lockedHint}>
            {lockedByAdmin ? TT.t('approved by admin — locked') : TT.t('read-only — reopen from the week header')}
          </span>
        </div>
      )}
      {rows.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          state={state}
          ui={ui}
          reg={reg}
          nav={nav}
          admin={admin}
          locked={locked}
        />
      ))}
      {!locked && (
        <NewRow
          key="new"
          date={date}
          ui={ui}
          reg={reg}
          nav={nav}
          focusLater={focusLater}
          empty={rows.length === 0}
          admin={admin}
        />
      )}
    </div>
  );
}
