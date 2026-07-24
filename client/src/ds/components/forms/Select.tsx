import React from 'react';
import { normalizeOption, type DSOptionInput } from '../../types';
import styles from './Select.module.css';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options?: DSOptionInput[];
}

export function Select({ options = [], className, ...rest }: SelectProps) {
  return (
    <select className={[styles.select, className].filter(Boolean).join(' ')} {...rest}>
      {options.map((o) => {
        const opt = normalizeOption(o);
        return (
          <option key={opt.value} value={opt.value} className={styles.opt}>
            {opt.label}
          </option>
        );
      })}
    </select>
  );
}
