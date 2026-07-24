import React from 'react';
import styles from './Avatar.module.css';

export type AvatarTone = 'gold' | 'accent' | 'green' | 'neutral';

export interface AvatarProps {
  initials?: string;
  tone?: AvatarTone;
  size?: number;
  style?: React.CSSProperties;
}

export function Avatar({ initials = '?', tone = 'neutral', size = 18, style }: AvatarProps) {
  return (
    <span
      className={[styles.avatar, styles[tone]].join(' ')}
      style={{
        width: size,
        height: size,
        borderRadius: size >= 24 ? 8 : '50%',
        fontSize: size >= 24 ? '11px' : '9px',
        ...style,
      }}
    >
      {initials}
    </span>
  );
}
