import React from 'react';
import TT from '../i18n';
import { Button } from '../ds';
import styles from './onboarding.module.css';
import { OnboardingCard } from './OnboardingCard';
import { api } from '../api';
import type { ApiError } from '../api';

/**
 * DD-024 / SB-158: the first screen a person meets, and the one that stands where `<Login>` used
 * to stand on a fresh install.
 *
 * THE FINDING THIS CLOSES, in one line: the install used to ask what it WAS before it would let
 * anyone in, using a password nobody was ever shown. The shape concept is gone (SB-181), so one
 * question is left — whether to start with example hours — and answering it lands the person on
 * `<Login>` with the default credential stated.
 *
 * The server half (`GET`/`POST /api/first-run`) answers with no credential to a loopback socket
 * only, and 404s to everyone else — a caller who is not on this machine lands on `<Login>`.
 *
 * THE DEMO STEP IS OPT-IN AND OFF BY DEFAULT (DD-024 clause 3 / SB-159), and its button says which
 * of the two things it is about to do rather than `OK` (DD-018 ruling 5).
 *
 * THERE IS NO BACK LINK, because there is nothing to go back to.
 */
export function FirstRun({ onDone }: { onDone: () => void }) {
  const [demo, setDemo] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    api
      .answerFirstRun({ demo })
      .then(onDone)
      .catch((e: ApiError) => {
        // The server's own sentence, which is the house pattern for a refusal the client cannot
        // re-derive: a 409 saying the question was answered elsewhere, or a 500.
        setErr(TT.t(e.message));
        setBusy(false);
      });
  };

  return (
    <OnboardingCard tag="first-run" question={TT.t('Start with something in it?')}>
      <label className={styles.check} data-tt="first-run-demo-toggle">
        <input type="checkbox" checked={demo} disabled={busy} onChange={(e) => setDemo(e.target.checked)} />
        <span>
          {TT.t(
            'Add a few example clients, projects and a week of logged hours, so the app has something in it while you look around. You can delete them.',
          )}
        </span>
      </label>
      {err && (
        <div className={styles.err} data-tt="first-run-error">
          {err}
        </div>
      )}
      {/* DD-018 ruling 5: the button says which of the two things it is about to do. `OK` under a
          checkbox makes the person re-read the checkbox to find out what they just agreed to. */}
      <Button
        variant="primary"
        className={styles.submit}
        data-tt="first-run-demo-submit"
        disabled={busy}
        onClick={submit}
      >
        {demo ? TT.t('Add the example hours and start') : TT.t('Start with an empty timesheet')}
      </Button>
    </OnboardingCard>
  );
}
