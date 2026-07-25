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
