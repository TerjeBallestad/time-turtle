import React from 'react';
import TT from '../i18n';
import styles from './ShapeChoice.module.css';
import type { Shape } from '../../../shared/types';
import type { UiActions } from '../types';

/**
 * SB-098 item 4 / DD-015: the first-run question.
 *
 * WHY IT SHIPS HERE AND NOT WITH THE TOGGLE (SB-056). A fresh install that answers "my own
 * Obsidian-backed timesheet" and is then handed a login form has been sold something that does
 * not exist. The question ships with the shape it promises — the implicit local session, the
 * loopback bind and the absent identity surface all land in this same ticket — or not at all.
 *
 * WHO SEES IT: nobody, almost always. `state.shapeOpen` is resolved server-side and is true only
 * for DD-015's open state — nothing stored, no TT_SHAPE, no TT_SHAPE_LOCK, exactly one user, and
 * that user an admin. Every deployed team install (Terje's is five users) sails past with no
 * modal, because more than one user has answered the question by existing.
 *
 * IT IS NOT SKIPPABLE, and that is why there is no × and no click-outside-to-close: the two
 * answers ARE the escape. `team` is the safe half — it is the status quo, the repo default and
 * reversible in Settings — so a person who does not want to decide can pick it and lose nothing.
 * A dismiss would leave the install in the open state and ask again on the next load, which is
 * a worse experience than the question and teaches people to distrust it.
 *
 * THE WORDS ARE SHAPE WORDS. Never `sqlite`, never `vault` as an engine name — DD-015's whole
 * point is that an install chooses what it IS and the storage falls out of that. Someone opening
 * Time Turtle for the first time can answer "is this mine or my company's"; nobody should have to
 * answer "sqlite or vault" to start logging hours.
 */
export function ShapeChoice({ ui }: { ui: UiActions }) {
  const [busy, setBusy] = React.useState(false);
  // The answer navigates: `chooseShape` reloads the whole session, so the modal disappears
  // because `shapeOpen` went false. Latching `busy` stops a double click from posting twice
  // during the round trip — a second POST would be harmless server-side, but a second toast
  // and a second reload are not what the user asked for.
  const answer = (shape: Shape) => {
    if (busy) return;
    setBusy(true);
    ui.chooseShape(shape);
  };
  return (
    <div className={styles.screen} data-tt="shape-choice">
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandName}>Time Turtle</span>
        </div>
        <p className={styles.question}>{TT.t('Whose hours will this Time Turtle keep?')}</p>
        <div className={styles.options}>
          {/* `personal` FIRST, deliberately. It is the answer this question exists for — a team
              install almost never reaches this screen, because more than one user has already
              answered by existing (DD-015). */}
          <button
            className={styles.option}
            disabled={busy}
            data-tt="shape-choice-personal"
            onClick={() => answer('personal')}
          >
            <div className={styles.optionLabel}>{TT.t('My own Obsidian-backed timesheet')}</div>
            <div className={styles.optionBody}>
              {TT.t(
                'One person, no sign-in. Your Obsidian vault keeps the hours — Time Turtle writes them into your daily notes and reads back the edits you make there.',
              )}
            </div>
          </button>
          <button
            className={styles.option}
            disabled={busy}
            data-tt="shape-choice-team"
            onClick={() => answer('team')}
          >
            <div className={styles.optionLabel}>{TT.t('My company’s')}</div>
            <div className={styles.optionBody}>
              {TT.t(
                'Several people, each signing in, with roles and a review step before hours are invoiced. Time Turtle keeps the hours and mirrors every save to markdown.',
              )}
            </div>
          </button>
        </div>
        <div className={styles.note}>{TT.t('Asked once. You can change the answer later under Settings → Vault.')}</div>
      </div>
    </div>
  );
}
