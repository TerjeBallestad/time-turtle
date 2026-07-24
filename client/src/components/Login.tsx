import React from 'react';
import TT from '../i18n';
import { Button, FormRow, Input } from '../ds';
import styles from './Login.module.css';
import { api } from '../api';

interface LoginProps {
  onLogin: () => void;
}

export function Login({ onLogin }: LoginProps) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const submit = () => {
    if (!email || !password || busy) return;
    setBusy(true);
    setErr(null);
    api
      .login(email, password)
      .then(onLogin)
      .catch((e: Error) => {
        setErr(e.message);
        setBusy(false);
      });
  };
  return (
    <div className={styles.screen}>
      <div
        className={styles.card}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') submit();
        }}
      >
        <div className={styles.brand}>
          <span className={styles.brandName}>Time Turtle</span>
        </div>
        <FormRow label={TT.t('Email')}>
          <Input autoFocus={true} value={email} onChange={(e) => setEmail(e.target.value)} spellCheck={false} />
        </FormRow>
        <FormRow label={TT.t('Password')}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </FormRow>
        {err && <div className={styles.err}>{err}</div>}
        <Button variant="primary" onClick={submit} disabled={!email || !password || busy} className={styles.submit}>
          {busy ? TT.t('Signing in…') : TT.t('Sign in')}
        </Button>
      </div>
    </div>
  );
}
