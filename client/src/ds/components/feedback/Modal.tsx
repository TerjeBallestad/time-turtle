import React from 'react';
import styles from './Modal.module.css';

export interface ModalProps {
  title?: React.ReactNode;
  onClose?: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  open?: boolean;
  style?: React.CSSProperties;
}

export function Modal({ title, onClose, children, footer, open = true, style }: ModalProps) {
  if (!open) return null;
  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div className={styles.dialog} style={style}>
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button className={styles.close} onClick={onClose}>
            &times;
          </button>
        </div>
        {children}
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}
