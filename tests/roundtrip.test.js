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
import { describe, it, expect } from 'vitest';
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
    });
  }

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
    for (const junk of [null, undefined, '', '\n\n\n', 42, {}, [], '## Time Log'.repeat(500), ' �|||']) {
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

  it('carries a vocabulary column with no model field through verbatim (Mode → passthrough)', () => {
    // Entry.tags does not exist yet (SB-059); dropping the cell would lose a typed `#deep`
    const entries = TT.parseVaultBlock(FULL).entries;
    expect(entries.map((e) => e.vaultCells)).toEqual([{ mode: '#admin' }, { mode: '#deep' }, { mode: '#rest' }]);
  });

  it('carries the Project cell verbatim — `[[Planning]]` and bare `FAG` alike (SB-059 owns the mapping)', () => {
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
