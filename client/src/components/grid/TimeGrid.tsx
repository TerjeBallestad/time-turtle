// TimeGrid — spreadsheet-style entry grid with smart time cell + task autocomplete
import React from 'react';
import TT from '../../i18n';
import { Chip } from '../../ds';
import styles from './TimeGrid.module.css';
import { EntryRow } from './EntryRow';
import { NewRow } from './NewRow';
import { isAdmin } from '../../roles';
import { isApproved } from '../views/viewUtils';
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
  // SB-102 / DD-017 §1: the lock is a property of THE DAY, not of the role. Under `team` this is
  // still SDD-002 ruling 4/5/6 exactly — an employee's committed (week∩month) segment is
  // read-only, admins are exempt so they can correct history — and `TT.readOnlyDay`'s team
  // branch is that expression, unchanged, which the existing suite and tests-browser prove.
  //
  // Under `personal` the exemption was the bug: the one user IS the seeded admin (DD-015
  // depth 2), so `!admin && …` never fired for the only person there is, and a week from before
  // the vault rendered fully editable — add-row and all — under a chip reading `committed`.
  // DD-016's "the lock mechanism already exists" was false here; DD-017 §1 is the ruling that
  // fixes it, and the rule now lives in one place beside `TT.vaultBound` rather than in this file.
  const ctx = {
    shape: state.shape,
    vaultCutover: state.settings.vaultCutover,
    commits: state.commits,
    admin,
  };
  const locked = TT.readOnlyDay(date, ctx);
  // WHY the day is locked, kept apart, because the banner below has to say different things and
  // a personal user must never be pointed at a verb their week header does not have.
  const preVault = TT.preCutover(date, ctx); // both are false under `team` by construction,
  const frozen = TT.frozenSegment(date, ctx); // so every branch below falls through to today's
  // SDD-002 ruling 5 (SB-025): an APPROVED segment is not just committed — it is locked by
  // the admin, so the "reopen from the week header" affordance is gone. A `team` concept: under
  // `personal` there is no admin over you, so an approval stamped before a shape switch does not
  // get to relabel your own frozen week.
  const lockedByAdmin = locked && !preVault && !frozen && isApproved(state, date);
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
      {/* DD-017 §1: the banner is honest per-day, because under `personal` the old one told two
          lies at once. A day from before the vault was never `committed` by anybody, so the green
          chip was false; and `reopen from the week header` pointed at a verb the personal week
          header does not have (WeekView hides it behind `committingOff`). Under `team` both the
          chip and the hint are byte-identical to what they always were — `preVault` and `frozen`
          are false there by construction. */}
      {locked && (
        <div className={styles.lockedBanner}>
          {preVault ? (
            // No chip: nothing was committed, and DD-017 §4 rules the words. It says what is
            // true — these hours predate the vault — and promises nothing about phase 3.
            <span className={styles.lockedHint}>{TT.t('before your vault · read-only')}</span>
          ) : (
            <>
              <Chip tone={lockedByAdmin ? 'accent' : 'green'} mono={true}>
                {lockedByAdmin ? TT.t('locked') : TT.t('committed')}
              </Chip>
              <span className={styles.lockedHint}>
                {lockedByAdmin
                  ? TT.t('approved by admin — locked')
                  : frozen
                    ? // The user clicked commit themselves, so the chip stays — but there is no
                      // reopen verb to send them to in this shape, and pointing at one is worse
                      // than saying less.
                      TT.t('read-only')
                    : TT.t('read-only — reopen from the week header')}
              </span>
            </>
          )}
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
