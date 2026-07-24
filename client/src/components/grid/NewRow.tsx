import React from 'react';
import TT from '../../i18n';
import styles from './NewRow.module.css';
import cells from './cells.module.css';
import type { UiActions, RegisterCell, NavigateCell } from '../../types';

interface NewRowProps {
  date: string;
  ui: UiActions;
  reg: RegisterCell;
  nav: NavigateCell;
  focusLater: (key: string) => void;
  empty: boolean;
  admin: boolean;
}

export function NewRow({ date, ui, reg, nav, focusLater, empty }: NewRowProps) {
  const [draft, setDraft] = React.useState('');
  const [err, setErr] = React.useState(false);
  const commit = () => {
    if (!draft.trim()) return false;
    const parsed = TT.parseTimeCell(draft);
    if (!parsed) {
      setErr(true);
      return false;
    }
    const id = ui.add(date, parsed);
    setDraft('');
    setErr(false);
    focusLater(id + ':1');
    return true;
  };
  return (
    <div className={styles.row}>
      <input
        ref={reg('new', 0)}
        value={draft}
        spellCheck={false}
        placeholder={empty ? '12:00-13:00 · 5h…' : TT.t('+ add')}
        onChange={(ev) => {
          setDraft(ev.target.value);
          setErr(false);
        }}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            commit();
          } else if (ev.key === 'Tab' && !ev.shiftKey && draft.trim()) {
            ev.preventDefault();
            commit();
          } else if (ev.key === 'Escape') {
            setDraft('');
            setErr(false);
          } else if (ev.key === 'ArrowUp') {
            ev.preventDefault();
            nav('new', 0, 'up');
          }
        }}
        onBlur={() => {
          if (draft.trim()) commit();
        }}
        className={[cells.cell, cells.time].join(' ')}
        style={{ borderColor: err ? 'rgba(229,72,77,.5)' : 'transparent' }}
      />
      <span className={styles.err}>{err ? TT.t('unrecognized — try 12:00-13:00, 12:30→ or 1h30m') : ''}</span>
    </div>
  );
}
