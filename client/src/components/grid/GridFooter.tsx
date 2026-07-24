import React from 'react';
import TT from '../../i18n';
import { isAdmin } from '../../roles';
import styles from './GridFooter.module.css';
import type { AppState, Entry } from '../../../../shared/types';

interface GridFooterProps {
  entries: Entry[];
  state: AppState;
}

export function GridFooter({ entries, state }: GridFooterProps) {
  const admin = isAdmin(state);
  const total = entries.reduce((sum, entry) => sum + TT.entryMinutes(entry), 0);
  // SDD-002 ruling 8: committed entries contribute their frozen money; uncommitted ones
  // fall back to live, so this footer stays a correct working total either way.
  const billed = entries.reduce((sum, entry) => sum + TT.effectiveBillMinutes(state, entry), 0);
  const amount = entries.reduce((sum, entry) => sum + TT.effectiveAmount(state, entry), 0);
  return (
    <div className={styles.footer}>
      <span>
        {TT.t('count') + ' '}
        <span className={styles.value2}>{entries.length}</span>
      </span>
      <span className={styles.right}>
        {TT.t('billable') + ' '}
        <span className={styles.value2}>
          {TT.fmtHours(billed)}
          {TT.t('h')}
        </span>
        {admin ? ' · ' + TT.fmtMoney(amount, state.settings.currency) : ''}
      </span>
      <span>
        {TT.t('sum') + ' '}
        <span className={styles.value}>
          {TT.fmtHours(total)}
          {TT.t('h')}
        </span>
      </span>
    </div>
  );
}
