import React from 'react';
import TT from '../../i18n';
import { Input } from '../../ds';
import st from './settings.module.css';
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface SettingsProps {
  state: AppState;
  ui: UiActions;
}

/**
 * The mirror FOLDER — where on the server every user's timesheet file is written. Admin-only
 * by virtue of living inside `MarkdownSection`, and legitimately so: one path decides it for
 * the whole install.
 *
 * SB-095 took the standing-refusal notice OUT of here. SB-085 had put it under this input
 * because that is where the mirror lived, which left an employee's own refusal unreachable —
 * the folder row is admin-only and the refusal is not. It now has its own section
 * (`MirrorSection`) that every user sees, and it renders THERE and only there: putting it
 * back here would show an admin the same block twice.
 */
export function MirrorDirRow({ state, ui }: SettingsProps) {
  const saved = state.settings.mdDir || '';
  // DC-002: the server froze the mirror path to TT_MD_DIR — writes are rejected, so don't offer the edit
  const locked = !!state.mdDirLocked;
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
    </div>
  );
}
