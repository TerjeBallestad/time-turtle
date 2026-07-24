import React from 'react';
import TT from '../i18n';
import { StatusDot } from '../ds';
import styles from './TopBar.module.css';
import type { Entry } from '../../../shared/types';
import type { UiActions } from '../types';

interface TopBarProps {
  title: string;
  running: Entry | undefined;
  runningCode: string | null;
  todayMin: number;
  ui: UiActions;
}

export function TopBar({ title, running, runningCode, todayMin, ui }: TopBarProps) {
  return (
    <header className={styles.bar}>
      <span className={styles.title}>{title}</span>
      <span className={styles.right}>
        {running && (
          <span className={styles.pill}>
            <StatusDot state="live" color="var(--green)" size={7} />
            <span className={styles.pillText}>
              {(runningCode || TT.t('timer')) + ' ' + TT.fmtDur(TT.entryMinutes(running))}
            </span>
            <button className={styles.stop} onClick={() => ui.stop(running.id)}>
              {TT.t('stop')}
            </button>
          </span>
        )}
        <span className={styles.today}>
          {TT.t('today') + ' '}
          <span className={styles.todayValue}>{TT.fmtHours(todayMin)}h</span>
        </span>
      </span>
    </header>
  );
}
