import React from 'react';
import styles from './FormRow.module.css';

export interface FormRowProps {
  label?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function FormRow({ label, children, style }: FormRowProps) {
  return (
    <div className={styles.row} style={style}>
      {label && <label className={styles.label}>{label}</label>}
      {children}
    </div>
  );
}
