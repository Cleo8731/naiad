import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackend } from '../src/backend';
import { fnv1a64 } from '../src/core/hash';

// A page whose server has stopped: every request fails before any answer, as a
// browser's fetch does when nothing listens at the address any more.
async function pageWithoutServer(dev: boolean) {
  vi.stubEnv('DEV', dev);
  vi.stubGlobal('window', {}); // no desktop shell
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
  return createBackend();
}

describe('a page in a browser whose server has stopped', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('npm run dev: says the development server is gone, not "Failed to fetch"', async () => {
    const backend = await pageWithoutServer(true);
    expect(backend.kind).toBe('browser');
    const lost = 'the connection to the development server is lost. Start it again with npm run dev, then reload this page.';
    await expect(backend.writeHighlights('flow.mmd', 'collect\n')).rejects.toThrow(lost);
    await expect(backend.write('flow.mmd', 'flowchart TD\n')).rejects.toThrow(lost);
    await expect(backend.read('flow.mmd')).rejects.toThrow(lost);
  });

  it('naiad serve: says the connection to Naiad is lost', async () => {
    const backend = await pageWithoutServer(false);
    expect(backend.kind).toBe('served');
    await expect(backend.writeHighlights('flow.mmd', 'collect\n')).rejects.toThrow(
      'the connection to Naiad is lost. Ask the agent to show the flowchart again.',
    );
  });
});

describe('a save in a browser names the text it read (bug hunt S17, C7)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function pageAnswered(status: number, body: unknown, dev = false) {
    const sent: { headers: Record<string, string>; body: unknown }[] = [];
    vi.stubEnv('DEV', dev);
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push({ headers: init.headers as Record<string, string>, body: init.body });
      return new Response(JSON.stringify(body), { status });
    });
    return { backend: await createBackend(), sent };
  }

  it('sends the hash of the text read, and says false when the server answers 409', async () => {
    const { backend, sent } = await pageAnswered(409, { error: 'The file changed on disk after it was read.', changed: true });
    await expect(backend.write('flow.mmd', 'new', 'café\r\n')).resolves.toBe(false);
    expect(sent[0].headers['x-naiad-expect']).toBe(fnv1a64(new TextEncoder().encode('café\r\n')));
    expect(sent[0].body).toBe('new');
  });

  it('says true when the write is made, and sends no hash when none is given', async () => {
    const { backend, sent } = await pageAnswered(200, { ok: true });
    await expect(backend.write('flow.mmd', 'new', 'old')).resolves.toBe(true);
    await expect(backend.write('flow.mmd', 'new')).resolves.toBe(true);
    expect('x-naiad-expect' in sent[1].headers).toBe(false);
  });

  it('the dev page names the file it shows on every read and write (bug hunt S21: C14)', async () => {
    const { backend, sent } = await pageAnswered(200, { text: '' }, true);
    const file = 'D:/Flow charts/plan é.mmd';
    await backend.read(file);
    await backend.write(file, 'new', 'old');
    await backend.readHighlights(file);
    await backend.writeHighlights(file, 'a\n');
    expect(sent.map((s) => decodeURIComponent(s.headers['x-naiad-path']))).toEqual([file, file, file, file]);
    expect(sent[1].headers['x-naiad-expect']).toBe(fnv1a64(new TextEncoder().encode('old')));
  });

  it('a page from naiad serve does not send it (that server serves one file)', async () => {
    const { backend, sent } = await pageAnswered(200, { text: '' });
    await backend.read('flow.mmd');
    await backend.write('flow.mmd', 'new');
    expect(sent.every((s) => !('x-naiad-path' in s.headers))).toBe(true);
  });

  it('a highlights write names the text read too, and says false on 409 (bug hunt round 4, E16)', async () => {
    const { backend, sent } = await pageAnswered(409, { error: 'The file changed on disk after it was read.', changed: true });
    await expect(backend.writeHighlights('flow.mmd', 'a\nb\n', 'a\n')).resolves.toBe(false);
    expect(sent[0].headers['x-naiad-expect']).toBe(fnv1a64(new TextEncoder().encode('a\n')));
    const made = await pageAnswered(200, { ok: true });
    await expect(made.backend.writeHighlights('flow.mmd', '')).resolves.toBe(true);
    expect('x-naiad-expect' in made.sent[0].headers).toBe(false); // Clear names nothing
  });

  it('still fails on any other error', async () => {
    const { backend } = await pageAnswered(500, { error: 'disk full' });
    await expect(backend.write('flow.mmd', 'new', 'old')).rejects.toThrow('disk full');
  });
});

describe('the hash is FNV-1a, 64 bits', () => {
  it('gives the published test values, and the same as a plain BigInt version', () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(fnv1a64(bytes(''))).toBe('cbf29ce484222325');
    expect(fnv1a64(bytes('a'))).toBe('af63dc4c8601ec8c');
    expect(fnv1a64(bytes('foobar'))).toBe('85944171f73967e8');
    const plain = (b: Uint8Array) => {
      let h = 0xcbf29ce484222325n;
      for (const x of b) h = BigInt.asUintN(64, (h ^ BigInt(x)) * 0x100000001b3n);
      return h.toString(16).padStart(16, '0');
    };
    const random = new Uint8Array(5000).map((_, i) => (i * 7919 + 13) % 256);
    expect(fnv1a64(random)).toBe(plain(random));
  });
});

describe('a page from naiad serve says when it closes (bug hunt round 3: oF5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function page(dev: boolean) {
    const handlers = new Map<string, (e: unknown) => void>();
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubEnv('DEV', dev);
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (e: unknown) => void) => { handlers.set(type, fn); },
      removeEventListener: (type: string) => { handlers.delete(type); },
    });
    vi.stubGlobal('EventSource', class { close() {} });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response('{"ok":true}'); });
    const backend = await createBackend();
    const stop = await backend.watch('flow.mmd', () => {});
    return { handlers, calls, stop };
  }

  it('oF5: closing sends a goodbye, so a page that only lost its connection keeps its highlights', async () => {
    const { handlers, calls } = await page(false);
    handlers.get('pagehide')!({ persisted: false });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('api/bye');
    expect(calls[0][1]).toMatchObject({ method: 'PUT', keepalive: true, headers: { 'x-naiad': '1' } });
  });

  it('a page kept for Back sends none, nor does the dev page, nor a page that stopped watching', async () => {
    const kept = await page(false);
    kept.handlers.get('pagehide')!({ persisted: true });
    expect(kept.calls).toHaveLength(0);
    vi.unstubAllGlobals();
    const dev = await page(true);
    dev.handlers.get('pagehide')!({ persisted: false });
    expect(dev.calls).toHaveLength(0);
    vi.unstubAllGlobals();
    const stopped = await page(false);
    stopped.stop();
    expect(stopped.handlers.has('pagehide')).toBe(false);
  });
});
