import React from 'react';
import TT from '../../i18n';
import { StatusDot, SectionLabel, Button, Chip } from '../../ds';
import { TimeGrid } from '../grid/TimeGrid';
import { GridFooter } from '../grid/GridFooter';
import { SyntaxHint } from '../grid/SyntaxHint';
import { entriesOn, sumMin, committedKeys, approvedKeys } from './viewUtils';
import vs from './views.module.css';
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

// A segment lives inside one calendar month, so its range is always "d–d Mon". The
// month abbrev goes through the i18n-aware fmtMonth ("Jul 2026" → "Jul") so the chips
// localize with the rest of the week header (fmtDayShort) instead of hardcoding English.
function segRange(dates: string[]): string {
  const firstDay = Number(dates[0].slice(8));
  const lastDay = Number(dates[dates.length - 1].slice(8));
  const month = TT.fmtMonth(dates[0].slice(0, 7)).split(' ')[0];
  return firstDay + '–' + lastDay + ' ' + month;
}

interface ViewProps {
  state: AppState;
  ui: UiActions;
}

export function WeekView({ state, ui }: ViewProps) {
  const [offset, setOffset] = React.useState(0);
  const anchor = TT.addDays(TT.todayStr(), offset * 7);
  const days = TT.weekDates(anchor);
  const weekInfo = TT.isoWeek(days[0]);
  const allEntries = state.entries.filter((entry) => days.includes(entry.date));
  const today = TT.todayStr();
  // SDD-002 ruling 4 (SB-024): one commit chip per (week∩month) segment — a month-
  // straddling week shows two, each independently committable. State is per-user, so
  // these are always the logged-in user's own segments.
  const segments = TT.weekSegments(anchor);
  const committed = committedKeys(state);
  // SDD-002 ruling 5 (SB-025): an admin-APPROVED segment is LOCKED — the employee can no
  // longer reopen it, so its reopen verb is gone and the chip reads 'locked'.
  const approved = approvedKeys(state);
  // SB-056 / DD-008: under the vault backend there is nowhere to persist a commit — the ledger
  // belongs in weekly notes, which are phase 3 — so the server refuses one. This is the half
  // the user actually meets. SB-056's ruling is explicit that it must not be a hidden disabled
  // button: "switching backends silently losing a shipped feature is the kind of thing that
  // reads as a bug months later… it should say WHY it is off and that phase 3 restores it."
  //
  // It is also not optional. `useServerSync` re-queues any non-409 failure and re-arms a 4 s
  // timer forever, so leaving the verb on screen under `vault` would turn one click into a
  // permanent toast loop. The gate the server enforces and the gate the UI shows have to be
  // the same gate, which is why both read `TT.backendCapabilities` rather than either one
  // deciding for itself.
  //
  // `state.backend` is absent on an older server; backendCapabilities resolves that to the
  // sqlite row, so this reads `committing: true` and nothing changes.
  const committingOff = TT.backendOffReason('committing', state.backend);
  return (
    <div className={vs.page}>
      <div className={[vs.headerRow, vs.baseline].join(' ')}>
        <h1 className={vs.h1}>{TT.t('Week') + ' ' + weekInfo.week}</h1>
        <span className={vs.subtle}>
          {TT.fmtDayShort(days[0]) + ' → ' + TT.fmtDayShort(days[6]) + ' · ' + weekInfo.year}
        </span>
        <span className={vs.weekNav}>
          <Button variant="ghost" size="sm" onClick={() => setOffset(offset - 1)}>
            ‹
          </Button>
          {offset !== 0 && (
            <Button variant="ghost" size="sm" onClick={() => setOffset(0)}>
              {TT.t('this week')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setOffset(offset + 1)}>
            ›
          </Button>
        </span>
      </div>
      <div className={vs.segChipRow}>
        {segments.map((segment) => {
          const isCommitted = committed.has(segment.key);
          const isLocked = approved.has(segment.key);
          return (
            <div key={segment.key} className={vs.segChip} data-committed={isCommitted} data-locked={isLocked}>
              <StatusDot
                state={isCommitted ? 'solid' : 'outline'}
                color={isLocked ? 'var(--accent)' : isCommitted ? 'var(--green)' : 'var(--text-4)'}
                size={7}
              />
              <span className={vs.segRange}>{segRange(segment.dates)}</span>
              <Chip tone={isLocked ? 'accent' : isCommitted ? 'green' : 'neutral'} mono={true}>
                {isLocked ? TT.t('locked') : isCommitted ? TT.t('committed') : TT.t('open')}
              </Chip>
              {isLocked ? (
                // Approved by an admin: no reopen verb — the segment is theirs to release now.
                // This note survives under `vault` even though the VERB does not: the capability
                // gate removes what you cannot do, never the explanation of the state you are
                // in, and "locked, and here is who locked it" is the second kind.
                <span className={vs.segLockedNote}>{TT.t('approved by admin')}</span>
              ) : committingOff ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => (isCommitted ? ui.uncommitSegment(segment.key) : ui.commitSegment(segment.key))}
                >
                  {isCommitted ? TT.t('reopen') : TT.t('commit')}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {/* One line, where the verb was, saying why it is gone. Deliberately not a disabled
          button: a control you cannot press and which does not explain itself is the "reads as
          a bug months later" failure, not a fix for it. */}
      {committingOff && <div className={vs.capabilityOff}>{TT.t(committingOff)}</div>}
      {days.map((day) => {
        const entries = entriesOn(state, day);
        if (!entries.length && day !== today && TT.parseDate(day) > new Date()) return null;
        return (
          <div key={day} className={vs.day}>
            <div className={vs.dayHead}>
              <SectionLabel dot={day === today ? <StatusDot state="outline" color="var(--accent)" size={7} /> : null}>
                {TT.fmtDayShort(day) + (day === today ? ' · ' + TT.t('today') : '')}
              </SectionLabel>
              <span className={vs.dayHours} style={{ color: entries.length ? 'var(--text-2)' : 'var(--text-4)' }}>
                {entries.length ? TT.fmtHours(sumMin(entries)) + TT.t('h') : '—'}
              </span>
            </div>
            <TimeGrid date={day} entries={entries} state={state} ui={ui} compact={true} />
          </div>
        );
      })}
      <GridFooter entries={allEntries} state={state} />
      <SyntaxHint />
    </div>
  );
}
