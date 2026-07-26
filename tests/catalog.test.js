// The catalog note codec — `Time Turtle/Catalog.md` (SB-058, PLAN-011).
//
// Four independently-anchored sections, each the SAME shape as a daily-note block, so
// TT.locateVaultBlock parses them with no change at all. Nothing here reads or writes a file:
// every function under test takes a string and returns a string or a model. Finding, opening and
// safely replacing the real note is SB-057's.
//
// What a green run here does NOT prove, stated once so a green suite is never reported as "the
// catalog works": no file is ever opened, no arbitration between two machines is exercised, and
// byte equality is structurally blind to a severed reference — which is what the task 4 suite
// (`a severed reference`) is for.
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

    it('an EMPTY table (header row only) serializes and parses for both money tables', () => {
      // On TASK-042's golden list and missed first time round. A catalog with no clients yet is
      // the first-boot state, so it has to be expressible — and the locator has to accept a table
      // whose only rows are the header and the delimiter.
      for (const section of ['clients', 'projects']) {
        const md = region(section, [], 2);
        expect(md.split('\n')).toHaveLength(6); // heading, blank, header, delimiter, blank, anchor
        const parsed = parse(section, md);
        expect(parsed.quarantine).toBe(false);
        expect(parsed.rows).toEqual([]);
        expect(region(section, parsed.rows, parsed.revision)).toBe(md);
      }
    });

    it('a `|` in a PROJECT name is escaped and comes back intact', () => {
      // The client-name case was covered; the project one was not, and it is the table where a
      // split row would take a rate with it.
      const md = region('projects', [{ ...DRIFT, name: 'Drift | support \\ 2026' }]);
      expect(md).toContain('| Drift \\| support \\\\ 2026 |');
      const parsed = parse('projects', md);
      expect(parsed.rows[0].name).toBe('Drift | support \\ 2026');
      expect(parsed.rows[0].rate).toBe(1400); // the cell after it did not shift
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

    it('an unknown section name is REFUSED, not thrown (SB-124)', () => {
      // The untrusted-input direction the TypeScript union does not defend. `server/src/` is plain
      // JS and SB-057's sync engine feeds this function names taken off real notes, so the name
      // arrives as whatever a human typed — and a throw there is a crash on the boot scan instead
      // of a quarantine a human can read. Called from JS with a name derived from a PARSED note
      // rather than a literal, which is the shape that actually reaches it.
      const note = noteWith(region('clients', [FJELLHEIM]));
      const parsed = TT.parseVaultCatalogSection(note, 'clients');
      expect(parsed.quarantine).toBe(false);
      // A section key derived from the NOTE — the heading as written — rather than typed as a
      // literal. `Clients` is not `clients`, and a caller reading section names off a note has no
      // reason to know that. Before SB-124 this reached `spec.heading` on `undefined` and threw.
      const fromTheNote = parsed.heading;
      expect(fromTheNote).toBe('Clients');
      const res = TT.parseVaultCatalogSection(note, fromTheNote);
      expect(res.quarantine).toBe(true);
      expect(res.reason).toBe('catalog-unknown-section');
      expect(res.section).toBe(fromTheNote); // it names what it could not resolve
      // a few more shapes an untrusted name really takes, none of which may throw
      for (const bad of ['', 'Projects', 'entries', 'tidslogg', '__proto__'])
        expect(TT.parseVaultCatalogSection(note, bad).reason).toBe('catalog-unknown-section');
      // and the four valid sections are the control — the refusal must not have widened
      for (const section of ['clients', 'projects', 'tasks', 'settings'])
        expect(TT.parseVaultCatalogSection(noteWith(region(section, [])), section).quarantine).toBe(false);
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
      // Pinned, like the block guard it mirrors: `toBeGreaterThan(0)` would let coverage shrink
      // silently if the scrape ever under-matched.
      expect(reasons.length).toBe(7);
      const core = readFileSync(new URL('../shared/core.js', import.meta.url), 'utf8');
      // A golden is either a row of the section-level table above or an assertion anywhere else
      // in this file — the whole-note reasons (a revision disagreement, a dangling client) can
      // only be produced by a note with four sections, so they are goldened in the task 3 and 4
      // suites below rather than here.
      const self = readFileSync(new URL('./catalog.test.js', import.meta.url), 'utf8');
      const produced = new Set(REFUSALS.map(([, reason]) => reason));
      for (const reason of reasons) {
        expect(core.includes(`'${reason}'`), `reason declared but never emitted: ${reason}`).toBe(true);
        const goldened = produced.has(reason) || self.includes(`toBe('${reason}')`);
        expect(goldened, `no refusal golden for reason: ${reason}`).toBe(true);
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

    it('none of them survives TT.vaultCatalogSettingRows — the one place rows are built', () => {
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

    it('…and the guarantee stops there — going around that function DOES reach the bytes', () => {
      // The honest limit of the rule, pinned so nobody reads the exclusion as a byte-boundary
      // filter. `serializeVaultCatalog` emits the ROWS it is handed, and it must: the unknown-row
      // rule requires a key from a newer TT to survive a read-write cycle untouched, and a filter
      // at the byte boundary cannot tell that key from a forbidden one.
      //
      // So this is a rule about ONE FUNCTION, and this test is what stops the comment beside it
      // from drifting back into claiming more. The end-gate review caught exactly that overclaim.
      const handRolled = [{ key: 'vaultPaths', value: '{"root":"/Users/x/Vault"}' }];
      expect(region('settings', handRolled, 1)).toContain('| vaultPaths |');

      // What is guaranteed in BOTH directions is that such a row is never APPLIED — it stays
      // bytes, and never becomes a Settings value TT acts on.
      expect(TT.vaultCatalogSettings(handRolled)).toEqual({});
      expect(TT.vaultCatalogSettingRows(TT.vaultCatalogSettings(handRolled))).toEqual([]);
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

// ## Verified red-green: 2026-07-26
// Task 3 (TASK-044): the whole note — assemble, splice, and refuse as one unit.
describe('catalog note — the whole note (SB-058 task 3)', () => {
  const CATALOG = {
    clients: [FJELLHEIM, BRYGGA],
    projects: [NETT, DRIFT, ADMIN],
    tasks: [{ id: 'checkout', label: 'Checkout flow', project: 'FJH-NETT' }],
    settings: [
      { key: 'currency', value: 'kr' },
      { key: 'language', value: 'en' },
      { key: 'vaultTimeSeparator', value: 'unicode' },
    ],
    revision: 3,
  };
  const NOTE = TT.serializeVaultCatalog(CATALOG);

  describe('assemble', () => {
    it('emits four sections in order under one H1, and nothing else', () => {
      expect(NOTE.split('\n').filter((line) => line.startsWith('#'))).toEqual([
        '# Time Turtle',
        '## Clients',
        '## Projects',
        '## Task templates',
        '## Settings',
      ]);
      expect(NOTE.endsWith('\n')).toBe(true);
    });

    it('writes the SAME N into every section — one catalog-wide counter (SB-104)', () => {
      const anchors = NOTE.split('\n').filter((line) => line.startsWith('`revision:'));
      expect(anchors).toHaveLength(4);
      expect(anchors.every((line) => line.startsWith('`revision: 3 · '))).toBe(true);
      // …and four DIFFERENT digests, because DD-009's digest is per block. One file-level anchor
      // over four tables would leave the Projects table undetectably mergeable.
      expect(new Set(anchors).size).toBe(4);
    });

    it('round-trips both ways', () => {
      const parsed = TT.parseVaultCatalog(NOTE);
      expect(parsed.quarantine).toBe(false);
      expect(parsed.revision).toBe(3);
      expect(parsed.verified).toBe(true);
      expect(parsed.clients).toEqual(CATALOG.clients);
      expect(parsed.projects).toEqual(CATALOG.projects);
      expect(parsed.tasks).toEqual(CATALOG.tasks);
      expect(parsed.settings).toEqual(CATALOG.settings);
      expect(TT.serializeVaultCatalog(parsed)).toBe(NOTE);
      expect(TT.writeVaultCatalog(NOTE, CATALOG).md).toBe(NOTE);
    });
  });

  describe('splice — everything outside the four regions is Terje’s', () => {
    // Sections in a DIFFERENT order from the canonical one, with prose above, between and below,
    // plus a heading of his own. The same guarantee writeVaultBlock gives a daily note.
    const HAND = [
      '# Time Turtle',
      '',
      'Rates renegotiated with Fjellheim in March. Do not touch the archive project.',
      '',
      TT.serializeVaultCatalogSection('settings', CATALOG.settings, { revision: 3 }),
      '',
      '## Notes to self',
      '',
      'Brygga pays on 30 days, everyone else on 14.',
      '',
      TT.serializeVaultCatalogSection('clients', CATALOG.clients, { revision: 3 }),
      '',
      TT.serializeVaultCatalogSection('tasks', CATALOG.tasks, { revision: 3 }),
      '',
      TT.serializeVaultCatalogSection('projects', CATALOG.projects, { revision: 3 }),
      '',
      '## Archive',
      '',
      'Old rates live in Time Turtle/2025.md.',
      '',
    ].join('\n');

    it('parses a note whose sections are in the author’s order, not TT’s', () => {
      const parsed = TT.parseVaultCatalog(HAND);
      expect(parsed.quarantine).toBe(false);
      expect(parsed.clients).toEqual(CATALOG.clients);
      expect(parsed.projects).toEqual(CATALOG.projects);
    });

    it('a write keeps every byte outside the four regions, and each section where it was', () => {
      const bumped = { ...CATALOG, clients: [{ ...FJELLHEIM, rate: 1400 }, BRYGGA] };
      const res = TT.writeVaultCatalog(HAND, bumped);
      expect(res.quarantine).toBe(false);
      for (const line of [
        '# Time Turtle',
        'Rates renegotiated with Fjellheim in March. Do not touch the archive project.',
        '## Notes to self',
        'Brygga pays on 30 days, everyone else on 14.',
        '## Archive',
        'Old rates live in Time Turtle/2025.md.',
      ])
        // prettier-ignore
        expect(res.md).toContain(line);
      // the author's section order survives the write
      expect(res.md.split('\n').filter((line) => line.startsWith('## '))).toEqual([
        '## Settings',
        '## Notes to self',
        '## Clients',
        '## Task templates',
        '## Projects',
        '## Archive',
      ]);
      expect(res.md).toContain('| fjellheim | Fjellheim AS | 1400 | 15 |');
      // and only the one line changed
      const before = HAND.split('\n');
      const after = res.md.split('\n');
      expect(after.length).toBe(before.length);
      expect(after.filter((line, i) => line !== before[i]).length).toBe(2); // the row, and its anchor
    });

    it('a section that GAINS or LOSES rows leaves every other section intact', () => {
      // The case that makes splice ORDER load-bearing: rewriting a section with a different row
      // count moves every line below it. Splicing top-down would leave the later sections'
      // offsets stale and eat the wrong lines — and no fixture whose sections keep their row
      // count can tell the two orders apart.
      const NORD = { id: 'nord', name: 'Nord Bygg', rate: 800, rounding: 30, archived: false };
      const changed = { ...CATALOG, clients: [...CATALOG.clients, NORD], tasks: [] };
      for (const before of [NOTE, HAND]) {
        const res = TT.writeVaultCatalog(before, changed);
        expect(res.quarantine).toBe(false);
        const reparsed = TT.parseVaultCatalog(res.md);
        expect(reparsed.quarantine).toBe(false);
        expect(reparsed.clients).toEqual(changed.clients);
        expect(reparsed.projects).toEqual(changed.projects);
        expect(reparsed.tasks).toEqual([]);
        expect(reparsed.settings).toEqual(changed.settings);
        // and the prose still bounds the sections it bounded before
        for (const line of before.split('\n').filter((l) => l && !l.startsWith('|') && !l.startsWith('`')))
          expect(res.md).toContain(line);
      }
    });

    it('a PARTIAL catalog leaves the sections it does not mention alone', () => {
      // The atomicity rule arriving through the write direction, and a real defect the end-gate
      // review caught: with `|| []` instead of `??`, `writeVaultCatalog(note, { clients })` — the
      // call a `Partial<VaultCatalog>` signature invites — reported `quarantine: false` and
      // returned a note whose other three tables had been EMPTIED. The output gate cannot see it,
      // because a header-only table parses perfectly well.
      const res = TT.writeVaultCatalog(NOTE, { clients: [{ ...FJELLHEIM, rate: 1500 }, BRYGGA] });
      expect(res.quarantine).toBe(false);
      const reparsed = TT.parseVaultCatalog(res.md);
      expect(reparsed.clients[0].rate).toBe(1500); // the section that WAS mentioned changed
      expect(reparsed.projects).toEqual(CATALOG.projects); // the ones that were not, did not
      expect(reparsed.tasks).toEqual(CATALOG.tasks);
      expect(reparsed.settings).toEqual(CATALOG.settings);
    });

    it('…while an EXPLICIT empty list still empties that section', () => {
      // `[]` and "absent" must stay distinguishable, or clearing a section becomes impossible.
      const res = TT.writeVaultCatalog(NOTE, { ...CATALOG, tasks: [] });
      const reparsed = TT.parseVaultCatalog(res.md);
      expect(reparsed.tasks).toEqual([]);
      expect(reparsed.clients).toEqual(CATALOG.clients);
    });

    it('the revision is not bumped by a write — that is SB-057’s arbitration', () => {
      expect(TT.parseVaultCatalog(TT.writeVaultCatalog(NOTE, CATALOG).md).revision).toBe(3);
      const set = TT.writeVaultCatalog(NOTE, CATALOG, { revision: 9 });
      const reparsed = TT.parseVaultCatalog(set.md);
      expect(reparsed.revision).toBe(9);
      expect(set.md.split('\n').filter((line) => line.startsWith('`revision: 9 · '))).toHaveLength(4);
    });
  });

  describe('refuse as one unit', () => {
    /** Damage exactly one section of an otherwise perfect note. */
    const damage = (section, from, to) => {
      const bad = sign(edit(TT.serializeVaultCatalogSection(section, CATALOG[section], { revision: 3 }), from, to));
      return NOTE.replace(TT.serializeVaultCatalogSection(section, CATALOG[section], { revision: 3 }), bad);
    };

    const CASES = [
      ['clients', 'catalog-bad-number', damage('clients', '| 1250 |', '| 1,250 |')],
      ['projects', 'catalog-bad-flag-cell', damage('projects', '| ✓ | [[Nettbutikk rebuild]] |', '| y | [[Nettbutikk rebuild]] |')], // prettier-ignore
      ['tasks', 'unknown-header', damage('tasks', '| Template | Label | Project |', '| Template | Label | Client |')], // prettier-ignore
      ['settings', 'catalog-duplicate-id', damage('settings', '| language | en |', '| currency | en |')],
    ];

    for (const [section, reason, md] of CASES) {
      it(`one damaged section (${section}: ${reason}) quarantines the WHOLE note`, () => {
        const parsed = TT.parseVaultCatalog(md);
        expect(parsed.quarantine).toBe(true);
        expect(parsed.reason).toBe(reason);
        expect(parsed.section).toBe(section);
        // …and NO section is written. A catalog that kept its projects and lost its clients
        // resolves every rate to 0 with no error anywhere: refused beats partial.
        const res = TT.writeVaultCatalog(md, CATALOG);
        expect(res.quarantine).toBe(true);
        expect(res.reason).toBe(reason);
        expect(res.section).toBe(section);
        expect(res.md).toBe(md); // not one byte
      });
    }

    it('a partial catalog never escapes the parse — the three healthy sections come back with nothing', () => {
      const parsed = TT.parseVaultCatalog(CASES[0][2]);
      expect(parsed.quarantine).toBe(true);
      for (const key of ['clients', 'projects', 'tasks', 'settings']) expect(key in parsed).toBe(false);
    });

    it('sections disagreeing on N quarantine — never reconciled to the max (SB-104)', () => {
      const mixed = NOTE.replace(
        TT.serializeVaultCatalogSection('projects', CATALOG.projects, { revision: 3 }),
        TT.serializeVaultCatalogSection('projects', CATALOG.projects, { revision: 4 }),
      );
      const parsed = TT.parseVaultCatalog(mixed);
      expect(parsed.quarantine).toBe(true);
      expect(parsed.reason).toBe('catalog-revision-mismatch');
      expect(parsed.section).toBe(null); // a fact about the note, not about one section
      expect(TT.writeVaultCatalog(mixed, CATALOG).md).toBe(mixed);
    });

    it('a project naming a client the Clients table does not hold quarantines', () => {
      const orphan = { ...CATALOG, projects: [...CATALOG.projects, { code: 'GONE-01', name: 'Orphan', clientId: 'vanished', rate: null, billable: true, archived: false }] }; // prettier-ignore
      const parsed = TT.parseVaultCatalog(TT.serializeVaultCatalog(orphan));
      expect(parsed.quarantine).toBe(true);
      expect(parsed.reason).toBe('catalog-dangling-client');
      expect(parsed.section).toBe('projects');
    });

    it('a MISSING section is reported, never adopted — DD-012 stops at the daily note', () => {
      // The catalog is a file TT owns end to end, and a `## Clients` heading in some unrelated
      // note is not an invitation. Whether to CREATE the note is SB-057's write decision.
      const noAnchor = ['# Time Turtle', '', '## Clients', '', '| Client | Name |', '|---|---|', '| brygga | Brygga Digital |', ''].join('\n'); // prettier-ignore
      const parsed = TT.parseVaultCatalog(noAnchor);
      expect(parsed.quarantine).toBe(true);
      expect(parsed.reason).toBe('no-revision');
      expect(parsed.section).toBe('clients');
      const res = TT.writeVaultCatalog(noAnchor, CATALOG);
      expect(res.md).toBe(noAnchor); // nothing inserted, no anchor synthesised
      expect(res.md).not.toContain('`revision:');
    });

    it('a section absent altogether is `no-heading` for that section', () => {
      const withoutTasks = NOTE.replace(TT.serializeVaultCatalogSection('tasks', CATALOG.tasks, { revision: 3 }) + '\n\n', ''); // prettier-ignore
      const parsed = TT.parseVaultCatalog(withoutTasks);
      expect(parsed.quarantine).toBe(true);
      expect(parsed.reason).toBe('no-heading');
      expect(parsed.section).toBe('tasks');
    });

    it('the OUTPUT is gated too — bytes TT could not read back are refused, not written', () => {
      // TT.encodeCell escapes `\` and `|`; it does not escape a NEWLINE, so a name carrying one
      // would split its own row and produce a note TT's own parser refuses — a note frozen
      // against TT until a human repaired it, reported as a successful write.
      const res = TT.writeVaultCatalog(NOTE, { ...CATALOG, clients: [{ ...FJELLHEIM, name: 'Fjell\nheim' }, BRYGGA] });
      expect(res.quarantine).toBe(true);
      expect(res.reason).toBe('write-would-corrupt');
      expect(res.md).toBe(NOTE);
      // and it names WHICH table it could not read back — "TT could not read back what it wrote"
      // is not something a human can act on without that
      expect(res.section).toBe('clients');
    });

    it('a caller’s own dangling clientId is caught by the output gate, and the section is named', () => {
      // The input note is fine; the CATALOG being written is not. It cannot land as
      // `catalog-dangling-client` (that is a verdict about a note TT read), so it arrives as
      // `write-would-corrupt` — which is why carrying the section matters here.
      const orphan = { ...CATALOG, projects: [{ ...NETT, clientId: 'vanished' }] };
      const res = TT.writeVaultCatalog(NOTE, orphan);
      expect(res.quarantine).toBe(true);
      expect(res.reason).toBe('write-would-corrupt');
      expect(res.section).toBe('projects');
      expect(res.md).toBe(NOTE);
    });

    it('a note TT cannot read is never written to, whatever the caller wants written', () => {
      // Including "write the fix over it": resolving a quarantine is a human decision surfaced by
      // SB-057, never something a write silently performs.
      const res = TT.writeVaultCatalog(CASES[0][2], CATALOG);
      expect(res.md).toBe(CASES[0][2]);
      expect(res.md).toContain('| 1,250 |');
    });
  });
});

// ## Verified red-green: 2026-07-26
// Task 4 (TASK-045): the goldens byte-equality cannot see — money resolves the same through a
// parsed catalog.
//
// SB-048 taught this the expensive way and PLAN-009 carried the warning forward:
// `serializeMd(parseMd(md)) === md` passed byte-exact while `commitSnapshot(entry)` returned null,
// because ids never appear in the bytes. A BYTE-EQUALITY GOLDEN CANNOT SEE A SEVERED SEMANTIC
// LINK. The catalog's version of that failure is a note whose every `Project.clientId` names a
// client the Clients table does not contain: the bytes round-trip perfectly, and `TT.rateOf`
// quietly returns 0 for every project. On this file that is invoiced money, not a test failure.
//
// So these assert on RESOLVED REFERENCES, not on bytes.
describe('catalog note — money resolves the same through a parsed catalog (SB-058 task 4)', () => {
  // A realistic graph, built so every inheritance case that makes a REFERENCE worth having is in
  // it: an inherited rate and an overridden one, `round 15` and `round exact`, a non-billable
  // project, a client with no rate at all, and an archived project that must keep resolving.
  const CLIENTS = [
    { id: 'fjellheim', name: 'Fjellheim AS', rate: 1250, rounding: 15, archived: false },
    { id: 'brygga', name: 'Brygga Digital', rate: 990, rounding: 'exact', archived: false },
    { id: 'nord', name: 'Nord Bygg', rate: null, rounding: 30, archived: true },
  ];
  const PROJECTS = [
    { code: 'FJH-NETT', name: 'Nettbutikk rebuild', clientId: 'fjellheim', rate: null, billable: true, archived: false, vaultNote: 'Nettbutikk rebuild' }, // prettier-ignore
    { code: 'FJH-DRIFT', name: 'Drift & support', clientId: 'fjellheim', rate: 1400, billable: true, archived: false },
    { code: 'BRY-APP', name: 'Bryggeappen', clientId: 'brygga', rate: null, billable: true, archived: false },
    { code: 'INT-ADM', name: 'Internal admin', clientId: null, rate: null, billable: false, archived: false },
    { code: 'ARK-01', name: 'Arkiv 2025', clientId: 'nord', rate: 750, billable: true, archived: true },
  ];
  const CATALOG = {
    clients: CLIENTS,
    projects: PROJECTS,
    tasks: [{ id: 'checkout', label: 'Checkout flow', project: 'FJH-NETT' }],
    settings: [{ key: 'currency', value: 'kr' }],
    revision: 5,
  };
  const ENTRIES = [
    { id: 'e1', date: '2026-03-02', start: 540, end: 577, durMin: null, project: 'FJH-NETT', label: 'Checkout', note: '', billable: true }, // prettier-ignore
    { id: 'e2', date: '2026-03-02', start: 600, end: 637, durMin: null, project: 'BRY-APP', label: 'Bugfix', note: '', billable: true }, // prettier-ignore
    { id: 'e3', date: '2026-03-02', start: 700, end: 760, durMin: null, project: 'FJH-DRIFT', label: 'Support', note: '', billable: true }, // prettier-ignore
    { id: 'e4', date: '2026-03-02', start: 800, end: 860, durMin: null, project: 'INT-ADM', label: 'Admin', note: '', billable: false }, // prettier-ignore
    { id: 'e5', date: '2026-03-02', start: 900, end: 941, durMin: null, project: 'ARK-01', label: 'Archive', note: '', billable: true }, // prettier-ignore
  ];
  /** The resolvers read a Catalog; this is the smallest honest one a parsed note can furnish. */
  const state = (catalog) => ({ settings: {}, clients: catalog.clients, projects: catalog.projects, tasks: catalog.tasks, entries: ENTRIES, commits: [] }); // prettier-ignore
  /** Every money answer the catalog is responsible for, as one comparable object. */
  const resolved = (catalog) => {
    const s = state(catalog);
    return {
      rates: PROJECTS.map((project) => TT.rateOf(s, project.code)),
      clients: PROJECTS.map((project) => (TT.clientOf(s, TT.projectOf(s, project.code)) || {}).id ?? null),
      billable: PROJECTS.map((project) => TT.projectBillable(s, project.code)),
      rounded: PROJECTS.map((project) => TT.roundBill(37, (TT.clientOf(s, TT.projectOf(s, project.code)) || { rounding: 0 }).rounding)), // prettier-ignore
      billMinutes: ENTRIES.map((entry) => TT.billMinutes(s, entry)),
      amounts: ENTRIES.map((entry) => TT.amount(s, entry)),
    };
  };

  const NOTE = TT.serializeVaultCatalog(CATALOG);
  const PARSED = TT.parseVaultCatalog(NOTE);

  it('the note parses at all — everything below is meaningless otherwise', () => {
    expect(PARSED.quarantine).toBe(false);
    expect(PARSED.verified).toBe(true);
  });

  it('every resolver returns identical values in memory and through the note', () => {
    expect(resolved(PARSED)).toEqual(resolved(CATALOG));
  });

  it('…and those values are the right ones, pinned rather than merely equal to each other', () => {
    // Equality alone would pass if the resolvers were broken in the same way on both sides. These
    // are the numbers an invoice is made of, so they are written down.
    const money = resolved(CATALOG);
    // inherited 1250, overridden 1400, inherited 990, no client at all, archived client with no
    // rate but a project override
    expect(money.rates).toEqual([1250, 1400, 990, 0, 750]);
    expect(money.clients).toEqual(['fjellheim', 'fjellheim', 'brygga', null, 'nord']);
    expect(money.billable).toEqual([true, true, true, false, true]);
    // `round 15` takes 37 minutes to 45, `exact` leaves it, no client leaves it, `round 30` → 60
    expect(money.rounded).toEqual([45, 45, 37, 37, 60]);
    // e1 37min @ round 15 → 45min @ 1250 = 937.5 · e2 37min exact @ 990 = 610.5
    // e3 60min @ round 15 @ 1400 = 1400 · e4 not billable = 0 · e5 41min @ round 30 → 60 @ 750
    expect(money.billMinutes).toEqual([45, 37, 60, 0, 60]);
    expect(money.amounts).toEqual([937.5, 610.5, 1400, 0, 750]);
  });

  it('an ARCHIVED client and project keep resolving for history (SDD-002 ruling 7)', () => {
    const s = state(PARSED);
    expect(TT.projectOf(s, 'ARK-01').archived).toBe(true);
    expect(TT.clientOf(s, TT.projectOf(s, 'ARK-01')).archived).toBe(true);
    expect(TT.rateOf(s, 'ARK-01')).toBe(750);
    expect(TT.amount(s, ENTRIES[4])).toBe(750);
  });

  // ---- the failure byte-equality is structurally blind to ----
  describe('a severed reference', () => {
    // Every clientId renamed. Nothing else changes: the ids are still well-formed, every cell
    // still parses, every section still verifies, and the file still LOOKS right.
    const SEVERED = { ...CATALOG, projects: PROJECTS.map((project) => ({ ...project, clientId: project.clientId ? project.clientId + '-2025' : null })) }; // prettier-ignore
    const SEVERED_NOTE = TT.serializeVaultCatalog(SEVERED);

    it('round-trips BYTE-EXACT through the section codec, and every section verifies', () => {
      // This is the assertion that would have passed while the money was gone. It is written out
      // deliberately, so the next reader can see exactly what a byte golden proves here: nothing.
      for (const section of ['clients', 'projects', 'tasks', 'settings']) {
        const parsed = TT.parseVaultCatalogSection(SEVERED_NOTE, section);
        expect(parsed.quarantine).toBe(false);
        expect(parsed.verified).toBe(true);
        expect(region(section, parsed.rows, parsed.revision)).toBe(region(section, SEVERED[section], 5));
      }
    });

    it('and this is what it would have cost — every rate resolves to 0', () => {
      // The severed model, resolved. Not hypothetical: this is the object the section codec alone
      // would hand back, and `rateOf` returns 0 for every project whose client vanished.
      const severed = {
        clients: TT.parseVaultCatalogSection(SEVERED_NOTE, 'clients').rows,
        projects: TT.parseVaultCatalogSection(SEVERED_NOTE, 'projects').rows,
        tasks: [],
      };
      const s = state(severed);
      expect(TT.rateOf(s, 'FJH-NETT')).toBe(0); // was 1250 — the inherited rate is simply gone
      expect(TT.rateOf(s, 'BRY-APP')).toBe(0); // was 990
      expect(TT.clientOf(s, TT.projectOf(s, 'FJH-NETT'))).toBe(null);
      expect(TT.amount(s, ENTRIES[0])).toBe(0); // an invoice line for free work
      // FJH-DRIFT keeps its OWN rate, which is what makes this so quiet: some projects still
      // look right, so a spot check passes and only the client-inheriting ones bill zero
      expect(TT.rateOf(s, 'FJH-DRIFT')).toBe(1400);
    });

    it('so the whole-note parse REFUSES it — a decision, not a fall-through', () => {
      const parsed = TT.parseVaultCatalog(SEVERED_NOTE);
      expect(parsed.quarantine).toBe(true);
      expect(parsed.reason).toBe('catalog-dangling-client');
      expect(parsed.section).toBe('projects');
      // and no catalog escapes for anything to resolve against
      expect('projects' in parsed).toBe(false);
      // nor can a write proceed over it
      expect(TT.writeVaultCatalog(SEVERED_NOTE, CATALOG).md).toBe(SEVERED_NOTE);
    });

    it('a project with NO client is not a dangling one — absent and severed are different facts', () => {
      // INT-ADM has `clientId: null` and always did. Refusing it would make "no client" impossible
      // to express, and it resolves to 0 legitimately rather than silently.
      expect(TT.parseVaultCatalog(NOTE).quarantine).toBe(false);
      expect(TT.rateOf(state(PARSED), 'INT-ADM')).toBe(0);
      expect(TT.projectOf(state(PARSED), 'INT-ADM').clientId).toBe(null);
    });
  });

  // ---- the never-zero rule, end to end ----
  describe('a damaged rate cannot produce a catalog at all, let alone one that reads 0', () => {
    for (const bad of ['1,250', '1250 kr', '-50', 'tbd', '12.50.00', '1 250'])
      it(`a Rate cell reading ${bad} quarantines the whole note`, () => {
        const damaged = NOTE.replace(
          region('clients', CLIENTS, 5),
          sign(edit(region('clients', CLIENTS, 5), '| 1250 |', `| ${bad} |`)),
        );
        const parsed = TT.parseVaultCatalog(damaged);
        expect(parsed.quarantine).toBe(true);
        expect(parsed.reason).toBe('catalog-bad-number');
        // asserted on the ABSENCE of a degraded result, not only on the presence of a verdict:
        // there must be no object here at all for a resolver to read a 0 out of
        expect('clients' in parsed).toBe(false);
        expect('projects' in parsed).toBe(false);
        // and the note is not written over, so the damaged cell stays visible to a human
        expect(TT.writeVaultCatalog(damaged, CATALOG).md).toBe(damaged);
      });

    it('there is no route from a damaged rate to a resolved rate of 0', () => {
      // The whole class, stated once: for every damaged rate cell, either the parse refuses FOR
      // THE RIGHT REASON, or every rate it produces is one a human wrote. Nothing in between.
      //
      // The reason has to be asserted inside the refusing branch, not skipped past. Written as a
      // bare `if (quarantine) continue` this test executed ZERO expects — every value quarantines,
      // so the body never ran and the four cases that exist only here (`NaN`, `Infinity`, `1e3`,
      // `0x10`) were unproven. It would also have stayed green if `sign()` broke and every fixture
      // degraded to `digest-mismatch`. Caught by the end-gate review, and it is the exact failure
      // this file's own honesty rules are about: green for a reason that is not the requirement.
      const BAD = ['1,250', '1250 kr', '-50', 'tbd', 'NaN', 'Infinity', '1e3', '0x10'];
      let refused = 0;
      for (const bad of BAD) {
        const damaged = NOTE.replace(
          region('clients', CLIENTS, 5),
          sign(edit(region('clients', CLIENTS, 5), '| 1250 |', `| ${bad} |`)),
        );
        const parsed = TT.parseVaultCatalog(damaged);
        if (parsed.quarantine) {
          expect(parsed.reason, `wrong refusal for ${bad}`).toBe('catalog-bad-number');
          refused++;
          continue;
        }
        for (const client of parsed.clients) expect(client.rate === null || client.rate > 0).toBe(true);
        expect(parsed.clients.find((client) => client.id === 'fjellheim').rate).not.toBe(0);
      }
      // …and the loop actually ran. Without this a future `BAD = []` would pass silently.
      expect(refused).toBe(BAD.length);
    });
  });
});
