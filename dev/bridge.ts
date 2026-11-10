// Browser-mode stand-in for the desktop shell: lets the page read, write and watch one
// flowchart file through the Vite dev server. Development only (`npm run dev`); the
// desktop app uses the Rust commands in src-tauri/src/lib.rs instead.
//
// It serves requests from this machine only, touches only .mmd / .mermaid files, and
// requires a custom header on writes so that no other web page can trigger one.

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const ALLOWED = new Set(['.mmd', '.mermaid']);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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

          if (url === '/file' && req.method === 'GET') {
            if (!fs.existsSync(current)) return send(404, { error: 'not found', path: current });
            return send(200, { path: current, text: fs.readFileSync(current, 'utf8') });
          }
          if (url === '/file' && req.method === 'PUT') {
            const tmp = `${current}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, await readBody(req), 'utf8');
            fs.renameSync(tmp, current);
            return send(200, { ok: true });
          }
          if (url === '/open' && req.method === 'POST') {
            const next = path.resolve((await readBody(req)).trim());
            if (!ALLOWED.has(path.extname(next).toLowerCase())) return send(400, { error: 'Only .mmd and .mermaid files can be opened.' });
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
          send(500, { error: String((e as Error).message ?? e) });
        }
      });
    },
  };
}
