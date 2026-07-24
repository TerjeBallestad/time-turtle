import React from 'react';
import styles from './SearchInput.module.css';

export interface SearchInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** When set, renders a click-to-open button showing this key hint (e.g. "⌘K") instead of a live input. */
  kbd?: React.ReactNode;
  /** Widens 150 → 210px on focus (the topbar-search pattern). */
  expandOnFocus?: boolean;
}

export function SearchInput({ kbd, expandOnFocus = false, className, ...rest }: SearchInputProps) {
  if (kbd) {
    // The kbd variant is a button, not an input — rest carries the shared placeholder/onClick props.
    const buttonRest = rest as unknown as React.ButtonHTMLAttributes<HTMLButtonElement>;
    return (
      <button className={[styles.kbdBtn, className].filter(Boolean).join(' ')} {...buttonRest}>
        <span>{rest.placeholder || 'Search'}</span>
        <kbd className={styles.kbdHint}>{kbd}</kbd>
      </button>
    );
  }

  return (
    <input
      type="search"
      className={[styles.search, expandOnFocus && styles.expand, className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
