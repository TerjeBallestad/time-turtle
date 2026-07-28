// SB-127 — DD-021's adopt gesture, widened by DD-022. Three rungs in one file, because it is one
// gesture: the codec change that makes it possible (pure), the whole thing end to end (api), and
// the admission test on its own (module) — the last because every state it turns on is one the
// scan reconciles within a debounce, so a live server can only race them.
//
// WHAT THIS FILE CANNOT PROVE, and it is the half that matters most: that a person can SEE the
// button and press it. A green api test here is exactly the failure SB-063 is this repo's example
// of — perfect plumbing, a green test, and a control nobody could reach. That claim is
// tests-browser/vault-quarantine.test.js's, at the browser rung, per the ticket's own judge note.
//
// THE API HALF IS TERJE'S OWN 2026-07-28 REPRO, not an invented fixture. TT wrote his note with a
// running row; he typed the end time into Obsidian; the day quarantined on `digest-mismatch`; the
// entry then closed in TT at a DIFFERENT time and could not be written through. Both sides hold
// one row and they disagree — the case DD-021's lossy confirm exists for, and the one the delta
// count has to get right or the confirm is decoration.
//
// ## Verified red-green: 2026-07-28
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT, { VAULT_ADOPTABLE_QUARANTINE_REASONS, VAULT_BLOCK_QUARANTINE_REASONS } from '../shared/core.js';
import { startServer, stopServer, stopAllServers, adminOn } from './util.js';

const HEADING = 'Time Log';

const entry = (id, date, start, end, label) => ({
  id,
  date,
  start,
  end,
  durMin: null,
  project: null,
  label,
  note: '',
  billable: true,
});

// ============================================================================================
// The codec half — `opts.adopt`, the one thing in shared/core.js that can stand a wrong digest
// down. Pure, so every case is bytes in and a verdict out.
// ============================================================================================
describe('the adopt stand-down in the locator (DD-021)', () => {
  const DATE = '2026-07-20';
  const opts = { heading: HEADING, date: DATE };
  const rows = [entry('e1', DATE, 540, 600, 'first'), entry('e2', DATE, 600, 660, 'second')];
  /** A whole daily note with real sections around the block — Terje's owns everything else. */
  const note = (entries, revision) =>
    '# Monday\n\n## Intentions\n\nship it\n\n' +
    TT.serializeVaultBlock(entries, { heading: HEADING, revision }) +
    '\n\n## Captures\n\nnothing yet\n';

  const SIGNED = note(rows, 4);
  // THE SB-051 CHIMERA, which is what a `digest-mismatch` actually is: TT's anchor line kept, the
  // buffer's rows kept. Structurally perfect, semantically wrong — every check but the digest
  // passes, which is why no other refusal stands in for this one in the cases below.
  const CHIMERA = SIGNED.replace('| first', '| typed over the top');

  it('refuses the chimera without the flag, and reads it as digest-LESS with it', () => {
    // the control: this really is a digest mismatch and nothing else
    const refused = TT.locateVaultBlock(CHIMERA, opts);
    expect(refused.quarantine).toBe(true);
    expect(refused.reason).toBe('digest-mismatch');

    const adopted = TT.locateVaultBlock(CHIMERA, { ...opts, adopt: true });
    expect(adopted.quarantine).toBe(false);
    // DD-009 consequence 2's shape and no new one: parses, unverified, never quarantined. A
    // `verified: true` here would have TT vouching for bytes it has just been told it cannot
    // check, and a non-null digest would be a token describing other bytes.
    expect(adopted.verified).toBe(false);
    expect(adopted.digest).toBe(null);
    expect(adopted.revision).toBe(4);
  });

  it('leaves a digest that MATCHES exactly as it was — the flag is a stand-down, not a bypass', () => {
    // This is what DD-022's two arbitration reasons arrive with: a block whose digest matches its
    // own table, refused for its provenance rather than its readability. If `adopt` blanked every
    // digest, adopting a restored note would silently drop it to unverified for no reason.
    const plain = TT.locateVaultBlock(SIGNED, opts);
    const withFlag = TT.locateVaultBlock(SIGNED, { ...opts, adopt: true });
    expect(plain.quarantine).toBe(false);
    expect(withFlag).toEqual(plain);
    expect(withFlag.verified).toBe(true);
  });

  it('stands down the digest and NOTHING else', () => {
    // The narrowing is the point. A block adoption cannot READ is a block adoption may not
    // overrule — the same rule `vaultAdoptionCandidate` keeps for 'no-revision' — and the two
    // reasons SB-083 excluded deliberately (a repair, not an adoption) must stay excluded.
    //
    // Driven through `parseVaultBlock` rather than the locator, because the list deliberately
    // spans both stages: `unknown-header` is the PARSER's verdict, and under the flag it is now
    // reachable on a signed note at all — the digest used to refuse first. That is exactly the
    // case worth pinning: standing the digest down must expose the parser's refusal, not skip it.
    const REFUSED = [
      ['no-table', SIGNED.replace(/\| Time.*\n\| -.*\n/, '')],
      ['unknown-header', SIGNED.replace(/^\| Time\b/m, '| Cat')],
      ['unparseable-time', SIGNED.replace('| 09:00→10:00', '| half past something')],
      ['crlf-line-endings', SIGNED.replace(/\n/g, '\r\n')],
      ['unexpected-content-in-block', SIGNED.replace('\n\n`revision:', '\na note to self\n\n`revision:')],
      ['multiple-headings', SIGNED.replace('## Captures', '## ' + HEADING)],
    ];
    for (const [reason, md] of REFUSED) {
      const got = TT.parseVaultBlock(md, { ...opts, adopt: true });
      expect(got.quarantine, `${reason} was let through by the adopt flag`).toBe(true);
      expect(got.reason, `${reason} came back as something else`).toBe(reason);
    }
  });

  it('parses the chimera’s OWN rows — the note wins, which is the whole gesture', () => {
    expect(TT.parseVaultBlock(CHIMERA, opts).quarantine).toBe(true);
    const parsed = TT.parseVaultBlock(CHIMERA, { ...opts, adopt: true });
    expect(parsed.quarantine).toBe(false);
    expect(parsed.entries.map((e) => e.label)).toEqual(['typed over the top', 'second']);
    // NOT `adopted: true`. DD-012's flag means "TT synthesised the missing anchor"; this note has
    // an anchor, it is simply wrong. Two ways to adopt would be two things called adoption.
    expect(parsed.adopted).toBe(false);
  });

  it('re-signs the anchor: the write comes back verified, and its rows are the note’s', () => {
    const parsed = TT.parseVaultBlock(CHIMERA, { ...opts, adopt: true });
    const written = TT.writeVaultBlock(CHIMERA, parsed.entries, { ...opts, adopt: true, revision: 9 });
    expect(written.quarantine).toBe(false);
    // and the OUTPUT needs no flag to read — the whole point is that the day is ordinary again
    const after = TT.parseVaultBlock(written.md, opts);
    expect(after.quarantine).toBe(false);
    expect(after.verified).toBe(true);
    expect(after.revision).toBe(9);
    expect(after.entries.map((e) => e.label)).toEqual(['typed over the top', 'second']);
    // ADOPT IS NOT DESTRUCTIVE TO THE VAULT (DD-021): everything outside the block is untouched,
    // which is why this write warrants no checkpoint, no backup copy and no rename-first.
    expect(written.md).toContain('## Intentions\n\nship it');
    expect(written.md).toContain('## Captures\n\nnothing yet');
  });

  it('the flag defaults OFF, so no ordinary caller can retire DD-009 by forgetting it', () => {
    for (const bad of [undefined, {}, { heading: HEADING }, { ...opts, adopt: false }])
      expect(TT.locateVaultBlock(CHIMERA, bad).reason).toBe('digest-mismatch');
  });

  it('offers the gesture on three reasons and refuses the other thirteen', () => {
    // DD-021 ruled one, DD-022 widened it to three, and DD-021 consequence 4 is that every other
    // refusal renders with NO control at all. This is the predicate both ends read.
    expect(VAULT_ADOPTABLE_QUARANTINE_REASONS.every((r) => TT.vaultAdoptable(r))).toBe(true);
    for (const reason of VAULT_BLOCK_QUARANTINE_REASONS)
      if (reason !== 'digest-mismatch')
        expect(TT.vaultAdoptable(reason), `${reason} must not be adoptable`).toBe(false);
    // the two SB-083 excluded on purpose, named so a later reader sees it was a decision
    expect(TT.vaultAdoptable('malformed-revision')).toBe(false);
    expect(TT.vaultAdoptable('crlf-line-endings')).toBe(false);
    // and an unfamiliar code is `false` — the safe direction, since an unknown reason already
    // renders as a legible refusal through the fallback line
    for (const junk of [null, undefined, '', 'nonsense', '__proto__']) expect(TT.vaultAdoptable(junk)).toBe(false);
  });
});

// ============================================================================================
// The gesture, end to end — a real server, `TT_SHAPE=personal`, a throwaway vault.
// ============================================================================================
describe('adopting a paused note (api)', () => {
  const TODAY = TT.todayStr();
  let vault = '';
  let dailyDir = '';
  let admin = null;
  let child = null;
  const notePath = (date) => join(dailyDir, date + '.md');
  const read = (date) => readFileSync(notePath(date), 'utf8');
  const parseNote = (date, opts) => TT.parseVaultBlock(read(date), { heading: HEADING, date, ...(opts || {}) });

  /** Poll: the vault fan-out happens inside the save, but the save is over HTTP. */
  async function until(predicate, { timeout = 5000, step = 25 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await predicate()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, step));
    }
  }
  /** PUT an entry set with a fresh version, so an import's bump cannot 409 us. */
  async function save(entries) {
    const state = await admin('GET', '/api/state');
    const res = await admin('PUT', '/api/state', { entries, version: state.json.version });
    expect(res.status).toBe(200);
    return res;
  }
  const paused = async (date) => {
    const state = await admin('GET', '/api/state');
    return (state.json.vaultQuarantined || []).find((row) => row.date === date) || null;
  };

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tt-adopt-data-'));
    vault = mkdtempSync(join(tmpdir(), 'tt-adopt-vault-'));
    dailyDir = join(vault, 'Calendar', 'Daily');
    mkdirSync(dailyDir, { recursive: true });
    const server = await startServer({ TT_DATA_DIR: dataDir, TT_SHAPE: 'personal', TT_SEED_DEMO: '0' });
    child = server.child;
    admin = await adminOn(server.port);
    const state = await admin('GET', '/api/state');
    // the shape, asserted on the wire — without it every assertion below is vacuous
    expect(state.json.shape).toBe('personal');
    const put = await admin('PUT', '/api/state', {
      settings: { vaultPaths: { root: vault, daily: 'Calendar/Daily' } },
      version: state.json.version,
    });
    expect(put.status).toBe(200);
  });
  afterAll(async () => {
    if (child) await stopServer(child);
    stopAllServers();
  });

  it('TERJE’S CASE: a typed-in end time pauses the day, and adopting takes the note’s hours', async () => {
    // 1. TT writes the note with the entry still running — `10:30→`, a 0h total.
    await save([entry('e1', TODAY, 630, null, 'the day')]);
    expect(await until(async () => parseNote(TODAY).entries.length === 1)).toBe(true);
    expect(parseNote(TODAY).entries[0].end).toBe(null);
    const revBefore = parseNote(TODAY).revision;

    // 2. He fills the end time in, IN OBSIDIAN. A content edit, not a reflow — DD-023 fixed
    //    reflow and this is not that. The anchor keeps the digest TT wrote, which now describes
    //    bytes that are no longer there.
    writeFileSync(notePath(TODAY), read(TODAY).replace('10:30→ ', '10:30→20:00'));
    expect(TT.locateVaultBlock(read(TODAY), { heading: HEADING }).reason).toBe('digest-mismatch');

    // 3. The entry closes in TT at a DIFFERENT time, and cannot be written through: the note is
    //    refused, so both sides now hold one row and they disagree. Neither can reach the other.
    await save([entry('e1', TODAY, 630, 720, 'the day')]);
    expect(await until(async () => (await paused(TODAY)) != null)).toBe(true);
    const row = await paused(TODAY);
    expect(row.reason).toBe('digest-mismatch');
    expect(row.path).toBe(notePath(TODAY));
    expect(read(TODAY)).toContain('10:30→20:00'); // TT left the note alone, byte for byte

    // 4. THE DELTA THE ROW STATES. One row each side and they are not the same row — which is
    //    precisely why counts alone are not the test (DD-022 rider 1). This is the number the
    //    confirm names, and getting it from the lengths would say `0` and ask nothing.
    expect(row.ttEntries).toBe(1);
    expect(row.noteEntries).toBe(1);
    expect(row.dropped).toBe(1);

    // 5. Adopt. The note's rows win — 20:00 is kept and the 12:00 close is discarded, because
    //    under `vault` SQLite is the derived index (DD-006).
    const res = await admin('POST', '/api/vault/adopt', { path: row.path });
    expect(res.status).toBe(200);
    expect(res.json.imported).toBe(1);
    expect(res.json.rev).toBeGreaterThan(revBefore); // DD-022 rider 2: the counter never rewinds

    // the day is ordinary again: no flag needed to read it, and TT vouches for it
    const after = parseNote(TODAY);
    expect(after.quarantine).toBe(false);
    expect(after.verified).toBe(true);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0].start).toBe(630);
    expect(after.entries[0].end).toBe(1200); // 20:00, the note's answer

    // …and TT's INDEX now says the same thing, which is the half that was stuck
    const state = await admin('GET', '/api/state');
    const held = state.json.entries.filter((e) => e.date === TODAY);
    expect(held).toHaveLength(1);
    expect(held[0].end).toBe(1200);
    expect(await paused(TODAY)).toBe(null); // the row is gone from the surface

    // the note keeps writing: a later save lands rather than being refused forever
    await save([entry('e1', TODAY, 630, 1200, 'the day'), entry('e2', TODAY, 1230, 1260, 'and an evening hour')]);
    expect(await until(async () => parseNote(TODAY).entries.length === 2)).toBe(true);
  });

  it('a benign mismatch costs nothing: dropped is 0, so the row is one click', async () => {
    // DD-021's own trade, and the case that will fire most often: the click is uninformed only
    // when it is also harmless. Same rows on both sides, different bytes.
    //
    // A HAND-TYPED SEPARATOR, not re-padding. Re-padding stopped producing a mismatch at all when
    // DD-023/SB-165 landed — `vaultPayloadDigest` normalises table framing now, which is the whole
    // fix Terje was testing when he hit this ticket. `09:00-10:00` is what remains: an ASCII
    // hyphen for TT's `→` is a change the normaliser does not erase and the parser converges on
    // (tests/roundtrip.test.js Family B), so the digest breaks and not one entry does.
    const date = TT.addDays(TODAY, 1);
    await save([entry('r1', date, 540, 600, 'an hour')]);
    expect(await until(async () => parseNote(date).entries.length === 1)).toBe(true);
    writeFileSync(notePath(date), read(date).replace('09:00→10:00', '09:00-10:00'));
    expect(await until(async () => (await paused(date)) != null, { timeout: 15000 })).toBe(true);
    const row = await paused(date);
    expect(row.reason).toBe('digest-mismatch');
    expect(row.ttEntries).toBe(1);
    expect(row.noteEntries).toBe(1);
    expect(row.dropped).toBe(0); // nothing is lost, so DD-021 asks nothing

    expect((await admin('POST', '/api/vault/adopt', { path: row.path })).status).toBe(200);
    expect(parseNote(date).verified).toBe(true);
    expect(parseNote(date).entries[0].end).toBe(600); // and the hour is still the hour
    expect(await paused(date)).toBe(null);
  }, 30000);

  it('DD-022: a restored note gets the SAME gesture, and re-anchors above the index’s revision', async () => {
    // The rev-regression case. `git restore` from the vault's checkpoint history puts back a note
    // at a revision TT recorded, carrying content TT did not write there — SB-061's case, and the
    // one whose block parses AND whose digest matches its own table. DD-022: the weaker case got
    // the gesture, so this one cannot be denied it.
    const date = TT.addDays(TODAY, 2);
    await save([entry('g1', date, 540, 600, 'before the restore')]);
    expect(await until(async () => parseNote(date).entries.length === 1)).toBe(true);
    // let TT move the counter on, so the restored copy is genuinely behind the index
    await save([entry('g1', date, 540, 630, 'edited once'), entry('g2', date, 660, 720, 'and again')]);
    expect(await until(async () => parseNote(date).entries.length === 2)).toBe(true);
    const indexRev = parseNote(date).revision;
    expect(indexRev).toBeGreaterThan(1);

    // the restored file: an OLD revision, internally consistent, holding content TT never wrote
    // at that revision
    const restored =
      `# ${date}\n\n## Intentions\n\nwhat I meant to do\n\n` +
      TT.serializeVaultBlock([entry('g9', date, 480, 540, 'the restored morning')], {
        heading: HEADING,
        revision: 1,
      }) +
      '\n\n## Captures\n\n-\n';
    writeFileSync(notePath(date), restored);
    // it really is internally consistent — this is NOT a digest-mismatch wearing another name
    expect(TT.locateVaultBlock(restored, { heading: HEADING }).verified).toBe(true);

    // NO SAVE HERE, deliberately, and it is the difference between testing this and testing
    // nothing: a rev regression is the SCAN's verdict, not the writer's. A save touching this
    // date would splice TT's rows in at `file.rev + 1` before anything compared revisions — the
    // writer is told which day to write, the arbitration is what decides whether the file is
    // behind. The watcher is the trigger, exactly as it is on Terje's machine.
    expect(await until(async () => (await paused(date)) != null, { timeout: 15000 })).toBe(true);
    const row = await paused(date);
    expect(['external-rewrite', 'unprovable-staleness']).toContain(row.reason);
    expect(row.ttEntries).toBe(2);
    expect(row.noteEntries).toBe(1);
    expect(row.dropped).toBe(2); // both of TT's rows are gone from the note — the confirm fires

    const res = await admin('POST', '/api/vault/adopt', { path: row.path });
    expect(res.status).toBe(200);
    // DD-022 RIDER 2, the load-bearing one: re-anchoring at the FILE's own revision would leave
    // the peer machine's higher-rev copy winning the next arbitration and silently undoing the
    // restore — the SB-061 failure this gesture exists to prevent.
    expect(res.json.rev).toBeGreaterThan(indexRev);
    expect(parseNote(date).revision).toBe(res.json.rev);
    expect(parseNote(date).entries.map((e) => e.label)).toEqual(['the restored morning']);
    expect(await paused(date)).toBe(null);

    const state = await admin('GET', '/api/state');
    expect(state.json.entries.filter((e) => e.date === date).map((e) => e.label)).toEqual(['the restored morning']);
  }, 30000);

  it('refuses every other reason — no rows to adopt, and no counts offered either', async () => {
    // DD-021 consequence 4 from the server's side. The surface renders no control for these; this
    // is the other half, so a hand-made POST cannot reach what the button will not offer.
    const date = TT.addDays(TODAY, 3);
    const prose = `# ${date}\n\n## ${HEADING}\n\nI wrote about my morning instead of logging it.\n\n\`revision: 4 · abcd\`\n`;
    writeFileSync(notePath(date), prose);
    await save([entry('p1', date, 480, 540, 'never lands'), entry('k', TT.addDays(TODAY, 8), 540, 600, 'elsewhere')]);
    expect(await until(async () => (await paused(date)) != null)).toBe(true);
    const row = await paused(date);
    expect(row.reason).toBe('no-table');
    // not on offer, and no numbers on a row nobody can act on
    expect(row.adoptable).toBe(false);
    expect(row.ttEntries).toBe(null);
    expect(row.noteEntries).toBe(null);
    expect(row.dropped).toBe(null);

    const res = await admin('POST', '/api/vault/adopt', { path: row.path });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain('no-table');
    expect(read(date)).toBe(prose); // and the note is exactly where it was
    expect((await paused(date)).reason).toBe('no-table');
  });

  // ------------------------------------------------------------------------------------------
  // The two failure edges. Both were shipped wrong once and both are silent by nature: the human
  // is TOLD the day is fixed, which is the one thing this gesture must never say falsely.
  // ------------------------------------------------------------------------------------------

  it('a write that FAILS is not a success — the note is untouched and the response says which half stands', async () => {
    // The vault is a synced folder. Obsidian Sync, iCloud or a full disk holds the directory for a
    // moment and the atomic temp-write throws. `rewriteVaultDate` catches every throw, which left
    // BOTH `refused` and `written` empty — so gating on `refused` alone returned `{ok: true}` for a
    // note that was never opened. The client then reloads on that 200, the paused row is gone, and
    // the day re-quarantines on the next scan with the human believing it is resolved.
    const date = TT.addDays(TODAY, 5);
    await save([entry('f1', date, 540, 600, 'the hour TT holds')]);
    expect(await until(async () => parseNote(date).entries.length === 1)).toBe(true);
    writeFileSync(notePath(date), read(date).replace('09:00→10:00', '09:00-10:00'));
    expect(await until(async () => (await paused(date)) != null, { timeout: 15000 })).toBe(true);
    const row = await paused(date);
    expect(row.reason).toBe('digest-mismatch');
    const before = read(date);

    // Lock the directory the temp file has to be created in. Asserted to have actually taken
    // effect before anything is claimed about it — running as root would make this a no-op and
    // every assertion below vacuous.
    chmodSync(dailyDir, 0o555);
    let locked = true;
    try {
      writeFileSync(join(dailyDir, '.tt-probe'), 'x');
      locked = false;
    } catch {
      /* the directory really is read-only, which is the point */
    }
    try {
      expect(locked, 'chmod 555 did not make the daily directory read-only — running as root?').toBe(true);
      const res = await admin('POST', '/api/vault/adopt', { path: row.path });
      expect(res.status).toBe(409);
      // NOT `ok`, and the error names the half that is durable rather than implying nothing
      // happened: import-first is required, so the rows ARE in the index by the time a write can
      // fail. What did not happen is the only thing the gesture exists to do.
      expect(res.json.error).toContain('the note itself was not rewritten');
    } finally {
      chmodSync(dailyDir, 0o755);
    }

    // The measurable truth the 200 used to contradict: the note is byte-identical, its anchor
    // still carries the digest that describes bytes which are no longer there, and the day is
    // still not syncing.
    expect(read(date)).toBe(before);
    expect(TT.locateVaultBlock(read(date), { heading: HEADING }).reason).toBe('digest-mismatch');

    // THE ROW IS STILL ON THE SURFACE — the failure did not quietly take the paused day off the
    // screen. Without this the human is told the write failed and then shown nothing to retry
    // against until the next scan pass.
    const stillPaused = await paused(date);
    expect(stillPaused).not.toBe(null);
    expect(stillPaused.reason).toBe('digest-mismatch');

    // …and it is recoverable: with the directory writable the same press works.
    const again = await admin('POST', '/api/vault/adopt', { path: row.path });
    expect(again.status).toBe(200);
    expect(parseNote(date).verified).toBe(true);
    expect(await paused(date)).toBe(null);
  }, 30000);

  it('the row states its price and offers the gesture only while the note reads', async () => {
    // The api half of the admission test — the module rung below takes the states themselves,
    // where they can be held still. Here it is only the wire shape: `adoptable` travels with the
    // counts and says the same thing they do.
    const date = TT.addDays(TODAY, 6);
    await save([entry('u1', date, 540, 600, 'the hour TT holds'), entry('u2', date, 660, 720, 'and another')]);
    expect(await until(async () => parseNote(date).entries.length === 2)).toBe(true);
    writeFileSync(notePath(date), read(date).replace('09:00→10:00', '09:00-10:00'));
    expect(await until(async () => (await paused(date)) != null, { timeout: 15000 })).toBe(true);
    const row = await paused(date);
    expect(row.reason).toBe('digest-mismatch');
    expect(row.adoptable).toBe(true);
    expect(row.ttEntries).toBe(2);
    expect(row.noteEntries).toBe(2);
    expect(row.dropped).toBe(0);
  }, 30000);

  it('refuses a path it holds no paused row for, without touching the filesystem', async () => {
    // The path arrives in the request body. It is matched against `vault_index` and never
    // resolved, so an arbitrary one reaches no file at all.
    expect((await admin('POST', '/api/vault/adopt', { path: '/etc/passwd' })).status).toBe(404);
    expect((await admin('POST', '/api/vault/adopt', {})).status).toBe(400);
    // A note TT is perfectly happy with is refused too, and with the OTHER code: TT holds an index
    // row for it, so this is "the world is not what you thought" (409) rather than "no such note"
    // (404). Adopt resolves a refusal; a day that is syncing has none to resolve.
    const healthy = TT.addDays(TODAY, 4);
    await save([entry('h1', healthy, 540, 600, 'a good day')]);
    expect(await until(async () => parseNote(healthy).entries.length === 1)).toBe(true);
    const res = await admin('POST', '/api/vault/adopt', { path: notePath(healthy) });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain('not paused');
    expect(parseNote(healthy).entries).toHaveLength(1); // and it did not touch the note
  }, 20000);
});

// ============================================================================================
// The admission test, at the MODULE rung — `vaultAdoptDelta` and `adoptVaultDate` side by side.
//
// WHY NOT THE api RUNG, where the rest of the gesture is proved. Every state below is one the
// scan RECONCILES: an unreadable note becomes `unknown` on the next pass (SB-052's invariant 1),
// a note that stops parsing gets a new reason, a note that is gone loses its row. On a live server
// they exist only inside the 500 ms watch debounce, so an api test for them is a test that has to
// win a race — and a test that usually wins a race is a flake, not a claim. Here nothing is
// watching and nothing is scanning: the state is set and it stays set.
//
// WHAT IS CLAIMED: the two functions take the SAME admission test. Every state where the delta
// cannot be priced is a state where the adopt would refuse — so `adoptable: false` is not caution,
// it is the truth about what pressing the button would do, and DD-021 consequence 4's answer to
// that is no control rather than a weakened one. The client used to be handed `dropped: null` on
// exactly these states with the reason still saying "offer it", read the missing price as `?? 0`,
// and render a bare one-click adopt with no counts and no confirm.
// ============================================================================================
describe('the adopt admission test — priced and offered, or neither (module)', () => {
  /** @type {typeof import('../server/src/db.js')} */
  let db;
  /** @type {typeof import('../server/src/vault-write.js')} */
  let writer;
  let vaultRoot = '';
  let daily = '';
  let userId = 0;
  const DATE = '2026-07-20';
  const path = () => join(daily, DATE + '.md');
  const signed = (entries, revision) =>
    `# ${DATE}\n\n## Intentions\n\nplans\n\n` +
    TT.serializeVaultBlock(entries, { heading: HEADING, revision }) +
    '\n\n## Captures\n\nthoughts\n';

  /** A paused row for the note as it stands, on the reason DD-021 was written for. */
  const pause = () =>
    db.putVaultIndex({
      path: path(),
      date: DATE,
      state: 'quarantined',
      rev: 3,
      payloadDigest: 'b3ce',
      fileSha: null,
      verified: true,
      quarantineReason: 'digest-mismatch',
      seenAt: new Date().toISOString(),
      quarantinedAt: new Date().toISOString(),
    });

  beforeAll(async () => {
    process.env.TT_DATA_DIR = mkdtempSync(join(tmpdir(), 'tt-adopt-module-'));
    process.env.TT_SHAPE = 'personal';
    db = await import('../server/src/db.js');
    writer = await import('../server/src/vault-write.js');
    const user = db.createUser({ email: 'solo@timeturtle.local', name: 'Solo', role: 'admin', password: 'pw' });
    userId = user.id;
  });

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), 'tt-adopt-module-vault-'));
    daily = join(vaultRoot, 'Calendar', 'Daily');
    mkdirSync(daily, { recursive: true });
    db.putSettings({ shape: 'personal', vaultPaths: { root: vaultRoot, daily: 'Calendar/Daily' } });
    db.db.exec("INSERT INTO settings (key, value) VALUES ('vaultCutover', '2020-01-01T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value = excluded.value"); // prettier-ignore
    for (const row of db.listVaultIndex()) db.deleteVaultIndex(row.path);
    db.putEntries(userId, [entry('m1', DATE, 540, 600, 'the hour TT holds')]);
  });
  afterEach(() => {
    try {
      chmodSync(path(), 0o644);
    } catch {
      /* the note may have been unlinked, or never chmodded */
    }
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  /** The whole claim, in one place: unpriceable and un-adoptable are the same set. */
  const bothRefuse = () => {
    const delta = writer.vaultAdoptDelta(userId, path(), DATE, 'digest-mismatch');
    expect(delta.adoptable).toBe(false);
    expect(delta.ttEntries).toBe(null);
    expect(delta.noteEntries).toBe(null);
    expect(delta.dropped).toBe(null);
    expect(writer.adoptVaultDate(userId, path(), DATE).ok).toBe(false);
  };

  it('prices and offers the note it CAN read — the control the other cases are measured against', () => {
    // Not decoration: without it every `false` below would also be produced by a delta that
    // answers `false` unconditionally, and the four cases would prove nothing.
    writeFileSync(path(), signed([entry('m1', DATE, 540, 630, 'a longer hour')], 3));
    pause();
    const delta = writer.vaultAdoptDelta(userId, path(), DATE, 'digest-mismatch');
    expect(delta.adoptable).toBe(true);
    expect(delta.ttEntries).toBe(1);
    expect(delta.noteEntries).toBe(1);
    expect(delta.dropped).toBe(1); // one row each side, and they are not the same row
  });

  it('a note that will not READ is neither priced nor offered', () => {
    writeFileSync(path(), signed([entry('m1', DATE, 540, 630, 'a longer hour')], 3));
    pause();
    chmodSync(path(), 0o000);
    let unreadable = true;
    try {
      readFileSync(path(), 'utf8');
      unreadable = false;
    } catch {
      /* exactly the state under test */
    }
    // Never silently skipped: an environment where chmod cannot make a file unreadable must say
    // so, or a green run here would be meaningless.
    expect(unreadable, 'chmod 000 did not make the note unreadable — running as root?').toBe(true);
    bothRefuse();
  });

  it('a note that is GONE is neither priced nor offered', () => {
    writeFileSync(path(), signed([entry('m1', DATE, 540, 630, 'a longer hour')], 3));
    pause();
    unlinkSync(path());
    bothRefuse();
  });

  it('a note that no longer PARSES is neither priced nor offered, reason notwithstanding', () => {
    // The row says `digest-mismatch` — an admitting reason — and the bytes have moved since the
    // scan recorded it. The admission test is "TT can read the rows", and it is taken against the
    // note as it is NOW, not against the reason code.
    writeFileSync(
      path(),
      `# ${DATE}\n\n## ${HEADING}\n\nI wrote about my morning instead.\n\n\`revision: 3 · b3ce\`\n`,
    );
    pause();
    bothRefuse();
  });

  it('no vault configured at all is neither priced nor offered', () => {
    writeFileSync(path(), signed([entry('m1', DATE, 540, 630, 'a longer hour')], 3));
    pause();
    db.putSettings({ shape: 'personal', vaultPaths: { root: '', daily: '' } });
    bothRefuse();
  });

  it('a reason the gesture is not admitted on is refused before the note is read at all', () => {
    // The tenth-through-thirteenth refusals. Same answer, reached one step earlier — and reached
    // even though the note on disk is perfectly readable, which is what makes it the REASON's
    // refusal and not the read's.
    writeFileSync(path(), signed([entry('m1', DATE, 540, 630, 'a longer hour')], 3));
    db.putVaultIndex({
      path: path(),
      date: DATE,
      state: 'quarantined',
      rev: 3,
      payloadDigest: null,
      fileSha: null,
      verified: false,
      quarantineReason: 'no-table',
      seenAt: new Date().toISOString(),
      quarantinedAt: new Date().toISOString(),
    });
    const delta = writer.vaultAdoptDelta(userId, path(), DATE, 'no-table');
    expect(delta.adoptable).toBe(false);
    expect(delta.dropped).toBe(null);
    expect(writer.adoptVaultDate(userId, path(), DATE).ok).toBe(false);
  });
});
