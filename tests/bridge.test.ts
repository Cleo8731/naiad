// The file bridge of the dev page (`npm run dev`, dev/bridge.ts), run on a real local
// server against files in a temporary folder. From the bug hunt's area C.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileBridge } from '../dev/bridge';
import { fnv1a64 } from '../src/core/hash';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** A folder of its own holding `flow.mmd` and `other.mmd`, and the bridge serving `flow.mmd`. */
async function bridge(files: Record<string, string | Buffer> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naiad-bridge-'));
  const all = { 'flow.mmd': 'flowchart TD\n    a --> b\n', 'other.mmd': 'flowchart LR\n    o\n', ...files };
  for (const [name, text] of Object.entries(all)) fs.writeFileSync(path.join(dir, name), text);
  const file = path.join(dir, 'flow.mmd');
  const handlers: [string, Handler][] = [];
  const server = http.createServer((req, res) => {
    const found = handlers.find(([prefix]) => req.url!.startsWith(prefix));
    if (!found) { res.statusCode = 404; res.end(); return; }
    req.url = req.url!.slice(found[0].length) || '/';
    found[1](req, res, () => {});
  });
  const before = process.env.NAIAD_FILE;
  process.env.NAIAD_FILE = file;
  (fileBridge().configureServer as (s: unknown) => void)({ httpServer: server, middlewares: { use: (p: string, fn: Handler) => handlers.push([p, fn]) } });
  process.env.NAIAD_FILE = before;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  stops.push(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  /** A request as the page makes it (`src/backend.ts`), naming the file it shows when given. */
  const call = async (route: string, init: { method?: string; body?: string; shows?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { 'x-naiad': '1', ...(init.headers ?? {}) };
    if (init.shows) headers['x-naiad-path'] = encodeURIComponent(init.shows);
    const res = await fetch(base + route, { method: init.method ?? 'GET', body: init.body, headers });
    return { status: res.status, body: await res.json() };
  };
  return { dir, file, other: path.join(dir, 'other.mmd'), call, read: (p: string) => fs.readFileSync(p, 'utf8') };
}

describe('the dev page writes only the file it shows (bug hunt S21: C14)', () => {
  it('C14: after another view opens another file, a save from the first view is refused and both files stay', async () => {
    const b = await bridge();
    const first = (await b.call('/file')).body.path as string;
    expect(first).toBe(b.file);
    const before = b.read(b.file);
    expect((await b.call('/open', { method: 'POST', body: b.other })).status).toBe(200); // the second view
    const save = await b.call('/file', { method: 'PUT', body: 'flowchart TD\n    undone\n', shows: first });
    expect(save.status).toBe(400);
    expect(save.body.error).toMatch(/another file/);
    expect(b.read(b.other)).toBe('flowchart LR\n    o\n');
    expect(b.read(b.file)).toBe(before);
    expect((await b.call('/file', { shows: first })).status).toBe(400);
    expect((await b.call('/highlights', { method: 'PUT', body: 'a\n', shows: first })).status).toBe(400);
    expect(fs.existsSync(path.join(b.dir, '.naiad'))).toBe(false);
  });

  it('a save that names no file is refused; one naming the file served is written', async () => {
    const b = await bridge();
    expect((await b.call('/file', { method: 'PUT', body: 'flowchart TD\n    x\n' })).status).toBe(400);
    expect(b.read(b.file)).toBe('flowchart TD\n    a --> b\n');
    expect((await b.call('/file', { method: 'PUT', body: 'flowchart TD\n    x\n', shows: b.file })).status).toBe(200);
    expect(b.read(b.file)).toBe('flowchart TD\n    x\n');
    expect((await b.call('/file', { shows: b.file })).body.text).toBe('flowchart TD\n    x\n');
  });

  it('a save naming the text it read is still checked against the file', async () => {
    const b = await bridge();
    const read = b.read(b.file);
    fs.writeFileSync(b.file, read + '%% agent\n');
    const expect409 = await b.call('/file', { method: 'PUT', body: 'flowchart LR\n', shows: b.file, headers: { 'x-naiad-expect': fnv1a64(Buffer.from(read)) } });
    expect(expect409.status).toBe(409);
    expect(b.read(b.file)).toBe(read + '%% agent\n');
  });
});

describe('the dev page never leaves or reuses a temporary file (bug hunt S22: C15)', () => {
  const names = (dir: string) => fs.readdirSync(dir).sort();

  it('C15: a save whose rename fails (the file is read-only) leaves nothing beside the file', async () => {
    const b = await bridge();
    const before = names(b.dir);
    fs.chmodSync(b.file, 0o444);
    try {
      const save = await b.call('/file', { method: 'PUT', body: 'flowchart TD\n    x\n', shows: b.file });
      expect(save.status).toBe(500);
      expect(names(b.dir)).toEqual(before);
      expect(b.read(b.file)).toBe('flowchart TD\n    a --> b\n');
    } finally {
      fs.chmodSync(b.file, 0o644);
    }
  });

  it('a file of the user\'s named like a temporary file is never touched', async () => {
    const mine = { [`flow.mmd.${process.pid}.tmp`]: 'mine\n', [`.naiad-${process.pid}-0.tmp`]: 'mine too\n' };
    const b = await bridge(mine);
    expect((await b.call('/file', { method: 'PUT', body: 'flowchart TD\n    x\n', shows: b.file })).status).toBe(200);
    expect((await b.call('/highlights', { method: 'PUT', body: 'a\n', shows: b.file })).status).toBe(200);
    for (const [name, text] of Object.entries(mine)) expect(b.read(path.join(b.dir, name))).toBe(text);
    expect(b.read(b.file)).toBe('flowchart TD\n    x\n');
    expect(names(b.dir)).toEqual(['.naiad', ...Object.keys(mine), 'flow.mmd', 'other.mmd'].sort());
    expect(fs.readdirSync(path.join(b.dir, '.naiad', 'flow.mmd'))).toEqual(['highlights.txt']);
  });
});
