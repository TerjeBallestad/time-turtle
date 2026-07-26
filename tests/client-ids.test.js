// SB-067: client ids — the minting/de-collide/derive rules, unit-tested.
//
// These live at the `unit` rung against `client/src/clientIds.ts`, which is where the
// generator was extracted to. Before the extraction the rule was an inline expression in
// a React callback (`App.tsx`: `id: 'client' + (current.clients.length + 1)`), reachable
// only by the `browser` rung — which is why the collision it produces shipped unnoticed.
//
// The save-lock the collision causes is pinned separately at the `api` rung, against a
// real server: see 'SB-067: duplicate client ids' in api.test.js.
//
// ## Verified red-green: 2026-07-26
import { describe, it, expect } from 'vitest';
import TT from '../shared/core.js';
import { makeClientId, nextClientId, isGeneratedClientId, derivedClientId } from '../client/src/clientIds.ts';

const client = (id, name = id) => ({ id, name, rounding: 'exact', rate: null, archived: false });
const project = (code, clientId) => ({ code, name: code, clientId, rate: null, billable: true, archived: false });

describe('nextClientId (fix 1: de-collide)', () => {
  it('numbers from one on an empty catalog and counts up', () => {
    expect(nextClientId([])).toBe('client1');
    expect(nextClientId([client('client1')])).toBe('client2');
  });

  // THE bug: `clients.length + 1` reuses an id that is still in use. Three clients,
  // delete the middle one, add one → length is 2 → 'client3' → UNIQUE constraint on
  // `clients.id` → 400 save failed → the client keeps the bad state and every later
  // save fails until the page is reloaded.
  it('does not reuse a live id after a delete-then-add', () => {
    const afterDelete = [client('client1'), client('client3')];
    const minted = nextClientId(afterDelete);
    expect(minted).not.toBe('client3');
    expect(afterDelete.some((c) => c.id === minted)).toBe(false);
  });

  it('skips past a whole run of holes without ever colliding', () => {
    // ids 2..5 exist, 1 was deleted: length+1 = 5, which is taken, and so is 6-1.
    const clients = [client('client2'), client('client3'), client('client4'), client('client5')];
    const minted = nextClientId(clients);
    expect(clients.some((c) => c.id === minted)).toBe(false);
    expect(isGeneratedClientId(minted)).toBe(true);
  });

  it('does not collide with a DERIVED id that happens to look generated', () => {
    // A client literally named "client2" derives the id `client2`.
    const clients = [client('client1'), client('client2', 'client2')];
    expect(nextClientId(clients)).not.toBe('client2');
  });
});

describe('makeClientId (fix 2: readable ids derived from the name)', () => {
  it('slugs a name into a readable, mirror-safe id', () => {
    expect(makeClientId('Ballestad Studios')).toBe('ballestad-studios');
    expect(makeClientId('Brygga')).toBe('brygga');
    expect(makeClientId('  Acme   Co.  ')).toBe('acme-co');
  });

  it('never emits a pipe or any other cell separator the markdown mirror would eat', () => {
    // The id is a CELL in `- client3 | Ballestad Studios | round 15` and the join key in
    // `- LIFE | Lifelines | client3`, so a `|` in the id would need escaping to survive.
    expect(makeClientId('Acme | Co')).toBe('acme-co');
    expect(makeClientId('A/B & C')).toBe('a-b-c');
  });

  it('transliterates Norwegian letters instead of dropping them', () => {
    expect(makeClientId('Fjellheim')).toBe('fjellheim');
    expect(makeClientId('Ålesund')).toBe('alesund');
    expect(makeClientId('Bærum Bygg')).toBe('baerum-bygg');
    expect(makeClientId('Sør-Norge')).toBe('sor-norge');
  });

  it('caps the length and never ends on a dash', () => {
    const id = makeClientId('Ballestad Studios International Holding Company');
    expect(id.length).toBeLessThanOrEqual(24);
    expect(id.endsWith('-')).toBe(false);
  });

  it('returns empty for a name with nothing usable in it', () => {
    expect(makeClientId('   ')).toBe('');
    expect(makeClientId('!!!')).toBe('');
  });

  // ## Verified red-green: 2026-07-26
  // SB-088: there is now exactly ONE slug rule. SB-067 had to keep a second copy of it here
  // because `shared/core.js` was held by another session; the transliteration has since moved
  // into `TT.slug`, so this asserts the copy is gone rather than merely agreeing today. The
  // only remaining difference is the FALLBACK: an unusable name must come back '' here (the
  // caller's answer is "wait, don't derive yet"), where TT.slug's default invents 'task'.
  it.each([
    'Ballestad Studios',
    '  Acme   Co.  ',
    'Acme | Co',
    'Bærum Bygg',
    'Sør-Norge',
    'Ålesund',
    'A\u030Alesund', // Ålesund again, DECOMPOSED — must land on the same id
    'Straße',
    'Ballestad Studios International Holding Company',
  ])('is TT.slug with an empty fallback, for %s', (name) => {
    expect(makeClientId(name)).toBe(TT.slug(name, ''));
  });

  it('differs from TT.slug in exactly one place: the fallback', () => {
    expect(makeClientId('!!!')).toBe('');
    expect(TT.slug('!!!')).toBe('task');
  });
});

describe('derivedClientId (fix 2: derive when the name is first set)', () => {
  const PLACEHOLDER = 'New client';

  it('derives from the name while the client is still on its minted id and unreferenced', () => {
    const clients = [client('client1', 'Brygga'), client('client2', 'Ballestad Studios')];
    expect(derivedClientId(clients, [], 'client2', PLACEHOLDER)).toBe('ballestad-studios');
  });

  it('leaves a client alone once a project references it', () => {
    // Re-pointing Project.clientId server-side is fix 3 (its own ticket). Until then a
    // referenced client keeps its id rather than orphaning the reference.
    const clients = [client('client1', 'Ballestad Studios')];
    const projects = [project('LIFE', 'client1')];
    expect(derivedClientId(clients, projects, 'client1', PLACEHOLDER)).toBeNull();
  });

  it('leaves a client alone once its id is already derived (a second rename is fix 3)', () => {
    const clients = [{ id: 'ballestad-studios', name: 'Ballestad AS', rounding: 'exact', rate: null, archived: false }];
    expect(derivedClientId(clients, [], 'ballestad-studios', PLACEHOLDER)).toBeNull();
  });

  it('leaves the hand-written seed ids alone', () => {
    const clients = [client('fjellheim', 'Fjellheim Hytter'), client('brygga', 'Brygga')];
    expect(derivedClientId(clients, [], 'fjellheim', PLACEHOLDER)).toBeNull();
  });

  it('waits while the name is still the untouched placeholder', () => {
    // Otherwise a stray focus/blur freezes the id at `new-client` and the real name,
    // typed a second later, would never reach it.
    const clients = [client('client1', 'New client')];
    expect(derivedClientId(clients, [], 'client1', PLACEHOLDER)).toBeNull();
    expect(derivedClientId(clients, [], 'client1', 'Ny kunde')).toBe('new-client');
  });

  it('waits while the name has nothing sluggable in it', () => {
    expect(derivedClientId([client('client1', '   ')], [], 'client1', PLACEHOLDER)).toBeNull();
    expect(derivedClientId([client('client1', '???')], [], 'client1', PLACEHOLDER)).toBeNull();
  });

  it('de-collides the derived id against the existing clients', () => {
    const clients = [client('brygga', 'Brygga'), client('client1', 'Brygga')];
    expect(derivedClientId(clients, [], 'client1', PLACEHOLDER)).toBe('brygga-2');
  });

  it('de-collides past a run of taken suffixes', () => {
    const clients = [client('brygga', 'Brygga'), client('brygga-2', 'Brygga'), client('client1', 'Brygga')];
    expect(derivedClientId(clients, [], 'client1', PLACEHOLDER)).toBe('brygga-3');
  });

  it('is a no-op for an unknown id and for a name that derives to the id it already has', () => {
    expect(derivedClientId([], [], 'client1', PLACEHOLDER)).toBeNull();
    expect(derivedClientId([client('client1', 'client1')], [], 'client1', PLACEHOLDER)).toBeNull();
  });

  // ## Verified red-green: 2026-07-26
  // SB-111: the de-collide step used to append past TT.slug's cap — `base + '-2'` is 26
  // characters against 24. It goes through TT.uniqueId now, which truncates the base to make
  // room. The `-2` spelling above is unchanged; only the width is.
  it('de-collides INSIDE the cap rather than growing past it', () => {
    const LONG = 'Ballestad Studios International Holding Company';
    const base = makeClientId(LONG); // 24 characters — already at the cap
    expect(base).toHaveLength(24);
    const clients = [client(base, LONG), client('client1', LONG)];
    const derived = derivedClientId(clients, [], 'client1', PLACEHOLDER);
    expect(derived).toHaveLength(24);
    expect(derived).toBe('ballestad-studios-inte-2');
    expect(clients.some((c) => c.id === derived)).toBe(false);
  });

  it('never hands back an id another client already holds', () => {
    // The property the whole fix exists to guarantee: whatever comes out of the derive is
    // free, so the PUT cannot trip the clients.id PRIMARY KEY.
    const clients = [client('acme'), client('acme-2'), client('acme-3'), client('client9', 'Acme')];
    const derived = derivedClientId(clients, [], 'client9', PLACEHOLDER);
    expect(derived).toBeTruthy();
    expect(clients.some((c) => c.id === derived)).toBe(false);
  });
});
