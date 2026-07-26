import React from 'react';
import TT from '../i18n';
import { api } from '../api';
import type { ApiError } from '../api';
import type { SessionState } from './useSession';
import type { AppState, MirrorBlock, StatePatch, StateVersion } from '../../../shared/types';

const SYNC_DEBOUNCE_MS = 700;
// SDD-002 ruling 4: `commits` rides the same debounced diff as entries. The client
// sends only which segment keys are committed (a provisional committedAt); the server
// owns committedAt + the money snapshot and reconciles, so the response version is what
// we adopt — the authoritative committedAt/snapshot arrive on the next GET.
const SYNC_KEYS = ['clients', 'projects', 'tasks', 'entries', 'settings', 'commits'] as const;
type SyncKey = (typeof SYNC_KEYS)[number];

export type SyncStatus = 'synced' | 'saving' | 'error';

// Per-key copy keeps the collection type correlated between state and patch.
function copyKey<K extends SyncKey>(dst: StatePatch, src: AppState, key: K) {
  dst[key] = src[key];
}

// Diff the synced collections by reference, debounce, and PUT a merged patch.
// DC-001: every PUT carries the version we last saw. If someone else saved in
// between, the server answers 409 and we reload instead of clobbering them —
// the losing side's un-flushed edits are dropped, which is the point.
// SB-085: every mirror-writing response carries the standing refusal, so the save that
// TRIPS the guard is the moment the client learns about it. Hand it to the App so it lands
// in AppState — a toast alone is a transient message about a sticky, persisted condition,
// and the settings row is where it has to stay put until someone acknowledges it.
export function useServerSync(
  state: SessionState,
  toast: (msg: string) => void,
  reload: () => void,
  onMirrorBlocked: (block: MirrorBlock | null) => void,
): SyncStatus {
  const [sync, setSync] = React.useState<SyncStatus>('synced');
  const prevRef = React.useRef<SessionState>(null);
  const pendingRef = React.useRef<StatePatch>({});
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const versionRef = React.useRef<StateVersion | null>(null);
  const inFlightRef = React.useRef(false);
  // Set when we reload after a conflict, so the incoming state re-baselines the
  // diff instead of being PUT straight back at the server.
  const resyncRef = React.useRef(false);
  // A queued flush runs the closure it was scheduled with; keep the callback in a ref so a
  // timer scheduled two renders ago still reports into the current state.
  const blockedRef = React.useRef(onMirrorBlocked);
  blockedRef.current = onMirrorBlocked;
  const flush = () => {
    timerRef.current = null;
    if (!Object.keys(pendingRef.current).length) return;
    // One PUT at a time — an overlapping write would carry the version from
    // before the in-flight one landed and conflict with ourselves.
    if (inFlightRef.current) {
      timerRef.current = setTimeout(flush, SYNC_DEBOUNCE_MS);
      return;
    }
    const patch = pendingRef.current;
    pendingRef.current = {};
    inFlightRef.current = true;
    setSync('saving');
    api
      .putState(versionRef.current ? { ...patch, version: versionRef.current } : patch)
      .then((res) => {
        inFlightRef.current = false;
        versionRef.current = res.version;
        setSync(timerRef.current ? 'saving' : 'synced');
        // SB-085: `mirrorBlocked` is present on every mirror-writing response — adopt it
        // (including the null that means a previous block is gone) so Settings reflects the
        // server without a reload.
        if (res.mirrorBlocked !== undefined) blockedRef.current(res.mirrorBlocked);
        // A guard refusal is not a passing error: point at the place that can clear it
        // rather than dumping the raw server string into a toast that vanishes.
        if (res.mirrorBlocked) toast(TT.t('mirror paused — see Settings → Mirror folder'));
        else if (res.mirrorError) toast(TT.t('markdown mirror failed: ') + res.mirrorError);
      })
      .catch((err: ApiError) => {
        inFlightRef.current = false;
        if (err.status === 409) {
          // Someone else got there first: drop our stale patch and take the server's copy.
          pendingRef.current = {};
          versionRef.current = null;
          resyncRef.current = true;
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          setSync('synced');
          toast(TT.t('someone else saved first — reloaded'));
          reload();
          return;
        }
        setSync('error');
        toast(err.message || TT.t('offline — retrying'));
        Object.assign(pendingRef.current, { ...patch, ...pendingRef.current });
        timerRef.current = setTimeout(flush, 4000);
      });
  };
  React.useEffect(() => {
    if (!state) {
      prevRef.current = state;
      return;
    }
    const prev = prevRef.current;
    prevRef.current = state;
    // Initial load and post-conflict reload both adopt the server's version and
    // skip the diff — there is nothing of ours left to save.
    if (!prev || resyncRef.current) {
      resyncRef.current = false;
      versionRef.current = state.version;
      return;
    }
    let changed = false;
    for (const key of SYNC_KEYS) {
      if (state[key] !== prev[key]) {
        copyKey(pendingRef.current, state, key);
        changed = true;
      }
    }
    if (changed) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SYNC_DEBOUNCE_MS);
    }
  }, [state]);
  React.useEffect(() => {
    const before = (ev: BeforeUnloadEvent) => {
      if (timerRef.current || sync === 'saving') {
        ev.preventDefault();
        ev.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [sync]);
  return sync;
}
