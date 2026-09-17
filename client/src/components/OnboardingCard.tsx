import React from 'react';
import styles from './onboarding.module.css';

/**
 * The card every onboarding beat is drawn on — the brand, the question, and whatever answers it.
 *
 * ONE CHROME. The scrim, card, brand and question markup lives here rather than inside the screen
 * that uses it, so a second onboarding beat cannot grow its own copy (PLAN-016's end-gate review
 * found exactly that).
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
