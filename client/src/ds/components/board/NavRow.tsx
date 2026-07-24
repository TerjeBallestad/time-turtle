import React from 'react';
import styles from './NavRow.module.css';

export interface NavRowProps {
  label?: React.ReactNode;
  count?: number | null;
  active?: boolean;
  dot?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}

export function NavRow({ label, count, active = false, dot, onClick, style }: NavRowProps) {
  return (
    <button onClick={onClick} className={[styles.nav, active && styles.active].filter(Boolean).join(' ')} style={style}>
      {dot}
      <span className={styles.label}>{label}</span>
      {count != null && <span className={styles.count}>{count}</span>}
    </button>
  );
}
