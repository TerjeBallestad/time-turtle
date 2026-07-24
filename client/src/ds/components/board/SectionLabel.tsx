import React from 'react';
import styles from './SectionLabel.module.css';

/** The uppercase 10.5px label pattern — an intentional addition, see readme.md. */
export interface SectionLabelProps {
  children?: React.ReactNode;
  action?: React.ReactNode;
  dot?: React.ReactNode;
  style?: React.CSSProperties;
}

export function SectionLabel({ children, action, dot, style }: SectionLabelProps) {
  return (
    <div className={styles.label} style={style}>
      {dot}
      <span>{children}</span>
      {action && <span className={styles.action}>{action}</span>}
    </div>
  );
}
