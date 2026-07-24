import React from 'react';
import TT from '../../i18n';
import { Chip } from '../../ds';
import { TimeGrid } from '../grid/TimeGrid';
import { GridFooter } from '../grid/GridFooter';
import { SyntaxHint } from '../grid/SyntaxHint';
import { entriesOn } from './viewUtils';
import vs from './views.module.css';
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface ViewProps {
  state: AppState;
  ui: UiActions;
}

export function TodayView({ state, ui }: ViewProps) {
  const date = TT.todayStr();
  const entries = entriesOn(state, date);
  const weekInfo = TT.isoWeek(date);
  return (
    <div className={vs.page}>
      <div className={[vs.headerRow, vs.baseline].join(' ')}>
        <h1 className={vs.h1}>{TT.t('Today')}</h1>
        <span className={vs.subtle}>{TT.fmtDayLong(date)}</span>
        <Chip mono={true} className={vs.chipRight}>
          {TT.t('week') + ' ' + weekInfo.week}
        </Chip>
      </div>
      <TimeGrid date={date} entries={entries} state={state} ui={ui} />
      <GridFooter entries={entries} state={state} />
      <SyntaxHint />
    </div>
  );
}
