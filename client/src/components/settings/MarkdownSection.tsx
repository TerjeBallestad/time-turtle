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
  const dirty = draft != null && draft !== md;
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
        {TT.t(
          'The whole timesheet persists as one markdown file — clients, projects and a section per day. Sync it to any cloud drive, edit it by hand, paste it back here. This is the entire database.',
        )}
      </p>
      <MirrorDirRow state={state} ui={ui} />
      <Textarea
        value={dirty ? draft : md}
        rows={14}
        spellCheck={false}
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
