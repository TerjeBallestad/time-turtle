// Shared test helpers.
//
// freePort() takes a port from the OS (listen on 0, read the assigned port, close)
// rather than guessing one. A hardcoded port is a latent flake: any leftover dev
// server on it answers our readiness probes, the real child dies with EADDRINUSE,
// and the suite fails for the wrong reason (a misleading 401-instead-of-200). See
// SB-012 — this helper started life inside md-dir-lock.test.js.
import { createServer } from 'node:net';

export function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}
