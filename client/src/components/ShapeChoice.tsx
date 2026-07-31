import React from 'react';
import TT from '../i18n';
import styles from './onboarding.module.css';
import { OnboardingCard } from './OnboardingCard';
import type { Shape } from '../../../shared/types';

/**
 * SB-098 item 4 / DD-015: the first-run question.
 *
 * WHY IT SHIPS HERE AND NOT WITH THE TOGGLE (SB-056). A fresh install that answers "my own
 * Obsidian-backed timesheet" and is then handed a login form has been sold something that does
 * not exist. The question ships with the shape it promises — the implicit local session, the
 * loopback bind and the absent identity surface all land in this same ticket — or not at all.
 *
 * WHERE IT RENDERS, amended by DD-024. It is now the FIRST step of `<FirstRun>`, which stands
 * where the login screen used to stand on a fresh install — SB-158's finding was that the question
 * could only be reached by clearing a wall that answering it then deletes. `onAnswer` is what makes
 * one component serve both callers: in the first run it advances to the next step with no round
 * trip, and in the authenticated fallback (`state.shapeOpen`, App.tsx) it is `ui.chooseShape`,
 * which posts and reloads. This component knows the words, never the plumbing.
 *
 * IT IS NOT SKIPPABLE, and that is why there is no × and no click-outside-to-close: the two
 * answers ARE the escape. `team` is the safe half — it is the status quo, the repo default and
 * reversible in Settings — so a person who does not want to decide can pick it and lose nothing.
 * A dismiss would leave the install in the open state and ask again on the next load, which is
 * a worse experience than the question and teaches people to distrust it.
 *
 * THE WORDS ARE SHAPE WORDS — WITH ONE ENGINE NAMED, RULED BY TERJE ON SB-153. This comment used
 * to say "never `sqlite`", and it was overridden rather than eroded. His reasoning: the personal
 * option already names its engine (an Obsidian vault is the answer, not an implementation detail
 * of it), so the question was never engine-free — only engine-free on ONE side, which left `Team`
 * reading as the vague default you pick when you do not understand the other one. Naming SQLite in
 * the team body makes the two answers symmetric. The rule that survives is the one that mattered:
 * nobody has to answer "sqlite or vault" — they answer whose hours these are, and each answer then
 * says plainly where the hours will live.
 *
 * `My company’s` → `Team` is the same ruling's other half, and it is a one-word-one-meaning fix:
 * Settings → Vault has always called this shape `Team`, so the two surfaces named one value with
 * two words. `tests-browser/first-run.test.js` asserts they agree, which is the only rung that can
 * see a disagreement between two screens.
 */
export function ShapeChoice({ onAnswer }: { onAnswer: (shape: Shape) => void }) {
  const [busy, setBusy] = React.useState(false);
  // Latching `busy` stops a double click from answering twice. In the authenticated fallback the
  // answer navigates (a POST and a session reload), so the second click would cost a second toast
  // and a second reload; in the first run this component unmounts on the next step, so the latch
  // simply never matters there.
  const answer = (shape: Shape) => {
    if (busy) return;
    setBusy(true);
    onAnswer(shape);
  };
  return (
    <OnboardingCard tag="shape-choice" question={TT.t('Whose hours will this Time Turtle keep?')}>
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
        <button className={styles.option} disabled={busy} data-tt="shape-choice-team" onClick={() => answer('team')}>
          <div className={styles.optionLabel}>{TT.t('Team')}</div>
          <div className={styles.optionBody}>
            {TT.t(
              'Several people, each signing in, with roles and a review step before hours are invoiced. The hours live in Time Turtle’s own SQLite database, and every save is mirrored to markdown.',
            )}
          </div>
        </button>
      </div>
      <div className={styles.note}>{TT.t('Asked once. You can change the answer later under Settings → Vault.')}</div>
    </OnboardingCard>
  );
}
