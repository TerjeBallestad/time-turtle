import React from 'react';
import { caretAtStart, caretAtEnd } from './gridUtils';
import cells from './cells.module.css';
import type { Entry } from '../../../../shared/types';
import type { UiActions, RegisterCell, NavigateCell } from '../../types';

interface NoteCellProps {
  entry: Entry;
  ui: UiActions;
  reg: RegisterCell;
  nav: NavigateCell;
}

export function NoteCell({ entry, ui, reg, nav }: NoteCellProps) {
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <input
      ref={reg(entry.id, 2)}
      spellCheck={false}
      value={draft != null ? draft : entry.note || ''}
      placeholder=""
      onChange={(ev) => setDraft(ev.target.value)}
      onBlur={() => {
        if (draft != null && draft !== entry.note) ui.update(entry.id, { note: draft });
        setDraft(null);
      }}
      onKeyDown={(ev) => {
        const commit = () => {
          if (draft != null && draft !== entry.note) ui.update(entry.id, { note: draft });
          setDraft(null);
        };
        if (ev.key === 'Enter') {
          commit();
          nav(entry.id, 2, 'down');
        } else if (ev.key === 'Escape') {
          setDraft(null);
          ev.currentTarget.blur();
        } else if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          commit();
          nav(entry.id, 2, 'down');
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          commit();
          nav(entry.id, 2, 'up');
        } else if (ev.key === 'ArrowLeft' && caretAtStart(ev.currentTarget)) {
          ev.preventDefault();
          commit();
          nav(entry.id, 2, 'left');
        } else if (ev.key === 'ArrowRight' && caretAtEnd(ev.currentTarget)) {
          ev.preventDefault();
          commit();
          nav(entry.id, 2, 'right');
        }
      }}
      className={[cells.cell, cells.note].join(' ')}
    />
  );
}
