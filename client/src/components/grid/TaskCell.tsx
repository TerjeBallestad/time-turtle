import React from 'react';
import TT from '../../i18n';
import { caretAtEnd } from './gridUtils';
import cells from './cells.module.css';
import styles from './TaskCell.module.css';
import type { AppState, Entry } from '../../../../shared/types';
import type { UiActions, RegisterCell, NavigateCell } from '../../types';

interface TaskCellProps {
  entry: Entry;
  state: AppState;
  ui: UiActions;
  reg: RegisterCell;
  nav: NavigateCell;
}

// SDD-002: the cell shows the entry's own label + project (copied at birth). The
// dropdown searches the user's personal TEMPLATES; picking one STAMPS its label +
// project onto the entry (a copy, never a link) and derives billable from the
// project the one moment a projectless entry first gets a project.
export function TaskCell({ entry, state, ui, reg, nav }: TaskCellProps) {
  const [editing, setEditing] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const proj = TT.projectOf(state, entry.project);
  const options = React.useMemo(() => {
    if (!editing) return [];
    const needle = query.trim().toLowerCase();
    return state.tasks.filter((candidate) => {
      // SDD-002 ruling 7: a template on an ARCHIVED project is hidden from this stamp
      // picker — picking it would log NEW work against an archived project. Templates with
      // no project, or on an active one, stay.
      const candidateProject = TT.projectOf(state, candidate.project);
      if (candidateProject && candidateProject.archived) return false;
      if (!needle) return true;
      const project = TT.projectOf(state, candidate.project),
        client = TT.clientOf(state, project);
      return (
        candidate.label +
        ' ' +
        (project ? project.code + ' ' + project.name : '') +
        ' ' +
        (client ? client.name : '')
      )
        .toLowerCase()
        .includes(needle);
    });
  }, [editing, query, state]);
  const canCreate =
    query.trim() !== '' &&
    !state.tasks.some((candidate) => candidate.label.toLowerCase() === query.trim().toLowerCase());
  const total = options.length + (canCreate ? 1 : 0);
  const pick = (i: number) => {
    if (i < options.length) {
      const template = options[i];
      // Copy the template's label + project onto the entry. billable derives from
      // the project only when the entry had none yet; a re-stamp never re-derives.
      ui.update(entry.id, {
        project: template.project,
        label: template.label,
        billable: entry.project == null ? TT.projectBillable(state, template.project) : entry.billable,
      });
    } else if (canCreate) {
      ui.openTaskModal(query.trim(), entry.id);
    }
    setEditing(false);
    setQuery('');
  };
  const display = entry.label || '';
  return (
    <div className={styles.wrap}>
      <input
        ref={reg(entry.id, 1)}
        spellCheck={false}
        value={editing ? query : display}
        placeholder={editing ? TT.t('search or create task…') : TT.t('task…')}
        onFocus={(ev) => {
          setEditing(true);
          setQuery('');
          setHighlight(0);
        }}
        onBlur={() => {
          setEditing(false);
          setQuery('');
        }}
        onChange={(ev) => {
          setQuery(ev.target.value);
          setHighlight(0);
        }}
        onKeyDown={(ev) => {
          if (editing && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && total > 0) {
            ev.preventDefault();
            setHighlight((h) => (h + (ev.key === 'ArrowDown' ? 1 : total - 1)) % total);
            return;
          }
          if (ev.key === 'Enter') {
            ev.preventDefault();
            if (total > 0) pick(highlight);
            nav(entry.id, 1, 'right');
          } else if (ev.key === 'Escape') {
            setEditing(false);
            setQuery('');
            ev.currentTarget.blur();
          } else if (ev.key === 'ArrowLeft' && (editing ? query : display) === '') {
            ev.preventDefault();
            nav(entry.id, 1, 'left');
          } else if (ev.key === 'ArrowRight' && caretAtEnd(ev.currentTarget)) {
            ev.preventDefault();
            nav(entry.id, 1, 'right');
          }
        }}
        className={[cells.cell, cells.task].join(' ')}
        style={{ color: entry.label && !editing ? 'transparent' : 'var(--text-2)' }}
      />
      {!editing && entry.label && (
        <span className={styles.overlay}>
          {proj && (
            <span className={styles.code} style={{ color: TT.projColor(state, proj.code) }}>
              {proj.code}
            </span>
          )}
          <span className={styles.name}>{entry.label}</span>
        </span>
      )}
      {editing && total > 0 && (
        <div className={styles.menu}>
          {options.map((option, i) => {
            const project = TT.projectOf(state, option.project),
              client = TT.clientOf(state, project);
            return (
              <div
                key={option.id}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  pick(i);
                  nav(entry.id, 1, 'right');
                }}
                onMouseEnter={() => setHighlight(i)}
                className={[styles.option, i === highlight && styles.active].filter(Boolean).join(' ')}
              >
                {project && (
                  <span className={styles.optCode} style={{ color: TT.projColor(state, project.code) }}>
                    {project.code}
                  </span>
                )}
                <span className={styles.optName}>{option.label}</span>
                {client && <span className={styles.optClient}>{client.name}</span>}
              </div>
            );
          })}
          {canCreate && (
            <div
              onMouseDown={(ev) => {
                ev.preventDefault();
                pick(options.length);
              }}
              onMouseEnter={() => setHighlight(options.length)}
              className={[
                styles.option,
                highlight === options.length && styles.active,
                options.length && styles.createTop,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className={styles.createPlus}>+</span>
              <span className={styles.createText}>{TT.t('create task') + ' “' + query.trim() + '”'}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
