import React from 'react';
import TT from '../../i18n';
import { SectionLabel, Button } from '../../ds';
import st from './settings.module.css';
import type { AppState, MirrorBlock } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface MirrorSectionProps {
  state: AppState;
  ui: UiActions;
  admin: boolean;
}

/** An ISO instant as a local `Sun 26 Jul 13:07`. The stamp is UTC; people read local time. */
function whenLocal(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return TT.fmtDayShort(TT.dateStr(at)) + ' ' + hh + ':' + mm;
}

/**
 * SB-085: the standing mirror refusal, and the way out of it.
 *
 * SB-065 made the block STICKY and persisted, but the only surface it had was the transient
 * "markdown mirror failed" toast on each save — a passing message about a permanent state,
 * with no way out except a hand-rolled POST. This is the way out.
 *
 * The action is two-step on purpose, and deliberately NOT `confirm()`: acknowledging adopts
 * whatever bytes are on disk as Time Turtle's own, which is what lets the next save
 * overwrite them. That is destructive to the other machine's edits, so the second step says
 * so in those words instead of asking "OK?".
 *
 * SB-095: a block carrying `userId` is SOMEONE ELSE'S, shown to an admin. Same affordance,
 * addressed differently — "everything you log is still saved" is not true of a row about a
 * colleague — and the acknowledge call is keyed by that id.
 */
function MirrorBlockedNotice({ block, ui, onCleared }: { block: MirrorBlock; ui: UiActions; onCleared?: () => void }) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const mine = block.userId === undefined;
  // A fresh refusal (new detectedAt) folds the confirm step back up — the user would be
  // answering about a different file state than the one they opened the question on.
  React.useEffect(() => {
    setConfirming(false);
  }, [block.detectedAt]);
  const adopt = () => {
    setBusy(true);
    void ui.acknowledgeMirror(block.userId).then(() => {
      setBusy(false);
      setConfirming(false);
      onCleared?.();
    });
  };
  return (
    <div className={st.mirrorBlock}>
      <div className={st.mirrorBlockHead}>
        <span className={st.mirrorBlockDot}></span>
        <span className={st.mirrorBlockTitle}>
          {mine ? TT.t('Mirror paused') : TT.t('Mirror paused for ') + (block.userName ?? '')}
        </span>
      </div>
      <div className={st.mirrorBlockPath}>{block.path}</div>
      <div className={st.mirrorBlockMeta}>
        {TT.t(block.reason)} · {TT.t('detected ') + whenLocal(block.detectedAt)} ·{' '}
        {block.lastWrittenAt
          ? TT.t('last written by Time Turtle ') + whenLocal(block.lastWrittenAt)
          : TT.t('never written by Time Turtle')}
      </div>
      <div className={st.mirrorBlockBody}>
        {mine
          ? TT.t(
              'Time Turtle will not overwrite a file it did not write, so it has stopped mirroring this timesheet. Everything you log is still saved here — only the markdown file is frozen. Copy it somewhere safe if it holds changes you need.',
            )
          : TT.t(
              'Time Turtle will not overwrite a file it did not write, so it has stopped mirroring this person’s timesheet. Their hours are still saved here — only the markdown file is frozen. Copy it somewhere safe before you adopt it.',
            )}
      </div>
      {confirming ? (
        <>
          <div className={st.mirrorBlockWarn}>
            {TT.t(
              'Nothing is merged: Time Turtle adopts the file exactly as it stands right now, and the next save replaces its contents with the data in this app.',
            )}
          </div>
          <div className={st.mirrorBlockActions}>
            <Button variant="danger" size="sm" disabled={busy} onClick={adopt}>
              {TT.t('Adopt it and overwrite on the next save')}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              {TT.t('cancel')}
            </Button>
          </div>
        </>
      ) : (
        <div className={st.mirrorBlockActions}>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            {TT.t('Adopt the file on disk…')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * SB-095 — the mirror-refusal surface EVERY user can reach.
 *
 * SB-085 put the notice under the Mirror folder input, inside `MarkdownSection`, which is
 * admin-only: an employee whose own mirror had stopped saw nothing but a toast flying past,
 * with no way to clear it. Terje's ruling (2026-07-26) splits the two apart, because their
 * audiences differ and that is the whole reason they separate:
 *
 *   - the mirror FOLDER decides where on the server everyone's timesheets are written, so it
 *     stays where it was, admin-only, in `MarkdownSection`;
 *   - the refusal on MY OWN file is mine to clear, so it gets its own row that everyone sees.
 *
 * Two consequences worth stating, because both are easy to get wrong:
 *   1. The section renders NOTHING when nothing is blocked — no permanent empty row on a
 *      healthy install. The block is the reason the row exists.
 *   2. The admin's own block MOVED here; `MirrorDirRow` no longer renders it, so it appears
 *      exactly once.
 *
 * The admin half is the second defect SB-095 names: `/api/state` reports only the session
 * user's block, so an employee's was invisible even though `POST /api/mirror/acknowledge` has
 * taken `{userId}` since SB-065 — built and unreachable. `GET /api/mirror/blocks` is the
 * missing read; it 403s for a non-admin, so this fetch is gated on `admin` and its failure
 * path draws nothing.
 */
export function MirrorSection({ state, ui, admin }: MirrorSectionProps) {
  const own = state.mirrorBlocked || null;
  const [others, setOthers] = React.useState<MirrorBlock[]>([]);
  const meId = state.user.id;
  // The read returns EVERY block including the caller's own; we drop ours, because it is
  // already rendered above from /api/state (the ruling: do not render it twice).
  const reload = React.useCallback(() => {
    if (!admin) {
      setOthers([]);
      return;
    }
    void ui.mirrorBlocks().then((blocks) => setOthers(blocks.filter((block) => block.userId !== meId)));
    // Deliberately NOT depending on `ui`: App rebuilds that object on every render, so a
    // dependency on it would refire this fetch on every keystroke in the app. The identity
    // that actually decides the result is who I am and whether I may ask.
  }, [admin, meId]);
  // Refetch when my own block appears or changes: the write that just blocked my mirror is
  // often the same admin cross-user edit that blocked someone else's.
  React.useEffect(reload, [reload, own?.detectedAt]);
  if (!own && others.length === 0) return null;
  return (
    <div className={st.section}>
      <SectionLabel style={{ marginBottom: 10 }}>{TT.t('Mirror')}</SectionLabel>
      {own && <MirrorBlockedNotice block={own} ui={ui} />}
      {others.map((block) => (
        <MirrorBlockedNotice key={block.path} block={block} ui={ui} onCleared={reload} />
      ))}
    </div>
  );
}
