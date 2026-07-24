// SB-014: session cookies are scoped by host, not port, so two dev instances on
// localhost (e.g. backend :3001 vs :3099) share one 'tt_session' cookie and clobber
// each other — and because each instance has its own SECRET, the survivor's token
// fails HMAC verification on the other, 401-ing every request. The cookie name is now
// suffixed with the port for non-default instances (the default instance keeps the
// bare name so its existing sessions survive). auth.js is loaded twice under different
// PORT values to prove both the emitted name and that a non-default instance ignores
// the default instance's cookie — the isolation that stops the clobber.
//
// ## Verified red-green: 2026-07-23
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// auth.js -> config.js mkdirs DATA_DIR and writes a .secret on load. Point both at a
// throwaway dir and pin the secret so token signing is deterministic across reloads.
const DATA = mkdtempSync(join(tmpdir(), 'tt-cookie-'));
const ORIG = { PORT: process.env.PORT, DATA: process.env.TT_DATA_DIR, SECRET: process.env.TT_SECRET };

async function loadAuth(port) {
  process.env.TT_DATA_DIR = DATA;
  process.env.TT_SECRET = 'test-secret';
  if (port === undefined) delete process.env.PORT;
  else process.env.PORT = String(port);
  vi.resetModules();
  return import('../server/src/auth.js');
}

const header = (name, token) => ({ headers: { cookie: `${name}=${encodeURIComponent(token)}` } });

afterAll(() => {
  for (const [k, v] of [
    ['PORT', ORIG.PORT],
    ['TT_DATA_DIR', ORIG.DATA],
    ['TT_SECRET', ORIG.SECRET],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

describe('SB-014 session cookie name', () => {
  it('the default instance (:3001) keeps the bare tt_session name', async () => {
    const auth = await loadAuth(undefined);
    const token = auth.makeToken(1, 0);
    expect(auth.sessionCookie(token).startsWith('tt_session=')).toBe(true);
    expect(auth.clearCookie.startsWith('tt_session=')).toBe(true);
    expect(auth.readSessionCookie(header('tt_session', token))).toEqual({ userId: 1, tokenVersion: 0 });
  });

  it('a non-default instance (:3099) uses a port-suffixed name', async () => {
    const auth = await loadAuth(3099);
    const token = auth.makeToken(2, 0);
    expect(auth.sessionCookie(token).startsWith('tt_session_3099=')).toBe(true);
    expect(auth.clearCookie.startsWith('tt_session_3099=')).toBe(true);
    expect(auth.readSessionCookie(header('tt_session_3099', token))).toEqual({ userId: 2, tokenVersion: 0 });
  });

  it('a non-default instance ignores the default instance cookie (no clobber)', async () => {
    const auth = await loadAuth(3099);
    // A validly-signed token under a 'tt_session' name — what the :3001 instance would
    // leave in the shared jar. The :3099 instance must not read it as its own session.
    const token = auth.makeToken(3, 0);
    expect(auth.readSessionCookie(header('tt_session', token))).toBe(null);
  });
});
