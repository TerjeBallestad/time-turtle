import React from 'react';
import styles from './Kbd.module.css';

export interface KbdProps {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Kbd({ children, style }: KbdProps) {
  return (
    <kbd className={styles.kbd} style={style}>
      {children}
    </kbd>
  );
}
