import React from 'react';
import TT from '../../i18n';
import { Button, SectionLabel, SegToggle, Select, Input } from '../../ds';
import st from './settings.module.css';
import type { AppState, Shape, VaultPaths, VaultQuarantinedNote, VaultTimeSeparator } from '../../../../shared/types';
import type { UiActions } from '../../types';

interface SettingsProps {
  state: AppState;
  ui: UiActions;
}

/**
 * SB-056 / SB-100: the vault settings surface — the SHAPE selector, `vaultPaths`, and the time
 * separator SB-063 shipped deliberately WITHOUT a control.
 *
 * The selector chooses what this install IS, never which storage engine it runs (DD-015). The
 * backend falls out of the shape and has no control anywhere in the app.
 *
 * SB-063's reasoning for shipping headless was that its only consumer was a vault store that
 * did not exist yet. That reasoning expires exactly here, at the commit that makes `personal`
 * selectable, and this repo is its own live example of what the failure looks like: perfect
 * plumbing, a green api test, and a setting nobody can change from the app. Which is why this
 * task is judged at the browser rung and not at `api`.
 *
 * The heading name is a SETTING with a default, never a constant (SB-057): rename or translate
 * `## Time Log` and TT's parse boundary moves with it, so it has to be editable next to the
 * paths that decide which file it is a heading in.
 */

/** MirrorDirRow's discipline: commit on blur/Enter, revert on Escape. A path saved per keystroke is a half-typed path. */
function PathRow({
  label,
  value,
  placeholder,
  hint,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = () => {
    if (draft != null && draft.trim() !== value) onCommit(draft.trim());
    setDraft(null);
  };
  return (
    <div className={st.mirror}>
      <div className={st.mirrorRow}>
        <span className={[st.label, st.mirrorLabel, st.vaultLabel].join(' ')}>{label}</span>
        <Input
          value={draft != null ? draft : value}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') commit();
            else if (ev.key === 'Escape') setDraft(null);
          }}
          className={[st.small, st.mirrorInput].join(' ')}
        />
      </div>
      {hint && <div className={st.mirrorHint}>{hint}</div>}
    </div>
  );
}

/** An ISO instant as a local `Sun 26 Jul 13:07`. MirrorDirRow's formatter, same reason: stamps are UTC. */
function whenLocal(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return TT.fmtDayShort(TT.dateStr(at)) + ' ' + hh + ':' + mm;
}

/**
 * SB-127 / DD-021 + DD-022: the one gesture a paused note gets.
 *
 * OFFERED ON `note.adoptable` AND NOTHING ELSE, which the SERVER decides — `TT.vaultAdoptable` on
 * the reason, plus the note actually reading and parsing when the row was built. Both halves have
 * to be the server's: the predicate is the same one its endpoint gates on, and the second half is
 * a fact only a process that can read the vault has. Every row without it renders with NO CONTROL
 * AT ALL rather than a disabled or an unpriced one (DD-021 consequence 4): there is nothing for a
 * person to press, and a greyed button says there is.
 *
 * THE FLAG COMES WITH THE COUNTS OR NOT AT ALL. `VaultQuarantinedNote` is a union on it, so past
 * the guard below the three numbers are numbers — there is no unpriced row to default. That is the
 * defect this shape exists to make unwritable: the guard used to be the reason alone and the price
 * was read as `dropped ?? 0`, so a note that momentarily would not read — a sync blip, an iCloud
 * placeholder — rendered a bare one-click adopt with no counts, and discarded whatever it
 * discarded without asking. "The cost is unknown" is not "the cost is zero".
 *
 * ONE DIRECTION. There is no "keep Time Turtle's version" button beside this one and there is not
 * going to be one. Under `vault` SQLite is the derived index (DD-006), so that button would be an
 * in-place rewrite onto a file Time Turtle has just said it cannot read — the shape SB-065/DD-011
 * refused for the mirror in capitals, and the thing DD-021 killed permanently.
 *
 * THE COUNTS ARE ALWAYS THERE; THE CONFIRM IS NOT. The label cannot tell a reflow from a restore —
 * if it could, the note would not be paused — but the row CAN state the price, so the click is
 * uninformed only when it is also harmless. `dropped === 0` is one click. Anything else names the
 * number and asks once, in the shape MirrorSection already established one screen over: a warning
 * line, a danger confirm, a ghost cancel.
 *
 * `dropped` IS ABOUT CONTENT, NOT LENGTH, and the server computes it that way (DD-021 "drop **or
 * change**", DD-022 rider 1). Matching counts on a reflow are genuinely benign; matching counts on
 * a restore prove nothing, because the same number of hours logged differently is the ordinary
 * case. So `4 · 4` on this row does not imply one click, and must not be read as if it did.
 *
 * ADOPTING DOES NOT DAMAGE THE NOTE, and the confirm says so where a reader will meet it rather
 * than here. The table already parses; the rows that go away go away from Time Turtle's INDEX, the
 * derived side. That is why there is no checkpoint, no backup copy and no rename-first anywhere on
 * this path — DD-021 refuses the ceremony by name.
 */
function AdoptRow({ note, ui }: { note: VaultQuarantinedNote; ui: UiActions }) {
  const [confirming, setConfirming] = React.useState(false);
  if (!note.adoptable) return null;
  const dropped = note.dropped;
  const counts =
    TT.t('Time Turtle holds ') +
    note.ttEntries +
    ' ' +
    TT.t(note.ttEntries === 1 ? 'entry' : 'entries') +
    ' · ' +
    TT.t('the note has ') +
    note.noteEntries +
    '.';
  const adopt = () => ui.adoptVaultNote(note.path);
  return (
    <>
      <div className={st.mirrorBlockMeta}>{counts}</div>
      {confirming ? (
        <>
          <div className={st.mirrorBlockWarn}>
            {TT.t('Adopting takes this note’s rows exactly as they stand. ') +
              dropped +
              ' ' +
              TT.t(
                dropped === 1
                  ? 'entry Time Turtle holds is not in the note, and adopting drops it'
                  : 'entries Time Turtle holds are not in the note, and adopting drops them',
              ) +
              TT.t(
                ' — from Time Turtle’s index, not from the note. Nothing in the note is removed: Time Turtle re-signs its revision line and starts writing the day again.',
              )}
          </div>
          <div className={st.mirrorBlockActions}>
            <Button variant="danger" size="sm" data-tt="vault-adopt-confirm" onClick={adopt}>
              {TT.t('Adopt the note as-is')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {TT.t('cancel')}
            </Button>
          </div>
        </>
      ) : (
        <div className={st.mirrorBlockActions}>
          <Button
            variant="secondary"
            size="sm"
            data-tt="vault-adopt"
            onClick={() => (dropped ? setConfirming(true) : adopt())}
          >
            {dropped
              ? TT.t('Adopt — ') +
                dropped +
                ' ' +
                TT.t(dropped === 1 ? 'entry will be dropped' : 'entries will be dropped')
              : TT.t('Adopt the note as-is')}
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * SB-057 task 8: the daily notes Time Turtle has stopped writing to.
 *
 * STICKY STATE A PERSON CAN SEE, not a log line — modelled on `mirrorBlocked`, which is the shape
 * this repo already proved (SB-065 fixed exactly this failure once for the mirror: quietly ceasing
 * to write leaves the file drifting while it still LOOKS current). Under `personal` it is worse,
 * because the vault IS the storage.
 *
 * SB-127 ADDED THE ACTION SB-057 DELIBERATELY LEFT OUT. That omission was correct at the time and
 * said so: SB-103 owned what a human could DO about a quarantine, and shipping a button before it
 * was ruled would have ruled it. It was ruled — DD-021, widened by DD-022 — and `AdoptRow` above
 * is that ruling. Everything SB-057 built here is untouched; the gesture is purely additive, which
 * is what both decisions' first binding consequence requires.
 *
 * THE WORDING NEVER SAYS THE HOURS WERE CORRUPTED. Two of the commonest reasons are not damage —
 * an adopted note's missing digest (SB-091 rider 3) and a table editor reflowing cell padding
 * (SB-080's trade-off) — so the headline is *cannot prove it wrote this block*. The per-reason line
 * comes from `TT.vaultQuarantineText`, which falls back to a generic sentence rather than a blank:
 * SB-090 is open and will move reason names, and a row that renders nothing for an unfamiliar code
 * is a note that silently stops syncing, which is the whole failure this surface exists to prevent.
 */
function QuarantinedNotes({ notes, ui }: { notes: VaultQuarantinedNote[]; ui: UiActions }) {
  if (!notes.length) return null;
  return (
    <div className={st.mirrorBlock} data-tt="vault-quarantined">
      <div className={st.mirrorBlockHead}>
        <span className={st.mirrorBlockDot}></span>
        <span className={st.mirrorBlockTitle}>
          {TT.t('Notes paused')} ({notes.length})
        </span>
      </div>
      <div className={st.mirrorBlockBody}>{TT.t(TT.VAULT_QUARANTINE_HEADLINE)}</div>
      {notes.map((note) => (
        <div key={note.path} className={st.vaultQuarantineRow}>
          <div className={st.mirrorBlockPath}>{note.path}</div>
          <div className={st.mirrorBlockMeta}>
            {note.date}
            {note.detectedAt ? ' · ' + TT.t('paused') + ' ' + whenLocal(note.detectedAt) : ''}
          </div>
          <div className={st.mirrorBlockBody}>{TT.t(TT.vaultQuarantineText(note.reason))}</div>
          <AdoptRow note={note} ui={ui} />
        </div>
      ))}
    </div>
  );
}

export function VaultSection({ state, ui }: SettingsProps) {
  // The EFFECTIVE shape, not the stored one: TT_SHAPE and TT_SHAPE_LOCK can both beat the
  // setting, and the toggle has to show what is actually in force.
  const shape: Shape = state.shape ?? 'team';
  const locked = !!state.shapeLocked;
  // TT.VAULT_PATHS_DEFAULT, not a local literal: SB-057/SB-058 extend this shape additively, and
  // a copy here would go on producing a VaultPaths missing whatever key they add.
  const paths: VaultPaths = state.settings.vaultPaths ?? TT.VAULT_PATHS_DEFAULT;
  const separator: VaultTimeSeparator = state.settings.vaultTimeSeparator ?? 'unicode';
  return (
    <div className={st.section}>
      <SectionLabel style={{ marginBottom: 10 }}>{TT.t('Vault')}</SectionLabel>
      <div className={st.mirror}>
        <div className={st.mirrorRow}>
          <span className={[st.label, st.mirrorLabel, st.vaultLabel].join(' ')}>{TT.t('Instance shape')}</span>
          {locked ? (
            <span className={st.vaultLocked}>{shape}</span>
          ) : (
            <SegToggle
              value={shape}
              onChange={(next) => ui.setShape(next as Shape)}
              options={[
                { value: 'team', label: TT.t('Team') },
                { value: 'personal', label: TT.t('Personal') },
              ]}
            />
          )}
        </div>
        <div className={st.mirrorHint}>
          {locked
            ? TT.t('the server pins the instance shape (TT_SHAPE_LOCK) — change it in the server environment.')
            : TT.t(
                'A team install keeps SQLite as the source of truth and mirrors every save to markdown. A personal install is one person, with an Obsidian vault as the source of truth instead.',
              )}
        </div>
      </div>
      {shape === 'personal' && (
        <>
          {/* Design decision 3, said out loud rather than discovered: `personal` is selectable
              before SB-057 fills the vault store in. */}
          <div className={st.vaultWarn}>
            {TT.t(
              'The personal shape is not finished: the markdown mirror is off (the files it wrote are retired), committing is off until weekly notes land, and markdown paste-back is off. Daily notes DO sync — hours you log here are written into them, and edits made elsewhere are read back.',
            )}
          </div>
          <PathRow
            label={TT.t('Vault folder')}
            value={paths.root}
            placeholder={TT.t('e.g. ~/Obsidian/ballestad')}
            hint={TT.t('the vault root — every path below is relative to it.')}
            onCommit={(root) => ui.setVaultPaths({ root })}
          />
          <PathRow label={TT.t('Daily notes')} value={paths.daily} onCommit={(daily) => ui.setVaultPaths({ daily })} />
          <PathRow
            label={TT.t('Weekly notes')}
            value={paths.weekly}
            hint={TT.t('where the commit ledger will live once weekly rollups land.')}
            onCommit={(weekly) => ui.setVaultPaths({ weekly })}
          />
          <PathRow
            label={TT.t('Catalog note')}
            value={paths.catalog}
            onCommit={(catalog) => ui.setVaultPaths({ catalog })}
          />
          <PathRow
            label={TT.t('Time Log heading')}
            value={paths.timeLogHeading}
            hint={TT.t(
              'the heading Time Turtle writes its block under in a daily note — rename it here if you renamed it there.',
            )}
            onCommit={(timeLogHeading) => ui.setVaultPaths({ timeLogHeading })}
          />
          {/* Under the paths, because that is where "which files" already lives, and a paused note
              is a fact ABOUT those files. Above the separator, because it is the one thing on this
              screen that needs doing something about. */}
          <QuarantinedNotes notes={state.vaultQuarantined ?? []} ui={ui} />
          <div className={st.mirror}>
            <div className={st.mirrorRow}>
              <span className={[st.label, st.mirrorLabel, st.vaultLabel].join(' ')}>{TT.t('Time separator')}</span>
              <Select
                value={separator}
                onChange={(e) => ui.setVaultTimeSeparator(e.target.value as VaultTimeSeparator)}
                // DERIVED from core.js, never a hand-typed list: TT.TIME_SEPARATOR_VALUES owns
                // the vocabulary and TT.timeSeparator owns the glyph each name emits, so a
                // fourth value or a changed glyph shows up here without an edit — and the
                // sample shown is provably the one that would be written.
                //
                // The sample is in the label because the choice is about how it LOOKS. THE NAME
                // IS THERE TOO, and that is not decoration: measured in the browser, JetBrains
                // Mono composes `->` into a long-arrow ligature, so `ascii` and `unicode`
                // rendered PIXEL-IDENTICAL and the control could not tell you which you had
                // picked — SB-063's own warning landing on the control built to expose it.
                // `.vaultSeparator` turns ligatures off; the name is the half that cannot lie
                // whatever font loads.
                options={TT.TIME_SEPARATOR_VALUES.map((name) => ({
                  value: name,
                  label: `09:00 ${TT.timeSeparator(name)} 10:00   ${name}`,
                }))}
                className={[st.small, st.vaultSeparator].join(' ')}
              />
            </div>
            <div className={st.mirrorHint}>
              {TT.t(
                'how a daily note writes a start and an end time. Reading accepts all three, so changing it never needs a migration.',
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
