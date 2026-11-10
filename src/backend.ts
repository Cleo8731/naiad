// File access. The desktop app talks to the Rust shell (src-tauri/src/lib.rs); in a
// browser during development the same calls go to the Vite file bridge (dev/bridge.ts).

export interface Backend {
  kind: 'desktop' | 'browser';
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

function browser(): Backend {
  const call = async (url: string, init?: RequestInit) => {
    const res = await fetch(url, { ...init, headers: { 'x-naiad': '1', ...(init?.headers ?? {}) } });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
    return body;
  };
  return {
    kind: 'browser',
    initialPath: async () => (await call('/api/file')).path,
    read: async () => (await call('/api/file')).text,
    write: async (_path, text) => { await call('/api/file', { method: 'PUT', body: text }); },
    async watch(_path, onChange) {
      const es = new EventSource('/api/watch');
      es.onmessage = () => onChange();
      return () => es.close();
    },
    async pickOpen() {
      const typed = window.prompt('Full path of the .mmd or .md file to open:');
      if (!typed) return null;
      return (await call('/api/open', { method: 'POST', body: typed })).path;
    },
    pickSave: async () => null,
    openLink: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
    setWindowTitle: (title) => { document.title = title; },
  };
}

export async function createBackend(): Promise<Backend> {
  return '__TAURI_INTERNALS__' in window ? desktop() : browser();
}
