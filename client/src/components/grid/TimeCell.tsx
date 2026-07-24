import React from 'react';
import TT from '../../i18n';
import { caretAtEnd } from './gridUtils';
import cells from './cells.module.css';
import type { Entry } from '../../../../shared/types';
import type { UiActions, RegisterCell, NavigateCell } from '../../types';

interface TimeCellProps {
  entry: Entry;
  ui: UiActions;
  reg: RegisterCell;
  nav: NavigateCell;
}

export function TimeCell({ entry, ui, reg, nav }: TimeCellProps) {
  const value = TT.fmtTimeCell(entry);
  const [draft, setDraft] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const commit = () => {
    if (draft == null || draft === value) {
      setDraft(null);
      setErr(false);
      return true;
    }
    if (draft.trim() === '') {
      setDraft(null);
      setErr(false);
      return true;
    }
    const parsed = TT.parseTimeCell(draft);
    if (!parsed) {
      setErr(true);
      return false;
    }
    const patch =
      parsed.kind === 'duration'
        ? { start: null, end: null, durMin: parsed.min }
        : { start: parsed.start, end: parsed.kind === 'range' ? parsed.end : null, durMin: null };
    ui.update(entry.id, patch);
    setDraft(null);
    setErr(false);
    return true;
  };
  return (
    <input
      ref={reg(entry.id, 0)}
      value={draft != null ? draft : value}
      spellCheck={false}
      onChange={(ev) => {
        setDraft(ev.target.value);
        setErr(false);
      }}
      onFocus={(ev) => ev.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter') {
          if (commit()) nav(entry.id, 0, 'down');
        } else if (ev.key === 'Escape') {
          setDraft(null);
          setErr(false);
          ev.currentTarget.blur();
        } else if (ev.key === 'Tab' && !ev.shiftKey) {
          if (!commit()) ev.preventDefault();
        } else if (ev.key === 'Backspace' && (draft != null ? draft : value) === '') {
          ev.preventDefault();
          ui.remove(entry.id);
        } else if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          if (commit()) nav(entry.id, 0, 'down');
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          if (commit()) nav(entry.id, 0, 'up');
        } else if (ev.key === 'ArrowRight' && caretAtEnd(ev.currentTarget)) {
          ev.preventDefault();
          if (commit()) nav(entry.id, 0, 'right');
        }
      }}
      className={[cells.cell, cells.time].join(' ')}
      style={{
        borderColor: err ? 'rgba(229,72,77,.5)' : 'transparent',
        color: TT.isRunning(entry) ? 'var(--green)' : 'var(--text)',
      }}
    />
  );
}
