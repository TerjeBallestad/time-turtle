import React from 'react';
import TT from '../i18n';
import { Button, FormRow, Input } from '../ds';
import styles from './Login.module.css';
import { api } from '../api';

interface LoginProps {
  onLogin: () => void;
  /**
   * DD-024 clause 2 — the seeded admin still carries the password this repo publishes, so say it.
   * `null` for every other caller, and that covers three different ones at once: the password has
   * been changed, an operator set their own `TT_ADMIN_PASSWORD`, or the probe 404'd because this
   * browser is not on the machine the server runs on.
   */
  defaultLogin: { email: string; password: string } | null;
}

/**
 * THE WALL, AND WHY THIS HINT IS HERE (DD-024 clause 2). Moving the shape question in FRONT of the
 * login is what created it: a person who answers `Team` now lands here holding a credential nobody
 * ever showed them — `seedIfEmpty` announces it once on stdout, which `tt serve` redirects into a
 * detached log file. Before DD-024 they at least met this wall after signing in.
 *
 * WHAT IS ACTUALLY DISCLOSED, and the reason this is not a hole: the literal in `server/src/config.js`
 * of a public MIT repo (DD-004), stated back only to a caller the server has already established is
 * on a loopback SOCKET with a loopback Host header — the same predicate the first-run surface and
 * task 2's peer guard use, never the Host header alone. Under `team` the bind is every interface, so
 * a header-only gate would read this out to any machine on the wifi: SB-162 with a password in it.
 * It retires itself the moment the password changes, because the server recomputes the answer from
 * the stored hash on every probe.
 */
export function Login({ onLogin, defaultLogin }: LoginProps) {
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
        {defaultLogin && (
          <div className={styles.hint} data-tt="login-default-credentials">
            {TT.t('This install still has its starting password. Sign in as')} <code>{defaultLogin.email}</code> /{' '}
            <code>{defaultLogin.password}</code>{' '}
            {TT.t('and change it under Settings → Password. This note disappears when you do.')}
          </div>
        )}
      </div>
    </div>
  );
}
