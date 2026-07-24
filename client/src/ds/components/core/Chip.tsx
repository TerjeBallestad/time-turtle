import React from 'react';
import styles from './Chip.module.css';

export type ChipTone = 'neutral' | 'accent' | 'blue' | 'green' | 'orange' | 'danger' | 'yellow' | 'claim';

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  mono?: boolean;
}

export function Chip({ tone = 'neutral', mono = false, className, children, ...rest }: ChipProps) {
  const cls = [styles.chip, styles[tone], mono && styles.mono, className].filter(Boolean).join(' ');
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
