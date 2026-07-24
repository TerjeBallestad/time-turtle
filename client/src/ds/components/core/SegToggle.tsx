import React from 'react';
import { normalizeOption, type DSOptionInput } from '../../types';
import styles from './SegToggle.module.css';

export interface SegToggleProps {
  options?: DSOptionInput[];
  value?: string;
  onChange?: (value: string) => void;
  style?: React.CSSProperties;
}

export function SegToggle({ options = [], value, onChange, style }: SegToggleProps) {
  return (
    <div className={styles.seg} style={style}>
      {options.map((o) => {
        const opt = normalizeOption(o);
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange && onChange(opt.value)}
            className={[styles.opt, active && styles.active].filter(Boolean).join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
