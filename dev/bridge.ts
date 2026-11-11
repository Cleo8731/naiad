// Browser-mode stand-in for the desktop shell: lets the page read, write and watch one
// flowchart file through the Vite dev server. Development only (`npm run dev`); the
// desktop app uses the Rust commands in src-tauri/src/lib.rs instead.
//
// It serves requests from this machine only, touches only flowchart and Markdown files
// (.mmd, .mermaid, .md, .markdown), and requires a custom header on writes so that no
// other web page can trigger one.

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { fnv1a64 } from '../src/core/hash';

const ALLOWED = new Set(['.mmd', '.mermaid', '.md', '.markdown']);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Thrown for a file that is not UTF-8 text; answered with 422. */
class NotUtf8 extends Error {}

/**
 * Reads a file as UTF-8, its byte-order mark kept. Bytes that are not UTF-8 are refused,
 * as the desktop shell does: read with them replaced, a save would write the
 * replacements over them (bug hunt C16).
 */
function readText(file: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
  } catch (e) {
    if (e instanceof TypeError) throw new NotUtf8(`${path.basename(file)} is not UTF-8 text, so Naiad leaves it alone.`);
    throw e;
  }
}

let saves = 0;

/**
 * Writes `text` to a new temporary file beside `target` and renames it over `target`, so
 * the file is never left half written. The temporary name is one no file has yet (made
 * with 'wx'), and the temporary file is removed whenever the write does not finish (bug
 * hunt C15). `unchanged` runs just before the rename: false refuses the write.
 */
function replaceFile(target: string, text: string, unchanged: () => boolean = () => true): boolean {
  let tmp = '';
  let fd = -1;
  for (let tries = 0; fd < 0; tries++) {
    tmp = path.join(path.dirname(target), `.naiad-${process.pid}-${saves++}.tmp`);
    try {
      fd = fs.openSync(tmp, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 100) throw e;
    }
  }
  let done = false;
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.closeSync(fd);
    fd = -1;
    if (!unchanged()) return false;
    fs.renameSync(tmp, target);
    done = true;
    return true;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
    if (!done) fs.rmSync(tmp, { force: true });
  }
}

export function fileBridge(): Plugin {
  return {
    name: 'naiad-file-bridge',
    apply: 'serve',
    configureServer(server) {
      let current = path.resolve(process.env.NAIAD_FILE ?? 'examples/sample.mmd');
      const listeners = new Set<ServerResponse>();
      let watcher: fs.FSWatcher | null = null;
      let timer: NodeJS.Timeout | null = null;

      const watch = () => {
        watcher?.close();
        const name = path.basename(current);
        // Watch the folder, not the file: editors often save by replacing the file.
        watcher = fs.watch(path.dirname(current), (_event, changed) => {
          if (changed && changed !== name) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { for (const res of listeners) res.write('data: changed\n\n'); }, 60);
        });
      };
      watch();
      server.httpServer?.on('close', () => watcher?.close());

      // Open in one view changes the file for every view of this server, so the page names
      // the file it shows (header x-naiad-path) and a page still showing another is
      // refused (bug hunt C14). `required`: a write must name it.
      const otherFile = (req: IncomingMessage, required: boolean): string | null => {
        const named = req.headers['x-naiad-path'];
        if (typeof named !== 'string') return required ? 'The page did not say which file it shows. Reload this page.' : null;
        let shows: string;
        try { shows = path.resolve(decodeURIComponent(named)); } catch { shows = ''; }
        if (shows === current) return null;
        return `This page shows another file than the one the development server now serves (${path.basename(current)}, opened in another view). Reload this page.`;
      };

      server.middlewares.use('/api', async (req, res) => {
        const send = (code: number, body: unknown) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        try {
          const host = (req.headers.host ?? '').split(':')[0];
          if (host !== '127.0.0.1' && host !== 'localhost') return send(403, { error: 'local only' });
          const url = (req.url ?? '').split('?')[0];
          const guarded = req.method !== 'GET';
          if (guarded && req.headers['x-naiad'] !== '1') return send(403, { error: 'missing header' });

          const route = `${req.method} ${url}`;
          if (['GET /file', 'PUT /file', 'GET /highlights', 'PUT /highlights'].includes(route)) {
            const other = otherFile(req, req.method === 'PUT');
            if (other) return send(400, { error: other });
          }
          if (url === '/file' && req.method === 'GET') {
            if (!fs.existsSync(current)) return send(404, { error: 'not found', path: current });
            return send(200, { path: current, text: readText(current) });
          }
          if (url === '/file' && req.method === 'PUT') {
            // The hash of the text the page read (src/core/hash.ts): refused if the file
            // holds anything else now, as `naiad serve` does.
            const expect = req.headers['x-naiad-expect'];
            const unchanged = () => {
              if (expect === undefined) return true;
              const now = fs.existsSync(current) ? fnv1a64(fs.readFileSync(current)) : null;
              return typeof expect === 'string' && now === expect.trim().toLowerCase();
            };
            if (!replaceFile(current, await readBody(req), unchanged)) {
              return send(409, { error: 'The file changed on disk after it was read.', changed: true });
            }
            return send(200, { ok: true });
          }
          // The highlights file beside the open file (src-tauri/src/highlights.rs does
          // the same for the app; this stand-in does not set the folder's hidden mark).
          const naiad = path.join(path.dirname(current), '.naiad');
          const folder = path.join(naiad, path.basename(current));
          const highlights = path.join(folder, 'highlights.txt');
          if (url === '/highlights' && req.method === 'GET') {
            return send(200, { text: fs.existsSync(highlights) ? readText(highlights) : null });
          }
          if (url === '/highlights' && req.method === 'PUT') {
            const text = await readBody(req);
            if (text.trim() === '') {
              fs.rmSync(highlights, { force: true });
              for (const d of [folder, naiad]) { try { fs.rmdirSync(d); } catch { /* not empty, or gone */ } }
            } else {
              fs.mkdirSync(folder, { recursive: true });
              replaceFile(highlights, text);
            }
            return send(200, { ok: true });
          }
          if (url === '/open' && req.method === 'POST') {
            const next = path.resolve((await readBody(req)).trim());
            if (!ALLOWED.has(path.extname(next).toLowerCase())) return send(400, { error: 'Only .mmd, .mermaid and .md files can be opened.' });
            if (!fs.existsSync(next)) return send(404, { error: `No file at ${next}` });
            current = next;
            watch();
            return send(200, { path: current });
          }
          if (url === '/watch' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            res.write('retry: 1000\n\n');
            listeners.add(res);
            req.on('close', () => listeners.delete(res));
            return;
          }
          send(404, { error: 'unknown' });
        } catch (e) {
          send(e instanceof NotUtf8 ? 422 : 500, { error: String((e as Error).message ?? e) });
        }
      });
    },
  };
}
