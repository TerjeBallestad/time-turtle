import React from 'react';
import TT from '../i18n';
import { NavRow, SectionLabel, StatusDot, Chip } from '../ds';
import styles from './Sidebar.module.css';
import sh from './shared.module.css';
import type { AppState, Entry } from '../../../shared/types';
import type { UiActions, Route, SetRoute } from '../types';

interface SidebarProps {
  state: AppState;
  route: Route;
  setRoute: SetRoute;
  ui: UiActions;
  running: Entry | undefined;
  todayEntries: Entry[];
  admin: boolean;
  /** SB-025: count of segments awaiting approval, badged on the Review nav item (null = unknown) */
  reviewPending: number | null;
  syncLabel: string;
  syncColor: string;
}

export function Sidebar({
  state,
  route,
  setRoute,
  ui,
  running,
  todayEntries,
  admin,
  reviewPending,
  syncLabel,
  syncColor,
}: SidebarProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <span className={styles.logo}></span>
        <span className={styles.brandName}>Time Turtle</span>
      </div>
      <nav className={styles.nav}>
        <NavRow
          label={TT.t('Today')}
          count={todayEntries.length || null}
          active={route.view === 'today'}
          onClick={() => setRoute({ view: 'today' })}
          dot={
            running ? (
              <StatusDot state="live" color="var(--green)" size={7} />
            ) : (
              <StatusDot state="outline" color="var(--accent)" size={7} />
            )
          }
        />
        <NavRow
          label={TT.t('This week')}
          active={route.view === 'week'}
          onClick={() => setRoute({ view: 'week' })}
          dot={<StatusDot state="dashed" size={7} />}
        />
        <NavRow
          label={TT.t('Reports')}
          active={route.view === 'reports'}
          onClick={() => setRoute({ view: 'reports' })}
          dot={<StatusDot state="dashed" size={7} />}
        />
        {admin && (
          <NavRow
            label={TT.t('Invoice')}
            active={route.view === 'invoice'}
            onClick={() => setRoute({ view: 'invoice' })}
            dot={<StatusDot state="dashed" size={7} />}
          />
        )}
        {admin && (
          <NavRow
            label={TT.t('Review')}
            count={reviewPending || null}
            active={route.view === 'review'}
            onClick={() => setRoute({ view: 'review' })}
            dot={<StatusDot state="dashed" size={7} />}
          />
        )}
      </nav>
      <SectionLabel style={{ margin: '18px 10px 8px' }}>{TT.t('Projects')}</SectionLabel>
      <nav className={styles.projects}>
        {state.projects.map((project) => (
          <NavRow
            key={project.code}
            label={project.name}
            count={(() => {
              const count = state.entries.filter((entry) => TT.entryProjectCode(state, entry) === project.code).length;
              return count || null;
            })()}
            active={route.view === 'project' && route.code === project.code}
            onClick={() => setRoute({ view: 'project', code: project.code })}
            dot={<StatusDot state="solid" color={TT.projColor(state, project.code)} size={7} />}
          />
        ))}
      </nav>
      <div className={styles.bottom}>
        <NavRow
          label={TT.t('Settings')}
          active={route.view === 'settings'}
          onClick={() => setRoute({ view: 'settings' })}
        />
        <div className={styles.syncRow}>
          <span className={styles.syncDot} style={{ background: syncColor }}></span>
          <span className={styles.syncLabel}>{syncLabel}</span>
        </div>
        <div className={styles.userRow}>
          <span className={[sh.ellipsis, styles.userName].join(' ')}>{state.user.name}</span>
          <Chip mono={true} tone={admin ? 'green' : 'neutral'} className={styles.chip}>
            {TT.t(state.user.role)}
          </Chip>
          <button onClick={ui.logout} className={[sh.ghostBtn, styles.signOut].join(' ')}>
            {TT.t('sign out')}
          </button>
        </div>
      </div>
    </aside>
  );
}
