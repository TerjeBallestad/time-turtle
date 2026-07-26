// The catalog note codec — `Time Turtle/Catalog.md` (SB-058, PLAN-011).
//
// Four independently-anchored sections, each the SAME shape as a daily-note block, so
// TT.locateVaultBlock parses them with no change at all. Nothing here reads or writes a file:
// every function under test takes a string and returns a string or a model. Finding, opening and
// safely replacing the real note is SB-057's.
//
// What a green run here does NOT prove, stated once so a green suite is never reported as "the
// catalog works": no file is ever opened, no arbitration between two machines is exercised, and
// byte equality is structurally blind to a severed reference — which is what Family C below is
// for.
//
// ## Verified red-green: 2026-07-26
// Task 1 (TASK-042): the section registry, and the two tables that carry money.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import TT from '../shared/core.js';

// ---- helpers ----
/** A one-section note: the section's region bytes with an H1 and some prose of Terje's above. */
const noteWith = (region) => ['# Time Turtle', '', 'My clients and rates.', '', region, ''].join('\n');
/** The region as TT emits it, which is also the region a golden is compared against. */
const region = (section, rows, revision = 1) => TT.serializeVaultCatalogSection(section, rows, { revision });
/** Parse one section straight out of the region bytes, wrapped in a realistic note. */
const parse = (section, region) => TT.parseVaultCatalogSection(noteWith(region), section);
/** Swap one line of a region for another — the hand-edit simulator. */
const edit = (md, from, to) => {
  expect(md.includes(from), `fixture line not found: ${from}`).toBe(true);
  return md.replace(from, to);
};
/**
 * Recompute a region's DD-009 payload digest, so a fixture derived by rewriting rows is one TT
 * itself could have written. Without this every edited fixture refuses as `digest-mismatch` —
 * the locator's gate fires before the parser ever runs, which is correct and is goldened on its
 * own below, but it would mask every parser-level reason behind one verdict.
 */
const sign = (md) => {
  const heading = /^##[ \t]+(.*)$/.exec(md.split('\n')[0])[1].trim();
  const lines = md.replace(/^`revision: (\d+)(?: · [0-9a-f]{4})?`$/m, '`revision: $1`').split('\n');
  const loc = TT.locateVaultBlock(lines.join('\n'), { heading });
  if (loc.quarantine) throw new Error('sign(): fixture does not locate — ' + loc.reason);
  const payload = [lines[loc.headerLine], lines[loc.separatorLine]].concat(loc.rowLines.map((n) => lines[n]));
  lines[loc.revisionLine] = '`revision: ' + loc.revision + ' · ' + TT.vaultPayloadDigest(payload) + '`';
  return lines.join('\n');
};

const FJELLHEIM = { id: 'fjellheim', name: 'Fjellheim AS', rate: 1250, rounding: 15, archived: false };
const BRYGGA = { id: 'brygga', name: 'Brygga Digital', rate: 990, rounding: 'exact', archived: false };
const NETT = { code: 'FJH-NETT', name: 'Nettbutikk rebuild', clientId: 'fjellheim', rate: null, billable: true, archived: false, vaultNote: 'Nettbutikk rebuild' }; // prettier-ignore
const DRIFT = { code: 'FJH-DRIFT', name: 'Drift & support', clientId: 'fjellheim', rate: 1400, billable: true, archived: false }; // prettier-ignore
const ADMIN = { code: 'INT-ADM', name: 'Internal admin', clientId: null, rate: null, billable: false, archived: false };

describe('catalog note — Clients and Projects (SB-058 task 1)', () => {
  // ---- Family A: the bytes ----
  describe('Family A — the emitted section is the shape SB-058 proposes', () => {
    it('Clients emits heading, table and one revision anchor, and nothing else', () => {
      expect(region('clients', [FJELLHEIM, BRYGGA], 3)).toBe(
        [
          '## Clients',
          '',
          '| Client | Name | Rate | Rounding |',
          '|---|---|---|---|',
          '| fjellheim | Fjellheim AS | 1250 | 15 |',
          '| brygga | Brygga Digital | 990 | exact |',
          '',
          '`revision: 3 · ' + TT.vaultPayloadDigest([
            '| Client | Name | Rate | Rounding |',
            '|---|---|---|---|',
            '| fjellheim | Fjellheim AS | 1250 | 15 |',
            '| brygga | Brygga Digital | 990 | exact |',
          ]) + '`',
        ].join('\n'), // prettier-ignore
      );
    });

    it('Projects emits an inherited rate and an absent client as EMPTY cells, never a placeholder', () => {
      const out = region('projects', [NETT, DRIFT, ADMIN], 3);
      expect(out.split('\n').slice(2, 7)).toEqual([
        '| Project | Name | Client | Rate | Billable | Note |',
        '|---|---|---|---|---|---|',
        '| FJH-NETT | Nettbutikk rebuild | fjellheim | | ✓ | [[Nettbutikk rebuild]] |',
        '| FJH-DRIFT | Drift & support | fjellheim | 1400 | ✓ | |',
        '| INT-ADM | Internal admin | | | | |',
      ]);
      // SB-045 ruled the v2 mirror's `—` placeholder out of the vault format; inside a table an
      // empty cell is already unambiguous.
      expect(out).not.toContain('—');
    });

    it('the anchor carries the section table its own DD-009 digest, not the note-wide one', () => {
      // The decisive argument in SB-104: one file-level revision over four tables leaves the
      // Projects table with no digest of its own, so an Obsidian diff-merge that rewrites a RATE
      // is undetectable. Two sections at the same revision must carry DIFFERENT digests.
      const clients = region('clients', [FJELLHEIM], 7).split('\n').pop();
      const projects = region('projects', [DRIFT], 7).split('\n').pop();
      expect(clients).toMatch(/^`revision: 7 · [0-9a-f]{4}`$/);
      expect(projects).toMatch(/^`revision: 7 · [0-9a-f]{4}`$/);
      expect(clients).not.toBe(projects);
    });

    it('the Archived column appears only when a row is archived — emit-when-set, lifted to the column', () => {
      expect(region('clients', [FJELLHEIM, BRYGGA])).toContain('| Client | Name | Rate | Rounding |');
      expect(region('clients', [FJELLHEIM, BRYGGA])).not.toContain('Archived');
      const withArchived = region('clients', [FJELLHEIM, { ...BRYGGA, archived: true }]);
      expect(withArchived).toContain('| Client | Name | Rate | Rounding | Archived |');
      expect(withArchived).toContain('| fjellheim | Fjellheim AS | 1250 | 15 | |');
      expect(withArchived).toContain('| brygga | Brygga Digital | 990 | exact | ✓ |');
    });
  });

  // ---- Family B: the round-trip ----
  describe('Family B — a section survives the note', () => {
    const ROWS = {
      clients: [FJELLHEIM, BRYGGA, { id: 'nord', name: 'Nord | Sør \\ AS', rate: null, rounding: 30, archived: true }],
      projects: [NETT, DRIFT, ADMIN, { code: 'ARK-01', name: 'Arkiv', clientId: 'nord', rate: 0, billable: true, archived: true, vaultNote: 'Arkiv | 2025' }], // prettier-ignore
    };

    for (const section of ['clients', 'projects']) {
      it(`${section}: parse(serialize(rows)).rows deep-equals the rows`, () => {
        const parsed = parse(section, region(section, ROWS[section], 4));
        expect(parsed.quarantine).toBe(false);
        expect(parsed.rows).toEqual(ROWS[section]);
        expect(parsed.revision).toBe(4);
        expect(parsed.verified).toBe(true);
      });

      it(`${section}: serialize(parse(md)) is byte-identical`, () => {
        const md = region(section, ROWS[section], 4);
        const parsed = parse(section, md);
        expect(region(section, parsed.rows, parsed.revision)).toBe(md);
      });
    }

    it('an absent Rate means INHERIT (null) and never 0 — the two are different facts', () => {
      const parsed = parse('projects', region('projects', [NETT, { ...DRIFT, rate: 0 }]));
      expect(parsed.rows[0].rate).toBe(null);
      expect(parsed.rows[1].rate).toBe(0);
    });

    it('a `|` and a `\\` in a name are escaped and come back intact', () => {
      const md = region('clients', [{ id: 'x', name: 'a|b\\c', rate: 1, rounding: 'exact', archived: false }]);
      expect(md).toContain('| a\\|b\\\\c |');
      expect(parse('clients', md).rows[0].name).toBe('a|b\\c');
    });

    it('a project with no vaultNote emits a blank Note cell and parses back with the field ABSENT', () => {
      const parsed = parse('projects', region('projects', [DRIFT]));
      expect('vaultNote' in parsed.rows[0]).toBe(false);
    });

    it('a bare note name is honoured and re-emitted in canonical wikilink form', () => {
      // Refusing would freeze the whole catalog — and with it every rate — over a missing pair of
      // brackets on a cosmetic column. No value is lost either way.
      const md = sign(edit(region('projects', [NETT]), '[[Nettbutikk rebuild]]', 'Nettbutikk rebuild'));
      const parsed = parse('projects', md);
      expect(parsed.rows[0].vaultNote).toBe('Nettbutikk rebuild');
      expect(region('projects', parsed.rows, parsed.revision)).toContain('[[Nettbutikk rebuild]]');
    });

    it('rounding: 0 and `exact` are one behaviour and normalise to one spelling', () => {
      const md = region('clients', [{ ...BRYGGA, rounding: 0 }]);
      expect(md).toContain('| exact |');
      expect(parse('clients', md).rows[0].rounding).toBe('exact');
      expect(TT.roundBill(37, 0)).toBe(TT.roundBill(37, 'exact'));
    });

    it('a blank Rounding cell reads as `exact` — an absent value, not an unreadable one', () => {
      const md = sign(edit(region('clients', [BRYGGA]), '| 990 | exact |', '| 990 | |'));
      expect(parse('clients', md).rows[0].rounding).toBe('exact');
    });
  });

  // ---- Family C: the vocabulary rule ----
  describe('Family C — any subset in any order parses, anything outside quarantines', () => {
    it('a section written before a column existed still parses, with the field at its default', () => {
      const md = ['## Clients', '', '| Client | Name |', '|---|---|', '| brygga | Brygga Digital |', '', '`revision: 2`'].join('\n'); // prettier-ignore
      const parsed = parse('clients', md);
      expect(parsed.quarantine).toBe(false);
      expect(parsed.rows).toEqual([{ id: 'brygga', name: 'Brygga Digital', rate: null, rounding: 'exact', archived: false }]); // prettier-ignore
      // DD-009 consequence 2: a digest-less anchor parses UNVERIFIED, never quarantined
      expect(parsed.verified).toBe(false);
    });

    it('a REORDERED header row parses, and the columns follow their labels not their positions', () => {
      const md = ['## Clients', '', '| Rounding | Name | Client |', '|---|---|---|', '| 15 | Fjellheim AS | fjellheim |', '', '`revision: 2`'].join('\n'); // prettier-ignore
      expect(parse('clients', md).rows).toEqual([{ id: 'fjellheim', name: 'Fjellheim AS', rate: null, rounding: 15, archived: false }]); // prettier-ignore
    });

    it('an Archived column present with nothing archived parses, and re-emits WITHOUT the column', () => {
      const md = ['## Clients', '', '| Client | Name | Rate | Rounding | Archived |', '|---|---|---|---|---|', '| brygga | Brygga Digital | 990 | exact | |', '', '`revision: 2`'].join('\n'); // prettier-ignore
      const parsed = parse('clients', md);
      expect(parsed.rows[0].archived).toBe(false);
      expect(region('clients', parsed.rows, 2)).not.toContain('Archived');
    });

    it('the WRITE side emits the canonical column set, never the note’s narrower one', () => {
      // The deliberate divergence from serializeVaultBlock, which re-emits a block's own headers.
      // Here the model is complete and this file is the only copy, so echoing back a narrower
      // header set would DROP fields with no database behind them to restore from.
      const md = ['## Clients', '', '| Client | Name |', '|---|---|', '| brygga | Brygga Digital |', '', '`revision: 2`'].join('\n'); // prettier-ignore
      const parsed = parse('clients', md);
      expect(region('clients', [{ ...parsed.rows[0], rate: 990 }], 2)).toContain('| Client | Name | Rate | Rounding |');
    });
  });

  // ---- Family D: every refusal, and what it is called ----
  describe('Family D — refusals', () => {
    /** @type {[string, string, string, string][]} section, reason, description, note */
    const REFUSALS = [
      // an unreadable NUMBER is a refusal, never a value — and above all never 0
      ['clients', 'catalog-bad-number', 'a rate with a thousands separator', sign(edit(region('clients', [FJELLHEIM]), '| 1250 |', '| 1,250 |'))], // prettier-ignore
      ['clients', 'catalog-bad-number', 'a rate with a currency suffix', sign(edit(region('clients', [FJELLHEIM]), '| 1250 |', '| 1250 kr |'))], // prettier-ignore
      ['clients', 'catalog-bad-number', 'a negative rate', sign(edit(region('clients', [FJELLHEIM]), '| 1250 |', '| -50 |'))], // prettier-ignore
      ['clients', 'catalog-bad-number', 'a rounding that is a word', sign(edit(region('clients', [FJELLHEIM]), '| 15 |', '| fifteen |'))], // prettier-ignore
      ['projects', 'catalog-bad-number', 'a project rate that is not a number', sign(edit(region('projects', [DRIFT]), '| 1400 |', '| tbd |'))], // prettier-ignore
      // a checkmark column carrying something that is neither the check mark nor blank
      ['projects', 'catalog-bad-flag-cell', 'a Billable cell reading yes', sign(edit(region('projects', [DRIFT]), '| ✓ |', '| yes |'))], // prettier-ignore
      ['clients', 'catalog-bad-flag-cell', 'an Archived cell reading x', sign(edit(region('clients', [{ ...BRYGGA, archived: true }]), 'exact | ✓ |', 'exact | x |'))], // prettier-ignore
      // identity
      [
        'clients',
        'catalog-missing-id',
        'a blank id cell',
        sign(edit(region('clients', [FJELLHEIM]), '| fjellheim |', '| |')),
      ],
      ['clients', 'catalog-missing-id', 'no id column at all', sign(['## Clients', '', '| Name | Rate |', '|---|---|', '| Fjellheim AS | 1250 |', '', '`revision: 2`'].join('\n'))], // prettier-ignore
      // …and the same with NO ROWS, which is the only fixture that isolates the header-level
      // guard: with rows present the blank-id check catches it one step later and the header
      // guard could be deleted without a single test noticing.
      ['clients', 'catalog-missing-id', 'no id column and no rows to reveal it', sign(['## Clients', '', '| Name | Rate |', '|---|---|', '', '`revision: 2`'].join('\n'))], // prettier-ignore
      ['clients', 'catalog-duplicate-id', 'two clients sharing an id', sign(region('clients', [FJELLHEIM, { ...BRYGGA, id: 'fjellheim' }]))], // prettier-ignore
      ['projects', 'catalog-duplicate-id', 'two projects sharing a code', sign(region('projects', [DRIFT, { ...ADMIN, code: 'FJH-DRIFT' }]))], // prettier-ignore
      // the shared, block-level refusals — same spelling, now carrying a section name
      ['clients', 'unknown-header', 'a column outside the vocabulary', sign(edit(region('clients', [FJELLHEIM]), '| Rounding |', '| Currency |'))], // prettier-ignore
      ['clients', 'duplicate-header', 'the same column twice', sign(['## Clients', '', '| Client | Name | Name |', '|---|---|---|', '| a | b | c |', '', '`revision: 2`'].join('\n'))], // prettier-ignore
      ['clients', 'row-cell-count', 'a row narrower than the header', sign(edit(region('clients', [FJELLHEIM]), '| fjellheim | Fjellheim AS | 1250 | 15 |', '| fjellheim | Fjellheim AS |'))], // prettier-ignore
      ['clients', 'no-heading', 'the section is simply not there', sign(region('projects', [DRIFT]))],
      ['clients', 'digest-mismatch', 'a hand edit under TT’s own anchor', edit(region('clients', [FJELLHEIM]), 'Fjellheim AS', 'Fjellheim ASA')], // prettier-ignore
    ];

    for (const [section, reason, what, md] of REFUSALS) {
      it(`${reason} — ${what}`, () => {
        const res = TT.parseVaultCatalogSection(noteWith(md), section);
        expect(res.quarantine).toBe(true);
        expect(res.reason).toBe(reason);
        // a shared reason like `no-heading` is only actionable once you know WHICH section
        expect(res.section).toBe(section);
      });
    }

    it('a damaged rate can never produce a catalog in which some rate reads 0', () => {
      // The never-zero rule, asserted on the ABSENCE of a degraded result rather than only on the
      // presence of a verdict. A rate TT cannot read must not reach the model at all.
      for (const bad of ['1,250', '1250 kr', '-50', 'tbd', 'NaN', '1250.', '']) {
        const damaged = edit(region('clients', [FJELLHEIM]), '| 1250 |', `| ${bad} |`);
        // both gates, because a damaged note reaches the reader in both states: unsigned it is
        // TT's own bytes with a stale anchor (the locator's digest check fires first), signed it
        // is a note whose author also fixed up the anchor (the parser's own check fires).
        for (const md of [damaged, sign(damaged)]) {
          const res = TT.parseVaultCatalogSection(noteWith(md), 'clients');
          if (res.quarantine) {
            expect(res.reason).toBe(md === damaged ? 'digest-mismatch' : 'catalog-bad-number');
            continue;
          }
          // the one legal blank: absent means INHERIT, which is null — never 0, never NaN
          expect(res.rows[0].rate).toBe(null);
          expect(res.rows.every((row) => row.rate === null || row.rate > 0)).toBe(true);
        }
      }
    });

    it('covers every catalog-only quarantine reason the codec can produce', () => {
      // The same guard tests/roundtrip.test.js keeps over the BLOCK half of the union, here over
      // the catalog half — a new reason added without a refusal golden beside it fails.
      //
      // Parsed robustly, unlike the block guard it mirrors (SB-109): block comments are stripped
      // before scraping, so a semicolon inside a doc comment cannot truncate the union, and only
      // `| '…'` members are counted, so a reason NAME quoted inside a comment cannot inflate it.
      const types = readFileSync(new URL('../shared/types.ts', import.meta.url), 'utf8');
      const union = /export type VaultCatalogQuarantineReason =([\s\S]*?);/.exec(types.replace(/\/\*[\s\S]*?\*\//g, '')); // prettier-ignore
      expect(union, 'VaultCatalogQuarantineReason union not found in shared/types.ts').toBeTruthy();
      const reasons = [...union[1].matchAll(/\|\s*'([a-z-]+)'/g)].map((m) => m[1]);
      expect(reasons.length).toBeGreaterThan(0);
      const core = readFileSync(new URL('../shared/core.js', import.meta.url), 'utf8');
      // reasons the WHOLE-note codec produces, goldened in their own suites in this file
      const elsewhere = new Set([]);
      const produced = new Set(REFUSALS.map(([, reason]) => reason));
      for (const reason of reasons) {
        expect(core.includes(`'${reason}'`), `reason declared but never emitted: ${reason}`).toBe(true);
        if (elsewhere.has(reason)) continue;
        expect(produced.has(reason), `no refusal golden for reason: ${reason}`).toBe(true);
      }
      // and the block half must not have quietly acquired a catalog reason
      const block = /export type VaultBlockQuarantineReason =([\s\S]*?);/.exec(types.replace(/\/\*[\s\S]*?\*\//g, ''));
      expect([...block[1].matchAll(/\|\s*'([a-z-]+)'/g)].some((m) => m[1].startsWith('catalog-'))).toBe(false);
    });
  });
});

// ## Verified red-green: 2026-07-26
// Task 2 (TASK-043): task templates, and the settings the note owns — plus the exclusion.
describe('catalog note — Task templates and Settings (SB-058 task 2)', () => {
  const TEMPLATES = [
    { id: 'checkout', label: 'Checkout flow', project: 'FJH-NETT' },
    { id: 'standup', label: 'Standup', project: null },
    { id: 'br-note', label: '- a label starting with a dash, mentioning <br>', project: 'INT-ADM' },
  ];
  const SETTINGS = [
    { key: 'currency', value: 'kr' },
    { key: 'language', value: 'en' },
    { key: 'vaultTimeSeparator', value: 'unicode' },
  ];

  describe('Task templates', () => {
    it('emits Template, Label and Project, and an unassigned template as an empty cell', () => {
      expect(region('tasks', TEMPLATES, 3).split('\n').slice(0, 6)).toEqual([
        '## Task templates',
        '',
        '| Template | Label | Project |',
        '|---|---|---|',
        '| checkout | Checkout flow | FJH-NETT |',
        '| standup | Standup | |',
      ]);
    });

    it('round-trips, including a label that would be structural in a daily-note Task cell', () => {
      const md = region('tasks', TEMPLATES, 3);
      const parsed = parse('tasks', md);
      expect(parsed.rows).toEqual(TEMPLATES);
      expect(region('tasks', parsed.rows, parsed.revision)).toBe(md);
    });

    it('does NOT import the daily block’s Task-cell machinery', () => {
      // `<br>` and the `- ` prefix are structural ONLY where a label and a note share one cell
      // (SB-045/DD-010). A template has no note, so neither is escaped here — importing that
      // codec by reflex would put a backslash in front of a legitimate label.
      const md = region('tasks', [TEMPLATES[2]]);
      expect(md).toContain('| br-note | - a label starting with a dash, mentioning <br> | INT-ADM |');
      expect(md).not.toContain('\\<br>');
      expect(md).not.toContain('\\- ');
    });

    it('a template naming a project that does not exist is CARRIED, not refused', () => {
      // Deliberately unlike a project's dangling clientId. A template is a stamp — logging an hour
      // COPIES its label and project onto the entry — and no resolver reads money through it, so a
      // stale template costs one bad autofill, where a dangling clientId costs a rate of 0.
      const parsed = parse('tasks', region('tasks', [{ id: 'x', label: 'Gone', project: 'DELETED-01' }]));
      expect(parsed.quarantine).toBe(false);
      expect(parsed.rows[0].project).toBe('DELETED-01');
    });
  });

  describe('Settings', () => {
    it('is a two-column key/value table', () => {
      expect(region('settings', SETTINGS, 3).split('\n').slice(0, 7)).toEqual([
        '## Settings',
        '',
        '| Setting | Value |',
        '|---|---|',
        '| currency | kr |',
        '| language | en |',
        '| vaultTimeSeparator | unicode |',
      ]);
    });

    it('round-trips, and projects only the keys this TT understands', () => {
      const md = region('settings', SETTINGS, 3);
      const parsed = parse('settings', md);
      expect(parsed.rows).toEqual(SETTINGS);
      expect(region('settings', parsed.rows, parsed.revision)).toBe(md);
      expect(TT.vaultCatalogSettings(parsed.rows)).toEqual({ currency: 'kr', language: 'en', vaultTimeSeparator: 'unicode' }); // prettier-ignore
    });

    it('an UNKNOWN key is carried verbatim and re-emitted — never applied, never quarantined', () => {
      // The deliberate opposite of the unknown-COLUMN rule: a row is extensible by construction,
      // and a key from a newer TT must survive a read-write cycle by an older one rather than
      // freezing the file that holds the rates.
      const rows = [...SETTINGS, { key: 'vaultColumns', value: 'Time,Project,Task' }];
      const parsed = parse('settings', region('settings', rows, 3));
      expect(parsed.quarantine).toBe(false);
      expect(parsed.rows).toEqual(rows);
      expect('vaultColumns' in TT.vaultCatalogSettings(parsed.rows)).toBe(false);
      // and it survives a full read-write cycle, in its original position relative to the rest
      expect(TT.vaultCatalogSettingRows(TT.vaultCatalogSettings(parsed.rows), parsed.rows)).toEqual(rows);
    });

    it('an unrecognised value for the enum key is DROPPED, exactly as putSettings drops it', () => {
      // `putSettings` writes `vaultTimeSeparator` only when it is in TT.TIME_SEPARATOR_VALUES and
      // silently ignores anything else. One rule, in both directions — and the ROW still survives,
      // so an older TT reading a newer TT's value never rewrites it away.
      const rows = [{ key: 'vaultTimeSeparator', value: 'emdash' }];
      const parsed = parse('settings', region('settings', rows, 3));
      expect(parsed.rows).toEqual(rows);
      expect(TT.vaultCatalogSettings(parsed.rows)).toEqual({});
      expect(TT.vaultCatalogSettingRows({}, parsed.rows)).toEqual([]);
    });

    it('every legal vaultTimeSeparator value is accepted, from the one home of that vocabulary', () => {
      for (const value of TT.TIME_SEPARATOR_VALUES)
        expect(TT.vaultCatalogSettings([{ key: 'vaultTimeSeparator', value }])).toEqual({ vaultTimeSeparator: value });
      expect(TT.TIME_SEPARATOR_VALUES.length).toBeGreaterThan(1);
    });

    it('an unset key emits no row at all, rather than an empty one', () => {
      expect(TT.vaultCatalogSettingRows({ currency: 'kr' })).toEqual([{ key: 'currency', value: 'kr' }]);
      expect(TT.vaultCatalogSettingRows({ currency: 'kr', language: '' })).toEqual([{ key: 'currency', value: 'kr' }]);
    });

    it('a `|` in a setting value is escaped and comes back intact', () => {
      const md = region('settings', [{ key: 'currency', value: 'a|b' }]);
      expect(md).toContain('| currency | a\\|b |');
      expect(parse('settings', md).rows[0].value).toBe('a|b');
    });

    it('two rows with the same key quarantine — the id rule holds for settings too', () => {
      const res = TT.parseVaultCatalogSection(
        noteWith(sign(region('settings', [{ key: 'currency', value: 'kr' }, { key: 'currency', value: 'NOK' }]))), // prettier-ignore
        'settings',
      );
      expect(res.quarantine).toBe(true);
      expect(res.reason).toBe('catalog-duplicate-id');
    });
  });

  // ---- the exclusion, which is a correctness rule and not a preference ----
  describe('the settings the note must NEVER carry', () => {
    // Written out here rather than read from core.js on purpose: a list shared with the
    // implementation would let both go wrong together, and this assertion is only worth anything
    // if it is stated independently.
    //
    // `backend` is `shape`'s pre-SB-100 spelling and is on the list for the same reason SB-100's
    // rename window needs it: a note written before the rename must not be able to smuggle it in
    // either, and asserting on both spellings is what stops this test going quietly green.
    const FORBIDDEN = ['shape', 'backend', 'vaultPaths', 'mdDir', 'vaultCutover'];

    it('none of them is a key the note owns', () => {
      for (const key of FORBIDDEN) expect(TT.VAULT_CATALOG_SETTING_KEYS).not.toContain(key);
      // the allowlist is exactly the three the note DOES own
      expect(TT.VAULT_CATALOG_SETTING_KEYS).toEqual(['currency', 'language', 'vaultTimeSeparator']);
    });

    it('none of them can reach the note’s bytes, however it is passed in', () => {
      // The bootstrap loop, stated as bytes: `shape`, `vaultPaths` and `mdDir` are how TT FINDS
      // this note, and `vaultCutover` is per-instance by DD-017 — "the date THIS instance's vault
      // history begins". All four stay in SQLite under BOTH shapes.
      const settings = {
        currency: 'kr',
        language: 'en',
        shape: 'personal',
        backend: 'vault',
        mdDir: '/Users/x/Inbox',
        vaultCutover: '2026-07-26T00:00:00.000Z',
        vaultPaths: { root: '/Users/x/Vault', daily: 'Calendar/Daily', catalog: 'Time Turtle/Catalog.md' },
      };
      const rows = TT.vaultCatalogSettingRows(settings);
      expect(rows).toEqual([
        { key: 'currency', value: 'kr' },
        { key: 'language', value: 'en' },
      ]);
      const md = region('settings', rows, 1);
      for (const key of FORBIDDEN) expect(md).not.toContain(key);
      for (const value of ['personal', 'vault', '/Users/x/Inbox', '2026-07-26', 'Calendar/Daily'])
        expect(md).not.toContain(value);
    });

    it('one of them arriving as a CARRIED unknown row is not laundered into settings', () => {
      // The other direction: a hand-edited note that names an instance-local key. The row is
      // carried verbatim like any unknown row — TT does not rewrite Terje's bytes — but it must
      // never be projected into a Settings object, which is where it would take effect.
      const rows = [{ key: 'shape', value: 'personal' }, { key: 'vaultPaths', value: '{}' }]; // prettier-ignore
      const parsed = parse('settings', region('settings', rows, 1));
      expect(parsed.rows).toEqual(rows);
      expect(TT.vaultCatalogSettings(parsed.rows)).toEqual({});
    });
  });
});
