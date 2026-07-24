import React from 'react';
import styles from './Input.module.css';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export function Input({ className, ...rest }: InputProps) {
  return <input type="text" className={[styles.input, className].filter(Boolean).join(' ')} {...rest} />;
}
