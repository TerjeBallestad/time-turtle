import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopAllServers } from './util.js';

afterAll(stopAllServers);

describe('GET /api/health', () => {
  it('answers without a login when the database works', async () => {
    const { port } = await startServer({ TT_DATA_DIR: mkdtempSync(join(tmpdir(), 'tt-health-')) });
    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
