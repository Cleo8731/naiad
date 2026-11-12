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

/**
 * A folder of its own holding `flow.mmd` and `other.mmd`, and the bridge serving
 * `flow.mmd`, by the path `<folder>/<served>`.
 */
async function bridge(files: Record<string, string | Buffer> = {}, served = 'flow.mmd') {
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
  process.env.NAIAD_FILE = path.join(dir, served);
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
  /** What the page's stream of changes receives while `act` runs (`/api/watch`). */
  const heard = (act: () => void) => new Promise<string>((resolve) => {
    let got = '';
    const req = http.get(`${base}/watch`, { headers: { 'x-naiad': '1' } }, (res) => {
      res.on('data', (c) => { got += c; });
      setTimeout(act, 300);
      setTimeout(() => { req.destroy(); resolve(got); }, 1200);
    });
    req.on('error', () => resolve(got));
  });
  return { dir, file, other: path.join(dir, 'other.mmd'), call, heard, read: (p: string) => fs.readFileSync(p, 'utf8') };
}

describe('the dev page hears of a change whatever the letter case of its path (bug hunt C18)', () => {
  it('a change to the file served is heard', async () => {
    const { file, heard } = await bridge();
    expect(await heard(() => fs.writeFileSync(file, 'flowchart TD\n    a --> c\n'))).toContain('data: changed');
  });

  // Windows does not tell names apart by letter case; Linux does, so there the path names no file.
  it.runIf(process.platform === 'win32')('C18: served by a path typed in other letters than the name on disk', async () => {
    const { file, heard } = await bridge({}, 'FLOW.mmd');
    expect(await heard(() => fs.writeFileSync(file, 'flowchart TD\n    a --> c\n'))).toContain('data: changed');
  });

  it.runIf(process.platform === 'win32')('after the file is renamed to other letters', async () => {
    const { dir, file, heard } = await bridge();
    const renamed = path.join(dir, 'Flow.mmd');
    fs.renameSync(file, renamed);
    await new Promise((r) => setTimeout(r, 200));
    expect(await heard(() => fs.writeFileSync(renamed, 'flowchart TD\n    a --> c\n'))).toContain('data: changed');
  });

  it('a change to another file in the folder is not heard', async () => {
    const { other, heard } = await bridge();
    expect(await heard(() => fs.writeFileSync(other, 'flowchart LR\n    p\n'))).not.toContain('data: changed');
  });
});

describe('a save keeps the name the file has on disk (bug hunt C24)', () => {
  it.runIf(process.platform === 'win32')('C24: served by a path in other letters, a save does not rename the file', async () => {
    const b = await bridge({}, 'FLOW.mmd');
    const shows = path.join(b.dir, 'FLOW.mmd');
    expect((await b.call('/file', { method: 'PUT', body: 'flowchart TD\n    x\n', shows })).status).toBe(200);
    expect(fs.readdirSync(b.dir).sort()).toEqual(['flow.mmd', 'other.mmd']);
    expect(b.read(b.file)).toBe('flowchart TD\n    x\n');
  });

  it('a new file is made under the name given', async () => {
    const b = await bridge({}, 'New.mmd');
    expect((await b.call('/file', { method: 'PUT', body: 'flowchart TD\n    n\n', shows: path.join(b.dir, 'New.mmd') })).status).toBe(200);
    expect(fs.readdirSync(b.dir).sort()).toEqual(['New.mmd', 'flow.mmd', 'other.mmd']);
  });
});

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

describe('the dev page reads only UTF-8 text (bug hunt S23: C16)', () => {
  const LATIN1 = Buffer.from('flowchart TD\n    a[Caf\xe9] --> b\n', 'latin1');

  it('C16: a file that is not UTF-8 is refused, not read with its bytes replaced', async () => {
    const b = await bridge({ 'flow.mmd': LATIN1 });
    const read = await b.call('/file', { shows: b.file });
    expect(read.status).toBe(422);
    expect(read.body.error).toMatch(/not UTF-8/);
    expect(fs.readFileSync(b.file).equals(LATIN1)).toBe(true);
  });

  it('a highlights file that is not UTF-8 is refused too', async () => {
    const b = await bridge();
    fs.mkdirSync(path.join(b.dir, '.naiad', 'flow.mmd'), { recursive: true });
    fs.writeFileSync(path.join(b.dir, '.naiad', 'flow.mmd', 'highlights.txt'), Buffer.from('caf\xe9\n', 'latin1'));
    expect((await b.call('/highlights', { shows: b.file })).status).toBe(422);
  });

  it('UTF-8 with a byte-order mark is read as it is, mark included', async () => {
    const text = '﻿flowchart TD\n    a[Café] --> b\n';
    const b = await bridge({ 'flow.mmd': text });
    expect((await b.call('/file', { shows: b.file })).body.text).toBe(text);
  });
});

describe('the dev page never follows a link in its .naiad folder (bug hunt round 2: F8)', () => {
  // As src-tauri/src/highlights.rs does: a junction, which anyone can make on Windows,
  // would lead the highlights' reads, writes and deletes to files elsewhere.
  it.runIf(process.platform === 'win32')('F8: a junction as .naiad, or as the flowchart\'s folder in it, is refused and kept, and the file elsewhere is untouched', async () => {
    const b = await bridge();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'naiad-outside-'));
    try {
      fs.mkdirSync(path.join(outside, 'flow.mmd'));
      const theirs = path.join(outside, 'flow.mmd', 'highlights.txt');
      fs.writeFileSync(theirs, 'theirs\n');
      const naiad = path.join(b.dir, '.naiad');
      for (const [link, to] of [[naiad, outside], [path.join(naiad, 'flow.mmd'), path.join(outside, 'flow.mmd')]]) {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(to, link, 'junction');
        const got = await b.call('/highlights', { shows: b.file });
        expect(got.status).toBe(500);
        expect(got.body.error).toMatch(/is a link/);
        expect((await b.call('/highlights', { method: 'PUT', body: 'a\n', shows: b.file })).status).toBe(500);
        expect((await b.call('/highlights', { method: 'PUT', body: ' \n', shows: b.file })).status).toBe(500);
        expect(b.read(theirs)).toBe('theirs\n');
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        fs.rmdirSync(link); // the junction only
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
