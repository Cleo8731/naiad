// File access. The desktop app talks to the Rust shell (src-tauri/src/lib.rs). In a
// browser the same calls go to a server: the app itself, started as
// `naiad serve <file>` (src-tauri/src/serve.rs), or, during development, the Vite file
// bridge (dev/bridge.ts).

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
  write(path: string, text: string): Promise<void>;
  /** Calls back whenever the file changes on disk. Returns a function that stops it. */
  watch(path: string, onChange: () => void): Promise<() => void>;
  pickOpen(): Promise<string | null>;
  pickSave(suggestedName: string): Promise<string | null>;
  openLink(url: string): void;
  setWindowTitle(title: string): void;
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
    write: (path, text) => invoke<void>('write_file', { path, contents: text }),
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
    async pickOpen() {
      const picked = await dialog.open({ multiple: false, directory: false, filters: OPEN_FILTERS });
      return typeof picked === 'string' ? picked : null;
    },
    pickSave: (suggestedName) => dialog.save({ defaultPath: suggestedName, filters: NEW_FILTERS }),
    openLink: (url) => { void invoke('open_link', { url }); },
    setWindowTitle: (title) => { void getCurrentWindow().setTitle(title); },
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
    } catch (e) {
      if (!served) throw e;
      // The server ends by itself ten minutes after its last page was closed.
      throw new Error('the connection to Naiad is lost. Ask the agent to show the flowchart again.');
    }
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
    return body;
  };
  return {
    kind: served ? 'served' : 'browser',
    cliJob: async () => null,
    cliDone: async () => {},
    initialPath: async () => (await call('api/file')).path,
    read: async () => (await call('api/file')).text,
    write: async (_path, text) => { await call('api/file', { method: 'PUT', body: text }); },
    async watch(_path, onChange) {
      const es = new EventSource('api/watch');
      es.onmessage = () => onChange();
      // After a break in the connection (the computer slept), look at the file again.
      let broken = false;
      es.onerror = () => { broken = true; };
      es.onopen = () => { if (broken) { broken = false; onChange(); } };
      return () => es.close();
    },
    async pickOpen() {
      if (served) return null;
      const typed = window.prompt('Full path of the .mmd or .md file to open:');
      if (!typed) return null;
      return (await call('api/open', { method: 'POST', body: typed })).path;
    },
    pickSave: async () => null,
    openLink: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
    setWindowTitle: (title) => { document.title = title; },
  };
}

export async function createBackend(): Promise<Backend> {
  return '__TAURI_INTERNALS__' in window ? desktop() : browser();
}
