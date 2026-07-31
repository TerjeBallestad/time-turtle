import React from 'react';
import TT from '../i18n';
import { Button, Input } from '../ds';
import styles from './ShapeChoice.module.css';
import { ShapeChoice } from './ShapeChoice';
import { api } from '../api';
import type { ApiError } from '../api';
import type { Shape, FirstRunResponse } from '../../../shared/types';

/**
 * DD-024 / SB-158: the five minutes a person actually meets, and the screen that stands where
 * `<Login>` used to stand on a fresh install.
 *
 * THE FINDING THIS CLOSES, in one line: the question that removes the login could only be reached
 * by first clearing that login, using a password nobody was ever shown. So the question moved in
 * front of it. The server half (`GET`/`POST /api/first-run`) answers with no credential to a
 * loopback socket only, and 404s to everyone else — a caller who is not on this machine still lands
 * on `<Login>`, exactly as before.
 *
 * ONE POST FOR THE WHOLE FLOW, deliberately. The shape and its follow-up step travel together, so
 * there is no half-applied first run: an install whose shape stored but whose vault was refused
 * would sit in a `personal` install with no vault, with the open state over and the step that would
 * have fixed it permanently closed.
 *
 * THE TWO SECOND STEPS ARE NOT SYMMETRIC and neither is optional-looking by accident:
 *
 *   • `personal` → the vault step is NOT SKIPPABLE. Without a root the install that was just sold
 *     an Obsidian-backed timesheet is an ordinary local timesheet (SB-140). The server accepts an
 *     answer with no root — see the note on the submit below — so this screen is what makes it
 *     true for a person.
 *   • `team` → the demo step is OPT-IN AND OFF BY DEFAULT (DD-024 clause 3 / SB-159), and its
 *     button says which of the two things it is about to do rather than `OK` (DD-018 ruling 5).
 *
 * GOING BACK IS NOT SKIPPING. The question itself remains unanswerable-around; the back link only
 * returns you to it, which is where a mis-click needs to be able to go.
 */
export function FirstRun({ info, onDone }: { info: FirstRunResponse; onDone: () => void }) {
  const [shape, setShape] = React.useState<Shape | null>(null);
  // The prefill, and the reason `GET /api/first-run` carries `vaults`: the open vault Obsidian
  // has registered, or nothing at all when there is no registry to read. `vaults[0]` IS the best
  // candidate — the server sorts open-first then most-recently-used, so this line does not have to
  // know the rule.
  const [root, setRoot] = React.useState(info.vaults[0]?.path ?? '');
  const [demo, setDemo] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = (answer: { shape: Shape; vaultRoot?: string; demo?: boolean }) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    api
      .answerFirstRun(answer)
      .then(onDone)
      .catch((e: ApiError) => {
        // The server's own sentence, verbatim — a refused vault path NAMES the path, which is the
        // typo the person cannot otherwise see, and a 409 says the question was answered elsewhere.
        setErr(e.message);
        setBusy(false);
      });
  };

  // THE ANSWER CLEARS THE REFUSAL, and this was found by looking at the screen rather than by
  // reading the code: a refused vault path, then Back, then `Team`, left "no folder at …" standing
  // on a step that has nothing to do with folders. A refusal belongs to the request that earned it.
  const chooseStep = (next: Shape | null) => {
    setErr(null);
    setShape(next);
  };

  if (shape === null) return <ShapeChoice onAnswer={chooseStep} />;

  if (shape === 'personal')
    return (
      <Screen question={TT.t('Which vault keeps these hours?')}>
        {/* A registry with more than one vault in it: offer them, rather than making somebody
            retype a path they can see in Obsidian. A vault whose folder is no longer on disk is
            still OFFERED and flagged — an unmounted drive is still the vault they mean. */}
        {info.vaults.length > 1 && (
          <div className={styles.options}>
            {info.vaults.map((vault) => (
              <button
                key={vault.path}
                className={[styles.option, vault.path === root ? styles.optionOn : ''].filter(Boolean).join(' ')}
                disabled={busy}
                aria-pressed={vault.path === root}
                data-tt="first-run-vault-option"
                onClick={() => setRoot(vault.path)}
              >
                <div className={styles.optionLabel}>{vault.name}</div>
                <div className={styles.optionPath}>
                  {vault.path}
                  {vault.missing ? ' · ' + TT.t('not on this machine right now') : ''}
                </div>
              </button>
            ))}
          </div>
        )}
        <div className={styles.field}>
          <Input
            autoFocus={true}
            value={root}
            spellCheck={false}
            data-tt="first-run-vault-root"
            placeholder={info.vaultPrefix ? info.vaultPrefix + '/…' : TT.t('e.g. ~/Obsidian/ballestad')}
            onChange={(e) => setRoot(e.target.value)}
          />
        </div>
        {/* WHAT IT WILL DO WITH THE ANSWER, on the screen that asks for it. The daily-notes folder
            is `TT.VAULT_PATHS_DEFAULT`, never a literal — the sub-paths are settable afterwards and
            a second copy of them here is exactly the drift that constant's comment forbids. */}
        <div className={styles.note} data-tt="first-run-vault-effect">
          {TT.t('Time Turtle will write your hours into')}{' '}
          <code>{(root || '…') + '/' + TT.VAULT_PATHS_DEFAULT.daily}</code>{' '}
          {TT.t('and read back the edits you make there. You can change any of this later under Settings → Vault.')}
        </div>
        {err && <div className={styles.err}>{err}</div>}
        <Button
          variant="primary"
          className={styles.submit}
          data-tt="first-run-vault-submit"
          disabled={!root.trim() || busy}
          onClick={() => submit({ shape: 'personal', vaultRoot: root.trim() })}
        >
          {TT.t('Keep my hours in this vault')}
        </Button>
        <BackLink disabled={busy} onClick={() => chooseStep(null)} />
      </Screen>
    );

  return (
    <Screen question={TT.t('Start with something in it?')}>
      <label className={styles.check} data-tt="first-run-demo-toggle">
        <input type="checkbox" checked={demo} disabled={busy} onChange={(e) => setDemo(e.target.checked)} />
        <span>
          {TT.t(
            'Add a few example clients, projects and a week of logged hours, so the app has something in it while you look around. You can delete them.',
          )}
        </span>
      </label>
      {err && <div className={styles.err}>{err}</div>}
      {/* DD-018 ruling 5: the button says which of the two things it is about to do. `OK` under a
          checkbox makes the person re-read the checkbox to find out what they just agreed to. */}
      <Button
        variant="primary"
        className={styles.submit}
        data-tt="first-run-demo-submit"
        disabled={busy}
        onClick={() => submit({ shape: 'team', demo })}
      >
        {demo ? TT.t('Add the example hours and start') : TT.t('Start with an empty timesheet')}
      </Button>
      <BackLink disabled={busy} onClick={() => chooseStep(null)} />
    </Screen>
  );
}

/** The card the first-run steps share with the question — one screen, three beats. */
function Screen({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <div className={styles.screen} data-tt="first-run">
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandName}>Time Turtle</span>
        </div>
        <p className={styles.question}>{question}</p>
        {children}
      </div>
    </div>
  );
}

/** Back to the question. NOT a skip — the question it returns to is still the only way out. */
function BackLink({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button className={styles.back} disabled={disabled} data-tt="first-run-back" onClick={onClick}>
      {TT.t('← Back to the question')}
    </button>
  );
}
