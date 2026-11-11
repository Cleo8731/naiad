import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackend } from '../src/backend';

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
