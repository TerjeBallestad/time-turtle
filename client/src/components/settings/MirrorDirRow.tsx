import React from 'react';
import TT from '../../i18n';
import { Button, Input } from '../../ds';
import st from './settings.module.css';
import type { AppState, MirrorBlock } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface SettingsProps {
  state: AppState;
  ui: UiActions;
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
 * SB-085: the standing mirror refusal, rendered where the mirror already lives.
 *
 * SB-065 made the block STICKY and persisted, but the only surface it had was the transient
 * "markdown mirror failed" toast on each save — a passing message about a permanent state,
 * with no way out except a hand-rolled POST. This is the way out.
 *
 * The action is two-step on purpose, and deliberately NOT `confirm()`: acknowledging adopts
 * whatever bytes are on disk as Time Turtle's own, which is what lets the next save
 * overwrite them. That is destructive to the other machine's edits, so the second step says
 * so in those words instead of asking "OK?".
 */
function MirrorBlockedNotice({ block, ui }: { block: MirrorBlock; ui: UiActions }) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // A fresh refusal (new detectedAt) folds the confirm step back up — the user would be
  // answering about a different file state than the one they opened the question on.
  React.useEffect(() => {
    setConfirming(false);
  }, [block.detectedAt]);
  const adopt = () => {
    setBusy(true);
    void ui.acknowledgeMirror().then(() => {
      setBusy(false);
      setConfirming(false);
    });
  };
  return (
    <div className={st.mirrorBlock}>
      <div className={st.mirrorBlockHead}>
        <span className={st.mirrorBlockDot}></span>
        <span className={st.mirrorBlockTitle}>{TT.t('Mirror paused')}</span>
      </div>
      <div className={st.mirrorBlockPath}>{block.path}</div>
      <div className={st.mirrorBlockMeta}>
        {TT.t(block.reason)} · {TT.t('detected ') + whenLocal(block.detectedAt)} ·{' '}
        {block.lastWrittenAt
          ? TT.t('last written by Time Turtle ') + whenLocal(block.lastWrittenAt)
          : TT.t('never written by Time Turtle')}
      </div>
      <div className={st.mirrorBlockBody}>
        {TT.t(
          'Time Turtle will not overwrite a file it did not write, so it has stopped mirroring this timesheet. Everything you log is still saved here — only the markdown file is frozen. Copy it somewhere safe if it holds changes you need.',
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

export function MirrorDirRow({ state, ui }: SettingsProps) {
  const saved = state.settings.mdDir || '';
  // DC-002: the server froze the mirror path to TT_MD_DIR — writes are rejected, so don't offer the edit
  const locked = !!state.mdDirLocked;
  // SB-085: a refusal is state, not an event — it lives under the row that names the folder.
  const blocked = state.mirrorBlocked || null;
  const [draft, setDraft] = React.useState<string | null>(null);
  // commit on blur/Enter only — saving per keystroke would mkdir half-typed paths
  const commit = () => {
    if (draft != null && draft.trim() !== saved) ui.setMdDir(draft.trim());
    setDraft(null);
  };
  return (
    <div className={st.mirror}>
      <div className={st.mirrorRow}>
        <span className={[st.label, st.mirrorLabel].join(' ')}>{TT.t('Mirror folder')}</span>
        <Input
          value={locked ? '' : draft != null ? draft : saved}
          spellCheck={false}
          disabled={locked}
          placeholder={
            locked ? TT.t('locked to the server default') : TT.t('server default — e.g. ~/Obsidian/vault/timesheets')
          }
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') commit();
            else if (ev.key === 'Escape') setDraft(null);
          }}
          className={[st.small, st.mirrorInput].join(' ')}
          style={{ opacity: locked ? 0.5 : 1 }}
        />
      </div>
      <div className={st.mirrorHint}>
        {locked
          ? TT.t('the server pins the mirror folder (TT_MD_DIR_LOCK) — change it in the server environment.')
          : TT.t(
              'every save writes timesheet-<user>.md here — point it at a cloud-synced folder (Obsidian, Dropbox…). Empty uses the server default.',
            )}
      </div>
      {blocked && <MirrorBlockedNotice block={blocked} ui={ui} />}
    </div>
  );
}
