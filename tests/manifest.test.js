// The instance manifest codec — `Time Turtle.md` (SDD-003, PLAN-008 task 2).
//
// The manifest is a FORMAT-2 DOCUMENT and nothing new: `TT.serializeMd` writes its body and
// `TT.parseMd` reads it back. What this codec adds is a header extension (`cutover`,
// `timeLogHeading`, `timeSeparator`), a title line, verbatim carriage of header lines TT does not
// know, and ONE trailing `revision: N · digest` line under the daily block's own trust discipline.
//
// Nothing here opens a file. Every function under test takes a string and returns a string or a
// model; resolving `vaultPaths.catalog`, reading it and writing it back is PLAN-008 task 3.
//
// What a green run here does NOT prove, stated once so a green suite is never reported as "the
// manifest works": no file is ever read or written, no boot ladder runs, and no server has ever
// seen these bytes.
//
// ## Verified red-green: 2026-07-28
import { describe, it, expect } from 'vitest';
import TT, { VAULT_MANIFEST_QUARANTINE_REASONS } from '../shared/core.js';

// ---- helpers ----

/** The catalog a manifest carries in these fixtures — small, but every optional token exercised. */
const CATALOG = () => ({
  settings: { currency: 'kr', language: 'nb' },
  clients: [
    { id: 'fjellheim', name: 'Fjellheim AS', rounding: 15, rate: 1250, archived: false },
    { id: 'brygga', name: 'Brygga Digital', rounding: 'exact', rate: null, archived: true },
  ],
  projects: [
    { code: 'FJH-NETT', name: 'Nettbutikk rebuild', clientId: 'fjellheim', rate: null, billable: true, archived: false }, // prettier-ignore
    { code: 'INT-ADM', name: 'Internal admin', clientId: null, rate: null, billable: false, archived: false },
  ],
  tasks: [
    { id: 'checkout', label: 'Checkout flow', project: 'FJH-NETT' },
    { id: 'admin', label: 'Admin & invoicing', project: 'INT-ADM' },
  ],
  entries: [],
  commits: [],
});

/** A pre-vault archive day — days that never had a TT daily-note block ride the manifest. */
const ARCHIVE_ENTRY = (date) => ({
  id: 'x1',
  date,
  start: 540,
  end: 690,
  durMin: null,
  project: 'FJH-NETT',
  label: 'Checkout flow',
  note: 'archived day',
  billable: true,
});

const MANIFEST = (over) => ({
  title: 'Time Turtle',
  cutover: '2026-07-27T09:14:00.000Z',
  timeLogHeading: 'Time Log',
  timeSeparator: 'unicode',
  extraHeaders: [],
  catalog: CATALOG(),
  revision: 4,
  digest: null,
  ...over,
});

/** Parse and insist it did not refuse — every non-refusal test wants the model, not the union. */
const parseOk = (md) => {
  const res = TT.parseManifest(md);
  expect(res.quarantine, `unexpected refusal: ${res.reason}`).toBe(false);
  return res;
};

/** Swap one whole line for another, insisting the fixture line was really there. */
const edit = (md, from, to) => {
  expect(md.split('\n').includes(from), `fixture line not found: ${from}`).toBe(true);
  return md
    .split('\n')
    .map((line) => (line === from ? to : line))
    .join('\n');
};

// ---- the house golden ----

describe('the manifest is a format-2 document', () => {
  it('round-trips byte-identical — catalog, archive day and revision line', () => {
    const manifest = MANIFEST({ catalog: { ...CATALOG(), entries: [ARCHIVE_ENTRY('2026-03-04')] } });
    const md = TT.serializeManifest(manifest);
    expect(TT.serializeManifest(parseOk(md).manifest)).toBe(md);
  });

  it('emits the header extension between `format: 2` and the first section', () => {
    const md = TT.serializeManifest(MANIFEST());
    expect(md.split('\n').slice(0, 9)).toEqual([
      '# Time Turtle',
      '',
      'currency: kr',
      'language: nb',
      'format: 2',
      'cutover: 2026-07-27T09:14:00.000Z',
      'timeLogHeading: Time Log',
      'timeSeparator: unicode',
      '',
    ]);
    expect(md.split('\n')[9]).toBe('## clients');
  });

  it('the body below the header is `TT.serializeMd`, byte for byte', () => {
    // The SDD's "no converter exists and none is built", as an assertion: strip the manifest's
    // title and its three header lines and what is left must be exactly the v2 mirror's bytes.
    const manifest = MANIFEST({ catalog: { ...CATALOG(), entries: [ARCHIVE_ENTRY('2026-03-04')] } });
    const md = TT.serializeManifest(manifest);
    const body = md
      .split('\n')
      .filter((line) => !/^(cutover|timeLogHeading|timeSeparator):/.test(line))
      .filter((line) => !/^`revision: /.test(line));
    // drop the title line and the blank line the revision line sat behind
    body[0] = '# timesheet';
    expect(body.slice(0, -2).join('\n') + '\n').toBe(TT.serializeMd(manifest.catalog));
  });

  it('reads the header extension back into the model', () => {
    const { manifest } = parseOk(TT.serializeManifest(MANIFEST()));
    expect(manifest.cutover).toBe('2026-07-27T09:14:00.000Z');
    expect(manifest.timeLogHeading).toBe('Time Log');
    expect(manifest.timeSeparator).toBe('unicode');
    expect(manifest.title).toBe('Time Turtle');
    expect(manifest.revision).toBe(4);
    expect(manifest.catalog.settings.currency).toBe('kr');
    expect(manifest.catalog.settings.language).toBe('nb');
    expect(manifest.catalog.clients.map((c) => c.id)).toEqual(['fjellheim', 'brygga']);
    expect(manifest.catalog.projects.find((p) => p.code === 'INT-ADM').billable).toBe(false);
  });

  it('carries the archive day back as entries', () => {
    const manifest = MANIFEST({ catalog: { ...CATALOG(), entries: [ARCHIVE_ENTRY('2026-03-04')] } });
    const read = parseOk(TT.serializeManifest(manifest)).manifest;
    expect(read.catalog.entries.map((e) => [e.date, e.project, e.note])).toEqual([
      ['2026-03-04', 'FJH-NETT', 'archived day'],
    ]);
  });

  it('omits a header line whose value is absent, rather than writing a fake one', () => {
    const md = TT.serializeManifest(MANIFEST({ cutover: null, timeSeparator: null }));
    expect(md).not.toMatch(/^cutover:/m);
    expect(md).not.toMatch(/^timeSeparator:/m);
    expect(md).toMatch(/^timeLogHeading: Time Log$/m);
    const { manifest } = parseOk(md);
    expect(manifest.cutover).toBe(null);
    expect(manifest.timeSeparator).toBe(null);
    expect(TT.serializeManifest(manifest)).toBe(md);
  });

  it('survives hostile names — SB-041 escaping is what makes the manifest safe to hold a catalog', () => {
    const catalog = CATALOG();
    catalog.clients[0].name = 'A|B AS';
    catalog.projects[0].name = 'X | archived';
    catalog.tasks[0].label = 'nb';
    const md = TT.serializeManifest(MANIFEST({ catalog }));
    const read = parseOk(md).manifest;
    expect(read.catalog.clients[0].name).toBe('A|B AS');
    expect(read.catalog.projects[0].name).toBe('X | archived');
    expect(read.catalog.projects[0].archived).toBe(false);
    expect(read.catalog.tasks[0].label).toBe('nb');
    expect(TT.serializeManifest(read)).toBe(md);
  });
});

// ---- header lines TT does not know ----

describe('unknown header lines pass through untouched', () => {
  // A manifest a NEWER TT wrote: it carries two header keys this build has never heard of, and
  // its digest covers them, so the file is fully verified rather than merely tolerated.
  const NEWER = () => MANIFEST({ extraHeaders: ['weekStart: monday', 'invoiceSeries: 2026-A'] });

  it('carries unrecognised `key: value` headers verbatim, in order', () => {
    const { manifest, verified } = parseOk(TT.serializeManifest(NEWER()));
    expect(verified).toBe(true);
    expect(manifest.extraHeaders).toEqual(['weekStart: monday', 'invoiceSeries: 2026-A']);
  });

  it('re-emits them, so an older TT cannot drop a newer TT’s headers on a read-write cycle', () => {
    const md = TT.serializeManifest(NEWER());
    const out = TT.serializeManifest(parseOk(md).manifest);
    expect(out).toBe(md);
    expect(out).toMatch(/^weekStart: monday$/m);
    expect(out).toMatch(/^invoiceSeries: 2026-A$/m);
  });

  it('carries header-region PROSE too — a line that is not a `key: value` at all', () => {
    const md = TT.serializeManifest(MANIFEST({ extraHeaders: ['', 'These are my clients and rates.'] }));
    const { manifest } = parseOk(md);
    expect(manifest.extraHeaders).toEqual(['These are my clients and rates.']);
    expect(TT.serializeManifest(manifest)).toMatch(/^These are my clients and rates\.$/m);
  });

  it('a header inserted into a SIGNED manifest is a digest mismatch, not a silent acceptance', () => {
    // The other half of the same rule: carriage is for a file whose digest already covers the
    // line. A line typed into a file TT signed is an edit, and TT says so.
    const md = TT.serializeManifest(MANIFEST()).replace(
      'timeSeparator: unicode\n',
      'timeSeparator: unicode\nweekStart: monday\n',
    );
    expect(TT.parseManifest(md).reason).toBe('digest-mismatch');
  });
});

// ---- the digest, in the three cases daily blocks use ----

describe('the trailing revision line — the daily block’s trust discipline, whole-file', () => {
  it('present and matching → verified', () => {
    const md = TT.serializeManifest(MANIFEST());
    const res = parseOk(md);
    expect(res.verified).toBe(true);
    expect(res.manifest.revision).toBe(4);
    expect(res.manifest.digest).toMatch(/^[0-9a-f]{4}$/);
  });

  it('present and DIFFERING → quarantine `digest-mismatch`, nothing guessed', () => {
    const md = TT.serializeManifest(MANIFEST());
    const tampered = edit(md, 'cutover: 2026-07-27T09:14:00.000Z', 'cutover: 2020-01-01T00:00:00.000Z');
    const res = TT.parseManifest(tampered);
    expect(res.quarantine).toBe(true);
    expect(res.reason).toBe('digest-mismatch');
    expect(res.manifest).toBe(undefined);
  });

  it('a hand-edited catalog row also trips it — the digest covers the whole payload', () => {
    const md = TT.serializeManifest(MANIFEST());
    const tampered = edit(md, '- fjellheim | Fjellheim AS | round 15 | rate 1250', '- fjellheim | Fjellheim AS | round 15 | rate 2500'); // prettier-ignore
    expect(TT.parseManifest(tampered).reason).toBe('digest-mismatch');
  });

  it('absent → parses UNVERIFIED, never refused', () => {
    const md = TT.serializeManifest(MANIFEST());
    const stripped = md
      .split('\n')
      .filter((line) => !/^`revision: /.test(line))
      .join('\n');
    const res = parseOk(stripped);
    expect(res.verified).toBe(false);
    expect(res.manifest.revision).toBe(null);
    expect(res.manifest.digest).toBe(null);
    expect(res.manifest.cutover).toBe('2026-07-27T09:14:00.000Z');
  });

  it('digest-LESS but numbered → parses unverified and keeps its number', () => {
    const md = edit(TT.serializeManifest(MANIFEST()), /** @type {string} */ (TT.serializeManifest(MANIFEST()).split('\n').filter((l) => /^`revision: /.test(l))[0]), '`revision: 4`'); // prettier-ignore
    const res = parseOk(md);
    expect(res.verified).toBe(false);
    expect(res.manifest.revision).toBe(4);
    expect(res.manifest.digest).toBe(null);
  });

  it('TT always writes a digest — serializing an unverified manifest stamps one', () => {
    const md = TT.serializeManifest(MANIFEST());
    const stripped = md
      .split('\n')
      .filter((line) => !/^`revision: /.test(line))
      .join('\n');
    const rewritten = TT.serializeManifest(parseOk(stripped).manifest);
    expect(rewritten).toMatch(/^`revision: 1 · [0-9a-f]{4}`$/m);
    expect(parseOk(rewritten).verified).toBe(true);
  });

  it('a blank line is not payload — adding one does not trip the digest', () => {
    const md = TT.serializeManifest(MANIFEST());
    const spaced = md.replace('## clients', '\n## clients');
    expect(parseOk(spaced).verified).toBe(true);
  });

  it('the digest is `TT.vaultPayloadDigest` over the payload, not a second hash', () => {
    const md = TT.serializeManifest(MANIFEST());
    const lines = md.split('\n');
    const revAt = lines.findIndex((l) => /^`revision: /.test(l));
    const payload = lines.slice(0, revAt).filter((l) => l.trim() !== '');
    expect(lines[revAt]).toBe('`revision: 4 · ' + TT.vaultPayloadDigest(payload) + '`');
  });
});

// ---- refusals ----

describe('what the manifest refuses', () => {
  it('CRLF line endings → `crlf-line-endings`', () => {
    const md = TT.serializeManifest(MANIFEST()).split('\n').join('\r\n');
    expect(TT.parseManifest(md).reason).toBe('crlf-line-endings');
  });

  it('a revision line TT cannot read → `malformed-revision`', () => {
    const md = TT.serializeManifest(MANIFEST());
    const rev = md.split('\n').filter((l) => /^`revision: /.test(l))[0];
    expect(TT.parseManifest(edit(md, rev, '`revision: 4 · ZZZZ`')).reason).toBe('malformed-revision');
  });

  it('two revision lines → `multiple-revisions`', () => {
    const md = TT.serializeManifest(MANIFEST());
    expect(TT.parseManifest(md + '`revision: 5 · abcd`\n').reason).toBe('multiple-revisions');
  });

  it('a revision line that is not the last thing in the file → `manifest-revision-not-last`', () => {
    const md = TT.serializeManifest(MANIFEST());
    expect(TT.parseManifest(md + '- a stray row\n').reason).toBe('manifest-revision-not-last');
  });

  it('no `format: 2` marker → `manifest-not-format-2`, never a silent v1 migration', () => {
    const md = TT.serializeManifest(MANIFEST());
    expect(TT.parseManifest(edit(md, 'format: 2', 'format: 1')).reason).toBe('manifest-not-format-2');
    expect(TT.parseManifest(edit(md, 'format: 2', 'format: 3')).reason).toBe('manifest-not-format-2');
    expect(
      TT.parseManifest(
        md
          .split('\n')
          .filter((l) => l !== 'format: 2')
          .join('\n'),
      ).reason,
    ).toBe('manifest-not-format-2');
  });

  it('a fenced example of the format is documentation, not an anchor and not a header', () => {
    // The note most likely to hold a fenced copy of the manifest format is the note documenting
    // the manifest format. A fenced `revision:` line must not read as a second anchor, and a
    // fenced `cutover:` line must not set the instance's cutover.
    const md = TT.serializeManifest(
      MANIFEST({ extraHeaders: ['```', '`revision: 99 · beef`', 'cutover: 1999-01-01T00:00:00.000Z', '```'] }),
    );
    const res = parseOk(md);
    expect(res.manifest.revision).toBe(4);
    expect(res.manifest.cutover).toBe('2026-07-27T09:14:00.000Z');
    expect(TT.serializeManifest(res.manifest)).toBe(md);
  });

  it('every refusal hands back no model — quarantine, never a partial parse', () => {
    const md = TT.serializeManifest(MANIFEST());
    for (const broken of [
      md.split('\n').join('\r\n'),
      edit(md, 'format: 2', 'format: 1'),
      md + '`revision: 5 · abcd`\n',
      md + '- a stray row\n',
    ]) {
      const res = TT.parseManifest(broken);
      expect(res.quarantine).toBe(true);
      expect(res.manifest).toBe(undefined);
    }
  });
});

// ---- the vocabulary ----

describe('the manifest quarantine vocabulary', () => {
  it('covers every manifest-only reason with a refusal golden', () => {
    // The SB-109 discipline, one file over: the vocabulary is IMPORTED as a runtime value rather
    // than scraped out of the `.ts` union, so prose in a doc comment cannot lie to this guard.
    const reasons = VAULT_MANIFEST_QUARANTINE_REASONS;
    expect(Array.isArray(reasons), 'VAULT_MANIFEST_QUARANTINE_REASONS is not an array').toBe(true);
    expect(reasons.every((r) => typeof r === 'string' && /^manifest-[a-z0-9-]+$/.test(r)), `not all reasons are manifest reason codes: ${JSON.stringify(reasons)}`).toBe(true); // prettier-ignore
    expect(new Set(reasons).size, `duplicate reason in the vocabulary: ${JSON.stringify(reasons)}`).toBe(reasons.length); // prettier-ignore
    // Pinned, so growing the vocabulary is a deliberate edit here with a golden beside it.
    expect(reasons.length, 'the manifest quarantine vocabulary changed size — add a refusal golden, then update this pin').toBe(2); // prettier-ignore
    const md = TT.serializeManifest(MANIFEST());
    const produced = new Set([
      TT.parseManifest(edit(md, 'format: 2', 'format: 1')).reason,
      TT.parseManifest(md + '- a stray row\n').reason,
    ]);
    for (const reason of reasons) expect(produced.has(reason), `no refusal golden for reason: ${reason}`).toBe(true);
  });

  it('every reason a manifest can produce has a sentence — never a blank', () => {
    const codes = [
      ...VAULT_MANIFEST_QUARANTINE_REASONS,
      'crlf-line-endings',
      'malformed-revision',
      'multiple-revisions',
      'digest-mismatch',
    ];
    for (const code of codes) {
      const text = TT.vaultQuarantineText(code);
      expect(text, `no sentence for ${code}`).not.toBe(TT.VAULT_QUARANTINE_FALLBACK);
      expect(text.length).toBeGreaterThan(10);
    }
  });
});
