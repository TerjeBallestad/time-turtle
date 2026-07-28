// SB-162 / DD-024 clause 4 — a `personal` install refuses every non-loopback peer, for the life
// of the process.
//
// THE BUG, MEASURED. Rook reproduced it on 2026-07-27 against Terje's own running instance:
//
//     curl    http://192.168.1.91:3002/api/state                    → 403
//     curl -H 'Host: localhost' http://192.168.1.91:3002/api/state  → 200, {"user":{"role":"admin"}}
//
// with no credentials, from another machine on the wifi. `lsof` showed `node … TCP *:3002 (LISTEN)`.
//
// WHY IT HAPPENS, and why it is this plan's to close rather than a separate cleanup. `BIND_HOST`
// is evaluated ONCE at module load. DD-024 moves the shape question AFTER boot, so on every
// personal install from now on `singleUserShape()` is false at bind time, the every-interface bind
// stands, and the process stays on `0.0.0.0` for its whole life while the shape becomes `personal`
// seconds later — at which point `requireUser`'s no-identity branch starts handing out an admin
// session with no credential, guarded only by the Host header. Before DD-024 that ordering was an
// accident of one person's boot order. After it, it is the standard path.
//
// THE SHAPE MUST BE STORED AT RUNTIME IN EVERY TEST BELOW. An install booted with
// `TT_SHAPE=personal` binds loopback at module load and therefore CANNOT exhibit this bug — a
// suite that did that would be green against the shipped hole.
//
// EVERY LAN REQUEST FORGES `Host: localhost`. A refusal without it re-proves SB-136's header check
// and says nothing about the peer gate, and SB-162 is the standing proof that the two are not the
// same guard.
//
// WHAT THIS DOES NOT DO, and the code comment says so too: it refuses at the HTTP layer and does
// NOT close the port. A port scan still finds the socket and TCP still connects. Re-binding was
// rejected — a runtime close()+listen() can fail and leave a process with no socket at all — so
// the durable fix is the restart the person makes anyway.
//
// ## Verified red-green: 2026-07-28
//   See the stanza above each describe block.
import { describe, it, expect, afterAll } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { TT_DATA_DIR: data, TT_MD_DIR: join(data, 'mirror') };
}

/** A fresh install in the OPEN STATE — no `TT_SHAPE`, so the bind is every interface. */
const open = (label) => ({ ...dataDir(label), TT_SEED_DEMO: '0' });

/** See tests/first-run-open.test.js — throws rather than skipping, for the same reason. */
function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs || []) if (addr.family === 'IPv4' && !addr.internal) return addr.address;
  }
  throw new Error(
    'this environment has no non-loopback IPv4 address, so it cannot decide whether a LAN caller ' +
      'is refused. Not skipped: an unasserted refusal is exactly how SB-162 shipped.',
  );
}

/** One hand-written HTTP/1.1 request to a chosen address with a chosen `Host`. */
function rawRequest(port, { connectTo = '127.0.0.1', method = 'GET', path = '/api/state', host, body } = {}) {
  return new Promise((ok, fail) => {
    const socket = connect(port, connectTo);
    socket.setTimeout(10000, () => {
      socket.destroy();
      fail(new Error(`raw ${method} ${path} to ${connectTo} (Host: ${host}) timed out`));
    });
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host ?? `localhost:${port}`}`];
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

/**
 * Boot an OPEN-STATE server and store a shape at RUNTIME through the first-run door.
 *
 * This is the sequence DD-024 makes standard, and it is the only one that reproduces SB-162: the
 * bind is decided while the shape is still `team`, and the shape moves afterwards.
 */
async function bootThenAnswer(label, shape) {
  const server = await startServer(open(label));
  const answered = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/first-run',
    host: `localhost:${server.port}`,
    body: JSON.stringify({ shape }),
  });
  expect(answered.status, `storing ${shape} through the first-run door failed`).toBe(200);
  return server;
}

// ## Verified red-green: 2026-07-28, TRANSCRIBED.
//   ABSENCE — the peer middleware deleted, i.e. the shipped behaviour SB-162 reported. The three
//   LAN claims fail and the loopback control stays green, which is the bug reproduced in the
//   suite rather than described:
//     FAIL  the exact request Rook used gets nothing — read
//           AssertionError: expected 200 to be 403 // Object.is equality
//     FAIL  a LAN WRITE is refused too — read-only is not the claim
//           AssertionError: expected 200 to be 403 // Object.is equality
//     FAIL  the static client is refused as well, not just /api
//           AssertionError: expected 200 to be 403 // Object.is equality
describe('SB-162: a personal install answers only the machine it runs on', () => {
  it('the exact request Rook used gets nothing — read', async () => {
    const lan = lanAddress();
    const server = await bootThenAnswer('peer-read', 'personal');

    // THE CONTROL. Same server, same port, same absent cookie, same forged-loopback Host — only
    // the peer address differs, so the refusal below cannot be the interface being unreachable.
    const local = await rawRequest(server.port, { connectTo: '127.0.0.1', host: `localhost:${server.port}` });
    expect(local.status).toBe(200);
    expect(local.json.user.id).toBe(1);
    // …and it really is the credential-free implicit session, which is what makes the LAN case bad.
    expect(TT.shapeCapabilities(local.json.shape).identity).toBe(false);

    const remote = await rawRequest(server.port, { connectTo: lan, host: `localhost:${server.port}` });
    expect(remote.status, `a LAN read from ${lan} was answered`).toBe(403);
    expect(remote.json.user).toBeUndefined();
    // Nothing about the caller is reflected back — not the timesheet, not the address it came from.
    expect(remote.raw).not.toMatch(new RegExp(lan.replace(/\./g, '\\.')));

    await stopServer(server.child);
  }, 60000);

  it('a LAN WRITE is refused too — read-only is not the claim', async () => {
    const lan = lanAddress();
    const server = await bootThenAnswer('peer-write', 'personal');

    const entry = { id: 'e1-sb162', date: TT.todayStr(), start: 540, end: 600, project: null, label: 'from the lan' };
    const put = await rawRequest(server.port, {
      connectTo: lan,
      host: `localhost:${server.port}`,
      method: 'PUT',
      body: JSON.stringify({ entries: [entry] }),
    });
    expect(put.status, `a LAN write from ${lan} was accepted`).toBe(403);

    // And it really was refused rather than merely answered oddly: the local read sees no such row.
    const after = await rawRequest(server.port, { connectTo: '127.0.0.1', host: `localhost:${server.port}` });
    expect(after.status).toBe(200);
    expect(after.json.entries.map((e) => e.id)).not.toContain('e1-sb162');

    await stopServer(server.child);
  }, 60000);

  it('the static client is refused as well, not just /api', async () => {
    // Serving the app to the LAN while refusing the API hands out a client that cannot talk to
    // anything, and it is the same bytes-to-the-wrong-network question either way.
    const lan = lanAddress();
    const server = await bootThenAnswer('peer-static', 'personal');

    const local = await rawRequest(server.port, {
      connectTo: '127.0.0.1',
      path: '/',
      host: `localhost:${server.port}`,
    });
    expect(local.status, 'the loopback control did not get the client — is client/dist built?').toBe(200);

    const remote = await rawRequest(server.port, { connectTo: lan, path: '/', host: `localhost:${server.port}` });
    expect(remote.status, `the LAN got the client from ${lan}`).toBe(403);

    await stopServer(server.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-28, TRANSCRIBED. The mutation is THE LEAK — `singleUserShape() &&`
//   dropped from the middleware, so the peer guard applies to every shape. That is the
//   plausible-looking wrong place to put it, and the whole block ABOVE stays green under it, which
//   is why this team contrast is not a duplicate of anything. 4 fail, not 2 — the two bind tests
//   go with them, because they run on `TT_HOST=<lan>` where every caller is a non-loopback peer:
//     FAIL  a team install still serves the network, which is what a team install is for
//     FAIL  a team install serves the client to the network too
//     FAIL  the first-run door is simply unreachable there, so nobody can strand themselves…
//     FAIL  the same refusal guards the door a client can still reach
describe('SB-162: the team shape is untouched — a LAN bind is what a team install is FOR', () => {
  it('a team install still serves the network, which is what a team install is for', async () => {
    const lan = lanAddress();
    const server = await bootThenAnswer('peer-team', 'team');

    // 401, NOT 403. Under `team` the answer to a cookieless request is "who are you", and it must
    // not become "go away" because of where the packet came from.
    const remote = await rawRequest(server.port, { connectTo: lan, host: `localhost:${server.port}` });
    expect(remote.status, `a team install refused ${lan}`).toBe(401);
    expect(remote.json.error).toBe('not authenticated');

    await stopServer(server.child);
  }, 60000);

  it('a team install serves the client to the network too', async () => {
    const lan = lanAddress();
    const server = await bootThenAnswer('peer-team-static', 'team');

    const remote = await rawRequest(server.port, { connectTo: lan, path: '/', host: `localhost:${server.port}` });
    expect(remote.status, `a team install refused the client to ${lan}`).toBe(200);

    await stopServer(server.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-28, TRANSCRIBED. Removing the bind refusal from
//   `shapeStoreRefusal` reddens the second test and leaves the first green — the first is about
//   the peer gate from task 1, which is a different guard:
//     FAIL  the same refusal guards the door a client can still reach
//           AssertionError: expected 200 to be 403 // Object.is equality
describe('DD-024 Amendment 1: storing `personal` on a routable bind is refused', () => {
  // The case clause 4 does NOT cover. With `TT_HOST` unset the bind is every interface, loopback
  // among them, and refusing non-loopback peers is enough. With `TT_HOST` SET to a routable
  // address loopback is never bound AT ALL — so after the answer the process would serve nobody,
  // from anywhere, for the life of the process. Refused at the door instead.
  it('the first-run door is simply unreachable there, so nobody can strand themselves through it', async () => {
    // MEASURED, not assumed, and it is not the refusal DD-024 Amendment 1 predicted. On a
    // routable-only bind every caller who can connect is a non-loopback peer, so task 1's peer
    // gate answers 404 and the bind refusal below it is never reached. That is the SAFE
    // direction — the install cannot answer the question, so it cannot strand itself — but it is
    // SILENT, and the operator learns nothing from a 404. Filed rather than papered over.
    const lan = lanAddress();
    const server = await startServer({ ...open('peer-bind-firstrun'), TT_HOST: lan }, { readyHost: lan });

    const reached = await rawRequest(server.port, {
      connectTo: lan, // loopback is not bound at all here, so this is the only way in
      method: 'POST',
      path: '/api/first-run',
      host: `localhost:${server.port}`,
      body: JSON.stringify({ shape: 'personal' }),
    });
    expect(reached.status).toBe(404);

    // Nothing was stored — the install is still open, and still unable to be asked.
    const still = await rawRequest(server.port, {
      connectTo: lan,
      path: '/api/first-run',
      host: `localhost:${server.port}`,
    });
    expect(still.status).toBe(404);

    await stopServer(server.child);
  }, 60000);

  it('the same refusal guards the door a client can still reach', async () => {
    // A door that refuses less than its siblings is a bypass. `POST /api/shape` is the one that
    // IS reachable here — it takes a cookie, so the peer gate above is not what answers it.
    const lan = lanAddress();
    const server = await startServer({ ...open('peer-bind-doors'), TT_HOST: lan }, { readyHost: lan });

    const login = await rawRequest(server.port, {
      connectTo: lan,
      method: 'POST',
      path: '/api/auth/login',
      host: `localhost:${server.port}`,
      body: JSON.stringify({ email: 'admin@timeturtle.local', password: 'testpw' }),
    });
    expect(login.status).toBe(200);
    const cookie = /set-cookie:\s*([^;\r\n]+)/i.exec(login.raw)[1];

    const viaShapeDoor = await new Promise((ok, fail) => {
      const socket = connect(server.port, lan);
      socket.setTimeout(10000, () => {
        socket.destroy();
        fail(new Error('POST /api/shape timed out'));
      });
      const body = JSON.stringify({ shape: 'personal' });
      let raw = '';
      socket.on('data', (d) => (raw += d));
      socket.on('error', fail);
      socket.on('end', () => ok({ status: +raw.split('\r\n')[0].split(' ')[1], raw }));
      socket.write(
        [
          'POST /api/shape HTTP/1.1',
          `Host: localhost:${server.port}`,
          `Cookie: ${cookie}`,
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      );
    });
    expect(viaShapeDoor.status).toBe(403);
    expect(viaShapeDoor.raw).toMatch(/unset TT_HOST/);

    await stopServer(server.child);
  }, 60000);
});
