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
export function BillCell({ entry, ui, reg, nav }: BillCellProps) {
  const chip = (
    <Chip
      mono={true}
      tone={entry.billable ? 'green' : 'neutral'}
      style={entry.billable ? {} : { color: 'var(--text-4)' }}
    >
      {entry.billable ? 'bill' : 'nb'}
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
