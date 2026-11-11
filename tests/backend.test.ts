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

  async function pageAnswered(status: number, body: unknown) {
    const sent: { headers: Record<string, string>; body: unknown }[] = [];
    vi.stubEnv('DEV', false);
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
