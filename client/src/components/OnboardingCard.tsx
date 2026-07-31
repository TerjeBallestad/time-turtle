import React from 'react';
import styles from './onboarding.module.css';

/**
 * The card every onboarding beat is drawn on — the brand, the question, and whatever answers it.
 *
 * ONE CHROME, TWO COMPONENTS. `ShapeChoice` and `FirstRun` are the same screen at different beats,
 * and until PLAN-016's end-gate review each wrote its own copy of the scrim/card/brand/question
 * markup against one stylesheet. It lives in its own file rather than in either of them because
 * `FirstRun` imports `ShapeChoice`, so a shared piece inside `FirstRun` would be a cycle.
 */
export function OnboardingCard({
  question,
  tag,
  children,
}: {
  question: string;
  /** the `data-tt` anchor for this beat — the tests locate a step by which card is on screen */
  tag: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.screen} data-tt={tag}>
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
