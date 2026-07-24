import React from 'react';
import styles from './TicketCard.module.css';

export type TicketKind = 'research' | 'probe' | 'grill' | 'task' | 'gap';

const KIND_COLORS: Record<TicketKind, string> = {
  research: '#52a9ff',
  probe: '#c084fc',
  grill: '#f0883e',
  task: '#46c288',
  gap: '#e2c541',
};

export interface TicketCardProps {
  id?: React.ReactNode;
  kind?: TicketKind;
  title?: React.ReactNode;
  age?: React.ReactNode;
  priority?: string;
  blocked?: React.ReactNode;
  progress?: { done: number; total: number };
  live?: boolean;
  emphasis?: 'sdd' | 'plan';
  onClick?: () => void;
  style?: React.CSSProperties;
}

export function TicketCard({
  id,
  kind,
  title,
  age,
  priority,
  blocked,
  progress,
  live,
  emphasis,
  onClick,
  style,
}: TicketCardProps) {
  // Border/shadow are data-driven (emphasis/kind); the hover border comes from CSS (:hover)
  // overriding the --tc-border custom property, so no hover state hook is needed.
  let border = 'var(--border)';
  let shadow = 'none';
  if (emphasis === 'sdd') {
    border = '#2a2d52';
    shadow = 'var(--glow-accent)';
  } else if (emphasis === 'plan') border = '#1f4436';
  else if (kind === 'grill') border = 'rgba(240,136,62,.3)';
  else if (kind === 'probe') border = 'rgba(192,132,252,.28)';

  return (
    <div
      onClick={onClick}
      className={styles.card}
      style={{ ['--tc-border' as string]: border, boxShadow: shadow, ...style } as React.CSSProperties}
    >
      <div className={styles.head}>
        {live && <span className={styles.live} />}
        <span className={styles.id} style={{ color: (kind && KIND_COLORS[kind]) || 'var(--text-2)' }}>
          {id}
        </span>
        {kind && (
          <span className={styles.kind} style={{ color: KIND_COLORS[kind] }}>
            {kind}
          </span>
        )}
        {priority && (
          <span
            className={styles.priority}
            style={{ color: priority === 'critical' ? 'var(--danger)' : 'var(--orange)' }}
          >
            {priority}
          </span>
        )}
        {age && <span className={styles.age}>{age}</span>}
      </div>
      <div className={styles.title}>{title}</div>
      {(blocked || progress) && (
        <div className={styles.foot}>
          {blocked && <span className={styles.blocked}>{blocked}</span>}
          {progress && (
            <>
              <span className={styles.track}>
                <span
                  className={styles.fill}
                  style={{ width: Math.min(100, (progress.done / progress.total) * 100) + '%' }}
                />
              </span>
              <span className={styles.count}>
                {progress.done}/{progress.total}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
