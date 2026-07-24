import React from 'react';
import TT from '../../i18n';
import { SectionLabel, Select, Input } from '../../ds';
import st from './settings.module.css';
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface GeneralSectionProps {
  state: AppState;
  ui: UiActions;
  admin: boolean;
}

export function GeneralSection({ state, ui, admin }: GeneralSectionProps) {
  return (
    <div className={st.section}>
      <SectionLabel style={{ marginBottom: 10 }}>{TT.t('General')}</SectionLabel>
      <div className={st.general}>
        {admin && <span className={st.label}>{TT.t('Currency')}</span>}
        {admin && (
          <Input
            value={state.settings.currency}
            onChange={(e) => ui.setCurrency(e.target.value)}
            className={[st.small, st.currencyInput].join(' ')}
          />
        )}
        <span className={st.label} style={{ marginLeft: admin ? 16 : 0 }}>
          {TT.t('Language')}
        </span>
        <Select
          value={TT.lang}
          onChange={(e) => ui.setLanguage(e.target.value)}
          options={[
            { value: 'en', label: 'English' },
            { value: 'no', label: 'Norsk' },
          ]}
          className={[st.small, st.langSelect].join(' ')}
        />
      </div>
    </div>
  );
}
