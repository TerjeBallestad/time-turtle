import React from 'react';
import styles from './ListRow.module.css';

export interface ListRowProps {
  id?: React.ReactNode;
  idColor?: string;
  title?: React.ReactNode;
  meta?: React.ReactNode;
  age?: React.ReactNode;
  done?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}

export function ListRow({
  id,
  idColor = 'var(--accent)',
  title,
  meta,
  age,
  done = false,
  onClick,
  style,
}: ListRowProps) {
  return (
    <div onClick={onClick} className={[styles.row, done && styles.done].filter(Boolean).join(' ')} style={style}>
      <span className={styles.id} style={{ color: idColor }}>
        {id}
      </span>
      <span className={[styles.title, done && styles.titleDone].filter(Boolean).join(' ')}>{title}</span>
      {meta && <span className={styles.meta}>{meta}</span>}
      {age && <span className={styles.age}>{age}</span>}
    </div>
  );
}
