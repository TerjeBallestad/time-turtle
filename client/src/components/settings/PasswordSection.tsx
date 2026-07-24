// Self-service password change — every role gets this (SB-010).
import React from 'react';
import TT from '../../i18n';
import { SectionLabel, Button, Input } from '../../ds';
import st from './settings.module.css';
import type { UiActions } from '../../types';

interface PasswordSectionProps {
  ui: UiActions;
}

export function PasswordSection({ ui }: PasswordSectionProps) {
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = !!current && !!next && next === confirm && !busy;
  const submit = () => {
    if (!ready) return;
    setBusy(true);
    setErr(null);
    ui.changePassword(current, next)
      .then(() => {
        setCurrent('');
        setNext('');
        setConfirm('');
        setBusy(false);
      })
      .catch((e: Error) => {
        setErr(e.message);
        setBusy(false);
      });
  };
  return (
    <div className={st.section}>
      <SectionLabel style={{ marginBottom: 10 }}>{TT.t('Password')}</SectionLabel>
      <div
        className={st.pwGrid}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') submit();
        }}
      >
        <Input
          type="password"
          autoComplete="current-password"
          placeholder={TT.t('Current password')}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={st.small}
        />
        <Input
          type="password"
          autoComplete="new-password"
          placeholder={TT.t('New password')}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className={st.small}
        />
        {/* the DS Input styles `border` as a shorthand — match it rather than setting borderColor, which React warns about on rerender */}
        <Input
          type="password"
          autoComplete="new-password"
          placeholder={TT.t('Repeat new password')}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={st.small}
          style={mismatch ? { border: '1px solid var(--danger)' } : undefined}
        />
        <Button variant="primary" size="sm" disabled={!ready} onClick={submit}>
          {TT.t('Change password')}
        </Button>
      </div>
      {(err || mismatch) && <div className={st.errLine}>{mismatch ? TT.t('The new passwords do not match') : err}</div>}
    </div>
  );
}
