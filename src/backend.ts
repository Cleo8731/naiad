// File access. The desktop app talks to the Rust shell (src-tauri/src/lib.rs). In a
// browser the same calls go to a server: the app itself, started as
// `naiad serve <file>` (src-tauri/src/serve.rs), or, during development, the Vite file
// bridge (dev/bridge.ts). The page never names the highlights file: each of them finds
// it beside the flowchart's file (src-tauri/src/highlights.rs).

import { fnv1a64 } from './core/hash';

/** A run of the checker from a terminal: `naiad check <file>...` or `naiad fix <file>...`. */
export interface CliJob {
  mode: 'check' | 'fix';
  /** Each file as it was typed, and its full path. */
  files: { name: string; path: string }[];
}

export interface Backend {
  /** "served": in a browser, from `naiad serve <file>`: that one file, no Open and no New. */
  kind: 'desktop' | 'browser' | 'served';
  /** The checker's job, when the app was started as `naiad check` or `naiad fix`. */
  cliJob(): Promise<CliJob | null>;
  /** Prints the checker's result and ends the program. */
  cliDone(code: number, output: string): Promise<void>;
  /** The file the app was started with, if any. */
  initialPath(): Promise<string | null>;
  read(path: string): Promise<string>;
  /**
   * Writes the file whole. Given `expected` (the file's text as read), it writes only
   * if the file still holds exactly that, checked just before the file is replaced;
   * otherwise it writes nothing and returns false (an agent saved meanwhile).
   */
  write(path: string, text: string, expected?: string): Promise<boolean>;
  /** Calls back whenever the file changes on disk. Returns a function that stops it. */
  watch(path: string, onChange: () => void): Promise<() => void>;
  /** The flowchart's highlights file (`.naiad/<name>/highlights.txt`), or null if there is none. */
  readHighlights(path: string): Promise<string | null>;
  /** Writes the highlights file whole; '' deletes it, and the folders left empty. */
  writeHighlights(path: string, text: string): Promise<void>;
  /**
   * Says which flowchart this view shows, so that the highlights file is deleted when
   * the last view of a flowchart closes. In the in-browser version the server does this.
   */
  viewing(path: string): void;
  pickOpen(): Promise<string | null>;
  pickSave(suggestedName: string): Promise<string | null>;
  openLink(url: string): void;
  setWindowTitle(title: string): void;
  /** Asks the person a yes-or-no question; true for yes. */
  confirm(message: string): Promise<boolean>;
  /**
   * The desktop app's window closes only once `canClose` says so (in a browser the page
   * asks through `beforeunload` instead). If `canClose` fails, the window closes.
   */
  guardClose(canClose: () => Promise<boolean>): void;
}

const NEW_FILTERS = [{ name: 'Mermaid flowchart', extensions: ['mmd', 'mermaid'] }];
const OPEN_FILTERS = [
  { name: 'Flowcharts (Mermaid, Markdown)', extensions: ['mmd', 'mermaid', 'md', 'markdown'] },
  ...NEW_FILTERS,
  { name: 'Markdown', extensions: ['md', 'markdown'] },
];

async function desktop(): Promise<Backend> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const dialog = await import('@tauri-apps/plugin-dialog');
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return {
    kind: 'desktop',
    async cliJob() {
      const job = await invoke<[string, [string, string][]] | null>('cli_job');
      if (!job) return null;
      return { mode: job[0] as CliJob['mode'], files: job[1].map(([name, path]) => ({ name, path })) };
    },
    cliDone: (code, output) => invoke<void>('cli_done', { code, output }),
    initialPath: () => invoke<string | null>('initial_file'),
    read: (path) => invoke<string>('read_file', { path }),
    write: (path, text, expected) => invoke<boolean>('write_file', { path, contents: text, expected: expected ?? null }),
    async watch(path, onChange) {
      // One save can raise several events (write, rename); wait for them to settle.
      let timer: number | undefined;
      const unlisten = await listen<string>('file-changed', (e) => {
        if (e.payload !== path) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(onChange, 80);
      });
      await invoke('watch_file', { path });
      return () => { window.clearTimeout(timer); unlisten(); };
    },
    readHighlights: (path) => invoke<string | null>('read_highlights', { path }),
    writeHighlights: (path, text) => invoke<void>('write_highlights', { path, contents: text }),
    viewing: (path) => { void invoke('view_file', { path }).catch(() => {}); },
    async pickOpen() {
      const picked = await dialog.open({ multiple: false, directory: false, filters: OPEN_FILTERS });
      return typeof picked === 'string' ? picked : null;
    },
    pickSave: (suggestedName) => dialog.save({ defaultPath: suggestedName, filters: NEW_FILTERS }),
    openLink: (url) => { void invoke('open_link', { url }); },
    setWindowTitle: (title) => { void getCurrentWindow().setTitle(title); },
    confirm: (message) => dialog.ask(message, { title: 'Naiad', kind: 'warning' }),
    guardClose(canClose) {
      void getCurrentWindow().onCloseRequested(async (event) => {
        let close = true;
        try {
          close = await canClose();
        } catch (e) {
          console.error(e); // never keep the window from closing
        }
        if (!close) event.preventDefault();
      });
    },
  };
}

// The addresses are relative: the app's server keeps the page and its calls under a
// folder named by its secret, which every request must carry.
function browser(): Backend {
  // A built page that is not in the desktop app can only have come from `naiad serve`.
  const served = !import.meta.env.DEV;
  const call = async (url: string, init?: RequestInit) => {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { 'x-naiad': '1', ...(init?.headers ?? {}) } });
    } catch {
      // No answer at all: the server has stopped. `naiad serve` ends by itself ten
      // minutes after its last page was closed; `npm run dev` ends when it is stopped,
      // and its page stays open looking as it did.
      throw new Error(served
        ? 'the connection to Naiad is lost. Ask the agent to show the flowchart again.'
        : 'the connection to the development server is lost. Start it again with npm run dev, then reload this page.');
    }
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status})`), { status: res.status });
    return body;
  };
  // The file the page shows, so that the dev page's server refuses a request meant for
  // another (dev/bridge.ts). `naiad serve` serves one file only: it is not sent there.
  const shows = (path: string): Record<string, string> => (served ? {} : { 'x-naiad-path': encodeURIComponent(path) });
  return {
    kind: served ? 'served' : 'browser',
    cliJob: async () => null,
    cliDone: async () => {},
    initialPath: async () => (await call('api/file')).path,
    read: async (path) => (await call('api/file', { headers: shows(path) })).text,
    async write(path, text, expected) {
      // The text read is named by its hash; the server answers 409 if the file's bytes differ.
      const headers: Record<string, string> = expected === undefined ? shows(path) : { ...shows(path), 'x-naiad-expect': fnv1a64(new TextEncoder().encode(expected)) };
      try {
        await call('api/file', { method: 'PUT', body: text, headers });
        return true;
      } catch (e) {
        if ((e as { status?: number }).status === 409) return false;
        throw e;
      }
    },
    async watch(_path, onChange) {
      const es = new EventSource('api/watch');
      es.onmessage = () => onChange();
      // After a break in the connection (the computer slept), look at the file again.
      let broken = false;
      es.onerror = () => { broken = true; };
      es.onopen = () => { if (broken) { broken = false; onChange(); } };
      // A page that closes says so: `naiad serve` then deletes the highlights once no
      // page of the flowchart is left. One that only lost its connection (the computer
      // slept) keeps them (bug hunt round 3, oF5). The dev page's server keeps no views.
      const bye = (e: PageTransitionEvent) => {
        if (served && !e.persisted) void fetch('api/bye', { method: 'PUT', keepalive: true, headers: { 'x-naiad': '1' } }).catch(() => {});
      };
      window.addEventListener('pagehide', bye);
      return () => { es.close(); window.removeEventListener('pagehide', bye); };
    },
    readHighlights: async (path) => (await call('api/highlights', { headers: shows(path) })).text,
    writeHighlights: async (path, text) => { await call('api/highlights', { method: 'PUT', body: text, headers: shows(path) }); },
    viewing: () => {},
    async pickOpen() {
      if (served) return null;
      const typed = window.prompt('Full path of the .mmd or .md file to open:');
      if (!typed) return null;
      return (await call('api/open', { method: 'POST', body: typed })).path;
    },
    pickSave: async () => null,
    openLink: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
    setWindowTitle: (title) => { document.title = title; },
    confirm: async (message) => window.confirm(message),
    guardClose: () => {},
  };
}

export async function createBackend(): Promise<Backend> {
  return '__TAURI_INTERNALS__' in window ? desktop() : browser();
}
