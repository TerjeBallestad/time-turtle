// The LAN bind — a Time Turtle install answers the network, which is what a team install is for.
//
// With no `TT_HOST` the server binds every interface: a colleague on the same network reaches the
// app and meets the login. These tests prove it by CONNECTING over this machine's own LAN address.
// Reading the bind argument would prove nothing — a test that asserted the value would pass against
// a server that ignored it.
//
// Moved here from personal-peer-guard.test.js and personal-no-login.test.js when the shape concept
// was removed (SB-181). Each test lost only its shape part: the install answers the first run with
// `{ demo: false }` instead of storing a shape, and nothing sets `TT_SHAPE`.
//
// ## Verified red-green: 2026-09-17, MEASURED HERE — not transcribed. The source stanza's mutation
// was `singleUserShape() &&` dropped from the peer-guard middleware, and SB-181 deleted that
// middleware, so there was nothing left to transcribe. Two new mutations, both run on this branch:
//   break 1 — `app.listen({ port: PORT, host: HOST || undefined })` → `HOST || '127.0.0.1'`
//     (server/src/index.js): 2 of 3 fail, the two that connect over this machine's LAN address.
//     `TT_HOST=0.0.0.0 binds every interface` stays green, as it must — it sets HOST explicitly,
//     so the default is not what it is testing. That contrast is the point of keeping all three.
//   break 2 — move `client/dist` aside and run with no built client: only `a team install serves
//     the client to the network too` fails, because the server registers express.static and the
//     SPA fallback only when the build exists. This is why CI builds before it tests.
import { describe, it, expect, afterAll } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer, stopAllServers } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  return { TT_DATA_DIR: mkdtempSync(join(tmpdir(), 'tt-' + label + '-')) };
}

/** A fresh install with its first run still open. */
const open = (label) => ({ ...dataDir(label), TT_SEED_DEMO: '0' });

/**
 * This machine's own non-loopback IPv4 — the address a colleague on the same wifi would type.
 *
 * It throws rather than skipping when there is no such address: an unasserted LAN claim is a green
 * run that proved nothing.
 */
function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs || []) if (addr.family === 'IPv4' && !addr.internal) return addr.address;
  }
  throw new Error(
    'this environment has no non-loopback IPv4 address, so it cannot decide whether the LAN is ' +
      'served. Not skipped: an unasserted LAN claim proves nothing.',
  );
}

/** Can this port be reached on `host` at all? A refused/timed-out connection resolves false. */
async function reachableOn(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}/api/me`, { signal: AbortSignal.timeout(3000) });
    return !!res.status;
  } catch {
    return false;
  }
}

/** One hand-written HTTP/1.1 request to a chosen address with a chosen `Host`. */
function rawRequest(port, { connectTo = '127.0.0.1', method = 'GET', path = '/api/state', host, body, cookie } = {}) {
  return new Promise((ok, fail) => {
    const socket = connect(port, connectTo);
    socket.setTimeout(10000, () => {
      socket.destroy();
      fail(new Error(`raw ${method} ${path} to ${connectTo} (Host: ${host}) timed out`));
    });
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host ?? `localhost:${port}`}`];
    if (cookie) lines.push(`Cookie: ${cookie}`);
    if (body !== undefined) {
      lines.push('Content-Type: application/json');
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    }
    lines.push('Connection: close', '', body ?? '');
    let raw = '';
    socket.on('data', (d) => (raw += d));
    socket.on('error', fail);
    socket.on('end', () => {
      const head = raw.split('\r\n\r\n')[0];
      const rest = raw.slice(head.length + 4);
      let json = null;
      try {
        json = JSON.parse(rest);
      } catch {
        /* not a JSON body */
      }
      ok({ status: +head.split('\r\n')[0].split(' ')[1], json, raw });
    });
    socket.write(lines.join('\r\n'));
  });
}

/** Boot a fresh install and answer its first run through the loopback door. */
async function bootThenAnswer(label) {
  const server = await startServer(open(label));
  const answered = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/first-run',
    host: `localhost:${server.port}`,
    body: JSON.stringify({ demo: false }),
  });
  expect(answered.status, 'answering the first run failed').toBe(200);
  return server;
}

describe('a LAN bind is what a team install is FOR', () => {
  it('a team install still serves the network, which is what a team install is for', async () => {
    const lan = lanAddress();
    const server = await bootThenAnswer('lan-api');

    // 401, NOT 403. The answer to a cookieless request is "who are you", and it must not become
    // "go away" because of where the packet came from.
    const remote = await rawRequest(server.port, { connectTo: lan, host: `localhost:${server.port}` });
    expect(remote.status, `the install refused ${lan}`).toBe(401);
    expect(remote.json.error).toBe('not authenticated');

    await stopServer(server.child);
  }, 60000);

  it('a team install serves the client to the network too', async () => {
    const lan = lanAddress();
    const server = await bootThenAnswer('lan-static');

    const remote = await rawRequest(server.port, { connectTo: lan, path: '/', host: `localhost:${server.port}` });
    expect(remote.status, `the install refused the client to ${lan}`).toBe(200);

    await stopServer(server.child);
  }, 60000);

  it('TT_HOST=0.0.0.0 binds every interface', async () => {
    const lan = lanAddress();
    const server = await startServer({ ...dataDir('lan-host'), TT_HOST: '0.0.0.0' });
    expect(await reachableOn(lan, server.port)).toBe(true);
    await stopServer(server.child);
  }, 60000);
});
