import React from 'react';
import TT from '../../i18n';
import { SectionLabel, Button, Textarea } from '../../ds';
import st from './settings.module.css';
import { MirrorDirRow } from './MirrorDirRow';
import type { AppState } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface SettingsProps {
  state: AppState;
  ui: UiActions;
}

export function MarkdownSection({ state, ui }: SettingsProps) {
  const md = TT.serializeMd(state);
  const [draft, setDraft] = React.useState<string | null>(null);
  // SB-056 / DD-011: paste-back is a WRITE path into the store from mirror bytes, and under
  // `vault` those bytes stop being maintained (the mirror is off and the files already written
  // are retired). So the write affordance goes, and the reason goes where it was.
  //
  // COPY AND DOWNLOAD STAY. Reading an export harms nothing, and removing them would lose a
  // real capability for no reason — the gate is on the write, not on the section.
  //
  // HONESTY NOTE, because the symmetry with the other two capabilities does NOT hold and the
  // next reader will assume it does: `mirror` and `committing` are each enforced by a server
  // refusal, and this one is not. Paste-back applies through `ui.importMd`, which produces an
  // ordinary `PUT /api/state` the server cannot tell from normal editing — there is no signal
  // to refuse on. So this is a client-side gate over an admin-only section whose collections
  // that admin may write anyway; it removes a footgun, not a permission. Giving it real
  // enforcement needs a distinguishable request, which is SB-101's to design.
  const importOff = TT.shapeOffReason('mdImport', state.shape);
  const dirty = !importOff && draft != null && draft !== md;
  const download = () => {
    const blob = new Blob([md], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'timesheet.md';
    link.click();
    URL.revokeObjectURL(link.href);
    ui.toast(TT.t('timesheet.md downloaded'));
  };
  return (
    <div>
      <SectionLabel style={{ marginBottom: 10 }} dot={<span className={st.mdDot}></span>}>
        {TT.t('Markdown backend')}
      </SectionLabel>
      <p className={st.mdIntro}>
        {/* The stock blurb ends "paste it back here. This is the entire database" — both halves
            are false under `vault`, directly above a box that says paste-back is off. */}
        {importOff
          ? TT.t(
              'The whole timesheet as one markdown file — clients, projects and a section per day. Copy it or download it; in the personal shape it is an export, not the database.',
            )
          : TT.t(
              'The whole timesheet persists as one markdown file — clients, projects and a section per day. Sync it to any cloud drive, edit it by hand, paste it back here. This is the entire database.',
            )}
      </p>
      <MirrorDirRow state={state} ui={ui} />
      {importOff && <div className={st.vaultWarn}>{TT.t(importOff)}</div>}
      <Textarea
        value={dirty ? draft : md}
        rows={14}
        spellCheck={false}
        // Read-only rather than removed: the export is still worth seeing and copying, and a
        // box you can type into whose edits go nowhere is worse than one that says so.
        readOnly={!!importOff}
        onChange={(e) => setDraft(e.target.value)}
        className={st.mdArea}
      />
      <div className={st.mdActions}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            navigator.clipboard.writeText(md).then(() => ui.toast(TT.t('Markdown copied')));
          }}
        >
          {TT.t('copy')}
        </Button>
        <Button variant="secondary" size="sm" onClick={download}>
          {TT.t('download .md')}
        </Button>
        {dirty && (
          <Button
            variant="accent"
            size="sm"
            onClick={() => {
              if (ui.importMd(draft)) setDraft(null);
            }}
          >
            {TT.t('apply edits')}
          </Button>
        )}
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
            {TT.t('discard')}
          </Button>
        )}
      </div>
    </div>
  );
}
