import React from 'react';
import TT from '../../i18n';
import { StatusDot } from '../../ds';
import styles from './EntryRow.module.css';
import { TimeCell } from './TimeCell';
import { TaskCell } from './TaskCell';
import { NoteCell } from './NoteCell';
import { BillCell } from './BillCell';
import type { AppState, Entry } from '../../../../shared/types';
import type { UiActions, RegisterCell, NavigateCell } from '../../types';

interface EntryRowProps {
  entry: Entry;
  state: AppState;
  ui: UiActions;
  reg: RegisterCell;
  nav: NavigateCell;
  admin: boolean;
  /** SDD-002 ruling 5: the entry's segment is committed and the viewer is an employee. */
  locked?: boolean;
}

export function EntryRow({ entry, state, ui, reg, nav, admin, locked }: EntryRowProps) {
  const running = TT.isRunning(entry);
  const min = TT.entryMinutes(entry);
  // SDD-002 ruling 5: a committed segment is read-only for the employee. Render a static,
  // dimmed row — no editable cells (so it holds no keyboard focus) and no delete button.
  // Only employees ever get here (admins are exempt), so there is no bill column.
  if (locked) {
    const code = TT.entryProjectCode(state, entry);
    const proj = TT.projectOf(state, code);
    return (
      <div className={[styles.row, styles.locked].join(' ')}>
        <span className={styles.lockedCell}>{TT.fmtTimeCell(entry) || '—'}</span>
        <span className={[styles.lockedCell, styles.lockedTask].join(' ')}>
          {proj && (
            <span className={styles.lockedCode} style={{ color: TT.projColor(state, code) }}>
              {proj.code}
            </span>
          )}
          <span className={styles.lockedLabel}>{entry.label || ''}</span>
          {entry.editedByAdmin && (
            <span className={styles.editedMark} title={TT.t('edited by admin')}>
              ✎ {TT.t('edited')}
            </span>
          )}
        </span>
        <span className={[styles.lockedCell, styles.lockedNote].join(' ')}>{entry.note || ''}</span>
        <div className={styles.hoursCell}>
          <span className={styles.hours} style={{ color: 'var(--text-4)' }}>
            {TT.fmtHours(min)}
          </span>
        </div>
        <span></span>
      </div>
    );
  }
  // Row hover, the running-entry stop/hours swap and the delete-button reveal are all
  // driven by CSS (:hover + the .running data class) — no hover state, so the row no
  // longer re-renders on every mouse move over the hot path.
  return (
    <div className={[styles.row, running && styles.running].filter(Boolean).join(' ')}>
      <TimeCell entry={entry} ui={ui} reg={reg} nav={nav} />
      <TaskCell entry={entry} state={state} ui={ui} reg={reg} nav={nav} />
      <NoteCell entry={entry} ui={ui} reg={reg} nav={nav} />
      {admin && <BillCell entry={entry} ui={ui} reg={reg} nav={nav} />}
      <div className={styles.hoursCell}>
        {running && <StatusDot state="live" color="var(--green)" size={7} />}
        {running && (
          <button className={styles.stop} onClick={() => ui.stop(entry.id)}>
            {TT.t('stop')}
          </button>
        )}
        <span className={styles.hours} style={{ color: running ? 'var(--green)' : 'var(--text-2)' }}>
          {TT.fmtHours(min)}
        </span>
      </div>
      <button className={styles.del} onClick={() => ui.remove(entry.id)} tabIndex={-1}>
        ×
      </button>
    </div>
  );
}
