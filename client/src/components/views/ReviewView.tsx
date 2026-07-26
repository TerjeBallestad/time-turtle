// SDD-002 rulings 5 & 6 (SB-025): the admin boss-review surface — a user rail → month
// segment pills → a week panel that walks another user's entries line by line, lets the
// admin correct a line (persisted via the target-id-scoped endpoint), shows the
// edited-by-admin marker, and offers Approve week / Release for edits. The feel design was
// PASSED in SB-025; this builds it. Admin-only (App gates the route).
import React from 'react';
import TT from '../../i18n';
import { StatusDot, Chip, Button } from '../../ds';
import { api } from '../../api';
import type { UserTimesheet, ApiError } from '../../api';
import vs from './views.module.css';
import sh from '../shared.module.css';
import rv from './ReviewView.module.css';
import type { AppState, User, Entry, Catalog } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface ViewProps {
  state: AppState;
  ui: UiActions;
  /** bump the sidebar's awaiting-approval badge after an approve/release/correction */
  onReviewChanged?: () => void;
}

// The day range of a segment, from the entries that fall in it: "4–8 Jul".
function segLabel(dates: string[]): string {
  if (!dates.length) return '';
  const first = Number(dates[0].slice(8));
  const last = Number(dates[dates.length - 1].slice(8));
  const month = TT.fmtMonth(dates[0].slice(0, 7)).split(' ')[0];
  return first + '–' + last + ' ' + month;
}

export function ReviewView({ state, ui, onReviewChanged }: ViewProps) {
  // SB-056 / DD-008: null under sqlite, the reason sentence under vault. Same source as the
  // server's 403 body and as WeekView's employee-facing line, so the three cannot drift.
  //
  // DEFENCE IN DEPTH, not a live bug fixed — say so rather than let the next reader assume the
  // stronger claim. This view lists OTHER users (the filter below drops the acting admin), and
  // under `vault` the single-user guard means there are none, so the rail is empty and these
  // verbs are unreachable with content. It is here because the composition can change without
  // this file being reopened: the server already 403s approve/release under `vault`, and a
  // surface offering a verb that can only fail is precisely what DD-008's comment forbids.
  const committingOff = TT.shapeOffReason('committing', state.shape);
  const [users, setUsers] = React.useState<User[] | null>(null);
  const [selId, setSelId] = React.useState<number | null>(null);
  const [sheet, setSheet] = React.useState<UserTimesheet | null>(null);
  const [draft, setDraft] = React.useState<Entry[]>([]);
  const [dirty, setDirty] = React.useState(false);
  const [segKey, setSegKey] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0); // remounts the edit inputs after a reload
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    api
      .listUsers()
      .then((r) => setUsers(r.users.filter((u) => u.id !== state.user.id)))
      .catch((e) => setErr(e.message || 'could not load users'));
  }, [state.user.id]);

  const loadSheet = React.useCallback((id: number) => {
    return api
      .getUserTimesheet(id)
      .then((t) => {
        setSheet(t);
        setDraft(t.entries);
        setDirty(false);
        setNonce((n) => n + 1);
      })
      .catch((e) => setErr(e.message || 'could not load timesheet'));
  }, []);

  React.useEffect(() => {
    if (selId == null) return;
    setSheet(null);
    setSegKey(null);
    setErr('');
    void loadSheet(selId);
  }, [selId, loadSheet]);

  // A Catalog over the SAVED ledger — money present (admin) — for the rollup + readers.
  const catalog: Catalog | null = sheet
    ? {
        settings: sheet.settings,
        clients: sheet.clients,
        projects: sheet.projects,
        tasks: sheet.tasks,
        entries: sheet.entries,
        commits: sheet.commits,
      }
    : null;

  const months = sheet ? [...new Set(sheet.entries.map((e) => e.date.slice(0, 7)))].sort().reverse() : [];

  const segDates = (key: string): string[] =>
    sheet ? [...new Set(sheet.entries.filter((e) => TT.segmentKey(e.date) === key).map((e) => e.date))].sort() : [];

  const editEntry = (id: string, patch: Partial<Entry>) => {
    setDraft((d) => d.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    setDirty(true);
  };
  const applyTime = (id: string, raw: string) => {
    const parsed = TT.parseTimeCell(raw);
    if (!parsed) return;
    editEntry(
      id,
      parsed.kind === 'duration'
        ? { durMin: parsed.min, start: null, end: null }
        : { start: parsed.start, end: parsed.kind === 'range' ? parsed.end : null, durMin: null },
    );
  };

  const save = async () => {
    if (selId == null) return;
    setBusy(true);
    setErr('');
    try {
      // DC-001: send the version we loaded. A stale save (the employee logged an hour, or
      // another admin saved, since the tab loaded) 409s rather than clobbering their write.
      await api.putUserEntries(selId, draft, sheet?.version);
      await loadSheet(selId);
      ui.toast(TT.t('Corrections saved'));
      onReviewChanged?.();
    } catch (e) {
      // SB-034: on a stale-write conflict, reload the fresh sheet (dropping the draft) and
      // surface a brief notice so the admin re-applies the correction against current data.
      if ((e as ApiError).status === 409) {
        await loadSheet(selId);
        setErr(TT.t('This timesheet changed while you were editing — reloaded. Re-apply your correction.'));
      } else {
        setErr((e as Error).message || 'save failed');
      }
    }
    setBusy(false);
  };

  const lockVerb = async (verb: 'approve' | 'release', key: string) => {
    if (selId == null) return;
    setBusy(true);
    setErr('');
    try {
      if (verb === 'approve') await api.approveSegment(selId, key);
      else await api.releaseSegment(selId, key);
      await loadSheet(selId);
      ui.toast(verb === 'approve' ? TT.t('Week approved') : TT.t('Released for edits'));
      onReviewChanged?.();
    } catch (e) {
      setErr((e as Error).message || 'action failed');
    }
    setBusy(false);
  };

  const selUser = users?.find((u) => u.id === selId) || null;
  const openDates = segKey ? segDates(segKey) : [];
  const openEntries = segKey && catalog ? draft.filter((e) => TT.segmentKey(e.date) === segKey) : [];
  const openSeg =
    segKey && catalog ? TT.monthSegments(catalog, openDates[0]?.slice(0, 7) || '').find((s) => s.key === segKey) : null;

  return (
    <div className={vs.page}>
      <div className={vs.headerRow}>
        <h1 className={vs.h1}>{TT.t('Review')}</h1>
        <span className={vs.subtle}>{TT.t('correct and approve any user’s committed weeks')}</span>
      </div>
      {err && <div className={vs.errLine}>{err}</div>}
      <div className={rv.layout}>
        {/* user rail */}
        <nav className={rv.rail}>
          {users == null && <div className={rv.railEmpty}>{TT.t('Loading…')}</div>}
          {users?.length === 0 && <div className={rv.railEmpty}>{TT.t('No other users yet.')}</div>}
          {users?.map((u) => (
            <button
              key={u.id}
              className={[rv.railRow, u.id === selId && rv.railActive].filter(Boolean).join(' ')}
              onClick={() => setSelId(u.id)}
            >
              <StatusDot state={u.id === selId ? 'solid' : 'outline'} color="var(--accent)" size={7} />
              <span className={[sh.ellipsis, rv.railName].join(' ')}>{u.name}</span>
              <Chip mono={true} tone={u.role === 'admin' ? 'green' : 'neutral'}>
                {TT.t(u.role)}
              </Chip>
            </button>
          ))}
        </nav>

        {/* panel */}
        <section className={rv.panel}>
          {!selUser && <div className={vs.empty}>{TT.t('Pick a user to review their weeks.')}</div>}
          {selUser && !sheet && <div className={vs.empty}>{TT.t('Loading…')}</div>}
          {selUser && sheet && catalog && (
            <>
              <div className={rv.panelHead}>
                <span className={rv.panelName}>{selUser.name}</span>
                <span className={vs.subtle}>{selUser.email}</span>
              </div>
              {months.length === 0 && <div className={vs.empty}>{TT.t('No entries logged.')}</div>}
              {months.map((month) => {
                const segs = TT.monthSegments(catalog, month);
                const good = segs.every((s) => s.committed);
                return (
                  <div key={month} className={rv.monthBlock}>
                    <div className={rv.monthHead}>
                      <span className={rv.monthLabel}>{TT.fmtMonth(month)}</span>
                      <Chip mono={true} tone={good ? 'green' : 'neutral'}>
                        {good ? TT.t('month good') : TT.t('incomplete')}
                      </Chip>
                    </div>
                    <div className={rv.pillRow}>
                      {segs.map((seg) => {
                        const dates = segDates(seg.key);
                        const tone = seg.approved ? 'accent' : seg.committed ? 'green' : 'neutral';
                        const label = seg.approved ? TT.t('locked') : seg.committed ? TT.t('committed') : TT.t('open');
                        return (
                          <button
                            key={seg.key}
                            className={[rv.pill, seg.key === segKey && rv.pillActive].filter(Boolean).join(' ')}
                            data-committed={seg.committed}
                            data-locked={seg.approved}
                            onClick={() => setSegKey(seg.key === segKey ? null : seg.key)}
                          >
                            <StatusDot
                              state={seg.committed ? 'solid' : 'outline'}
                              color={seg.approved ? 'var(--accent)' : seg.committed ? 'var(--green)' : 'var(--text-4)'}
                              size={7}
                            />
                            <span className={rv.pillRange}>{segLabel(dates)}</span>
                            <Chip mono={true} tone={tone}>
                              {label}
                            </Chip>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {/* week panel */}
              {segKey && openSeg && (
                <div className={rv.weekPanel}>
                  <div className={rv.weekHead}>
                    <span className={rv.weekTitle}>{segLabel(openDates)}</span>
                    <span className={rv.weekActions}>
                      <Button variant="secondary" size="sm" onClick={save} disabled={busy || !dirty}>
                        {TT.t('Save corrections')}
                      </Button>
                      {/* SB-056 / DD-008: approve and release are ledger WRITES, so the server
                          403s them under `vault` (segmentLockHandler). This is the admin half of
                          the same capability WeekView explains to the employee — leaving the
                          buttons here would offer a verb that can only fail, which is the
                          "reads as a bug months later" failure the ruling names. */}
                      {committingOff ? null : openSeg.committed && !openSeg.approved ? (
                        <Button variant="primary" size="sm" onClick={() => lockVerb('approve', segKey)} disabled={busy}>
                          {TT.t('Approve week')}
                        </Button>
                      ) : null}
                      {!committingOff && openSeg.approved && (
                        <Button variant="ghost" size="sm" onClick={() => lockVerb('release', segKey)} disabled={busy}>
                          {TT.t('Release for edits')}
                        </Button>
                      )}
                    </span>
                  </div>
                  {committingOff && <div className={vs.capabilityOff}>{TT.t(committingOff)}</div>}
                  <div className={rv.editTable}>
                    <div className={[rv.editRow, rv.editHead].join(' ')}>
                      <span>{TT.t('date')}</span>
                      <span>{TT.t('time')}</span>
                      <span>{TT.t('task')}</span>
                      <span>{TT.t('note')}</span>
                      <span className={vs.right}>{TT.t('amount')}</span>
                    </div>
                    {openEntries.length === 0 && <div className={vs.empty}>{TT.t('No entries in this week.')}</div>}
                    {openEntries.map((entry) => {
                      const code = TT.entryProjectCode(catalog, entry);
                      return (
                        <div key={entry.id + ':' + nonce} className={rv.editRow}>
                          <span className={[vs.mono, vs.cSecondary].join(' ')}>{entry.date.slice(5)}</span>
                          <input
                            className={rv.cell}
                            defaultValue={TT.fmtTimeCell(entry)}
                            onBlur={(e) => applyTime(entry.id, e.target.value)}
                          />
                          <span className={rv.taskCell}>
                            <span className={vs.code} style={{ color: TT.projColor(catalog, code) }}>
                              {code || '—'}
                            </span>
                            <input
                              className={[rv.cell, rv.cellGrow].join(' ')}
                              defaultValue={entry.label || ''}
                              onBlur={(e) => editEntry(entry.id, { label: e.target.value })}
                            />
                            {entry.editedByAdmin && (
                              <span className={rv.editedMark} title={TT.t('edited by admin')}>
                                ✎ {TT.t('edited')}
                              </span>
                            )}
                          </span>
                          <input
                            className={[rv.cell, rv.cellGrow].join(' ')}
                            defaultValue={entry.note || ''}
                            onBlur={(e) => editEntry(entry.id, { note: e.target.value })}
                          />
                          <span className={[vs.mono, vs.right, vs.cBody].join(' ')}>
                            {TT.fmtMoney(TT.effectiveAmount(catalog, entry), catalog.settings.currency)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className={rv.weekNote}>
                    {TT.t(
                      'Corrections are marked “edited by admin”. Approving locks the week — the employee can no longer reopen it until you release it.',
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
