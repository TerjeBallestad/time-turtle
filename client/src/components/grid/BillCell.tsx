import React from 'react';
import { Chip } from '../../ds';
import styles from './BillCell.module.css';
import type { Entry } from '../../../../shared/types';
import type { UiActions, RegisterCell, NavigateCell } from '../../types';

interface BillCellProps {
  entry: Entry;
  ui: UiActions;
  reg: RegisterCell;
  nav: NavigateCell;
}

// SB-011/SB-022: only an admin owns the billable flag, and employees have no bill
// column at all (EntryRow renders this cell for admins only).
//
// SDD-004: ONE SYMBOL AT TWO TONES, not two words. The column used to read `bill` / `nb`, and `nb`
// was worse than terse — `client/src/i18n.ts` uses `nb` for the Norwegian locale, so two letters
// carried two meanings in one codebase. A single `$`, green when billable and dimmed when not,
// makes the column read as one thing. (Tone and tint only; both weights are `font-weight: 400`.
// Colour-carrying-state is the design system's own grammar — see `ds/README.md` on colored dots.)
//
// AN ENTRY'S BILLABILITY HAS ONE SPELLING WHEREVER IT APPEARS, so `ProjectPage` renders the same
// chip over the same field. What this did NOT retire is `nb` in `ProjectsSection`'s SegToggle:
// that control sets a PROJECT's default billability, not an entry's state, and a two-option
// labelled toggle in a settings form is a place where words beat a symbol.
//
// DD-007 does not bind here. It governs the headers in a daily note on disk, not the UI, so
// nothing about the vault format constrains this cell.
export function BillCell({ entry, ui, reg, nav }: BillCellProps) {
  const chip = (
    <Chip
      mono={true}
      tone={entry.billable ? 'green' : 'neutral'}
      style={entry.billable ? {} : { color: 'var(--text-4)' }}
    >
      {'$'}
    </Chip>
  );
  return (
    <button
      ref={reg(entry.id, 3)}
      onClick={() => ui.update(entry.id, { billable: !entry.billable })}
      onKeyDown={(ev) => {
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          nav(entry.id, 3, 'down');
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          nav(entry.id, 3, 'up');
        } else if (ev.key === 'ArrowLeft') {
          ev.preventDefault();
          nav(entry.id, 3, 'left');
        }
      }}
      className={styles.btn}
    >
      {chip}
    </button>
  );
}
