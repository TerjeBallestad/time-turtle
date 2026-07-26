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
