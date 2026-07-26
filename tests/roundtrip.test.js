// Golden markdown tests (DD-002: the mirror must be round-trippable).
//
// SDD-002 versions the frozen contract instead of breaking it:
//   • serializeMd now emits FORMAT V2 — entries carry their own project + label,
//     tasks are per-user templates {id,label,project}, projects own `billable`.
//   • parseMd still reads V1 files, MIGRATING on read: each entry's task id is
//     resolved and its label + project are COPIED onto the entry (a dangling id
//     becomes the label with a null project — the old silent loss made visible).
//
// So there are two goldens:
//   1. The V1 fixture stays byte-identical, but is now a V1-PARSE test — it pins
//      the migration (parse V1 → assert the copied-at-birth state), not a
//      serialize round-trip (serialize emits V2, so V1 is no longer a fixed point).
//   2. A new V2 fixture pins the emission: serialize(parse(v2)) === v2.
//
// ## Verified red-green: 2026-07-23
// SDD-002 ruling 4: an additive `## commits` section carries the commit ledger + the
// per-entry money snapshot; no-commit V1/V2 goldens stay byte-identical.
// ## Verified red-green: 2026-07-24
// SDD-002 rulings 5 & 6 (SB-025, PLAN-007): additive approved:/released: segment tokens
// + the [ea] edited-by-admin entry marker round-trip exactly; existing goldens unchanged.
// ## Verified red-green: 2026-07-24
// SB-041 (PLAN-008): delimiter safety — `|`, `\` and a trailing [nb]/[ea] are ESCAPED, so
// content that looks like structure stops being read as structure. Goldens unchanged.
// ## Verified red-green: 2026-07-25
// SB-045 (PLAN-008 task 2): the vault `Task`-cell codec — `<br>` is a structural delimiter
// and `- ` a presentation prefix, so both are escaped/stripped to survive as content.
// Measured in the real vault: `\<br>` renders as literal text with zero <br> elements in
// BOTH Live Preview and Reading view; a genuine `<br>` yields exactly one.
// ## Verified red-green: 2026-07-25
// SB-059: `Entry.tags` (the vault `Mode` column) and `Project.vaultNote` (the `[[Wikilink]]`
// Project cell). Both round-trip; a block written before EITHER existed still parses and writes
// back byte-identically; a `|`, a `<br>` and a space in a tag or a note name are escaped and a
// newline is refused by the output gate rather than splitting a row; the v2 mirror does not move
// (SB-069) and carries neither field. 12 mutations of shared/core.js, each red on the tests it
// should be: tags dropped on write / on read, the wikilink not rendered / not resolved / stripped
// with no catalog, spaces and `|` unescaped, an empty Mode cell parsed as `[]`, the passthrough
// re-added as a fallback, a re-canonicalised header set, and a mirror token for `vaultNote`.
// ## Verified red-green: 2026-07-26
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import TT from '../shared/core.js';

// ---- V1 fixture (byte-identical to the pre-SDD-002 golden) ----
const V1_FIXTURE = [
  '# timesheet',
  '',
  'currency: kr',
  'language: en',
  '',
  '## clients',
  '- fjellheim | Fjellheim AS | round 15 | rate 1250',
  '- brygga | Brygga Digital | round exact',
  '- acme | Acme Inc | round 30 | rate 900',
  '- soloclient | Solo Client | round exact | rate 500',
  '',
  '## projects',
  '- FJH-NETT | Nettbutikk rebuild | fjellheim',
  '- FJH-DRIFT | Drift & support | fjellheim | rate 1400',
  '- INT-ADM | Internal admin | —',
  '- SOLO | Solo gig | — | rate 800',
  '',
  '## tasks',
  '- checkout | Checkout flow | FJH-NETT',
  '- ops | Ops & maintenance | FJH-DRIFT',
  '- admin | Admin & invoicing | —',
  '- internal | Internal | — | nb',
  '- upkeep | Upkeep | FJH-DRIFT | nb',
  '',
  '## 2026-01-05',
  '- 09:00→15:30 | checkout | information architecture',
  '- 5h | admin | first spike',
  '- 12:30→ | ops | still going',
  '',
  '## 2026-01-06',
  '- 08:30→12:00 | checkout | ',
  '- 1h30m | ops | cert renewal',
  '- 45m | admin | invoicing [nb]',
  '- 09:00→11:00 | — | no task here',
  '',
].join('\n');

// ---- V2 fixture (the EXACT canonical shape serializeMd emits) ----
// header carries `format: 2`; projects carry ` | nb` only when non-billable; tasks
// are `- id | label | project-or-—`; entries are
// `- <timecell> | <project-or-—> | <label> | <note>[ [nb]]`.
const V2_FIXTURE = [
  '# timesheet',
  '',
  'currency: kr',
  'language: en',
  'format: 2',
  '',
  '## clients',
  '- fjellheim | Fjellheim AS | round 15 | rate 1250',
  '- brygga | Brygga Digital | round exact', // round exact, no rate
  '',
  '## projects',
  '- FJH-NETT | Nettbutikk rebuild | fjellheim', // billable default (no marker)
  '- FJH-DRIFT | Drift & support | fjellheim | rate 1400',
  '- INT-ADM | Internal admin | —', // no client
  '- SOLO | Solo gig | — | rate 800 | nb', // non-billable default (SDD-002)
  '',
  '## tasks',
  '- checkout | Checkout flow | FJH-NETT', // template with project
  '- ops | Ops & maintenance | FJH-DRIFT',
  '- admin | Admin & invoicing | —', // template without project
  '',
  '## 2026-01-05',
  '- 09:00→15:30 | FJH-NETT | Checkout flow | information architecture', // range
  '- 5h | INT-ADM | Admin & invoicing | first spike', // duration
  '- 12:30→ | FJH-DRIFT | Ops & maintenance | still going', // running
  '',
  '## 2026-01-06',
  '- 08:30→12:00 | FJH-NETT | Checkout flow | ', // empty note (trailing space!)
  '- 1h30m | FJH-DRIFT | Ops & maintenance | cert renewal',
  '- 45m | INT-ADM | Admin & invoicing | invoicing [nb]', // non-billable entry
  '- 09:00→11:00 | — |  | no project here', // no project + empty label
  '',
].join('\n');

// ---- V2 + commits fixture (SDD-002 ruling 4 — the additive `## commits` section) ----
// A committed (ISO week ∩ month) segment carries a server-stamped committedAt and a
// per-entry money snapshot (rate | billMin | amount), one indented row per entry. The
// amounts are canonical numbers (incl. a fractional one) so the round-trip pins the
// exact frozen values, not merely that it parses.
const V2_COMMITS_FIXTURE = [
  '# timesheet',
  '',
  'currency: kr',
  'language: en',
  'format: 2',
  '',
  '## clients',
  '- fjellheim | Fjellheim AS | round 15 | rate 1250',
  '',
  '## projects',
  '- FJH-NETT | Nettbutikk rebuild | fjellheim',
  '',
  '## tasks',
  '- checkout | Checkout flow | FJH-NETT',
  '',
  '## 2026-01-05',
  '- 09:00→15:30 | FJH-NETT | Checkout flow | information architecture',
  '',
  '## commits',
  '- 2026-W02-2026-01 | 2026-01-15T10:00:00.000Z',
  '  - e1abc | 1250 | 390 | 8125',
  '  - e2def | 990 | 60 | 742.5', // fractional amount survives verbatim
  '',
].join('\n');

// ---- V2 + admin-lock/edit fixture (SDD-002 rulings 5 & 6, SB-025 — additive tokens) ----
// A committed segment carries a labeled `approved:<iso>` token; a SECOND committed segment
// (the same month, a different ISO week) carries a `released:<uid>` token (released-not-
// approved, unambiguous because the tokens are labeled). One entry carries the `[ea]`
// edited-by-admin marker. Every token is emit-when-present, so the fixture pins that they
// round-trip EXACTLY without disturbing the plain-committed shape above.
const V2_ADMIN_FIXTURE = [
  '# timesheet',
  '',
  'currency: kr',
  'language: en',
  'format: 2',
  '',
  '## clients',
  '- fjellheim | Fjellheim AS | round 15 | rate 1250',
  '',
  '## projects',
  '- FJH-NETT | Nettbutikk rebuild | fjellheim',
  '',
  '## tasks',
  '- checkout | Checkout flow | FJH-NETT',
  '',
  '## 2026-01-05',
  '- 09:00→15:30 | FJH-NETT | Checkout flow | information architecture [ea]', // edited by admin
  '',
  '## 2026-01-12',
  '- 09:00→12:00 | FJH-NETT | Checkout flow | search facets',
  '',
  '## commits',
  '- 2026-W02-2026-01 | 2026-01-15T10:00:00.000Z | approved:2026-01-20T08:30:00.000Z', // locked
  '  - e1abc | 1250 | 390 | 8125',
  '- 2026-W03-2026-01 | 2026-01-19T09:00:00.000Z | released:7', // released for edits by admin 7
  '  - e2def | 1250 | 180 | 3750',
  '',
].join('\n');

// ---- V2 + archived fixture (SDD-002 ruling 7 — the additive ` | archived` token) ----
// One archived client + one archived project sit alongside active ones; the token rides
// the client line (after rate) and the project line (after nb) only when true, so the
// active rows stay byte-identical to the V2 golden above. Amounts/resolution are
// unaffected — archived items still carry their rate/clientId so history resolves.
// ## Verified red-green: 2026-07-24
const V2_ARCHIVED_FIXTURE = [
  '# timesheet',
  '',
  'currency: kr',
  'language: en',
  'format: 2',
  '',
  '## clients',
  '- fjellheim | Fjellheim AS | round 15 | rate 1250',
  '- oldco | Old Co | round exact | rate 800 | archived', // archived client, token after rate
  '',
  '## projects',
  '- FJH-NETT | Nettbutikk rebuild | fjellheim',
  '- OLD-GIG | Retired gig | oldco | rate 900 | archived', // archived project (billable), token after rate
  '- OLD-NB | Retired non-billable | oldco | nb | archived', // archived + non-billable: token after nb
  '',
  '## tasks',
  '- checkout | Checkout flow | FJH-NETT',
  '',
  '## 2026-01-05',
  '- 09:00→15:30 | OLD-GIG | Retired gig | historical work on an archived project',
  '',
].join('\n');

describe('markdown V2 archived round-trip (ruling 7)', () => {
  it('serializeMd(parseMd(md)) === md for the V2+archived fixture (the token survives exactly)', () => {
    expect(TT.serializeMd(TT.parseMd(V2_ARCHIVED_FIXTURE))).toBe(V2_ARCHIVED_FIXTURE);
  });

  it('is idempotent when applied twice', () => {
    const once = TT.serializeMd(TT.parseMd(V2_ARCHIVED_FIXTURE));
    expect(TT.serializeMd(TT.parseMd(once))).toBe(once);
  });

  it('parses the archived flag onto the right client/project and defaults active ones to false', () => {
    const state = TT.parseMd(V2_ARCHIVED_FIXTURE);
    expect(state.clients.find((c) => c.id === 'oldco').archived).toBe(true);
    expect(state.clients.find((c) => c.id === 'fjellheim').archived).toBe(false);
    expect(state.projects.find((p) => p.code === 'OLD-GIG').archived).toBe(true);
    expect(state.projects.find((p) => p.code === 'OLD-NB').archived).toBe(true);
    expect(state.projects.find((p) => p.code === 'OLD-NB').billable).toBe(false); // archived AND non-billable
    expect(state.projects.find((p) => p.code === 'FJH-NETT').archived).toBe(false);
  });

  it('the active V2 golden emits NO archived token anywhere (emit-when-true keeps mirrors byte-identical)', () => {
    expect(TT.serializeMd(TT.parseMd(V2_FIXTURE))).not.toContain('archived');
    expect(TT.serializeMd(TT.parseMd(V1_FIXTURE))).not.toContain('archived');
  });
});

describe('markdown V2 golden round-trip', () => {
  it('serializeMd(parseMd(md)) === md for the full-syntax V2 fixture', () => {
    expect(TT.serializeMd(TT.parseMd(V2_FIXTURE))).toBe(V2_FIXTURE);
  });

  it('is idempotent when applied twice', () => {
    const once = TT.serializeMd(TT.parseMd(V2_FIXTURE));
    const twice = TT.serializeMd(TT.parseMd(once));
    expect(twice).toBe(once);
  });

  it('the built-in seed (now V2) round-trips to a stable fixed point', () => {
    const once = TT.serializeMd(TT.parseMd(TT.seedMd()));
    const twice = TT.serializeMd(TT.parseMd(once));
    expect(twice).toBe(once);
  });

  it('the no-commit V1 and V2 goldens carry no `## commits` header and parse to empty commits', () => {
    // The additive section must never touch existing mirrors: no header emitted…
    expect(TT.serializeMd(TT.parseMd(V1_FIXTURE))).not.toContain('## commits');
    expect(TT.serializeMd(TT.parseMd(V2_FIXTURE))).not.toContain('## commits');
    // …and both parse to an empty ledger (never undefined).
    expect(TT.parseMd(V1_FIXTURE).commits).toEqual([]);
    expect(TT.parseMd(V2_FIXTURE).commits).toEqual([]);
  });
});

describe('markdown V2 `## commits` round-trip (ruling 4)', () => {
  it('serializeMd(parseMd(md)) === md for the V2+commits fixture', () => {
    expect(TT.serializeMd(TT.parseMd(V2_COMMITS_FIXTURE))).toBe(V2_COMMITS_FIXTURE);
  });

  it('is idempotent when applied twice', () => {
    const once = TT.serializeMd(TT.parseMd(V2_COMMITS_FIXTURE));
    const twice = TT.serializeMd(TT.parseMd(once));
    expect(twice).toBe(once);
  });

  it('the per-entry money snapshot survives the round-trip with its resolved rate/billMin/amount', () => {
    const state = TT.parseMd(V2_COMMITS_FIXTURE);
    expect(state.commits).toHaveLength(1);
    expect(state.commits[0]).toMatchObject({
      key: '2026-W02-2026-01',
      committedAt: '2026-01-15T10:00:00.000Z',
    });
    expect(state.commits[0].snapshot).toEqual({
      e1abc: { rate: 1250, billMin: 390, amount: 8125 },
      e2def: { rate: 990, billMin: 60, amount: 742.5 },
    });
  });
});

describe('markdown V2 admin lock/edit round-trip (rulings 5 & 6, SB-025)', () => {
  it('serializeMd(parseMd(md)) === md for the V2+admin fixture (additive tokens survive exactly)', () => {
    expect(TT.serializeMd(TT.parseMd(V2_ADMIN_FIXTURE))).toBe(V2_ADMIN_FIXTURE);
  });

  it('is idempotent when applied twice', () => {
    const once = TT.serializeMd(TT.parseMd(V2_ADMIN_FIXTURE));
    expect(TT.serializeMd(TT.parseMd(once))).toBe(once);
  });

  it('parses approvedAt / releasedBy onto the right segments and editedByAdmin onto the entry', () => {
    const state = TT.parseMd(V2_ADMIN_FIXTURE);
    const approved = state.commits.find((c) => c.key === '2026-W02-2026-01');
    const released = state.commits.find((c) => c.key === '2026-W03-2026-01');
    expect(approved).toMatchObject({ approvedAt: '2026-01-20T08:30:00.000Z' });
    expect('releasedBy' in approved).toBe(false); // labeled tokens default absent
    expect(released).toMatchObject({ releasedBy: 7 });
    expect('approvedAt' in released).toBe(false);
    expect(TT.segmentApproved(approved)).toBe(true);
    expect(TT.segmentApproved(released)).toBe(false); // released, not locked
    const edited = state.entries.find((e) => e.note === 'information architecture');
    expect(edited.editedByAdmin).toBe(true);
    expect(edited.note).toBe('information architecture'); // marker stripped from note text
    const plain = state.entries.find((e) => e.note === 'search facets');
    expect('editedByAdmin' in plain).toBe(false);
  });
});

describe('markdown V1 migration on read', () => {
  const state = TT.parseMd(V1_FIXTURE);

  it('templates become {id, label, project} (billable dropped — the project owns it now)', () => {
    expect(state.tasks).toEqual([
      { id: 'checkout', label: 'Checkout flow', project: 'FJH-NETT' },
      { id: 'ops', label: 'Ops & maintenance', project: 'FJH-DRIFT' },
      { id: 'admin', label: 'Admin & invoicing', project: null },
      { id: 'internal', label: 'Internal', project: null },
      { id: 'upkeep', label: 'Upkeep', project: 'FJH-DRIFT' },
    ]);
    expect(state.tasks.every((t) => !('billable' in t))).toBe(true);
  });

  it('each entry gets its task’s label + project copied onto it — and drops the link', () => {
    const entries = state.entries;
    // 09:00→15:30 | checkout | information architecture
    expect(entries[0]).toMatchObject({
      project: 'FJH-NETT',
      label: 'Checkout flow',
      note: 'information architecture',
      billable: true,
      start: 540,
      end: 930,
    });
    // 45m | admin | invoicing [nb] — frozen non-billable preserved, project is admin's (null)
    const nb = entries.find((e) => e.note === 'invoicing');
    expect(nb).toMatchObject({ project: null, label: 'Admin & invoicing', billable: false, durMin: 45 });
    // 09:00→11:00 | — | no task here — a taskless V1 entry: empty label, null project
    const taskless = entries.find((e) => e.note === 'no task here');
    expect(taskless).toMatchObject({ project: null, label: '', billable: true });
    // the task-id link is gone from every entry (no leftover intermediate field either)
    expect(entries.every((e) => !('task' in e) && !('_task' in e))).toBe(true);
  });

  it('billing is unchanged: a migrated entry costs the same as before the format bump', () => {
    // checkout entry: 09:00→15:30 = 390 min on fjellheim (round 15, rate 1250)
    const e = state.entries[0];
    expect(TT.entryMinutes(e)).toBe(390);
    expect(TT.billMinutes(state, e)).toBe(390); // already a multiple of 15
    expect(TT.amount(state, e)).toBe((390 / 60) * 1250);
  });

  it('re-serializing a migrated V1 sheet emits V2 (the format marker appears)', () => {
    expect(TT.serializeMd(state)).toContain('format: 2');
  });
});

// ---- SB-041 / PLAN-008: content that LOOKS like structure ----
// Three reproduced failures, one per hazard:
//   1. `|` anywhere in a field truncated the value at the pipe.
//   2. A note ending in `[nb]`/`[ea]` lost the text AND falsely set the flag.
//   3. A project's positional clientId was scanned as a rule token (`nb`, `archived`).
// The fixture below is the ESCAPED canonical shape — `\|`, `\\`, `\[nb]`. Byte equality
// alone would prove nothing (both sides can agree on a corrupted reading), so every
// block here asserts the PARSED VALUES, and asserts them over TWO cycles: accretion and
// flag-eating only surface on the second pass.
const V2_HOSTILE_FIXTURE = [
  '# timesheet',
  '',
  'currency: kr',
  'language: en',
  'format: 2',
  '',
  '## clients',
  '- acme | Acme \\| Co | round exact', // pipe in a client NAME
  '- nb | Client Whose Id Looks Like A Flag | round exact', // client id === a project rule token
  '- archived | Client Whose Id Looks Archived | round exact | rate 500', // ditto
  '- back\\\\slash | Back\\\\slash Ltd | round exact', // literal backslash in id + name
  '',
  '## projects',
  '- A\\|B | Pipe \\| Project | acme', // pipe in a project CODE and name
  '- P-NB | Flaglike client | nb', // clientId `nb` sits at parts[2] (failure 3)
  '- P-ARCH | Archived-looking client | archived | nb', // clientId `archived` + a REAL nb token
  '- P-BS | Backslash client | back\\\\slash',
  '',
  '## tasks',
  '- t\\|1 | Task \\| One | A\\|B',
  '',
  '## 2026-01-05',
  '- 5h | A\\|B | Task \\| One | refactored the \\[nb]', // trailing [nb] as TEXT, still billable
  '- 45m | A\\|B | Task \\| One | done \\[ea] [nb]', // escaped [ea] as text + a REAL [nb] flag
  '- 1h30m | P-NB | Flaglike client | path C:\\\\work', // literal backslash in a note
  '',
].join('\n');

describe('markdown V2 delimiter safety (SB-041)', () => {
  it('serializeMd(parseMd(md)) === md for the hostile fixture', () => {
    expect(TT.serializeMd(TT.parseMd(V2_HOSTILE_FIXTURE))).toBe(V2_HOSTILE_FIXTURE);
  });

  it('is a fixed point under a SECOND cycle (a single pass hides accretion)', () => {
    const once = TT.serializeMd(TT.parseMd(V2_HOSTILE_FIXTURE));
    expect(TT.serializeMd(TT.parseMd(once))).toBe(once);
  });

  it('failure 1 — a pipe survives in every field it can appear in', () => {
    const state = TT.parseMd(V2_HOSTILE_FIXTURE);
    expect(state.clients.find((c) => c.id === 'acme').name).toBe('Acme | Co');
    const proj = state.projects.find((p) => p.code === 'A|B');
    expect(proj).toBeTruthy();
    expect(proj.name).toBe('Pipe | Project');
    expect(proj.clientId).toBe('acme');
    expect(state.tasks[0]).toEqual({ id: 't|1', label: 'Task | One', project: 'A|B' });
    const e = state.entries[0];
    expect(e.project).toBe('A|B');
    expect(e.label).toBe('Task | One');
  });

  it('failure 2 — a note ending in [nb]/[ea] keeps its text and does NOT set the flag', () => {
    const state = TT.parseMd(V2_HOSTILE_FIXTURE);
    // the reproduction from the ticket, asserted as VALUES
    expect(state.entries[0].note).toBe('refactored the [nb]');
    expect(state.entries[0].billable).toBe(true);
    expect('editedByAdmin' in state.entries[0]).toBe(false);
    // an escaped [ea] is text; the unescaped [nb] beside it is still a genuine flag
    expect(state.entries[1].note).toBe('done [ea]');
    expect(state.entries[1].billable).toBe(false);
    expect('editedByAdmin' in state.entries[1]).toBe(false);
  });

  it('failure 3 — a clientId that collides with a rule token is not read as a flag', () => {
    const state = TT.parseMd(V2_HOSTILE_FIXTURE);
    // `- P-NB | Flaglike client | nb` — parts[2] is the POSITIONAL clientId, never a token
    const pnb = state.projects.find((p) => p.code === 'P-NB');
    expect(pnb.clientId).toBe('nb');
    expect(pnb.billable).toBe(true);
    expect(pnb.archived).toBe(false);
    const parch = state.projects.find((p) => p.code === 'P-ARCH');
    expect(parch.clientId).toBe('archived');
    expect(parch.archived).toBe(false); // ditto
    expect(parch.billable).toBe(false); // …but a genuine `nb` token AFTER the clientId still lands
  });

  it('a literal backslash round-trips in ids, names and notes', () => {
    const state = TT.parseMd(V2_HOSTILE_FIXTURE);
    expect(state.clients.find((c) => c.id === 'back\\slash').name).toBe('Back\\slash Ltd');
    expect(state.projects.find((p) => p.code === 'P-BS').clientId).toBe('back\\slash');
    expect(state.entries[2].note).toBe('path C:\\work');
  });

  // The hazards above, driven from STATE rather than from markdown: this is the direction
  // the app actually writes (user types → serialize → mirror), so it catches an escape
  // that parses fine but is never emitted.
  it('hostile values entered as state survive serialize→parse→serialize→parse', () => {
    /** @type {any} */
    const state = {
      settings: { currency: 'kr', language: 'en' },
      clients: [
        { id: 'acme', name: 'Acme | Co', rounding: 'exact', rate: null, archived: false },
        { id: 'nb', name: 'Flaglike Client', rounding: 'exact', rate: null, archived: false },
      ],
      projects: [
        { code: 'A|B', name: 'Pipe | Project', clientId: 'acme', rate: null, billable: true, archived: false },
        // a billable project whose CLIENT id is `nb` — the old scan flipped it off and then
        // re-emitted the flag, so the corruption grew a token per write cycle
        { code: 'P-NB', name: 'Flaglike', clientId: 'nb', rate: null, billable: true, archived: false },
      ],
      tasks: [{ id: 'nb', label: 'Weird | template', project: 'A|B' }],
      entries: [
        {
          id: 'e1',
          date: '2026-01-05',
          start: null,
          end: null,
          durMin: 300,
          project: 'A|B',
          label: 'Task | One',
          note: 'refactored the [nb]',
          billable: true,
        },
        {
          id: 'e2',
          date: '2026-01-05',
          start: null,
          end: null,
          durMin: 45,
          project: 'A|B',
          label: 'back\\slash',
          note: 'trailing [nb] [ea]', // BOTH markers as text — the old strip loop ate both
          billable: false,
          editedByAdmin: true,
        },
      ],
      commits: [],
    };
    const once = TT.serializeMd(state);
    const back = TT.parseMd(once);
    expect(back.clients[0].name).toBe('Acme | Co');
    expect(back.projects[0]).toMatchObject({ code: 'A|B', name: 'Pipe | Project', billable: true, archived: false });
    expect(back.projects[1]).toMatchObject({ code: 'P-NB', clientId: 'nb', billable: true, archived: false });
    expect(back.tasks[0]).toEqual({ id: 'nb', label: 'Weird | template', project: 'A|B' });
    expect(back.entries[0]).toMatchObject({ note: 'refactored the [nb]', billable: true, label: 'Task | One' });
    expect(back.entries[1]).toMatchObject({
      note: 'trailing [nb] [ea]',
      billable: false,
      editedByAdmin: true,
      label: 'back\\slash',
    });
    // second cycle — the fixed point, where accretion would show
    const twice = TT.serializeMd(back);
    expect(twice).toBe(once);
    expect(TT.parseMd(twice).entries[1].note).toBe('trailing [nb] [ea]');
  });

  it('emit-when-needed: content with no reserved character gains no escape', () => {
    // the guard on every existing golden — an escape must never appear unbidden
    for (const golden of [V1_FIXTURE, V2_FIXTURE, V2_COMMITS_FIXTURE, V2_ADMIN_FIXTURE, V2_ARCHIVED_FIXTURE]) {
      expect(TT.serializeMd(TT.parseMd(golden))).not.toContain('\\');
    }
    expect(TT.serializeMd(TT.parseMd(TT.seedMd()))).not.toContain('\\');
  });
});

// ---- SB-071 / PLAN-009 task 1: the READ half of the codec is public ----
// `TT.splitUnescaped` / `TT.splitCells` split a row on UNESCAPED delimiters and hand back
// the pieces STILL escaped. They were module-private; SB-055's vault parser needs them, and
// the alternative was a second hand-maintained copy of the exact invariant PLAN-008 unified.
//
// So the property under test is not "the export exists" — it is that ONE implementation of
// the unescaped-split rule serves BOTH formats. The second test drives the same corpus
// through the production v2 mirror parser and asserts it lands on the same boundaries, so
// the rule cannot drift between the mirror and the vault.
// ## Verified red-green: 2026-07-25
describe('unescaped-split primitives are public and shared (SB-071)', () => {
  // Each entry is the ENCODED cell (what appears in a row) and the value it decodes to.
  const ESCAPE_CORPUS = [
    { name: 'a plain cell', cell: 'plain', value: 'plain' },
    { name: 'an escaped pipe', cell: 'a\\|b', value: 'a|b' },
    { name: 'a doubled backslash', cell: 'C:\\\\work', value: 'C:\\work' },
    { name: 'a trailing backslash', cell: 'ends with \\\\', value: 'ends with \\' },
    { name: 'an empty cell', cell: '', value: '' },
    { name: 'a cell that is only a pipe', cell: '\\|', value: '|' },
  ];

  it('splits the corpus into exactly one cell per entry, payloads still escaped', () => {
    const row = ESCAPE_CORPUS.map((c) => c.cell).join(' | ');
    const cells = TT.splitCells(row);
    expect(cells).toHaveLength(ESCAPE_CORPUS.length); // an escaped `|` never opens a new cell
    expect(cells).toEqual(ESCAPE_CORPUS.map((c) => c.cell)); // STILL escaped — decode is the caller's
    expect(cells.map(TT.decodeCell)).toEqual(ESCAPE_CORPUS.map((c) => c.value));
  });

  it('counts backslashes odd/even: `\\|` is content, `\\\\|` is a live delimiter', () => {
    // the sharp edge — no space to hide behind, the delimiter sits right on the backslashes
    expect(TT.splitCells('a\\|b')).toEqual(['a\\|b']); // odd → escaped → one cell
    expect(TT.splitCells('a\\\\|b')).toEqual(['a\\\\', 'b']); // even → live → two cells
  });

  it('TT.splitUnescaped works for the vault `<br>` delimiter too (one rule, both delimiters)', () => {
    expect(TT.splitUnescaped('label<br>- note', '<br>')).toEqual(['label', '- note']);
    expect(TT.splitUnescaped('a \\<br> b', '<br>')).toEqual(['a \\<br> b']); // escaped → not a delimiter
  });

  it('the vault row splitter and the v2 mirror parser resolve the corpus to the SAME boundaries', () => {
    const values = ESCAPE_CORPUS.map((c) => c.value);
    /** @type {any} */
    const state = {
      settings: { currency: 'kr', language: 'en' },
      clients: [],
      projects: [],
      tasks: [],
      entries: values.map((v, i) => ({
        id: 'e' + i,
        date: '2026-01-05',
        start: null,
        end: null,
        durMin: 30,
        project: null,
        label: v,
        note: v,
        billable: true,
      })),
      commits: [],
    };
    const md = TT.serializeMd(state);
    const rows = md.split('\n').filter((l) => l.startsWith('- 30m |'));
    expect(rows).toHaveLength(values.length);
    // the vault-side reader: split the SAME emitted rows with the newly public primitive
    rows.forEach((row, i) => {
      const cells = TT.splitCells(row.slice(2));
      expect(cells).toHaveLength(4); // time | project | label | note — never more, never fewer
      expect(TT.decodeCell(cells[2])).toBe(values[i]);
      expect(TT.decodeCell(cells[3])).toBe(values[i]);
    });
    // …and the production mirror parser lands on exactly the same values
    const back = TT.parseMd(md);
    expect(back.entries.map((e) => e.label)).toEqual(values);
    expect(back.entries.map((e) => e.note)).toEqual(values);
  });
});

/**
 * Give a hand-built fixture the digest TT would have written (DD-009), so it stands in for a note
 * TT wrote rather than one it would refuse. Input must be digest-LESS (or already correct), since
 * that is what still locates. Mutating a signed note afterwards is how the chimera is built.
 *
 * Deliberately NOT used by the goldens that assert the digest's VALUE or that corruption is
 * caught — those bake literals and mutate. This only canonicalises fixtures whose claim is
 * something else, so that claim is not blocked by a digest the fixture never set out to test.
 * @param {string} md @returns {string}
 */
const sign = (md) => {
  // strip any existing digest first: a fixture derived from a signed note by rewriting its rows
  // no longer verifies, so it would not even locate, and signing it is the whole point
  const lines = md.replace(/^`revision: (\d+)(?: · [0-9a-f]{4})?`$/m, '`revision: $1`').split('\n');
  const loc = TT.locateVaultBlock(lines.join('\n'));
  if (loc.quarantine) throw new Error('sign(): fixture does not locate — ' + loc.reason);
  const payload = [lines[loc.headerLine], lines[loc.separatorLine]].concat(loc.rowLines.map((n) => lines[n]));
  lines[loc.revisionLine] = '`revision: ' + loc.revision + ' · ' + TT.vaultPayloadDigest(payload) + '`';
  return lines.join('\n');
};

// ---- SB-045 / PLAN-008 task 2: the vault `Task` cell codec ----
// SB-045 froze the vault's Task column as `label<br>- note` in ONE cell. That makes
// `<br>` a structural delimiter and `- ` a presentation prefix — both are things a user
// can legitimately type. This is the codec SB-055's table serializer will call; the
// vault parser/serializer itself (heading anchors, totals row, `revision: N`) is NOT here.
//
// Every case is asserted over TWO cycles: the `- ` accretion (`- - note`) and the
// label/note swap only appear on the second one, so a single pass is blind to the exact
// bugs this codec exists to prevent.
describe('vault Task-cell codec (SB-045)', () => {
  /** @param {{label: string, note: string}} v */
  const cycle = (v) => TT.decodeTaskCell(TT.encodeTaskCell(v));

  const CASES = [
    { name: 'label + note (the ordinary shape)', v: { label: 'Checkout flow', note: 'wireframes' } },
    { name: 'label only', v: { label: 'Checkout flow', note: '' } },
    { name: 'note only — no label', v: { label: '', note: 'freeform hour' } },
    { name: 'both empty', v: { label: '', note: '' } },
    { name: 'a literal <br> in the note', v: { label: 'Docs', note: 'use <br> for line breaks' } },
    { name: 'a literal <br> in the label', v: { label: 'The <br> tag', note: 'explained' } },
    { name: 'a note that begins with "- "', v: { label: 'Checkout flow', note: '- a bulleted thought' } },
    { name: 'a note that begins with "- " and NO label', v: { label: '', note: '- a bulleted thought' } },
    { name: 'a label that begins with "- "', v: { label: '- weird label', note: 'note here' } },
    { name: 'a label that begins with "- " and no note', v: { label: '- weird label', note: '' } },
    { name: 'a pipe in both fields', v: { label: 'a|b', note: 'c|d' } },
    { name: 'a backslash in both fields', v: { label: 'C:\\work', note: 'path\\to\\thing' } },
    { name: 'an escaped-looking literal \\<br>', v: { label: 'x', note: 'literally \\<br> typed' } },
    { name: 'everything at once', v: { label: '- a|b <br>', note: '- c\\d <br> e' } },
  ];

  for (const { name, v } of CASES) {
    it(`round-trips ${name}`, () => {
      expect(cycle(v)).toEqual(v);
    });
  }

  // The value round-trip above is only half the story, and repeating it (`cycle(cycle(v))`)
  // adds nothing: `cycle` is pure, so `cycle(v) === v` implies every further pass. The
  // property it does NOT imply is the one that matters for repeated writes — the fixed
  // point of the ENCODED form, seeded from cell shapes a HAND EDIT can produce rather than
  // from the encoder's own output. That is where `- ` accretion and the label/note swap
  // would actually surface, and nothing above reaches these shapes.
  const HAND_EDITED = [
    'Checkout flow<br>- wireframes', // the canonical shape
    'Checkout flow', // label only
    '- freeform hour', // note only
    '', // empty cell
    'a<br>b', // note without the `- ` presentation prefix
    'a<br>- b<br>c', // a second, raw <br> the user typed
    '<br>- n', // stray leading delimiter, empty label
    'a<br>', // trailing delimiter, empty note
    '- - doubled', // a note that itself begins with `- `
    '\\- escaped label', // a label that begins with `- `
    'a\\|b<br>- c\\|d', // pipes escaped by the SB-041 layer
    'x<br>- literally \\<br> typed', // an escaped literal <br>
  ];
  for (const cell of HAND_EDITED) {
    it(`normalises then holds steady for a hand-edited cell: ${JSON.stringify(cell)}`, () => {
      const once = TT.encodeTaskCell(TT.decodeTaskCell(cell));
      const twice = TT.encodeTaskCell(TT.decodeTaskCell(once));
      expect(twice).toBe(once); // a second write must not drift — no accretion, no swap
      expect(TT.decodeTaskCell(twice)).toEqual(TT.decodeTaskCell(once)); // …and the values hold
    });
  }

  it('a cell the encoder produced is ALREADY normalised (no drift on first re-write)', () => {
    for (const { v } of CASES) {
      const encoded = TT.encodeTaskCell(v);
      expect(TT.encodeTaskCell(TT.decodeTaskCell(encoded))).toBe(encoded);
    }
  });

  it('emits SB-045’s exact shape: label<br>- note, label alone, and a bare `- note`', () => {
    expect(TT.encodeTaskCell({ label: 'Checkout flow', note: 'wireframes' })).toBe('Checkout flow<br>- wireframes');
    expect(TT.encodeTaskCell({ label: 'Checkout flow', note: '' })).toBe('Checkout flow');
    // note-only carries NO leading <br> (ruling: a bare `- note`)
    expect(TT.encodeTaskCell({ label: '', note: 'freeform hour' })).toBe('- freeform hour');
    expect(TT.encodeTaskCell({ label: '', note: '' })).toBe('');
  });

  it('a genuine <br> delimiter and an escaped literal are distinguishable in the bytes', () => {
    const cell = TT.encodeTaskCell({ label: 'Docs', note: 'use <br> here' });
    expect(cell).toBe('Docs<br>- use \\<br> here'); // one structural, one escaped
    expect(TT.decodeTaskCell(cell)).toEqual({ label: 'Docs', note: 'use <br> here' });
  });

  it('a label beginning with "- " does NOT decode as a note-only cell', () => {
    // the subtle one: `- foo` as a LABEL is otherwise indistinguishable from `foo` as a NOTE
    const asLabel = TT.encodeTaskCell({ label: '- foo', note: '' });
    const asNote = TT.encodeTaskCell({ label: '', note: 'foo' });
    expect(asLabel).not.toBe(asNote);
    expect(TT.decodeTaskCell(asLabel)).toEqual({ label: '- foo', note: '' });
    expect(TT.decodeTaskCell(asNote)).toEqual({ label: '', note: 'foo' });
  });

  it('composes with the cell escaping — a piped Task cell is still ONE cell', () => {
    const cell = TT.encodeTaskCell({ label: 'a|b', note: 'c|d' });
    expect(cell).toBe('a\\|b<br>- c\\|d');
    // SB-045 measured that `\|` renders as a literal `|` inside a two-line <br> cell, so a
    // vault row splitting on UNESCAPED pipes sees exactly one Task cell here.
    expect(cell.split(/(?<!\\)\|/)).toHaveLength(1);
  });

  it('emit-when-needed: ordinary content gains no escape at all', () => {
    expect(TT.encodeTaskCell({ label: 'Ops & maintenance', note: 'cert renewal + patching' })).toBe(
      'Ops & maintenance<br>- cert renewal + patching',
    );
  });
});

// ---- SB-055 / PLAN-009 task 2: locate the block, or refuse ----
// The safety half of the format, and the reason it is proven BEFORE anything parses a row:
// this function is what stands between a malformed daily note and TT overwriting Terje's
// Intentions, Habits, Captures and Reflection.
//
// So most of what is below is REFUSALS. A suite that fed only well-formed notes would prove
// the opposite of what this task claims. Note also what is NOT asserted anywhere: that a bad
// note makes the locator throw. A throw is not a quarantine — SB-057's boot scan needs a
// verdict it can record and surface, so every malformed case returns `{quarantine, reason}`.
// ## Verified red-green: 2026-07-25
describe('vault block locator (SB-055)', () => {
  /** A realistic daily note: TT's block sits between sections that are Terje's. */
  const HOST_NOTE = [
    '# 2026-01-05',
    '',
    '## Intentions',
    '',
    '- ship the block format',
    '',
    '## Time Log',
    '',
    '| Time | Mode | Project | Task | Bill |',
    '|---|---|---|---|---|',
    '| 09:00→09:15 | #admin | [[Planning]] | Daily planning ritual | |',
    '| 11:00→12:45 | #deep | FAG | Search & facets<br>- Narrow the facet query | ✓ |',
    '| **2h** | | | | **1.75h billable** |',
    '',
    '`revision: 8`',
    '',
    '## Captures',
    '',
    '- something Terje wrote',
    '',
  ].join('\n');

  /** @param {string} md @param {string} needle */
  const lineOf = (md, needle) => md.split('\n').indexOf(needle);

  it('locates the region and reads the revision', () => {
    const loc = TT.locateVaultBlock(HOST_NOTE);
    expect(loc.quarantine).toBe(false);
    expect(loc.revision).toBe(8);
    expect(loc.start).toBe(lineOf(HOST_NOTE, '## Time Log'));
    expect(loc.end).toBe(lineOf(HOST_NOTE, '`revision: 8`'));
    expect(loc.headerLine).toBe(lineOf(HOST_NOTE, '| Time | Mode | Project | Task | Bill |'));
    expect(loc.separatorLine).toBe(loc.headerLine + 1);
    expect(loc.rowLines).toEqual([loc.headerLine + 2, loc.headerLine + 3, loc.headerLine + 4]);
    expect(loc.totalsLine).toBe(loc.headerLine + 4); // the LAST row, first cell bold
  });

  it('the heading name is a PARAMETER, not a hardcoded string', () => {
    const renamed = HOST_NOTE.replace('## Time Log', '## Timeloggen');
    expect(TT.locateVaultBlock(renamed, { heading: 'Timeloggen' }).quarantine).toBe(false);
    // …and the default no longer finds anything in that note, which is what proves it
    expect(TT.locateVaultBlock(renamed)).toEqual({ quarantine: true, reason: 'no-heading' });
    // symmetrically, a non-default heading does not match the default note
    expect(TT.locateVaultBlock(HOST_NOTE, { heading: 'Timeloggen' }).quarantine).toBe(true);
  });

  // ---- the refusals ----
  const REFUSALS = [
    {
      name: 'no heading at all',
      reason: 'no-heading',
      md: ['# 2026-01-05', '', '## Captures', '', '- nothing to see', ''].join('\n'),
    },
    {
      name: 'heading present, no revision line before the hard stop',
      reason: 'no-revision',
      md: HOST_NOTE.replace('`revision: 8`\n', ''),
    },
    {
      name: 'a revision line that exists only PAST the hard stop',
      reason: 'revision-past-next-heading',
      // the bottom anchor is gone from the block and reappears under `## Captures` —
      // exactly the shape that would let a write run into Terje's section
      md: HOST_NOTE.replace('`revision: 8`\n', '').replace('- something Terje wrote', '`revision: 8`'),
    },
    {
      name: 'a `###` sub-heading between the table and the revision line',
      reason: 'revision-past-next-heading',
      md: HOST_NOTE.replace('`revision: 8`', '### Notes\n\n`revision: 8`'),
    },
    {
      name: 'more than one anchor heading in the file',
      reason: 'multiple-headings',
      md: HOST_NOTE + '\n## Time Log\n\n| Time |\n|---|\n\n`revision: 2`\n',
    },
    {
      name: 'the heading is the last line of the file',
      reason: 'no-revision',
      md: '# 2026-01-05\n\n## Time Log',
    },
    {
      name: 'two revision lines inside one block',
      reason: 'multiple-revisions',
      md: HOST_NOTE.replace('`revision: 8`', '`revision: 8`\n\n`revision: 9`'),
    },
    {
      name: 'the table is missing entirely',
      reason: 'no-table',
      md: '# 2026-01-05\n\n## Time Log\n\n`revision: 8`\n\n## Captures\n',
    },
    {
      name: 'a header row with no `|---|` delimiter row under it',
      reason: 'no-table',
      md: HOST_NOTE.replace('|---|---|---|---|---|\n', ''),
    },
    {
      name: 'prose between the heading and the table',
      reason: 'no-table',
      md: HOST_NOTE.replace('## Time Log\n', '## Time Log\n\nsome prose a hand edit left here\n'),
    },
    {
      name: 'stray content between the table and the revision line',
      reason: 'unexpected-content-in-block',
      md: HOST_NOTE.replace('`revision: 8`', 'a stray line\n\n`revision: 8`'),
    },
  ];

  for (const { name, reason, md } of REFUSALS) {
    it(`quarantines: ${name}`, () => {
      const loc = TT.locateVaultBlock(md);
      expect(loc).toEqual({ quarantine: true, reason });
    });
  }

  // ---- near-misses on the bottom anchor: backticks are LITERAL SYNTAX (SB-045) ----
  // Not the anchor, and not ANCHOR-SHAPED either: the inline-code span TT writes is missing,
  // unterminated, doubled, indented or trailed by prose, or what it opens with is not
  // `revision: <digits>`. TT cannot tell any of these from a line a human typed, so "there is no
  // revision line here" is the honest verdict and they stay exactly where SB-045 put them.
  // SB-090 deliberately did NOT widen `malformed-revision` to cover them: see the list below.
  const NEAR_MISSES = [
    'revision: 8', // bare — no backticks
    '`revision:8`', // no space
    '`revision: eight`', // not a number
    '`revision: 8', // unterminated
    '`Revision: 8`', // wrong case
    '  `revision: 8`', // indented (this is the code-fence shape)
    '`revision: 8` and more text', // not the whole line
    '``revision: 8``', // a double-backtick span
  ];
  for (const anchor of NEAR_MISSES) {
    it(`does NOT accept ${JSON.stringify(anchor)} as the bottom anchor`, () => {
      const md = HOST_NOTE.replace('`revision: 8`', anchor);
      const loc = TT.locateVaultBlock(md);
      expect(loc.quarantine).toBe(true);
      expect(loc.revision).toBeUndefined();
      // 'no-revision' specifically, not merely SOME refusal: the claim is that the line was
      // never an anchor at all. A looser matcher that accepted it and then failed it on the
      // digest would also quarantine, and asserting only `quarantine === true` cannot tell the
      // two apart — which is the whole difference between a near-miss and a damaged block.
      expect(loc.reason).toBe('no-revision');
    });
  }

  // ---- the digest half of the anchor (DD-009), which is a DIFFERENT refusal (SB-090) ----
  // Each of these is a MALFORMED digest, not an absent one. Absent is legal and unverified;
  // malformed fails the whole match, so the line stops being an anchor at all. That is the safe
  // direction — the alternative is a near-miss silently reading as "no digest here", which is the
  // one shape that would let a damaged block report itself merely unverified. What SB-090 changed
  // is the REASON, not the refusal: every line here opens the canonical span `` `revision: N ``
  // and closes it at end of line, so it is unmistakably the bottom anchor to the human reading the
  // note, and calling it missing was a lie about a line sitting plainly on screen.
  // ## Verified red-green: 2026-07-26 — all eight failed against the unfixed locator, reporting
  // 'no-revision'; and the digest-absent guard below fails if the digest is ever made mandatory.
  const MALFORMED_DIGESTS = [
    '`revision: 8 · `', // present separator, empty digest
    '`revision: 8 · a3f`', // three hex characters
    '`revision: 8 · a3f11`', // five
    '`revision: 8 · zzzz`', // not hex
    '`revision: 8 · A3F1`', // uppercase — TT writes one canonical spelling
    '`revision: 8 a3f1`', // no separator
    '`revision: 8 - a3f1`', // a hyphen, not U+00B7
    '`revision: 8·a3f1`', // separator without its spaces
  ];
  for (const anchor of MALFORMED_DIGESTS) {
    it(`reports ${JSON.stringify(anchor)} as a MALFORMED revision line, not a missing one`, () => {
      const md = HOST_NOTE.replace('`revision: 8`', anchor);
      const loc = TT.locateVaultBlock(md);
      expect(loc.quarantine).toBe(true);
      // still not an anchor — nothing is read off it, and the block is not writable
      expect(loc.revision).toBeUndefined();
      expect(TT.writeVaultBlock(md, []).md).toBe(md);
      expect(loc.reason).toBe('malformed-revision');
    });
  }

  // The boundary on the other side, and the one that would break real notes if it moved: a
  // DIGEST-LESS anchor is not malformed, it is the legitimate pre-cutover and hand-made shape
  // (DD-009 consequence 2), and it must keep locating and parsing exactly as before. It is also
  // the shape the malformed probe would happily match if it were ever consulted on a line
  // REVISION_RE had already accepted — so this is the assertion that catches that reordering.
  it('a digest-LESS anchor is untouched: it locates, it parses, it is merely unverified', () => {
    const loc = TT.locateVaultBlock(HOST_NOTE); // HOST_NOTE's anchor is `revision: 8`, no digest
    expect(loc.quarantine).toBe(false);
    expect(loc.revision).toBe(8);
    expect(loc.digest).toBe(null);
    expect(loc.verified).toBe(false);
  });

  it('a fenced example of the block format is inert — neither anchor nor hard stop', () => {
    const doc = ['# doc', '', '## Format', '', '```markdown', '## Time Log', '', '`revision: 3`', '```', ''].join('\n');
    expect(TT.locateVaultBlock(doc)).toEqual({ quarantine: true, reason: 'no-heading' });
    // and a fenced copy alongside a real block does not make it "multiple headings"
    const both = doc + '\n' + HOST_NOTE;
    const loc = TT.locateVaultBlock(both);
    expect(loc.quarantine).toBe(false);
    expect(loc.revision).toBe(8);
  });

  it('a zero-row table (header + delimiter only) is still a located region', () => {
    const md = ['## Time Log', '', '| Time | Task |', '|---|---|', '', '`revision: 1`', ''].join('\n');
    const loc = TT.locateVaultBlock(md);
    expect(loc.quarantine).toBe(false);
    expect(loc.rowLines).toEqual([]);
    expect(loc.totalsLine).toBe(-1);
  });

  it('an entry row is never mistaken for the generated totals row', () => {
    // the totals rule is "last row AND first cell bold" — an entry's Time cell is never bold
    const md = HOST_NOTE.replace('| **2h** | | | | **1.75h billable** |\n', '');
    const loc = TT.locateVaultBlock(md);
    expect(loc.quarantine).toBe(false);
    expect(loc.rowLines).toHaveLength(2);
    expect(loc.totalsLine).toBe(-1); // no bold last row → no totals row, not "the last entry"
  });

  it('returns a verdict — never throws — for junk input of any shape', () => {
    for (const junk of [null, undefined, '', '\n\n\n', 42, {}, [], '## Time Log'.repeat(500), '\u0000\uFFFD|||']) {
      // @ts-expect-error — deliberately hostile input: the boot scan must survive it
      const loc = TT.locateVaultBlock(junk);
      expect(loc.quarantine).toBe(true);
      expect(typeof loc.reason).toBe('string');
    }
  });
});

// ---- SB-055 / PLAN-009 task 3: parse the table into entries ----
// Everything here asserts RESOLVED VALUES, never bytes. DD-008 already recorded why: a
// byte-equality golden is structurally blind to a severed semantic link — the existing
// mirror round-trip passes byte-exact while commitSnapshot(entry) returns null, because ids
// never appear in the bytes. Byte goldens are task 5's job and they are a DIFFERENT claim.
// ## Verified red-green: 2026-07-25
describe('vault block parse (SB-055)', () => {
  /** Build a note with TT's block between two of Terje's sections. */
  const noteWith = (rows, header = '| Time | Mode | Project | Task | Bill |', delim = '|---|---|---|---|---|') =>
    ['# 2026-01-05', '', '## Intentions', '', '- ship it', '', '## Time Log', '', header, delim, ...rows, '', '`revision: 3`', '', '## Captures', ''].join('\n'); // prettier-ignore

  const FULL = noteWith([
    '| 09:00→15:30 | #admin | [[Planning]] | Daily planning ritual | ✓ |',
    '| 17:34→ | #deep | FAG | Search & facets<br>- Narrow the facet query | |',
    '| 30m | #rest | [[Home]] | | |',
    '| **8.5h** | | | | **6.5h billable** |',
  ]);

  it('resolves the three legal time shapes onto start/end/durMin', () => {
    const parsed = TT.parseVaultBlock(FULL, { date: '2026-01-05' });
    expect(parsed.quarantine).toBe(false);
    expect(parsed.entries).toHaveLength(3); // the totals row is NOT an entry
    expect(parsed.entries[0]).toMatchObject({ start: 540, end: 930, durMin: null }); // range
    expect(parsed.entries[1]).toMatchObject({ start: 1054, end: null, durMin: null }); // running
    expect(parsed.entries[2]).toMatchObject({ start: null, end: null, durMin: 30 }); // bare duration
    expect(TT.entryMinutes(parsed.entries[0])).toBe(390);
    expect(TT.isRunning(parsed.entries[1])).toBe(true);
    expect(parsed.entries.every((e) => e.date === '2026-01-05')).toBe(true);
  });

  it('splits the Task cell into label + note, and carries an empty one', () => {
    const [planning, facets, home] = TT.parseVaultBlock(FULL).entries;
    expect(planning).toMatchObject({ label: 'Daily planning ritual', note: '' });
    expect(facets).toMatchObject({ label: 'Search & facets', note: 'Narrow the facet query' });
    expect(home).toMatchObject({ label: '', note: '' }); // empty Task cell
  });

  it('reads billable from the Bill column: a check is true, blank is false', () => {
    const entries = TT.parseVaultBlock(FULL).entries;
    expect(entries.map((e) => e.billable)).toEqual([true, false, false]);
  });

  it('reads the Mode column into Entry.tags, and leaves the passthrough empty (SB-059)', () => {
    // SB-059 took `Mode` out of `vaultCells`. The passthrough MECHANISM stays (SB-044 lands on
    // it), but no vocabulary column routes through it today — so a parse produces none at all.
    const entries = TT.parseVaultBlock(FULL).entries;
    expect(entries.map((e) => e.tags)).toEqual([['#admin'], ['#deep'], ['#rest']]);
    expect(entries.map((e) => e.vaultCells)).toEqual([undefined, undefined, undefined]);
  });

  it('carries the Project cell verbatim when no catalog is supplied — `[[Planning]]` and bare `FAG` alike', () => {
    // SB-059 made the wikilink↔code mapping opt-in through `opts.projects`; without it the
    // pre-SB-059 behaviour is unchanged, which is what keeps every existing caller unmoved
    const entries = TT.parseVaultBlock(FULL).entries;
    expect(entries.map((e) => e.project)).toEqual(['[[Planning]]', 'FAG', '[[Home]]']);
  });

  it('a pre-Mode 4-column block still parses — any SUBSET of the vocabulary', () => {
    const md = noteWith(
      ['| 09:00→15:30 | [[Planning]] | Daily planning ritual | ✓ |'],
      '| Time | Project | Task | Bill |',
      '|---|---|---|---|',
    );
    const parsed = TT.parseVaultBlock(md);
    expect(parsed.quarantine).toBe(false);
    expect(parsed.headers).toEqual(['Time', 'Project', 'Task', 'Bill']);
    expect(parsed.entries[0]).toMatchObject({ start: 540, end: 930, project: '[[Planning]]', billable: true });
    expect('vaultCells' in parsed.entries[0]).toBe(false);
  });

  it('a REORDERED header set parses, and each cell follows the HEADER, not its position', () => {
    const md = noteWith(
      ['| ✓ | Daily planning ritual | [[Planning]] | 09:00→15:30 |'],
      '| Bill | Task | Project | Time |',
      '|---|---|---|---|',
    );
    const parsed = TT.parseVaultBlock(md);
    expect(parsed.entries[0]).toMatchObject({
      billable: true,
      label: 'Daily planning ritual',
      project: '[[Planning]]',
      start: 540,
      end: 930,
    });
  });

  it('a block with NO Bill column defaults to billable (nothing said otherwise)', () => {
    const md = noteWith(['| 30m | [[Home]] | Tidying |'], '| Time | Project | Task |', '|---|---|---|');
    expect(TT.parseVaultBlock(md).entries[0].billable).toBe(true);
  });

  it('an empty Time cell is legal — an entry with no time yet, not a corrupted one', () => {
    const md = noteWith(['|  | [[Home]] | Tidying |'], '| Time | Project | Task |', '|---|---|---|');
    expect(TT.parseVaultBlock(md).entries[0]).toMatchObject({ start: null, end: null, durMin: null });
  });

  it('propagates the locator’s verdict UNCHANGED', () => {
    expect(TT.parseVaultBlock('# just a note\n')).toEqual({ quarantine: true, reason: 'no-heading' });
  });

  // ---- the refusals: quarantine, never guess ----
  // Each asserts the WHOLE verdict object and then that no entries came back, so a
  // quarantine that also handed out a partial parse would fail. "The flag came back true"
  // is not the claim being made.
  const REFUSALS = [
    {
      name: 'a header label outside the vocabulary',
      reason: 'unknown-header',
      md: noteWith(['| 30m | #rest | [[Home]] | Tidying | |'], '| Time | Mood | Project | Task | Bill |'),
    },
    {
      name: 'the same column declared twice',
      reason: 'duplicate-header',
      md: noteWith(['| 30m | 1h | [[Home]] | Tidying | |'], '| Time | Time | Project | Task | Bill |'),
    },
    {
      name: 'a row with fewer cells than the header declares',
      reason: 'row-cell-count',
      md: noteWith(['| 30m | #rest | [[Home]] |']),
    },
    {
      name: 'a row with more cells than the header declares',
      reason: 'row-cell-count',
      md: noteWith(['| 30m | #rest | [[Home]] | Tidying | | extra |']),
    },
    {
      name: 'a Time cell that will not parse — the hour must never silently vanish',
      reason: 'unparseable-time',
      md: noteWith(['| 09:00 to lunch | #rest | [[Home]] | Tidying | |']),
    },
    {
      name: 'a Bill cell that is neither a check nor blank',
      reason: 'bad-bill-cell',
      md: noteWith(['| 30m | #rest | [[Home]] | Tidying | yes |']),
    },
  ];

  for (const { name, reason, md } of REFUSALS) {
    it(`quarantines: ${name}`, () => {
      expect(TT.parseVaultBlock(md)).toEqual({ quarantine: true, reason });
      expect(TT.parseVaultBlock(md).entries).toBeUndefined(); // not a partial parse
    });
  }

  it('an entry row is never mistaken for the generated totals row', () => {
    // same table with the totals row deleted: all three rows are entries, none is swallowed
    const noTotals = noteWith([
      '| 09:00→15:30 | #admin | [[Planning]] | Daily planning ritual | ✓ |',
      '| 17:34→ | #deep | FAG | Search & facets | |',
      '| 30m | #rest | [[Home]] | | |',
    ]);
    expect(TT.parseVaultBlock(noTotals).entries).toHaveLength(3);
    // …and with it present exactly one row is excluded — the entry count is 3 either way
    expect(TT.parseVaultBlock(FULL).entries).toHaveLength(3);
  });

  it('mints an ephemeral runtime id per entry (DD-008)', () => {
    const entries = TT.parseVaultBlock(FULL).entries;
    expect(new Set(entries.map((e) => e.id)).size).toBe(3);
    // a second parse of the SAME bytes mints DIFFERENT ids — the id is not derived from
    // content, which is exactly why it must never be written back to disk
    expect(TT.parseVaultBlock(FULL).entries.map((e) => e.id)).not.toEqual(entries.map((e) => e.id));
  });

  it('a pipe and a literal <br> inside cells resolve to content, not structure', () => {
    const md = noteWith(['| 30m | #rest | A\\|B | Docs<br>- use \\<br> here | ✓ |']);
    const entry = TT.parseVaultBlock(md).entries[0];
    expect(entry.project).toBe('A|B');
    expect(entry.label).toBe('Docs');
    expect(entry.note).toBe('use <br> here');
  });
});

// ---- SB-055 / PLAN-009 task 4: serialize the block and splice it in ----
// The expected bytes below are written from SB-045's ruling table and SB-055's own example
// block — NOT pasted from the implementation's output. Pasting would test the code against
// itself and would happily enshrine a wrong separator or a doubled `- ` prefix.
//
// The byte-preservation test compares the exact slices before and after the region. A
// `toContain('## Captures')` would pass even if the splice ate a blank line, and a fixture
// with nothing after the block would test only the easy half — so the fixture has four of
// Terje's sections around TT's, and the assertion is string equality on both slices.
// ## Verified red-green: 2026-07-25
describe('vault block serialize + splice (SB-055)', () => {
  /** @param {Partial<import('../shared/types.ts').Entry>} o */
  const E = (o) => ({
    id: 'runtime-id',
    date: '2026-01-05',
    start: null,
    end: null,
    durMin: null,
    project: null,
    label: '',
    note: '',
    billable: false,
    ...o,
  });

  // SB-059: the Mode cell comes from `tags` now, not from the `vaultCells` passthrough
  const DAY = [
    E({
      start: 540,
      end: 555,
      project: '[[Planning]]',
      label: 'Daily planning ritual',
      tags: ['#admin'],
    }),
    E({
      start: 660,
      end: 765,
      project: 'FAG',
      label: 'Search & facets',
      note: 'Narrow the facet query',
      billable: true,
      tags: ['#deep'],
    }),
    E({ start: 1054, project: '[[Time Turtle]]', label: 'Block format feel-gate', tags: ['#deep'] }),
    E({ durMin: 30, project: '[[Home]]', tags: ['#rest'] }),
  ];

  it('emits SB-045’s exact frozen shape', () => {
    expect(TT.serializeVaultBlock(DAY, { revision: 8 })).toBe(
      [
        '## Time Log',
        '',
        '| Time | Mode | Project | Task | Bill |',
        '|---|---|---|---|---|',
        '| 09:00→09:15 | #admin | [[Planning]] | Daily planning ritual | |',
        '| 11:00→12:45 | #deep | FAG | Search & facets<br>- Narrow the facet query | ✓ |',
        '| 17:34→ | #deep | [[Time Turtle]] | Block format feel-gate | |',
        '| 30m | #rest | [[Home]] | | |',
        '| **2.5h** | | | | **1.75h billable** |',
        '',
        // The digest is BAKED IN, not computed by the test (DD-009). Computing it here with the
        // same helper the emitter uses would assert only that the function is deterministic —
        // this literal is what pins the hash itself, so changing FNV or the fold breaks loudly
        // instead of silently re-keying every block in the vault.
        '`revision: 8 · 115d`',
      ].join('\n'),
    );
  });

  it('emits the header row and the totals row even on a ZERO-entry day (no header = no schema)', () => {
    expect(TT.serializeVaultBlock([], { revision: 1 })).toBe(
      [
        '## Time Log',
        '',
        '| Time | Mode | Project | Task | Bill |',
        '|---|---|---|---|---|',
        '| **0h** | | | | **0h billable** |',
        '',
        '`revision: 1 · 6ff8`',
      ].join('\n'),
    );
  });

  it('emits a bare `- note` with no leading <br> when there is no label', () => {
    const region = TT.serializeVaultBlock([E({ durMin: 30, note: 'freeform hour' })], { headers: ['Time', 'Task'] });
    expect(region).toContain('| 30m | - freeform hour |');
  });

  it('a note ending in [nb] emits with NO backslash (encodeNoteCell was not used)', () => {
    // encodeNoteCell escapes the trailing flag run — that is the v2 MIRROR's convention, and
    // the vault has a Bill column instead. Routing through it would corrupt this cell.
    const region = TT.serializeVaultBlock([E({ durMin: 45, label: 'Admin', note: 'invoicing [nb]' })], {
      headers: ['Time', 'Task'],
    });
    expect(region).toContain('| 45m | Admin<br>- invoicing [nb] |');
    expect(region).not.toContain('\\[nb]');
  });

  it('a running entry contributes 0 to the totals row, whatever the clock says (SB-077)', () => {
    const today = TT.todayStr();
    const region = TT.serializeVaultBlock(
      [E({ date: today, start: 540, billable: true }), E({ date: today, durMin: 60, billable: true })],
      { headers: ['Time', 'Bill'] },
    );
    expect(region).toContain('| 09:00→ | ✓ |'); // the open range is written as-is…
    expect(region).toContain('| **1h** | **1h billable** |'); // …and only the finished hour counts
  });

  it('the heading and the header set come from the block, not from a constant', () => {
    expect(TT.serializeVaultBlock([], { heading: 'Timeloggen', headers: ['Time', 'Task'], revision: 2 })).toBe(
      ['## Timeloggen', '', '| Time | Task |', '|---|---|', '| **0h** | **0h billable** |', '', '`revision: 2 · ce7f`'].join('\n'), // prettier-ignore
    );
  });

  // ---- the splice ----
  const HOST = [
    '---',
    'date: 2026-01-05',
    '---',
    '',
    '# Monday 5 January',
    '',
    '## Intentions',
    '',
    '- [ ] ship the block format',
    '',
    '## Habits',
    '',
    '| Habit | Done |',
    '|---|---|',
    '| Walk | ✓ |',
    '',
    '## Time Log',
    '',
    '| Time | Mode | Project | Task | Bill |',
    '|---|---|---|---|---|',
    '| 09:00→09:15 | #admin | [[Planning]] | Daily planning ritual | |',
    '| **0.25h** | | | | **0h billable** |',
    '',
    '`revision: 4 · 958a`',
    '',
    '## Captures',
    '',
    '- a stray thought   ',
    '',
    '## Reflection',
    '',
    'It went fine.',
    '',
  ].join('\n');

  it('leaves every byte outside the region untouched', () => {
    const res = TT.writeVaultBlock(HOST, DAY);
    expect(res.quarantine).toBe(false);
    expect(res.md).not.toBe(HOST); // the block DID change — the test is not vacuous

    const inLines = HOST.split('\n');
    const outLines = res.md.split('\n');
    const inLoc = TT.locateVaultBlock(HOST);
    const outLoc = TT.locateVaultBlock(res.md);
    expect(outLoc.quarantine).toBe(false);

    const before = (lines, loc) => lines.slice(0, loc.start).join('\n');
    const after = (lines, loc) => lines.slice(loc.end + 1).join('\n');
    expect(before(outLines, outLoc)).toBe(before(inLines, inLoc));
    expect(after(outLines, outLoc)).toBe(after(inLines, inLoc));
    // the halves are both substantial — a fixture with nothing after the block would prove
    // only that the easy end survived
    expect(before(inLines, inLoc)).toContain('| Walk | ✓ |');
    expect(after(inLines, inLoc)).toContain('- a stray thought   '); // trailing spaces and all
    expect(after(inLines, inLoc)).toContain('## Reflection');
  });

  it('re-emits the block’s OWN header set — a pre-Mode block does not gain a Mode column', () => {
    // re-signed because this fixture rewrites HOST's payload — left with HOST's digest it would
    // be a chimera and quarantine before the header-set claim is ever reached
    const preMode = sign(
      HOST.replace('| Time | Mode | Project | Task | Bill |', '| Time | Project | Task | Bill |')
        .replace('|---|---|---|---|---|', '|---|---|---|---|')
        .replace(
          '| 09:00→09:15 | #admin | [[Planning]] | Daily planning ritual | |',
          '| 09:00→09:15 | [[Planning]] | Daily planning ritual | |',
        ) // prettier-ignore
        .replace('| **0.25h** | | | | **0h billable** |', '| **0.25h** | | | **0h billable** |'),
    );
    const res = TT.writeVaultBlock(preMode, [E({ durMin: 30, project: '[[Home]]', label: 'Tidying' })]);
    expect(res.quarantine).toBe(false);
    expect(res.md).toContain('| Time | Project | Task | Bill |');
    expect(res.md).not.toContain('Mode');
    expect(res.md).toContain('| 30m | [[Home]] | Tidying | |');
  });

  it('keeps the located revision unless told otherwise (bumping is SB-057’s call)', () => {
    // matched up to the separator: the COUNTER is this test's claim, and the digest that follows
    // it belongs to DAY's rows rather than to HOST's, so pinning it here would assert the wrong
    // thing twice over
    expect(TT.writeVaultBlock(HOST, DAY).md).toContain('`revision: 4 · ');
    expect(TT.writeVaultBlock(HOST, DAY, { revision: 5 }).md).toContain('`revision: 5 · ');
  });

  it('it is impossible to write from a quarantined block — the input comes back byte-identical', () => {
    const QUARANTINED = [
      ['no heading', HOST.replace('## Time Log', '## Tidsloggen')],
      // DD-012 moved the bare "no revision line" case OUT of this list — that note is now
      // adopted, and the adoption suite owns it. What still refuses is a missing anchor over a
      // region TT cannot describe, so that is what this row asserts.
      ['no revision line, and prose under the heading', HOST.replace('`revision: 4 · 958a`\n', '').replace('## Time Log\n', '## Time Log\n\na hand edit left this here\n')], // prettier-ignore
      ['revision past the next heading', HOST.replace('`revision: 4 · 958a`\n', '').replace('It went fine.', '`revision: 4 · 958a`')], // prettier-ignore
      ['unknown header', HOST.replace('| Time | Mode |', '| Time | Mood |')],
      ['a broken Time cell', HOST.replace('09:00→09:15', 'sometime this morning')],
      ['a Bill cell that is neither a check nor blank', HOST.replace('| Daily planning ritual | |', '| Daily planning ritual | yes |')], // prettier-ignore
      ['the table deleted', HOST.replace('| Time | Mode | Project | Task | Bill |\n|---|---|---|---|---|\n', '')],
    ];
    for (const [name, md] of QUARANTINED) {
      const res = TT.writeVaultBlock(md, DAY);
      expect(res.quarantine, name).toBe(true);
      expect(typeof res.reason).toBe('string');
      expect(res.md, name).toBe(md); // byte-identical: nothing was written
    }
  });

  it('no ephemeral runtime id reaches the emitted bytes (DD-008)', () => {
    const parsed = TT.parseVaultBlock(HOST, { date: '2026-01-05' });
    const res = TT.writeVaultBlock(HOST, parsed.entries);
    expect(parsed.entries.length).toBeGreaterThan(0);
    for (const entry of parsed.entries) {
      expect(entry.id).toMatch(/^e\d+-/); // it exists…
      expect(res.md).not.toContain(entry.id); // …and it is nowhere in the file
    }
    // …nor does an id reach the region bytes when serializing straight from state
    expect(TT.serializeVaultBlock(DAY, { revision: 1 })).not.toContain('runtime-id');
  });
});

// ---- SB-055 / PLAN-009 task 5: the goldens ----
// The house golden is `serialize(parse(md)) === md`. SB-055 enumerates what it must cover,
// and it is built here as FOUR families, because one of them CANNOT be a byte golden and
// pretending otherwise produces a test that lies:
//
//   A — byte round-trip over TT-canonical markdown. The strongest claim, and the only one
//       that can be asserted byte-exactly.
//   B — CONVERGENCE, not byte identity. TT.parseTimeCell accepts `->`, `→` and `-` while
//       TT.fmtTimeCell always emits `→`, so `09:00-15:30` round-trips to `09:00→15:30`. The
//       byte golden cannot hold for accepted-but-non-canonical input; the correct property
//       is that one pass canonicalises and a second is a fixed point. Conflating the two is
//       how someone "fixes" the parser into preserving the input separator, and how the
//       `- ` prefix accretion bug comes back.
//   C — the refusals. Every quarantine reason asserts NO WRITE occurred (input md
//       byte-identical), not merely that a flag came back.
//   D — no ephemeral runtime id in the bytes, asserted on resolved references rather than a
//       string scan alone (DD-008: a byte golden is blind to a severed semantic link).
//
// Every Family A fixture below is written from SB-045's ruling table and SB-055's own
// example block. None of it is pasted from the implementation's output — that would test
// the code against itself and would happily enshrine a wrong separator or a doubled prefix.
// ## Verified red-green: 2026-07-25
describe('vault block round-trip (SB-055)', () => {
  /** serialize(parse(md)) — the house golden, as one call. */
  const roundTrip = (md, opts) => {
    const parsed = TT.parseVaultBlock(md, opts);
    if (parsed.quarantine) throw new Error('unexpectedly quarantined: ' + parsed.reason);
    const res = TT.writeVaultBlock(md, parsed.entries, opts);
    expect(res.quarantine).toBe(false);
    return res.md;
  };

  // ---- Family A: byte round-trip over TT-canonical markdown ----
  // Proves: the format is closed under parse→serialize for every shape SB-055 enumerates.
  // Cannot prove: anything about input TT did not write itself (that is Family B), and
  // nothing identity-adjacent (that is Family D).
  describe('Family A — byte round-trip (TT-canonical bytes)', () => {
    // A pipe in a project name AND in a note; a literal <br> in a note; a running timer; a
    // bare duration; an empty Task; a note ending in [nb]; `✓` and blank Bill.
    const FULL_DAY = [
      '---',
      'date: 2026-01-05',
      '---',
      '',
      '# Monday 5 January',
      '',
      '## Intentions',
      '',
      '- [ ] ship the block format',
      '',
      '## Time Log',
      '',
      '| Time | Mode | Project | Task | Bill |',
      '|---|---|---|---|---|',
      '| 09:00→15:30 | #deep | A\\|B | Pipe \\| work<br>- and a note with a \\| in it | ✓ |',
      '| 11:00→11:30 | #admin | FAG | Docs<br>- use \\<br> for a line break | |',
      '| 17:34→ | #deep | [[Time Turtle]] | Block format feel-gate | |',
      '| 30m | #rest | [[Home]] | | |',
      '| 45m | #admin | INT-ADM | Invoicing<br>- weekly invoicing [nb] | |',
      '| **8.25h** | | | | **6.5h billable** |',
      '',
      '`revision: 8 · 9b38`',
      '',
      '## Captures',
      '',
      '- a stray thought',
      '',
      '## Reflection',
      '',
      'It went fine.',
      '',
    ].join('\n');

    // The migration-free property, now carried by the header row: a block written before
    // `Mode` existed keeps parsing and keeps its own four columns.
    const PRE_MODE_DAY = [
      '## Time Log',
      '',
      '| Time | Project | Task | Bill |',
      '|---|---|---|---|',
      '| 08:30→12:00 | FJH-NETT | Checkout flow<br>- wireframes | ✓ |',
      '| **3.5h** | | | **3.5h billable** |',
      '',
      '`revision: 2 · 9854`',
      '',
      '## Captures',
      '',
    ].join('\n');

    // A header set in a different ORDER — also a subset, also migration-free.
    // The totals row is KEYED, so reading left to right it looks inverted: the billable total
    // sits under `Bill` and the hours total under `Time`, which is what those headings mean.
    // For a canonical block the keyed and positional readings are the same bytes; this is the
    // fixture that tells them apart.
    const REORDERED_DAY = [
      '## Time Log',
      '',
      '| Bill | Task | Time |',
      '|---|---|---|',
      '| ✓ | Checkout flow | 08:30→12:00 |',
      '| **3.5h billable** | | **3.5h** |',
      '',
      '`revision: 1 · 3fdf`',
      '',
    ].join('\n');

    // The reordering that matters for safety: a column that can hold arbitrary user text sits
    // FIRST. A row whose label a hand edit bolded used to be read as the generated totals row
    // and silently dropped, taking the hour with it (found in end-gate review).
    const TEXT_FIRST_DAY = [
      '## Time Log',
      '',
      '| Task | Time | Bill |',
      '|---|---|---|',
      '| Checkout flow | 08:30→12:00 | ✓ |',
      '| **urgent** fixes | 1h | |',
      '| | **4.5h** | **3.5h billable** |',
      '',
      '`revision: 1 · 007b`',
      '',
    ].join('\n');

    const ZERO_ENTRY_DAY = [
      '# Monday 5 January',
      '',
      '## Time Log',
      '',
      '| Time | Mode | Project | Task | Bill |',
      '|---|---|---|---|---|',
      '| **0h** | | | | **0h billable** |',
      '',
      '`revision: 1 · 6ff8`',
      '',
      '## Reflection',
      '',
      'Nothing logged.',
      '',
    ].join('\n');

    const GOLDENS = [
      ['a full day: pipes, a literal <br>, a running timer, a bare duration, an empty Task, a [nb] tail', FULL_DAY],
      ['a pre-Mode 4-column block (the migration-free property)', PRE_MODE_DAY],
      ['a reordered header set', REORDERED_DAY],
      ['a reordered set with a free-text column FIRST, holding a bolded label', TEXT_FIRST_DAY],
      ['a zero-entry day (header row and totals row still written)', ZERO_ENTRY_DAY],
    ];

    for (const [name, md] of GOLDENS) {
      it(`serialize(parse(md)) === md — ${name}`, () => {
        // today-dated, so the running timer is the case SB-055 actually names rather than a
        // past-dated proxy for it (SB-077 made that deterministic)
        expect(roundTrip(md, { date: TT.todayStr() })).toBe(md);
      });
    }

    it('is a fixed point under a SECOND cycle (a single pass hides accretion)', () => {
      for (const [, md] of GOLDENS) {
        const once = roundTrip(md);
        expect(roundTrip(once)).toBe(once);
      }
    });

    it('the bytes are clock-independent with a timer running (SB-077)', () => {
      // Serializing the same today-dated running block twice must agree. Before SB-077's
      // ruling the totals cell was computed from TT.nowMin() and this could differ across a
      // minute boundary — the reason the running-timer golden could not be written at all.
      const today = TT.todayStr();
      const parsed = TT.parseVaultBlock(FULL_DAY, { date: today });
      expect(parsed.entries.some((e) => TT.isRunning(e))).toBe(true); // the case is really present
      const a = TT.writeVaultBlock(FULL_DAY, parsed.entries, { date: today }).md;
      const b = TT.writeVaultBlock(FULL_DAY, TT.parseVaultBlock(FULL_DAY, { date: today }).entries, { date: today }).md;
      expect(b).toBe(a);
      expect(a).toBe(FULL_DAY);
    });

    it('the running entry contributes 0 to the totals — the note records finished work', () => {
      // 390 + 30 + 0 (running) + 30 + 45 = 495 min = 8.25h; only the first is billable.
      // Asserted on what the SERIALIZER emits. Asserting it against FULL_DAY would be a
      // tautology over the fixture constant, and would survive swapping the totals helper
      // for TT.entryMinutes — which is exactly what it exists to catch (end-gate review).
      const entries = TT.parseVaultBlock(FULL_DAY, { date: TT.todayStr() }).entries;
      expect(entries.filter((e) => TT.isRunning(e))).toHaveLength(1);
      const region = TT.serializeVaultBlock(entries, { revision: 8 });
      expect(region).toContain('| **8.25h** | | | | **6.5h billable** |');
      expect(region).toContain('| 17:34→ |'); // the running row is still written, open-ended
    });

    it('every byte outside the block survives each golden untouched', () => {
      for (const [name, md] of GOLDENS) {
        const out = roundTrip(md);
        const inLoc = TT.locateVaultBlock(md);
        const outLoc = TT.locateVaultBlock(out);
        expect(out.split('\n').slice(0, outLoc.start).join('\n'), name).toBe(
          md.split('\n').slice(0, inLoc.start).join('\n'),
        );
        expect(
          out
            .split('\n')
            .slice(outLoc.end + 1)
            .join('\n'),
          name,
        ).toBe(
          md
            .split('\n')
            .slice(inLoc.end + 1)
            .join('\n'),
        );
      }
    });
  });

  // ---- Family B: convergence, NOT byte identity ----
  // Proves: accepted-but-non-canonical input converges to canonical bytes in ONE pass and
  // then holds steady. Cannot prove: that the input bytes survive — they deliberately do
  // not, and asserting that they should is the mistake this family exists to prevent.
  // Mirrors the existing HAND_EDITED fixed-point pattern in the Task-cell codec above.
  describe('Family B — convergence (hand-edited, accepted-but-non-canonical)', () => {
    const withRow = (row) =>
      ['## Time Log', '', '| Time | Task | Bill |', '|---|---|---|', row, '', '`revision: 1`', ''].join('\n');

    const HAND_EDITED = [
      ['an ASCII hyphen separator', withRow('| 09:00-15:30 | Checkout flow | ✓ |'), '| 09:00→15:30 |'],
      ['an ASCII arrow separator', withRow('| 09:00->15:30 | Checkout flow | ✓ |'), '| 09:00→15:30 |'],
      // `- - note` is NOT a doubled prefix to be cleaned up: SB-045's codec strips exactly
      // one `- `, so this cell means a note whose text is `- note`. The property that
      // matters is that it never grows a THIRD hyphen — accretion is asserted below.
      ['a note that itself begins with `- `', withRow('| 30m | Label<br>- - note | |'), '<br>- - note |'],
      ['a note typed without the `- ` prefix', withRow('| 30m | Label<br>note | |'), '<br>- note |'],
      ['a raw <br> a hand edit left in the note', withRow('| 30m | Docs<br>- use <br> here | |'), '\\<br> here |'],
      ['a totals row someone edited by hand', withRow('| 1h | Label | ✓ |\n| **99h** | | **99h billable** |'), '| **1h** | | **1h billable** |'], // prettier-ignore
    ];

    for (const [name, md, canonicalFragment] of HAND_EDITED) {
      it(`canonicalises then holds steady: ${name}`, () => {
        const once = roundTrip(md);
        const twice = roundTrip(once);
        expect(twice).toBe(once); // the fixed point — where accretion and drift would show
        expect(once).toContain(canonicalFragment); // …and it landed on the canonical form
        // the values hold across the normalisation, so convergence is not quiet data loss
        expect(TT.parseVaultBlock(twice).entries).toEqual(TT.parseVaultBlock(once).entries.map((e) => ({ ...e, id: expect.any(String) }))); // prettier-ignore
      });
    }

    it('a canonical block is ALREADY a fixed point (one pass changes nothing)', () => {
      const canonical = roundTrip(withRow('| 09:00→15:30 | Checkout flow | ✓ |'));
      expect(roundTrip(canonical)).toBe(canonical);
    });

    it('the `- ` prefix never accretes across repeated writes', () => {
      // the bug this family exists to prevent: `- note` → `- - note` → `- - - note`, one
      // hyphen per write cycle, until the note is unreadable
      let md = withRow('| 30m | Label<br>note | |');
      for (let i = 0; i < 5; i++) md = roundTrip(md);
      expect(md).toContain('| 30m | Label<br>- note | |');
      expect(md).not.toContain('- - ');
      expect(TT.parseVaultBlock(md).entries[0]).toMatchObject({ label: 'Label', note: 'note' });
    });
  });

  // ---- Family C: the refusals ----
  // Proves: every quarantine path from tasks 2 and 3 provably writes NOTHING. The assertion
  // is byte identity of the returned md — "a flag came back true" would be satisfied by a
  // function that quarantined AND wrote.
  describe('Family C — refusals write nothing', () => {
    const OK = [
      '# Monday',
      '',
      '## Intentions',
      '',
      '- a thing',
      '',
      '## Time Log',
      '',
      '| Time | Mode | Project | Task | Bill |',
      '|---|---|---|---|---|',
      '| 30m | #rest | [[Home]] | Tidying | |',
      '| **0.5h** | | | | **0h billable** |',
      '',
      '`revision: 3`',
      '',
      '## Captures',
      '',
      '- a stray thought',
      '',
    ].join('\n');

    const REFUSALS = [
      ['no-heading', OK.replace('## Time Log', '## Tidsloggen')],
      ['multiple-headings', OK + '\n## Time Log\n\n| Time |\n|---|\n\n`revision: 9`\n'],
      // DD-012: `OK` with its revision line deleted is an ADOPTABLE note now, not a refusal —
      // heading once, one well-formed TT table, nothing else — so it moved to the adoption
      // suite. 'no-revision' survives as a locator-only verdict; see `elsewhere` below.
      // SB-090: the anchor is present and unreadable, which is neither "missing" nor "mismatched".
      // Unlike 'no-revision' above, `writeVaultBlock` CAN produce this one — adoption is gated on
      // 'no-revision' and nothing else, so a note whose anchor TT cannot read is never adopted.
      ['malformed-revision', OK.replace('`revision: 3`', '`revision: 3 · zzzz`')],
      ['revision-past-next-heading', OK.replace('`revision: 3`\n', '').replace('- a stray thought', '`revision: 3`')],
      ['multiple-revisions', OK.replace('`revision: 3`', '`revision: 3`\n\n`revision: 4`')],
      ['no-table', OK.replace('| Time | Mode | Project | Task | Bill |\n|---|---|---|---|---|\n', '')],
      ['unexpected-content-in-block', OK.replace('`revision: 3`', 'a stray line\n\n`revision: 3`')],
      ['unknown-header', OK.replace('| Time | Mode |', '| Time | Mood |')],
      ['duplicate-header', OK.replace('| Time | Mode |', '| Time | Time |')],
      ['row-cell-count', OK.replace('| 30m | #rest | [[Home]] | Tidying | |', '| 30m | #rest | [[Home]] |')],
      ['unparseable-time', OK.replace('| 30m |', '| after lunch |')],
      ['bad-bill-cell', OK.replace('| Tidying | |', '| Tidying | yes |')],
      // THE SB-051 CHIMERA (DD-009). A block TT signed, whose rows were then rewritten under it —
      // exactly what Obsidian's diff-merge produces: TT's anchor line kept, the buffer's rows
      // kept. Every other check on this list passes; the block is structurally perfect. Only the
      // digest notices, and this is the row that proves a wrong one refuses the write.
      ['digest-mismatch', sign(OK).replace('| Tidying |', '| USER-TYPED-IN-BLOCK |')],
    ];

    for (const [reason, md] of REFUSALS) {
      it(`${reason} — the note comes back byte-identical`, () => {
        const entries = [{ id: 'e9', date: '2026-01-05', start: 540, end: 600, durMin: null, project: 'X', label: 'Y', note: '', billable: true }]; // prettier-ignore
        const res = TT.writeVaultBlock(md, entries);
        expect(res.quarantine).toBe(true);
        expect(res.reason).toBe(reason);
        expect(res.md).toBe(md); // nothing written, not one byte
      });
    }

    it('covers every quarantine reason the parser and locator can produce', () => {
      // A guard against a new reason being added without a refusal golden beside it. The
      // vocabulary's home is the VaultBlockQuarantineReason union in shared/types.ts, so the list
      // is read from there rather than kept as a second hand-maintained copy — and every
      // reason in it must ALSO be emitted somewhere in core.js, which catches a dead one.
      //
      // SB-058 SPLIT THE UNION and this guard follows the BLOCK half. The catalog note
      // (`Time Turtle/Catalog.md`) adds refusals only it can produce, and their goldens live in
      // tests/catalog.test.js over a catalog note — this file has no catalog to refuse, so a flat
      // union would have made each guard demand goldens the other file owns. The type a boot scan
      // switches on is still the single `VaultQuarantineReason`, which is both halves; the
      // catalog half has the same guard beside its own goldens.
      const produced = new Set(REFUSALS.map(([reason]) => reason));
      const types = readFileSync(new URL('../shared/types.ts', import.meta.url), 'utf8');
      const union = /export type VaultBlockQuarantineReason =([\s\S]*?);/.exec(types);
      expect(union, 'VaultBlockQuarantineReason union not found in shared/types.ts').toBeTruthy();
      const reasons = [...union[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
      expect(reasons.length).toBe(16);
      const core = readFileSync(new URL('../shared/core.js', import.meta.url), 'utf8');
      // covered by their own tests in the end-gate review-regression section below.
      // 'no-revision' is on this list as of DD-012: `writeVaultBlock` can no longer produce it,
      // because a missing bottom anchor is now either adopted or refused for the specific reason
      // TT could not describe the region. It stays a LOCATOR verdict — asserted in the locator
      // suite above, and in the adoption suite below as the sole gate adoption may act on.
      const elsewhere = new Set(['crlf-line-endings', 'write-would-corrupt', 'no-revision']);
      for (const reason of reasons) {
        expect(core.includes(`'${reason}'`), `reason declared but never emitted: ${reason}`).toBe(true);
        if (elsewhere.has(reason)) continue;
        expect(produced.has(reason), `no refusal golden for reason: ${reason}`).toBe(true);
      }
    });
  });

  // ---- Family D: no ephemeral id reaches the bytes ----
  // Asserted on RESOLVED REFERENCES, not on a string scan alone. DD-008 recorded the exact
  // blindness being guarded against: the existing mirror golden passes byte-exact while
  // commitSnapshot(entry) returns null, because ids never appear in the bytes at all.
  describe('Family D — the runtime id is ephemeral (DD-008)', () => {
    const DAY = [
      '## Time Log',
      '',
      '| Time | Project | Task | Bill |',
      '|---|---|---|---|',
      '| 09:00→15:30 | FJH-NETT | Checkout flow<br>- wireframes | ✓ |',
      '| 30m | INT-ADM | Admin | |',
      '| 30m | INT-ADM | Admin | |',
      '| **6.5h** | | | **6.5h billable** |',
      '',
      '`revision: 5`',
      '',
    ].join('\n');

    it('no parsed entry’s id appears anywhere in the serialized output', () => {
      const parsed = TT.parseVaultBlock(DAY);
      const out = TT.writeVaultBlock(DAY, parsed.entries).md;
      expect(parsed.entries).toHaveLength(3);
      for (const entry of parsed.entries) expect(out).not.toContain(entry.id);
    });

    it('the entry COUNT and their resolved values survive the round-trip', () => {
      // two byte-identical `30m | INT-ADM | Admin` rows are a legitimate day — a
      // content-keyed scheme would collide here, which is why DD-008's spec owes an
      // ordinal-on-collision rule. Nothing may collapse them.
      const before = TT.parseVaultBlock(DAY).entries;
      const after = TT.parseVaultBlock(TT.writeVaultBlock(DAY, before).md).entries;
      expect(after).toHaveLength(before.length);
      const shape = (e) => ({ start: e.start, end: e.end, durMin: e.durMin, project: e.project, label: e.label, note: e.note, billable: e.billable }); // prettier-ignore
      expect(after.map(shape)).toEqual(before.map(shape));
      expect(after[1]).toMatchObject({ durMin: 30, project: 'INT-ADM', label: 'Admin' });
      expect(after[2]).toMatchObject({ durMin: 30, project: 'INT-ADM', label: 'Admin' });
    });

    it('an id planted in the entry list is not smuggled into the file', () => {
      const entries = TT.parseVaultBlock(DAY).entries.map((e) => ({ ...e, id: 'SMUGGLED-e1-abc' }));
      expect(TT.writeVaultBlock(DAY, entries).md).not.toContain('SMUGGLED');
    });
  });
});

// ---- end-gate review regressions (PLAN-009) ----
// Every case below is a defect the review found in the six task commits, reproduced first and
// then fixed. They are kept as their own section because each is a claim about what TT must
// NEVER do, not about what a task delivers.
// ## Verified red-green: 2026-07-25
describe('vault block — end-gate review regressions (SB-055)', () => {
  // The revision line carries the block's real digest (DD-009), because these fixtures stand in
  // for notes TT wrote and the round-trip claims below are `write(md) === md`. Computed rather
  // than baked: the helper is parameterised over header/delim/rows, so there is no one literal
  // to bake. What that CANNOT prove is that the digest is right — the baked literals in the
  // serializer goldens pin the hash's value, and the chimera golden pins that a wrong one is
  // caught. This call only builds a canonical fixture.
  const note = (header, delim, rows) =>
    ['## Time Log', '', header, delim, ...rows, '', '`revision: 1 · ' + TT.vaultPayloadDigest([header, delim, ...rows]) + '`', ''].join('\n'); // prettier-ignore

  // ---- an entry is never silently dropped as "the totals row" ----
  // The original detection rule was "last row AND first cell is bold", justified by "an
  // entry's Time cell is never bold". That silently assumed Time is column 0 — which the
  // vocabulary rule (any subset, any ORDER) does not guarantee. Both reviews found it.
  describe('a last row that is not the generated totals row is never guessed to be one', () => {
    it('a bolded LABEL in the first column is an entry, not the totals row', () => {
      // the reproduction: `| Task | Time |`, last row's label bolded by a hand edit
      const md = note('| Task | Time |', '|---|---|', ['| Checkout | 30m |', '| **urgent** | 1h |']);
      const parsed = TT.parseVaultBlock(md);
      expect(parsed.quarantine).toBe(false);
      expect(parsed.entries).toHaveLength(2); // the hour is still here
      expect(parsed.entries[1]).toMatchObject({ label: '**urgent**', durMin: 60 });
      // …and a write does not delete it
      expect(TT.writeVaultBlock(md, parsed.entries).md).toContain('| **urgent** | 1h |');
    });

    it('a bolded but unparseable Time cell quarantines rather than vanishing', () => {
      const md = note('| Time | Project | Task | Bill |', '|---|---|---|---|', [
        '| 30m | [[Home]] | Tidying | |',
        '| **30m** | [[Home]] | Emphasised | |',
      ]);
      expect(TT.parseVaultBlock(md)).toEqual({ quarantine: true, reason: 'unparseable-time' });
      expect(TT.writeVaultBlock(md, []).md).toBe(md); // refused, nothing written
    });

    it('a totals row whose cell count does not match the header is not exempt from validation', () => {
      // `continue`-ing on the totals line used to run BEFORE the row-cell-count check, so a
      // mangled totals row was the one row inside TT's region that could be anything at all
      const md = note('| Time | Project | Task | Bill |', '|---|---|---|---|', [
        '| 30m | [[Home]] | Tidying | |',
        '| **7h** |',
      ]);
      expect(TT.parseVaultBlock(md)).toEqual({ quarantine: true, reason: 'row-cell-count' });
    });

    it('still recognises the genuine generated totals row, in any column order', () => {
      for (const [header, delim, row, totals] of [
        ['| Time | Task | Bill |', '|---|---|---|', '| 30m | Tidying | |', '| **0.5h** | | **0h billable** |'],
        ['| Bill | Task | Time |', '|---|---|---|', '| | Tidying | 30m |', '| **0h billable** | | **0.5h** |'],
        ['| Time |', '|---|', '| 30m |', '| **0.5h** |'],
      ]) {
        const md = note(header, delim, [row, totals]);
        const parsed = TT.parseVaultBlock(md);
        expect(parsed.quarantine, header).toBe(false);
        expect(parsed.entries, header).toHaveLength(1); // the totals row is excluded, the entry is not
        expect(TT.writeVaultBlock(md, parsed.entries).md, header).toBe(md); // and it regenerates identically
      }
    });
  });

  // ---- the writer checks its own output ----
  // The module gated its INPUT exhaustively and never asked whether what it wrote was
  // readable. Both cases below reported a successful write and left a note TT could no longer
  // read — frozen until a human repaired it by hand.
  describe('a write that would not parse back is refused, not performed', () => {
    const OK = note('| Time | Task | Bill |', '|---|---|---|', ['| 30m | Tidying | |', '| **0.5h** | | **0h billable** |']); // prettier-ignore
    const E = (o) => ({ id: 'e1', date: '2026-01-05', start: null, end: null, durMin: null, project: null, label: '', note: '', billable: false, ...o }); // prettier-ignore

    it('a newline inside a field cannot split the row', () => {
      // encodeCell escapes `\` and `|` — not a newline, which would end the table row
      const res = TT.writeVaultBlock(OK, [E({ durMin: 30, label: 'a\nb' })]);
      expect(res.quarantine).toBe(true);
      expect(res.reason).toBe('write-would-corrupt');
      expect(res.md).toBe(OK);
    });

    it('a zero duration, which fmtDur emits as `0m` and parseTimeCell rejects, is refused', () => {
      const res = TT.writeVaultBlock(OK, [E({ durMin: 0, label: 'Nothing' })]);
      expect(res.quarantine).toBe(true);
      expect(res.reason).toBe('write-would-corrupt');
      expect(res.md).toBe(OK);
    });

    it('an ordinary write is unaffected by the output gate', () => {
      const res = TT.writeVaultBlock(OK, [E({ durMin: 45, label: 'Real work', billable: true })]);
      expect(res.quarantine).toBe(false);
      expect(res.md).toContain('| 45m | Real work | ✓ |');
      expect(TT.parseVaultBlock(res.md).quarantine).toBe(false); // and it really does parse back
    });
  });

  // ---- fences close on the same character (CommonMark) ----
  it('a tilde run does not close a backtick fence — no located region inside a code block', () => {
    // the note most likely to contain a fenced copy of the block format is the note
    // documenting the block format; a located region inside it is a write into someone's docs
    // The tilde run sits BEFORE the heading on purpose: if it closed the backtick fence, the
    // heading and the revision line below it would both go LIVE and the locator would hand
    // back a writable region pointing into the middle of the example.
    const doc = [
      '# Format notes',
      '',
      '```markdown',
      'an example of the other fence syntax:',
      '~~~',
      '## Time Log',
      '',
      '| Time | Task |',
      '|---|---|',
      '| **0h** | |',
      '',
      '`revision: 3`',
      '```',
      '',
    ].join('\n');
    expect(TT.locateVaultBlock(doc)).toEqual({ quarantine: true, reason: 'no-heading' });
    expect(TT.writeVaultBlock(doc, []).md).toBe(doc); // nothing written into the example
    // the same document with a REAL block after it still locates the real one
    const withReal = doc + '\n' + note('| Time | Task |', '|---|---|', ['| 30m | Tidying |']);
    expect(TT.locateVaultBlock(withReal).quarantine).toBe(false);
  });

  // ---- diagnosis quality ----
  it('a CRLF note is refused with a reason that names the real cause', () => {
    const lf = note('| Time | Task |', '|---|---|', ['| 30m | Tidying |', '| **0.5h** | |']);
    expect(TT.locateVaultBlock(lf).quarantine).toBe(false);
    // Refusing stays the behaviour — TT does not rewrite line endings it did not author — but
    // 'no-heading' for a note that plainly has the heading sends a human to the wrong place.
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(TT.locateVaultBlock(crlf)).toEqual({ quarantine: true, reason: 'crlf-line-endings' });
    expect(TT.writeVaultBlock(crlf, []).md).toBe(crlf); // and nothing is written
  });

  // A mixed-ending note — LF throughout with a stray `\r` on one line — is the live case, not a
  // hypothetical: it is what a hand edit in the wrong editor leaves behind. Before SB-084 the CRLF
  // probe lived inside the `no-heading` branch and only re-tested HEADING lines, so it fired only
  // when the TOP anchor was the thing that broke. Every other anchor-shaped refusal reported its
  // own reason and hid the cause — worst of all `no-revision`, which says "the anchor is missing"
  // about a note whose anchor a human can read on screen. SB-083's whole case for refusing CRLF
  // is "we refuse, but we say why"; this is the case where it did not.
  // ## Verified red-green: 2026-07-26
  describe('a stray \\r is diagnosed as CRLF whichever anchor it broke (SB-084)', () => {
    const lf = note('| Time | Task |', '|---|---|', ['| 30m | Tidying |', '| **0.5h** | |']);
    // a `\r` parked on the blank line after the heading: enough to make the note CRLF-tainted,
    // but it breaks no anchor by itself, so each case below breaks exactly one thing on purpose
    const taint = (md) => md.replace('\n\n', '\n\r\n');

    it('the LF original is writable, and the taint alone changes no verdict but the reason', () => {
      const loc = TT.locateVaultBlock(lf);
      expect(loc.quarantine).toBe(false);
      expect(loc.revision).toBe(1);
    });

    it('a `\\r` on the revision line reports CRLF, not `no-revision`', () => {
      // the defect this ticket exists for: REVISION_RE is anchored with `$`, which does not
      // cross `\r`, so the match fails while the anchor sits plainly in the file
      const md = lf.replace(/^(`revision: .*`)$/m, '$1\r');
      expect(md).not.toBe(lf); // the fixture bites
      expect(TT.locateVaultBlock(md)).toEqual({ quarantine: true, reason: 'crlf-line-endings' });
      expect(TT.writeVaultBlock(md, []).md).toBe(md); // still refused, still not a byte written
    });

    it('a `\\r` on the heading line reports CRLF', () => {
      const md = lf.replace('## Time Log', '## Time Log\r');
      expect(TT.locateVaultBlock(md)).toEqual({ quarantine: true, reason: 'crlf-line-endings' });
    });

    it('a missing delimiter row in a tainted note reports CRLF, not `no-table`', () => {
      const md = taint(lf.replace('|---|---|\n', ''));
      expect(md).not.toContain('|---|---|'); // the fixture bites
      expect(TT.locateVaultBlock(md)).toEqual({ quarantine: true, reason: 'crlf-line-endings' });
    });

    it('a revision line past the next heading in a tainted note reports CRLF', () => {
      const md = taint(lf.replace(/^(`revision: )/m, '## Someone else\n\n$1'));
      expect(TT.locateVaultBlock(lf.replace(/^(`revision: )/m, '## Someone else\n\n$1'))).toEqual({
        quarantine: true,
        reason: 'revision-past-next-heading',
      }); // untainted, the specific reason still stands
      expect(TT.locateVaultBlock(md)).toEqual({ quarantine: true, reason: 'crlf-line-endings' });
    });

    it('a missing heading in a tainted note reports CRLF', () => {
      const md = taint(lf.replace('## Time Log', '## Something Else'));
      expect(TT.locateVaultBlock(md)).toEqual({ quarantine: true, reason: 'crlf-line-endings' });
    });

    // SB-090's signal sits UNDER this one and must stay there. A stray `\r` explains the whole
    // file, a bad digest explains one line, so the file-wide diagnosis wins. The trap this pins:
    // the taint is on a DIFFERENT line than the anchor, so the malformed anchor line itself is
    // clean and would match the malformed probe happily if the probe ran first.
    // ## Verified red-green: 2026-07-26
    it('a malformed digest in a CRLF-tainted note reports CRLF, not `malformed-revision`', () => {
      const broken = lf.replace(/ · [0-9a-f]{4}`$/m, ' · zzzz`');
      expect(broken).not.toBe(lf); // the fixture bites
      expect(TT.locateVaultBlock(broken)).toEqual({ quarantine: true, reason: 'malformed-revision' });
      expect(TT.locateVaultBlock(taint(broken))).toEqual({ quarantine: true, reason: 'crlf-line-endings' });
    });

    // …and the refusals that found MORE than they expected keep their own reason: CRLF cannot
    // explain a SECOND heading or a SECOND revision line, and the specific reason is the useful
    // one. Deferring these to CRLF would trade a true diagnosis for a plausible-sounding one.
    it('`multiple-headings` and `multiple-revisions` are not blamed on CRLF', () => {
      const twoHeadings = taint(lf + '\n' + lf);
      expect(TT.locateVaultBlock(twoHeadings)).toEqual({ quarantine: true, reason: 'multiple-headings' });
      const twoRevisions = taint(lf.replace(/^(`revision: .*`)$/m, '$1\n$1'));
      expect(TT.locateVaultBlock(twoRevisions)).toEqual({ quarantine: true, reason: 'multiple-revisions' });
    });
  });

  it('an NFD heading matches its NFC twin (macOS hands out NFD)', () => {
    // `Å` genuinely decomposes (A + U+030A); `ø` does not, so a fixture built on it would
    // hold even with normalisation removed — a gate that cannot fail (caught in review).
    const heading = 'Årslogg';
    expect(heading.normalize('NFD')).not.toBe(heading.normalize('NFC')); // the fixture bites
    const md = note('| Time | Task |', '|---|---|', ['| 30m | Tidying |']).replace(
      '## Time Log',
      '## ' + heading.normalize('NFD'),
    );
    // written NFD in the note, asked for NFC from settings — and the other way round
    expect(TT.locateVaultBlock(md, { heading: heading.normalize('NFC') }).quarantine).toBe(false);
    expect(TT.locateVaultBlock(md, { heading: heading.normalize('NFD') }).quarantine).toBe(false);
  });

  it('an explicit empty header list does not silently re-canonicalise the block', () => {
    // `[]` is truthy, so it used to fall through to the canonical five — the exact opposite
    // of the migration-free property the header set exists to provide
    // no Bill column → billable defaults true → the billable total falls back to the last
    // column, which here is Task. Odd to read, documented as the fallback, and it round-trips.
    const md = note('| Time | Task |', '|---|---|', ['| 30m | Tidying |', '| **0.5h** | **0.5h billable** |']);
    const res = TT.writeVaultBlock(md, TT.parseVaultBlock(md).entries, { headers: [] });
    expect(res.quarantine).toBe(false);
    expect(res.md).toContain('| Time | Task |');
    expect(res.md).not.toContain('Mode');
    expect(res.md).toBe(md);
  });

  // ---- the read chain and the emit chain must stay in step ----
  // parseVaultBlock and serializeVaultBlock switch over the same vocabulary 100 lines apart.
  // SB-044 (settings-extended vocabulary) and SB-059 (Entry.tags removes `mode` from the
  // passthrough) each have to edit both. This is the guard: every column TT can READ must
  // also be one TT can WRITE, or the block gains a column on read it cannot emit.
  it('every vocabulary column round-trips — a column TT can read is one TT can write', () => {
    const SAMPLES = { Time: '30m', Mode: '#deep', Project: '[[Home]]', Task: 'Tidying', Bill: '✓' };
    const columns = ['Time', 'Mode', 'Project', 'Task', 'Bill'];
    for (const column of columns) {
      expect(SAMPLES[column], `no sample value for the column ${column} — add one`).toBeTruthy();
      const header = column === 'Time' ? '| Time |' : `| Time | ${column} |`;
      const delim = column === 'Time' ? '|---|' : '|---|---|';
      const row = column === 'Time' ? '| 30m |' : `| 30m | ${SAMPLES[column]} |`;
      const totals = column === 'Bill' ? '| **0.5h** | **0.5h billable** |' : column === 'Time' ? '| **0.5h** |' : '| **0.5h** | **0.5h billable** |'; // prettier-ignore
      const md = note(header, delim, [row, totals]);
      const parsed = TT.parseVaultBlock(md);
      expect(parsed.quarantine, column).toBe(false);
      expect(TT.writeVaultBlock(md, parsed.entries).md, column).toBe(md);
    }
  });
});

// ---- the payload digest (SB-080 / DD-009) ----
// The block's bottom anchor carries a digest of its table payload, so the corruption SB-051
// measured on the real vault becomes DETECTED rather than silently imported: Obsidian
// diff-merges an external write into a dirty open buffer, keeping TT's anchor line and the
// buffer's rows. `revision` is the field that survives that intact, which is exactly why it
// cannot be the detector.
//
// What would be FAKE EVIDENCE here, and is deliberately not the shape of these tests: computing
// the digest with the same helper on both sides and asserting the two agree. That proves the
// function is deterministic — nothing more. The claim is that a WRONG digest is caught, so the
// load-bearing golden is the mutation one, and the serializer goldens above bake the digest as a
// literal so the hash's own value is pinned rather than derived.
// ## Verified red-green: 2026-07-26
describe('vault block payload digest (SB-080 / DD-009)', () => {
  const host = (block) => ['# 2026-01-05', '', '## Intentions', '', '- ship it', '', ...block.split('\n'), '', '## Captures', '', '- a stray thought', ''].join('\n'); // prettier-ignore
  const E = (o) => ({ id: 'runtime-id', date: '2026-01-05', start: null, end: null, durMin: null, project: null, label: '', note: '', billable: false, ...o }); // prettier-ignore
  const DAY = [
    E({ start: 540, end: 930, project: '[[Planning]]', label: 'Daily planning ritual', billable: true }),
    E({ durMin: 30, project: '[[Home]]', label: 'Tidying' }),
  ];
  const WRITTEN = host(TT.serializeVaultBlock(DAY, { revision: 3 }));

  it('TT always writes a digest — the digest-less shape is a read concession, never an emitter option', () => {
    expect(TT.serializeVaultBlock(DAY, { revision: 3 })).toMatch(/\n`revision: 3 · [0-9a-f]{4}`$/);
    expect(TT.serializeVaultBlock([], { revision: 1 })).toMatch(/\n`revision: 1 · [0-9a-f]{4}`$/); // zero-entry day too
  });

  it('a block TT wrote verifies against itself', () => {
    const loc = TT.locateVaultBlock(WRITTEN);
    expect(loc.quarantine).toBe(false);
    expect(loc.verified).toBe(true);
    expect(loc.digest).toMatch(/^[0-9a-f]{4}$/);
    expect(TT.parseVaultBlock(WRITTEN).verified).toBe(true);
  });

  // THE ONE THAT COUNTS. Without this, nothing proves the decision was implemented rather than
  // merely emitted.
  it('the SB-051 chimera — TT’s anchor line over someone else’s rows — quarantines', () => {
    const chimera = WRITTEN.replace('Daily planning ritual', 'USER-TYPED-IN-BLOCKROW');
    // it is still a structurally perfect block: same anchors, same schema, same shape
    expect(chimera).toContain('`revision: 3 · ');
    expect(TT.locateVaultBlock(chimera)).toEqual({ quarantine: true, reason: 'digest-mismatch' });
    expect(TT.parseVaultBlock(chimera)).toEqual({ quarantine: true, reason: 'digest-mismatch' });
    // and not one byte is written back over it
    expect(TT.writeVaultBlock(chimera, DAY).md).toBe(chimera);
  });

  it('a digest-less block parses and reports UNVERIFIED — it is never quarantined', () => {
    // the back-compat and hand-made-block path (DD-009 consequence 2). Getting this backwards
    // makes every pre-cutover note unreadable, which is why it is asserted on both verbs.
    const legacy = WRITTEN.replace(/`revision: 3 · [0-9a-f]{4}`/, '`revision: 3`');
    const loc = TT.locateVaultBlock(legacy);
    expect(loc.quarantine).toBe(false);
    expect(loc.verified).toBe(false);
    expect(loc.digest).toBe(null);
    const parsed = TT.parseVaultBlock(legacy);
    expect(parsed.quarantine).toBe(false);
    expect(parsed.verified).toBe(false);
    expect(parsed.entries).toHaveLength(2); // and it really did parse, not merely not-refuse
  });

  it('covers exactly DD-009 rule 1: the table rows, and nothing around them', () => {
    const digestOf = (md, opts) => TT.locateVaultBlock(md, opts).digest;
    const base = digestOf(WRITTEN);
    // OUTSIDE the payload — the digest must not move, or every unrelated edit to Terje's own
    // sections would quarantine his hours
    expect(digestOf(WRITTEN.replace('- a stray thought', '- a different thought'))).toBe(base);
    expect(digestOf(WRITTEN.replace('- ship it', '- ship it today'))).toBe(base);
    expect(digestOf(WRITTEN.replace('## Time Log', '## Timeloggen'), { heading: 'Timeloggen' })).toBe(base);
    // INSIDE it — each of the four row kinds rule 1 names must move the digest. Compared against
    // a re-signed copy, since a mutated block no longer locates at all.
    const moved = (md, what) => {
      expect(md, `${what}: the mutation matched nothing — this case proves nothing`).not.toBe(WRITTEN);
      expect(digestOf(sign(md)), what).not.toBe(base);
    };
    moved(WRITTEN.replace('| Time | Mode | Project | Task | Bill |', '| Time | Mode | Project | Task |'), 'header row');
    moved(WRITTEN.replace('|---|---|---|---|---|', '|:---|---|---|---|---|'), 'delimiter row');
    moved(WRITTEN.replace('Daily planning ritual', 'Daily planning'), 'a data row');
    moved(WRITTEN.replace('**6.5h billable**', '**9.9h billable**'), 'the totals row');
  });

  it('the digest is stable across serialize→serialize with a timer running (SB-077)', () => {
    // SB-077 — a running entry contributes 0 to the totals — is what makes a payload digest
    // affordable at all: a clock-dependent payload would re-digest every minute and detect
    // nothing. This test is what catches that ruling regressing.
    const today = TT.todayStr();
    const running = [E({ date: today, start: 540, billable: true }), E({ date: today, durMin: 60, billable: true })];
    const once = TT.serializeVaultBlock(running, { revision: 2 });
    const twice = TT.serializeVaultBlock(running, { revision: 2 });
    expect(once).toBe(twice);
    expect(TT.locateVaultBlock(host(once)).verified).toBe(true);
  });

  it('a block round-trips through the writer and still verifies', () => {
    // the write path re-parses its own output before returning it, so this also pins that emit
    // and verify agree on what the payload is — two definitions that merely happened to agree
    // would surface here as a `write-would-corrupt` refusal
    const res = TT.writeVaultBlock(WRITTEN, DAY);
    expect(res.quarantine).toBe(false);
    expect(TT.locateVaultBlock(res.md).verified).toBe(true);
  });
});

// ---- SB-063: the vault Time-column separator is a setting ----
// Write-side only. TT.parseTimeCell has accepted `→`, `->` and `-` since SB-055, so the
// three values differ only in how a note LOOKS — which is what makes the setting
// migration-free, and is therefore the property these tests pin rather than assume.
//
// The trap this suite guards is the shared formatter: TT.fmtTimeCell serves the v2 mirror
// (`## <date>` entry lines) as well as the vault block, and SB-069 froze the mirror's bytes.
// So there are two halves here — the separator MOVES in the vault block under each value,
// and the mirror does NOT move under any of them.
// ## Verified red-green: 2026-07-26
describe('vault Time-column separator setting (SB-063)', () => {
  /** @param {Partial<import('../shared/types.ts').Entry>} o */
  const E = (o) => ({
    id: 'runtime-id',
    date: '2026-01-05',
    start: null,
    end: null,
    durMin: null,
    project: null,
    label: '',
    note: '',
    billable: false,
    ...o,
  });
  // a finished range, an open (running) range, and a duration-only row — the third has no
  // separator at all and must be untouched by every value
  const DAY = [
    E({ start: 660, end: 765, label: 'Search & facets' }),
    E({ start: 1054, label: 'Block format feel-gate' }),
    E({ durMin: 30, label: 'Tidying' }),
  ];
  const SEPARATORS = { unicode: '→', ascii: '->', hyphen: '-' };

  it('resolves each setting value to its characters, and anything else to the `→` default', () => {
    expect(TT.timeSeparator('unicode')).toBe('→');
    expect(TT.timeSeparator('ascii')).toBe('->');
    expect(TT.timeSeparator('hyphen')).toBe('-');
    // the setting can only change how a note LOOKS, never whether it can be written
    expect(TT.timeSeparator(undefined)).toBe('→');
    expect(TT.timeSeparator(null)).toBe('→');
    expect(TT.timeSeparator('')).toBe('→');
    expect(TT.timeSeparator('arrow')).toBe('→'); // the ticket's original draft name
    expect(TT.timeSeparator(' | ')).toBe('→'); // raw characters are NOT a value
  });

  it('emits the chosen separator in BOTH the range form and the running form', () => {
    for (const [value, sep] of Object.entries(SEPARATORS)) {
      const region = TT.serializeVaultBlock(DAY, { headers: ['Time', 'Task'], timeSeparator: value });
      expect(region, value).toContain('| 11:00' + sep + '12:45 | Search & facets |');
      expect(region, value).toContain('| 17:34' + sep + ' | Block format feel-gate |');
      expect(region, value).toContain('| 30m | Tidying |'); // duration-only: no separator to change
    }
  });

  it('an absent setting emits exactly what TT emits today (`unicode` is the default)', () => {
    const today = TT.serializeVaultBlock(DAY, { headers: ['Time', 'Task'] });
    expect(today).toBe(TT.serializeVaultBlock(DAY, { headers: ['Time', 'Task'], timeSeparator: 'unicode' }));
    expect(today).toBe(TT.serializeVaultBlock(DAY, { headers: ['Time', 'Task'], timeSeparator: undefined }));
    expect(today).toContain('| 11:00→12:45 | Search & facets |');
    expect(today).toContain('| 17:34→ | Block format feel-gate |');
  });

  it('the splice carries the setting through to the note', () => {
    const host = ['# Monday', '', '## Time Log', '', '| Time | Task |', '|---|---|', '| **0h** | **0h billable** |', '', '`revision: 1`', '', '## Captures', '- keep me'].join('\n'); // prettier-ignore
    const res = TT.writeVaultBlock(host, DAY, { headers: ['Time', 'Task'], timeSeparator: 'hyphen' });
    expect(res.quarantine).toBe(false);
    expect(res.md).toContain('| 11:00-12:45 | Search & facets |');
    expect(res.md).toContain('| 17:34- | Block format feel-gate |');
    expect(res.md.endsWith('\n## Captures\n- keep me')).toBe(true); // nothing outside the block moved
  });

  // THE property that makes the setting migration-free: whichever separator was written,
  // the parser recovers the same entries. Tested, not assumed — if this ever stops holding,
  // flipping the setting silently becomes a vault migration.
  it('round-trips under every value — the written separator never changes what is read back', () => {
    const fields = (entries) =>
      entries.map((entry) => ({
        start: entry.start,
        end: entry.end,
        durMin: entry.durMin,
        label: entry.label,
      }));
    const expected = fields(DAY);
    const written = new Set();
    for (const value of Object.keys(SEPARATORS)) {
      const region = TT.serializeVaultBlock(DAY, { headers: ['Time', 'Task'], timeSeparator: value });
      written.add(region);
      const parsed = TT.parseVaultBlock(region, { date: '2026-01-05' });
      expect(parsed.quarantine, value).toBe(false);
      expect(fields(parsed.entries), value).toEqual(expected);
    }
    // three DIFFERENT byte strings converged on one reading — without this the test would
    // pass just as happily if the option were being ignored entirely
    expect(written.size).toBe(3);
  });

  // ---- the v2 mirror does not move (SB-069) ----
  // `backend=sqlite` must come out of the whole vault effort byte-for-byte identical, so the
  // setting must be reachable ONLY through the vault block's own options.
  it('the v2 mirror is byte-identical at every value of the setting', () => {
    const base = TT.serializeMd(TT.parseMd(V2_FIXTURE));
    expect(base).toBe(V2_FIXTURE); // the existing golden, restated so a break lands here too
    for (const value of [...Object.keys(SEPARATORS), 'arrow', undefined]) {
      const state = TT.parseMd(V2_FIXTURE);
      state.settings.vaultTimeSeparator = value;
      expect(TT.serializeMd(state), String(value)).toBe(V2_FIXTURE);
    }
  });

  it('the mirror still writes `→`, and no Settings key can reach it', () => {
    const state = TT.parseMd(V2_FIXTURE);
    state.settings.vaultTimeSeparator = 'hyphen';
    const out = TT.serializeMd(state);
    expect(out).toContain('→');
    expect(out).not.toContain('vaultTimeSeparator'); // the mirror serializes no such line
    expect(TT.parseMd(out).settings.vaultTimeSeparator).toBe(undefined);
  });
});

describe('vault Mode tags + Project vaultNote (SB-059)', () => {
  /** A canonical TT-written note: heading, table, digest-carrying revision line (DD-009). */
  const note = (header, delim, rows) =>
    ['## Time Log', '', header, delim, ...rows, '', '`revision: 1 · ' + TT.vaultPayloadDigest([header, delim, ...rows]) + '`', ''].join('\n'); // prettier-ignore
  /** @param {Partial<import('../shared/types.ts').VaultEntry>} o */
  const E = (o) => ({ id: 'runtime-id', date: '2026-01-05', start: null, end: null, durMin: null, project: null, label: '', note: '', billable: false, ...o }); // prettier-ignore
  /** the runtime id is ephemeral (DD-008) — it is never part of a round-trip claim */
  const withoutId = (entries) => entries.map(({ id, ...rest }) => rest);
  /** @param {Partial<import('../shared/types.ts').Project>} o */
  const P = (o) => ({ code: 'X', name: 'X', clientId: null, rate: null, billable: true, archived: false, ...o });

  const PROJECTS = [
    P({ code: 'LT-01', name: 'Lifelines Tycoon', vaultNote: 'Lifelines Tycoon' }),
    P({ code: 'FAG', name: 'Fagbokforlaget' }), // no vaultNote — the bare-code fallback
  ];

  // ---- 1. both fields round-trip ----
  it('tags and vaultNote survive serialize → parse as the same entries', () => {
    const day = [
      E({ start: 540, end: 930, project: 'LT-01', label: 'Systems pass', tags: ['#deep'], billable: true }),
      E({ durMin: 30, project: 'FAG', label: 'Invoicing', tags: ['#admin', '#rest'] }),
    ];
    const region = TT.serializeVaultBlock(day, { revision: 4, projects: PROJECTS });
    // the bytes first — a round-trip that agrees with itself about the wrong shape is no proof
    expect(region).toContain('| 09:00→15:30 | #deep | [[Lifelines Tycoon]] | Systems pass | ✓ |');
    expect(region).toContain('| 30m | #admin #rest | FAG | Invoicing | |');
    const parsed = TT.parseVaultBlock(region, { date: '2026-01-05', projects: PROJECTS });
    expect(parsed.quarantine).toBe(false);
    expect(withoutId(parsed.entries)).toEqual(withoutId(day));
    // the model holds the CODE; the wikilink is a rendering of it
    expect(parsed.entries.map((e) => e.project)).toEqual(['LT-01', 'FAG']);
  });

  it('a note TT wrote with both fields is byte-identical after a full write cycle', () => {
    const md = note('| Time | Mode | Project | Task | Bill |', '|---|---|---|---|---|', [
      '| 09:00→15:30 | #deep | [[Lifelines Tycoon]] | Systems pass | ✓ |',
      '| 30m | #admin #rest | FAG | Invoicing<br>- monthly | |',
      '| **7h** | | | | **6.5h billable** |',
    ]);
    const opts = { date: '2026-01-05', projects: PROJECTS };
    const parsed = TT.parseVaultBlock(md, opts);
    expect(parsed.quarantine).toBe(false);
    const res = TT.writeVaultBlock(md, parsed.entries, opts);
    expect(res.quarantine).toBe(false);
    expect(res.md).toBe(md);
  });

  // ---- 2. the absent-field case: the migration-free property, exercised ----
  // A block written before EITHER field existed, read and written by the code that has them.
  // This is the whole reason the header row is the schema; assuming it would be assuming away
  // the one property the design exists to provide.
  it('a pre-SB-059 block — no Mode column, no vaultNote — parses and writes back byte-identically', () => {
    const md = note('| Time | Project | Task | Bill |', '|---|---|---|---|', [
      '| 08:30→12:00 | FAG | Checkout flow<br>- wireframes | ✓ |',
      '| 45m | INT-ADM | Invoicing | |',
      '| **4.25h** | | | **3.5h billable** |',
    ]);
    // the catalog IS supplied — the new machinery is fully wired, the block simply predates it
    const opts = { date: '2026-01-05', projects: PROJECTS };
    const parsed = TT.parseVaultBlock(md, opts);
    expect(parsed.quarantine).toBe(false);
    expect(parsed.headers).toEqual(['Time', 'Project', 'Task', 'Bill']); // its own four, kept
    expect(parsed.entries.map((e) => e.tags)).toEqual([undefined, undefined]); // no column ⇒ absent
    // FAG is in the catalog with no vaultNote; INT-ADM is not in the catalog at all
    expect(parsed.entries.map((e) => e.project)).toEqual(['FAG', 'INT-ADM']);
    const res = TT.writeVaultBlock(md, parsed.entries, opts);
    expect(res.quarantine).toBe(false);
    expect(res.md).toBe(md);
    expect(res.md).not.toContain('Mode'); // no column was invented on the way through
  });

  it('an empty Mode cell round-trips as empty, and parses to absent rather than []', () => {
    const md = note('| Time | Mode | Task |', '|---|---|---|', ['| 30m | | Tidying |', '| **0.5h** | | **0.5h billable** |']); // prettier-ignore
    const parsed = TT.parseVaultBlock(md, { date: '2026-01-05' });
    expect(parsed.entries[0].tags).toBe(undefined);
    expect(TT.writeVaultBlock(md, parsed.entries, { date: '2026-01-05' }).md).toBe(md);
  });

  // ---- 3. hostile content: the cell primitives, not a bare join ----
  // SB-082 and SB-070 are what happens when a value reaches a cell without them.
  it('a `|` and a `<br>` in a tag or a vaultNote are escaped, and the row does not split', () => {
    const projects = [P({ code: 'ODD', name: 'Odd', vaultNote: 'Pipe | Note<br>Here' })];
    const day = [E({ durMin: 30, project: 'ODD', label: 'Tidying', tags: ['#a|b', '#c<br>d'] })];
    const region = TT.serializeVaultBlock(day, { headers: ['Time', 'Mode', 'Project', 'Task'], projects });
    // THE BYTES: one `|` per column boundary, every content pipe backslash-escaped
    expect(region).toContain('| 30m | #a\\|b #c<br>d | [[Pipe \\| Note<br>Here]] | Tidying |');
    // and the table still has exactly header + delimiter + 1 entry + totals rows
    expect(region.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(4);
    const parsed = TT.parseVaultBlock(region, { date: '2026-01-05', projects });
    expect(parsed.quarantine).toBe(false);
    expect(parsed.entries[0].tags).toEqual(['#a|b', '#c<br>d']);
    expect(parsed.entries[0].project).toBe('ODD'); // the escaped wikilink still resolves
  });

  it('a space inside a tag is escaped, so one tag never becomes two', () => {
    const day = [E({ durMin: 30, tags: ['#deep work', '#admin'] })];
    const region = TT.serializeVaultBlock(day, { headers: ['Time', 'Mode'] });
    expect(region).toContain('| 30m | #deep\\ work #admin |');
    expect(TT.parseVaultBlock(region).entries[0].tags).toEqual(['#deep work', '#admin']);
  });

  // A newline cannot be escaped INTO a table cell — the row ends at the newline, whatever
  // precedes it. So the honest guarantee is the same one a newline in a label already gets
  // (SB-055's output gate): the write is REFUSED and the note comes back untouched. The row
  // never splits, which is the property SB-082/SB-070 are about.
  it('a newline in a tag or a vaultNote is refused by the output gate, not written as a split row', () => {
    const host = note('| Time | Mode | Project | Task | Bill |', '|---|---|---|---|---|', ['| **0h** | | | | **0h billable** |']); // prettier-ignore
    const tagged = TT.writeVaultBlock(host, [E({ durMin: 30, label: 'Tidying', tags: ['#a\nb'] })]);
    expect(tagged.quarantine).toBe(true);
    expect(tagged.reason).toBe('write-would-corrupt');
    expect(tagged.md).toBe(host);
    const projects = [P({ code: 'NL', name: 'NL', vaultNote: 'Two\nLines' })];
    const linked = TT.writeVaultBlock(host, [E({ durMin: 30, label: 'Tidying', project: 'NL' })], { projects });
    expect(linked.quarantine).toBe(true);
    expect(linked.reason).toBe('write-would-corrupt');
    expect(linked.md).toBe(host);
  });

  // ---- 4. the [[Wikilink]] fallback ----
  it('renders the wikilink when vaultNote is set and the bare code when it is not', () => {
    const day = [E({ durMin: 30, project: 'LT-01' }), E({ durMin: 45, project: 'FAG' })];
    const region = TT.serializeVaultBlock(day, { headers: ['Time', 'Project'], projects: PROJECTS });
    expect(region).toContain('| 30m | [[Lifelines Tycoon]] |'); // vaultNote set
    expect(region).toContain('| 45m | FAG |'); // vaultNote absent → the bare code
  });

  it('the mapping is opt-in: with no catalog both directions are verbatim, exactly as before SB-059', () => {
    const day = [E({ durMin: 30, project: 'LT-01' })];
    expect(TT.serializeVaultBlock(day, { headers: ['Time', 'Project'] })).toContain('| 30m | LT-01 |');
    const md = note('| Time | Project |', '|---|---|', ['| 30m | [[Lifelines Tycoon]] |', '| **0.5h** | **0.5h billable** |']); // prettier-ignore
    expect(TT.parseVaultBlock(md).entries[0].project).toBe('[[Lifelines Tycoon]]');
  });

  it('a wikilink no project claims is carried verbatim — TT never invents a code', () => {
    const md = note('| Time | Project |', '|---|---|', ['| 30m | [[Planning]] |', '| **0.5h** | **0.5h billable** |']); // prettier-ignore
    const opts = { date: '2026-01-05', projects: PROJECTS };
    expect(TT.parseVaultBlock(md, opts).entries[0].project).toBe('[[Planning]]');
    // and being unable to resolve it does not stop the note round-tripping
    expect(TT.writeVaultBlock(md, TT.parseVaultBlock(md, opts).entries, opts).md).toBe(md);
  });

  // ---- the read chain and the emit chain stay in step for Mode ----
  it('the Mode cell has ONE source: a stale vaultCells.mode can no longer reach the bytes', () => {
    // the drift this guards is a passthrough FALLBACK — `tags` when set, the old raw cell when
    // not. The second entry is the one that catches it: no tags, a stale cell, and an empty
    // Mode column is still the right answer, because `Mode` is not a passthrough column any more
    const day = [E({ durMin: 30, tags: ['#deep'] }), E({ durMin: 15, vaultCells: { mode: '#stale' } })];
    const region = TT.serializeVaultBlock(day, { headers: ['Time', 'Mode'] });
    expect(region).toContain('| 30m | #deep |');
    expect(region).toContain('| 15m | |');
    expect(region).not.toContain('#stale');
  });

  // ---- the Mode cell codec ----
  it('encodeTagsCell / decodeTagsCell are inverse, and normalise only what a cell cannot carry', () => {
    expect(TT.encodeTagsCell(['#deep', '#admin'])).toBe('#deep #admin');
    expect(TT.encodeTagsCell([])).toBe('');
    expect(TT.encodeTagsCell(undefined)).toBe('');
    expect(TT.encodeTagsCell(['  #deep  ', '', '   '])).toBe('#deep'); // trimmed, empties dropped
    expect(TT.decodeTagsCell('')).toEqual([]);
    expect(TT.decodeTagsCell('#deep   #admin')).toEqual(['#deep', '#admin']); // runs collapse
    expect(TT.decodeTagsCell('#a\\|b')).toEqual(['#a|b']);
    expect(TT.decodeTagsCell(TT.encodeTagsCell(['#a b', '#c\\d']))).toEqual(['#a b', '#c\\d']);
    expect(TT.decodeTagsCell('deep')).toEqual(['deep']); // a bare token stays bare — no `#` invented
  });

  // ---- 5. the v2 mirror does not move (SB-069) ----
  // `backend=sqlite` must come out of the vault effort byte-for-byte identical, so neither
  // field may reach a mirror byte. The consequence — recorded, not hidden — is that neither
  // field SURVIVES the mirror either; today the vault block is their only serialization.
  it('the v2 mirror is byte-identical with tags and vaultNote set, and carries neither back', () => {
    expect(TT.serializeMd(TT.parseMd(V2_FIXTURE))).toBe(V2_FIXTURE); // the golden, restated
    const state = TT.parseMd(V2_FIXTURE);
    state.projects[0].vaultNote = 'Lifelines Tycoon';
    state.entries[0].tags = ['#deep'];
    expect(TT.serializeMd(state)).toBe(V2_FIXTURE);
    const back = TT.parseMd(TT.serializeMd(state));
    expect(back.projects[0].vaultNote).toBe(undefined);
    expect(back.entries[0].tags).toBe(undefined);
  });
});

// ---- SB-091 / DD-012: TT adopts a daily note on first write ----
// Terje, raising SB-089: *"if I create a daily note by hand, I can't write to it with TT? That
// needs a solution."* Before this, `writeVaultBlock` required an already-located block and
// `locateVaultBlock` demanded both anchors, so a note that did not come from the Templater
// template was permanently unwritable — it quarantined forever while looking perfectly fine to a
// human.
//
// The precondition is STRICT and this suite is mostly refusals, for the same reason the locator
// suite is: adoption is the one path that creates an anchor, and a suite that fed it only
// adoptable notes would prove the opposite of what it claims.
//
// THE EXPENSIVE ONE IS `refuses a real pre-cutover note` — 60 notes, 141 hand-written rows of
// Terje's real work log, ruled untouched/unparsed/invisible by SB-049. Note what that test
// actually measures, because the ticket's premise was wrong about it: those notes DO carry
// `## Time Log` exactly once, and the region under it IS a single well-formed markdown table, so
// they pass precondition 1 and the SHAPE half of precondition 2. What refuses them is the header
// vocabulary — `Cat`/`Description`, uniform across all 66 header rows measured in the vault. A
// shape-only precondition would have adopted every one of them. That is precisely why adoption
// validates by running the real parser rather than a private opinion about "well-formed".
// ## Verified red-green: 2026-07-26
describe('adopting a hand-made daily note (SB-091 / DD-012)', () => {
  /** @param {Partial<import('../shared/types.ts').VaultEntry>} o */
  const E = (o) => ({ id: 'runtime-id', date: '2026-07-26', start: null, end: null, durMin: null, project: null, label: '', note: '', billable: false, ...o }); // prettier-ignore
  /** the runtime id is ephemeral (DD-008) — never part of a round-trip claim */
  const withoutId = (entries) => entries.map(({ id, ...rest }) => rest);
  /** @param {Partial<import('../shared/types.ts').Project>} o */
  const P = (o) => ({ code: 'X', name: 'X', clientId: null, rate: null, billable: true, archived: false, ...o });
  const PROJECTS = [P({ code: 'LT-01', name: 'Lifelines Tycoon', vaultNote: 'Lifelines Tycoon' })];

  /** Terje's own hand: no revision line anywhere, an hour already typed in, no totals row. */
  const HAND_MADE = [
    '---',
    'date: 2026-07-26',
    '---',
    '',
    '## Intentions',
    '',
    '- ship adoption',
    '',
    '## Time Log',
    '',
    '| Time | Mode | Project | Task | Bill |',
    '|---|---|---|---|---|',
    '| 09:00→10:30 | #deep | [[Lifelines Tycoon]] | Systems pass<br>- the economy loop | ✓ |',
    '| 30m | #admin | FAG | Invoicing | |',
    '',
    '## Captures',
    '',
    '- something Terje wrote',
    '',
  ].join('\n');

  /** The other adoptable shape: the heading is there and nothing at all is under it. */
  const EMPTY_REGION = ['# 2026-07-26', '', '## Time Log', '', '## Captures', '', '- a thought', ''].join('\n');

  // ---- 1. the two shapes that adopt ----

  it('imports the rows of a hand-made table — the whole point of the ticket', () => {
    const parsed = TT.parseVaultBlock(HAND_MADE, { date: '2026-07-26', projects: PROJECTS });
    expect(parsed.quarantine).toBe(false);
    expect(parsed.adopted).toBe(true);
    expect(parsed.revision).toBe(1); // DD-012: a first write starts at 1
    expect(parsed.headers).toEqual(['Time', 'Mode', 'Project', 'Task', 'Bill']);
    // the rows went through the SAME parse and the same cell primitives as any other block —
    // SB-059's tags and the `[[wikilink]]` → code resolution included, since adoption is a read
    // path into the data model and not a shortcut into it
    expect(withoutId(parsed.entries)).toEqual([
      { date: '2026-07-26', start: 540, end: 630, durMin: null, project: 'LT-01', label: 'Systems pass', note: 'the economy loop', billable: true, tags: ['#deep'] }, // prettier-ignore
      { date: '2026-07-26', start: null, end: null, durMin: 30, project: 'FAG', label: 'Invoicing', note: '', billable: false, tags: ['#admin'] }, // prettier-ignore
    ]);
  });

  it('adopts a region that is completely empty', () => {
    const parsed = TT.parseVaultBlock(EMPTY_REGION, { date: '2026-07-26' });
    expect(parsed.quarantine).toBe(false);
    expect(parsed.adopted).toBe(true);
    expect(parsed.entries).toEqual([]); // an empty region is zero entries, not a refusal
    const res = TT.writeVaultBlock(EMPTY_REGION, [E({ durMin: 45, label: 'First hour' })]);
    expect(res.quarantine).toBe(false);
    expect(res.adopted).toBe(true);
    expect(res.md).toContain('| 45m | | | First hour | |');
  });

  it('NEVER reports `verified` on an adopted block, in either shape', () => {
    // `verified` means "these bytes are what their writer wrote" (DD-009). TT is not the writer
    // of a note it has never touched, and a digest taken at adoption time would be over the very
    // bytes it is meant to check — vacuously true, and SB-057's arbitration is entitled to trust
    // it. There is no forced flag behind this: the anchor adoption synthesises carries no digest,
    // so DD-009's existing hand-made-block path reports it. The empty-region case is the trap —
    // that block IS entirely TT's own bytes, and it must still come back unverified.
    expect(TT.parseVaultBlock(HAND_MADE).verified).toBe(false);
    expect(TT.parseVaultBlock(EMPTY_REGION).verified).toBe(false);
  });

  it('the anchor heading comes from settings — adoption hardcodes nothing', () => {
    const renamed = HAND_MADE.replace('## Time Log', '## Tidsloggen');
    expect(TT.parseVaultBlock(renamed).quarantine).toBe(true); // not TT's heading
    const parsed = TT.parseVaultBlock(renamed, { heading: 'Tidsloggen' });
    expect(parsed.adopted).toBe(true);
    expect(parsed.entries).toHaveLength(2);
    expect(TT.writeVaultBlock(renamed, [], { heading: 'Tidsloggen' }).md).toContain('## Tidsloggen');
  });

  // ---- 2. the write: an adopted note becomes an ordinary block ----

  it('writes the anchor with its digest, and the second write is a fixed point', () => {
    const day = TT.parseVaultBlock(HAND_MADE, { date: '2026-07-26', projects: PROJECTS }).entries;
    const first = TT.writeVaultBlock(HAND_MADE, day, { projects: PROJECTS });
    expect(first.quarantine).toBe(false);
    expect(first.adopted).toBe(true);

    // DD-012: `revision: 1` PLUS SB-080's payload digest — and it must verify, or adoption has
    // minted a block that fails SB-080's own check the moment it is read back
    const loc = TT.locateVaultBlock(first.md);
    expect(loc.quarantine).toBe(false);
    expect(loc.revision).toBe(1);
    expect(loc.digest).toMatch(/^[0-9a-f]{4}$/);
    expect(loc.verified).toBe(true);
    expect(first.md).toContain('| **2h** | | | | **1.5h billable** |'); // TT's totals row now

    // …and from here it is an ordinary block: no second adoption, and the bytes are a fixed point
    const second = TT.writeVaultBlock(first.md, day, { projects: PROJECTS });
    expect(second.adopted).toBe(false);
    expect(second.md).toBe(first.md);
    expect(TT.parseVaultBlock(first.md, { date: '2026-07-26', projects: PROJECTS }).adopted).toBe(false);
  });

  it('nothing outside the region moves — asserted on the bytes above and below it', () => {
    const res = TT.writeVaultBlock(HAND_MADE, [E({ durMin: 15, label: 'A new hour' })]);
    expect(res.quarantine).toBe(false);
    const above = (md) => md.slice(0, md.indexOf('## Time Log'));
    const below = (md) => md.slice(md.indexOf('## Captures'));
    expect(above(res.md)).toBe(above(HAND_MADE)); // frontmatter + `## Intentions` untouched
    expect(below(res.md)).toBe(below(HAND_MADE)); // Terje's `## Captures` untouched
    // the same claim for the empty-region shape, where TT authors the table as well
    const res2 = TT.writeVaultBlock(EMPTY_REGION, []);
    expect(above(res2.md)).toBe(above(EMPTY_REGION));
    expect(below(res2.md)).toBe(below(EMPTY_REGION));
  });

  // ---- 3. everything else still quarantines, and writes nothing ----

  /** A real pre-cutover daily note (SB-049): `Calendar/Daily/2026-06-03.md`, shape verbatim. */
  const PRE_CUTOVER = [
    '---',
    'date: 2026-06-03',
    'day: Wednesday',
    'work_mode: learn',
    'main_project: "[[Lifelines]]"',
    '---',
    '',
    '## Intentions',
    '',
    '### Theme',
    'Step back from Lifelines fog.',
    '',
    '## Habits',
    '',
    '- [ ] 🧘 Meditation',
    '',
    '## Time Log',
    '',
    '| Time | Cat | Project | Description |',
    '|------|-----|---------|-------------|',
    '| 22:15-22:45 | #admin | [[Planning]] | Daily planning ritual |',
    '#### Hours',
    '',
    '```dataviewjs',
    'const content = await dv.io.load(dv.currentFilePath);',
    'const rowRegex = /^\\|\\s*(\\d{2}:\\d{2})-(\\d{2}:\\d{2})\\s*\\|\\s*#?(\\w+)\\s*\\|/;',
    'dv.table(["Category", "Hours"], rows);',
    '```',
    '',
    '## Captures',
    '',
    'Loose thoughts, ideas, things to process later.',
    '',
    '## Reflection',
    '',
    '*What went well?*',
    '',
  ].join('\n');

  const REFUSALS = [
    {
      name: 'prose under the heading',
      reason: 'no-table',
      md: HAND_MADE.replace('## Time Log\n', '## Time Log\n\nI worked on things today.\n'),
    },
    {
      name: 'a second table under the heading',
      reason: 'unexpected-content-in-block',
      md: HAND_MADE.replace(
        '| 30m | #admin | FAG | Invoicing | |\n',
        '| 30m | #admin | FAG | Invoicing | |\n\n| Time | Task |\n|---|---|\n| 1h | Something else |\n',
      ),
    },
    {
      name: 'an unparseable row — the hour must never silently vanish',
      reason: 'unparseable-time',
      md: HAND_MADE.replace('| 30m |', '| after lunch |'),
    },
    {
      name: 'a header outside the vocabulary',
      reason: 'unknown-header',
      md: HAND_MADE.replace('| Time | Mode |', '| Time | Mood |'),
    },
    {
      // SB-084's signal is computed before any branch and must still win: a tainted file is not
      // an adoptable one, and TT does not rewrite line endings it did not author (SB-083)
      name: 'a CRLF-tainted note',
      reason: 'crlf-line-endings',
      md: HAND_MADE.replace(/\n/g, '\r\n'),
    },
    {
      name: 'two anchor headings',
      reason: 'multiple-headings',
      md: HAND_MADE + '\n## Time Log\n\n| Time |\n|---|\n',
    },
    {
      // the dangerous shape SB-057 made both anchors mandatory for. Adoption acts ONLY on
      // 'no-revision', so a bottom anchor loose in someone else's section still refuses rather
      // than getting a second one inserted above it.
      name: 'a revision line loose past the next heading',
      reason: 'revision-past-next-heading',
      md: HAND_MADE.replace('- something Terje wrote', '`revision: 8`'),
    },
    {
      // SB-090. Adoption acts ONLY on 'no-revision', and this note no longer reports it: the
      // anchor is present and unreadable, not absent. Before SB-090 this shape reached adoption,
      // which inserted a SECOND anchor below the damaged one and then refused the result as
      // 'unexpected-content-in-block' — a refusal three steps removed from what is actually
      // wrong. TT does not repair a token it cannot read (SB-083), so refusing up front and
      // naming the line is the whole fix.
      name: 'a revision line whose digest is malformed — present, unreadable, not adoptable',
      reason: 'malformed-revision',
      md: HAND_MADE.replace('| 30m | #admin | FAG | Invoicing | |\n', '| 30m | #admin | FAG | Invoicing | |\n\n`revision: 4 · zzzz`\n'), // prettier-ignore
    },
    {
      name: 'a real pre-cutover note (SB-049 stays closed)',
      reason: 'unknown-header',
      md: PRE_CUTOVER,
    },
  ];

  for (const { name, reason, md } of REFUSALS) {
    it(`refuses: ${name}`, () => {
      expect(TT.parseVaultBlock(md)).toEqual({ quarantine: true, reason });
      expect(TT.parseVaultBlock(md).entries).toBeUndefined(); // no partial import
      const res = TT.writeVaultBlock(md, [E({ durMin: 15, label: 'A new hour' })]);
      expect(res).toEqual({ md, quarantine: true, reason, adopted: false }); // not one byte written
    });
  }

  it('SB-049: a pre-cutover note passes precondition 1 — only the VOCABULARY keeps it closed', () => {
    // Recorded because the ticket's premise was that these notes fail precondition 1 (no anchor
    // heading). They do not. Measured across the vault's 66 pre-cutover Time Log tables, every
    // one uses `| Time | Cat | Project | Description |` — so the header vocabulary is the single
    // thing standing between adoption and importing 141 rows of Terje's personal work log.
    expect(PRE_CUTOVER.match(/^## Time Log$/gm)).toHaveLength(1); // the anchor IS there, once
    expect(TT.locateVaultBlock(PRE_CUTOVER).reason).toBe('no-revision'); // …and found by the locator
    // the region is a well-shaped markdown table too: swap the two labels TT has no field for,
    // and the very same note adopts. Nothing else about it changes.
    const vocabularised = PRE_CUTOVER.replace('| Time | Cat | Project | Description |', '| Time | Mode | Project | Task |'); // prettier-ignore
    expect(TT.parseVaultBlock(vocabularised).adopted).toBe(true);
  });
});
