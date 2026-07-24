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
                <span className={vs.segLockedNote}>{TT.t('approved by admin')}</span>
              ) : (
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
