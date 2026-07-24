import React from 'react';
import styles from './StatusDot.module.css';

/** dashed = inbox/unset · outline = in progress · staged = staged · solid = done · live = pulsing agent */
export type StatusDotState = 'dashed' | 'outline' | 'staged' | 'live' | 'solid';

export interface StatusDotProps {
  state?: StatusDotState;
  color?: string;
  size?: number;
  square?: boolean;
  style?: React.CSSProperties;
}

export function StatusDot({
  state = 'solid',
  color = 'var(--green)',
  size = 10,
  square = false,
  style,
}: StatusDotProps) {
  // color/size/square are data-driven, so the visual props stay inline; only layout is a class.
  const s: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: square ? 2 : '50%',
    ...style,
  };
  if (state === 'dashed') return <span className={styles.dot} style={{ ...s, border: '1.5px dashed var(--text-3)' }} />;
  if (state === 'outline') return <span className={styles.dot} style={{ ...s, border: `1.5px solid ${color}` }} />;
  if (state === 'staged') {
    return (
      <span
        className={styles.dot}
        style={{
          ...s,
          border: `1.5px solid ${color}`,
          background: color.startsWith('var') ? `color-mix(in srgb, ${color} 25%, transparent)` : color + '40',
        }}
      />
    );
  }
  if (state === 'live') {
    return (
      <span
        className={styles.dot}
        style={{ ...s, background: color, boxShadow: `0 0 6px ${color}`, animation: 'pulse 1.8s ease-in-out infinite' }}
      />
    );
  }
  return <span className={styles.dot} style={{ ...s, background: color }} />;
}
