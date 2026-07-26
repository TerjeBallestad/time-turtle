// SB-067: client ids — minted, de-collided, and derived from the name.
//
// RULED by Terje 2026-07-26: **client ids are readable identifiers, derived from the
// name — not opaque keys.** The id is a visible join key in the markdown Terje reads
// (`- LIFE | Lifelines | client3`, `- client3 | Ballestad Studios | round 15`), and
// in the personal shape that markdown is authoritative rather than derived, so an
// opaque nanoid is a claim the format cannot make.
//
// This module is deliberately pure and free of React/i18n so it can be unit-tested
// without a DOM — the collision bug it fixes lived in `App.tsx` where no test rung
// below `browser` could reach it.

import TT from '../../shared/core.js';

/** The only shape of a client this module needs. */
export type ClientRow = { id: string; name: string };
/** The only shape of a project this module needs — `clientId` is the sole reference to a client. */
export type ProjectRow = { clientId: string | null };

/**
 * A minted, not-yet-named client id. Anything matching this is still ON its generated
 * id, which is what makes it safe to re-derive when the name is finally set.
 */
const GENERATED = /^client\d+$/;

/** True while the client still carries the id `addClient` minted for it. */
export function isGeneratedClientId(id: string): boolean {
  return GENERATED.test(id);
}

/**
 * The id for a brand-new client, which has no name yet (`addClient` creates the row
 * first and lets the user type over the placeholder).
 *
 * FIX 1 (SB-067). This used to be `'client' + (clients.length + 1)` and nothing else.
 * A positional counter reuses ids the moment the list has a hole in it: three clients,
 * archive/delete the middle one, add one → length 2 → `client3`, which still exists.
 * `clients.id` is a TEXT PRIMARY KEY and `putClients` is a plain INSERT, so the PUT dies
 * on a UNIQUE constraint inside `db.transaction` and comes back `400 save failed`. The
 * client keeps the bad state in memory and re-sends it on every debounce, so EVERY later
 * save fails too until the page is reloaded — a positional counter is a save-lock.
 * `createProject` has guarded against exactly this with a while-loop since it was written.
 */
export function nextClientId(clients: readonly ClientRow[]): string {
  const taken = new Set(clients.map((client) => client.id));
  let n = clients.length + 1;
  while (taken.has('client' + n)) n++;
  return 'client' + n;
}

/**
 * A readable id derived from a client name: lowercase, ASCII, dash-separated, capped.
 *
 * SB-088: this IS `TT.slug` now. SB-067 had to keep a second, transliterating copy of the
 * rule here because `shared/core.js` was held by another session at that moment, which left
 * two slug rules disagreeing about the language the catalog is written in — "Bærum" was
 * `baerum` here and `b-rum` there. The transliteration has moved into `TT.slug`; the only
 * thing left on this side is the empty FALLBACK, because an unusable name must stay
 * distinguishable from a usable one: the caller's answer is "wait, don't derive yet", not
 * "invent something".
 *
 * Returns '' when the name has nothing sluggable in it.
 */
export function makeClientId(name: string): string {
  return TT.slug(name, '');
}

/**
 * FIX 2 (SB-067). The id a client SHOULD take now that its name has been committed, or
 * null to leave it exactly as it is.
 *
 * `addClient` cannot derive at creation time — it makes the row before the name exists
 * (the name defaults to a placeholder the user types over). So the derive happens at the
 * one later moment it is still free: the first time the name is committed, while
 *
 *   - the client is still on the id `nextClientId` minted (`client7`), i.e. nobody has
 *     ever seen a meaningful id for it, and
 *   - **no project references it** — `Project.clientId` is the only reference to a client
 *     anywhere in the model (entries and templates carry project CODES, not client ids),
 *     so an unreferenced client's id can be rewritten with nothing left pointing at the
 *     old value. Once something references it, changing the id is a server-reconciled
 *     rename — fix 3, its own ticket — and this returns null instead.
 *
 * The result is de-collided against the other clients, so it can never reintroduce the
 * duplicate-id save-lock that fix 1 removes.
 *
 * @param placeholder the untouched default name (`TT.t('New client')`). A name still
 * equal to it is not a name yet: deriving `new-client` from it would burn the one
 * derivation the client gets, and the real name typed a second later would never reach
 * the id.
 */
export function derivedClientId(
  clients: readonly ClientRow[],
  projects: readonly ProjectRow[],
  id: string,
  placeholder = '',
): string | null {
  const client = clients.find((candidate) => candidate.id === id);
  if (!client) return null;
  if (!isGeneratedClientId(client.id)) return null; // already derived, or hand-written seed
  if (projects.some((project) => project.clientId === client.id)) return null; // referenced → fix 3
  const name = client.name.trim();
  if (!name || name === placeholder.trim()) return null; // not named yet
  const base = makeClientId(name);
  if (!base) return null; // nothing sluggable — keep the minted id rather than invent one
  const taken = new Set(clients.filter((candidate) => candidate.id !== client.id).map((c) => c.id));
  let next = base;
  for (let n = 2; taken.has(next); n++) next = base + '-' + n;
  return next === client.id ? null : next;
}
