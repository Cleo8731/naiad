// Trials of `naiad serve` (src-tauri/src/serve.rs) against the real program: what must
// work, and what its guard must refuse. Run after a desktop build:
//   node dev/serve-trials.cjs [path to the naiad command]
// The default is the build's own, src-tauri/target/release/naiad-cli.exe. It serves a
// copy of examples/sample.mmd from a temporary folder, runs the trials, stops the
// server and deletes the copy. It ends with "N trials, M failed" and never prints the
// secret. It takes about a minute (one trial waits for a silent connection to be
// dropped, another for the highlights to be deleted after the last page closes).
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const cli = process.argv[2] ?? path.join(__dirname, '..', 'src-tauri', 'target', 'release', process.platform === 'win32' ? 'naiad-cli.exe' : 'naiad-cli');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naiad-trials-'));
const file = path.join(dir, 'flow.mmd');
fs.copyFileSync(path.join(__dirname, '..', 'examples', 'sample.mmd'), file);
const serve = () => execFileSync(cli, ['serve', file], { encoding: 'utf8' }).trim();
const address = serve();
const m = address.match(/^http:\/\/127\.0\.0\.1:(\d+)\/([0-9a-f]{32})\/$/);
if (!m) { console.log('naiad serve did not print an address'); process.exit(1); }
const port = Number(m[1]);
const secret = m[2];
/** Stops the server (found through its record) and deletes the copy. */
function cleanUp() {
  const records = path.join(os.tmpdir(), 'naiad-serve');
  for (const name of fs.existsSync(records) ? fs.readdirSync(records) : []) {
    const lines = fs.readFileSync(path.join(records, name), 'utf8').split('\n');
    if (lines[1] === String(port)) {
      try { process.kill(Number(lines[0])); } catch {}
      fs.rmSync(path.join(records, name), { force: true });
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
const own = `http://127.0.0.1:${port}`;
const sha = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function ask({ method = 'GET', path, headers = {}, body, host = '127.0.0.1', noHost = false }) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, method, path, headers, setHost: !noHost && !('Host' in headers), timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => resolve({ status: 'broken', headers: {}, body: Buffer.alloc(0) }));
    });
    req.on('error', (e) => resolve({ status: e.code, headers: {}, body: Buffer.alloc(0) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', headers: {}, body: Buffer.alloc(0) }); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let failed = 0, count = 0;
const check = (name, ok, got) => { count++; if (!ok) failed++; console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : '  (got ' + got + ')'}`); };
const at = (rest) => `/${secret}/${rest}`;

(async () => {
  const before = sha();
  let r;

  check('asked again, the command gives the same address', serve() === address, 'another address');

  // ---- What must work
  r = await ask({ path: at('') });
  check('the page is served with the secret', r.status === 200 && /text\/html/.test(r.headers['content-type']) && r.body.includes('<div id="app"') , r.status);
  const page = r.body.toString();
  const script = (page.match(/src="\.\/(assets\/[^"]+\.js)"/) ?? [])[1];
  check('answers are no-store, nosniff, with a content policy, and no header for other sites',
    r.headers['cache-control'] === 'no-store' && r.headers['x-content-type-options'] === 'nosniff'
    && /script-src 'self'/.test(r.headers['content-security-policy'] ?? '') && /frame-ancestors 'none'/.test(r.headers['content-security-policy'] ?? '')
    && !Object.keys(r.headers).some((h) => h.startsWith('access-control')), JSON.stringify(r.headers));
  r = await ask({ path: at(script ?? 'assets/none.js') });
  check('the page\'s script is served', r.status === 200 && /javascript/.test(r.headers['content-type']) && r.body.length > 100000, `${r.status} ${r.body.length}`);
  r = await ask({ path: `/${secret}` });
  check('the secret with no slash is sent on to the folder', r.status === 308 && r.headers.location === `/${secret}/`, r.status);
  r = await ask({ path: at('api/file'), headers: { 'Sec-Fetch-Site': 'same-origin' } });
  let json = {};
  try { json = JSON.parse(r.body.toString()); } catch {}
  check('the file is read, byte for byte', r.status === 200 && Buffer.from(json.text ?? '', 'utf8').equals(fs.readFileSync(file)), r.status);
  check('the path it names is the served file', typeof json.path === 'string' && fs.realpathSync(json.path) === fs.realpathSync(file), json.path);
  r = await ask({ path: at('api/ping') });
  check('ping names the file', r.status === 200 && r.body.toString() === json.path, r.status);

  // ---- Without the secret
  for (const path of ['/', '/index.html', '/api/file', '/assets/' + (script ?? 'x').split('/').pop(), `/${secret.slice(0, 31)}/api/file`,
    `/${'0'.repeat(32)}/api/file`, `/${secret.toUpperCase().replace(/[0-9]/g, 'A')}/`, `/api/file?k=${secret}`, `/x/${secret}/api/file`]) {
    r = await ask({ path });
    check(`refused without the secret: ${path.replace(secret, '<secret>').replace(secret.slice(0, 31), '<secret less one>')}`, r.status === 404, r.status);
  }
  r = await ask({ path: '/api/file', headers: { 'X-Naiad': '1', Cookie: `k=${secret}`, Authorization: `Bearer ${secret}` } });
  check('the secret in a header instead of the address is no use', r.status === 404, r.status);

  // ---- Another web page, with the secret
  const others = [
    ['Host: evil.example (DNS rebinding)', { Host: `evil.example:${port}` }],
    ['Host: localhost', { Host: `localhost:${port}` }],
    ['Host with another port', { Host: '127.0.0.1:1' }],
    ['Origin: another site', { Origin: 'https://evil.example' }],
    ['Origin: null (a sandboxed frame or a file)', { Origin: 'null' }],
    ['Origin: localhost', { Origin: `http://localhost:${port}` }],
    ['Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { 'Sec-Fetch-Site': 'same-site' }],
  ];
  for (const [name, headers] of others) {
    r = await ask({ path: at('api/file'), headers });
    check(`reading refused: ${name}`, r.status === 403 && !r.body.includes('flowchart'), r.status);
    r = await ask({ path: at(''), headers });
    check(`the page refused: ${name}`, r.status === 403, r.status);
  }
  r = await ask({ path: at('api/file'), noHost: true });
  check('refused with no Host at all', r.status === 403 || r.status === 400, r.status);
  r = await ask({ method: 'OPTIONS', path: at('api/file'), headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-naiad' } });
  check('a cross-site preflight gets no permission', r.status === 403 && !Object.keys(r.headers).some((h) => h.startsWith('access-control')), r.status);
  r = await ask({ method: 'OPTIONS', path: at('api/file'), headers: { Origin: own } });
  check('OPTIONS is not a method it knows', r.status === 405 && !Object.keys(r.headers).some((h) => h.startsWith('access-control')), r.status);

  // ---- Writes
  const evil = 'flowchart TD\n    hacked\n';
  const writes = [
    ['no Origin', { 'X-Naiad': '1' }],
    ['no x-naiad header', { Origin: own }],
    ['another site\'s Origin', { Origin: 'https://evil.example', 'X-Naiad': '1' }],
    ['a form\'s content type and nothing else', { 'Content-Type': 'text/plain' }],
  ];
  for (const [name, headers] of writes) {
    r = await ask({ method: 'PUT', path: at('api/file'), headers: { ...headers, 'Content-Length': Buffer.byteLength(evil) }, body: evil });
    check(`a write refused: ${name}`, (r.status === 403 || r.status === 'ECONNRESET' || r.status === 'broken' || r.status === 'EPIPE') && sha() === before, r.status);
  }
  for (const method of ['POST', 'DELETE', 'PATCH']) {
    r = await ask({ method, path: at('api/file'), headers: { Origin: own, 'X-Naiad': '1', 'Content-Length': Buffer.byteLength(evil) }, body: evil });
    check(`${method} refused`, (r.status === 405 || r.status === 'ECONNRESET' || r.status === 'broken' || r.status === 'EPIPE') && sha() === before, r.status);
  }
  r = await ask({ method: 'POST', path: at('api/open'), headers: { Origin: own, 'X-Naiad': '1', 'Content-Length': 22 }, body: 'C:\\Windows\\win.ini.mmd' });
  check('there is no call that opens another file', r.status !== 200 && sha() === before, r.status);
  r = await ask({ method: 'PUT', path: at('api/file'), headers: { Origin: own, 'X-Naiad': '1', 'Content-Length': 3 }, body: Buffer.from([0xff, 0xfe, 0x41]) });
  check('a write that is not UTF-8 is refused and changes nothing', r.status === 500 && sha() === before, r.status);
  r = await ask({ method: 'PUT', path: at('api/file'), headers: { Origin: own, 'X-Naiad': '1', 'Transfer-Encoding': 'chunked' }, body: evil });
  check('a write without a stated length is refused', r.status !== 200 && sha() === before, r.status);
  r = await ask({ method: 'PUT', path: at('api/file'), headers: { Origin: own, 'X-Naiad': '1', 'Content-Length': 70 * 1024 * 1024 }, body: 'x' });
  check('a write over 64 MiB is refused before it is read', (r.status === 413 || r.status === 'ECONNRESET' || r.status === 'broken') && sha() === before, r.status);

  // The page's own write, with a BOM, CRLF and non-ASCII text: lands byte for byte; then put back.
  const original = fs.readFileSync(file);
  const text = '\ufeffflowchart TD\r\n    a[Caf\u00e9 \u2603 "x"] --> b\r\n';
  r = await ask({ method: 'PUT', path: at('api/file'), headers: { Origin: own, 'X-Naiad': '1', 'Sec-Fetch-Site': 'same-origin', 'Content-Length': Buffer.byteLength(text) }, body: text });
  check('the page\'s own write is made, byte for byte', r.status === 200 && fs.readFileSync(file).equals(Buffer.from(text, 'utf8')), r.status);
  r = await ask({ path: at('api/file') });
  check('and reads back the same, BOM and CRLF kept', JSON.parse(r.body.toString()).text === text, r.status);
  check('no temporary file is left beside it', !fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), fs.readdirSync(dir).join(', '));
  r = await ask({ method: 'PUT', path: at('api/file'), headers: { Origin: own, 'X-Naiad': '1', 'Content-Length': original.length }, body: original });
  check('the file is put back as it was', r.status === 200 && sha() === before, r.status);

  // A save names the text it read by its hash (FNV-1a, 64 bits; written again here, apart
  // from src/core/hash.ts and lib.rs): refused when the file holds anything else now.
  const fnv = (bytes) => {
    let h = 0xcbf29ce484222325n;
    for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
    return h.toString(16).padStart(16, '0');
  };
  const checked = (expect) => ask({ method: 'PUT', path: at('api/file'), headers: { Origin: own, 'X-Naiad': '1', 'X-Naiad-Expect': expect, 'Content-Length': Buffer.byteLength(evil) }, body: evil });
  r = await checked(fnv(Buffer.from('flowchart TD\n    what the page read\n')));
  let answer = {};
  try { answer = JSON.parse(r.body.toString()); } catch {}
  check('a save checked against a text the file no longer holds is refused (409) and changes nothing', r.status === 409 && answer.changed === true && sha() === before, r.status);
  r = await checked([fnv(fs.readFileSync(file)), fnv(fs.readFileSync(file))]);
  check('a save naming two hashes is refused', r.status === 400 && sha() === before, r.status);
  r = await checked('not a hash');
  check('a save naming something else than a hash is refused', r.status === 400 && sha() === before, r.status);
  r = await checked(fnv(fs.readFileSync(file)));
  check('a save checked against the file as it is is made', r.status === 200 && fs.readFileSync(file, 'utf8') === evil, r.status);
  r = await ask({ method: 'PUT', path: at('api/file'), headers: { Origin: own, 'X-Naiad': '1', 'X-Naiad-Expect': fnv(Buffer.from(evil)), 'Content-Length': original.length }, body: original });
  check('and put back the same way', r.status === 200 && sha() === before, r.status);
  check('no temporary file is left beside it after a refused save', !fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), fs.readdirSync(dir).join(', '));

  // ---- Other files
  const raw = (path) => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
    let got = '';
    s.on('data', (c) => { got += c; });
    s.on('close', () => resolve(got));
    s.on('error', () => resolve(got));
    setTimeout(() => s.destroy(), 4000);
  });
  for (const rest of ['assets/../../../../../Windows/win.ini', 'assets/..%2f..%2f..%2fWindows%2fwin.ini', 'assets/..\\..\\Windows\\win.ini', '../../Windows/win.ini', 'api/file/../../x', 'C:/Windows/win.ini']) {
    const got = await raw(at(rest));
    check(`no other file through ${rest}`, got.startsWith('HTTP/1.1 404 ') && !/fonts|extensions/i.test(got), got.slice(0, 20));
  }
  r = await ask({ path: at('api/file?path=C:/Windows/win.ini') });
  check('a path in the query is ignored: still the served file', r.status === 200 && JSON.parse(r.body.toString()).path === json.path, r.status);

  // ---- Not on the network
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  for (const ip of lan) {
    r = await ask({ host: ip, path: at(''), headers: { Host: `127.0.0.1:${port}` } });
    check(`not reachable at this computer's network address (${ip.replace(/\d+\.\d+$/, 'x.x')})`, r.status === 'ECONNREFUSED' || r.status === 'timeout' || r.status === 'ETIMEDOUT', r.status);
  }
  if (!lan.length) console.log('note  this computer has no network address to try');
  r = await new Promise((resolve) => { const s = net.connect(port, '::1', () => { s.destroy(); resolve('connected'); }); s.on('error', (e) => resolve(e.code)); });
  check('not reachable over IPv6 (::1)', r === 'ECONNREFUSED', r);

  // ---- Malformed and slow
  let got = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /' + 'a'.repeat(20000)));
    let d = '';
    s.on('data', (c) => { d += c; }); s.on('close', () => resolve(d)); s.on('error', () => resolve(d));
    setTimeout(() => s.destroy(), 4000);
  });
  check('a head over 16 KiB is refused', got.startsWith('HTTP/1.1 431 ') || got === '', got.slice(0, 20));
  got = await raw(at('') + ' extra');
  check('a malformed first line is refused', got.startsWith('HTTP/1.1 400 '), got.slice(0, 20));
  const started = Date.now();
  await new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.on('close', resolve); s.on('error', resolve); setTimeout(() => { s.destroy(); resolve(); }, 20000); });
  const waited = (Date.now() - started) / 1000;
  check('a silent connection is dropped after about 10 seconds', waited > 8 && waited < 14, waited.toFixed(1) + ' s');

  // ---- The stream of changes
  got = await new Promise((resolve) => {
    let d = '';
    const req = http.get({ host: '127.0.0.1', port, path: at('api/watch') }, (res) => {
      res.on('data', (c) => { d += c; });
      setTimeout(() => { fs.writeFileSync(file, original); }, 500);
      setTimeout(() => { req.destroy(); resolve(`${res.statusCode} ${res.headers['content-type']} ${d}`); }, 2500);
    });
    req.on('error', () => resolve(d));
  });
  check('the stream says when the file changed', /^200 text\/event-stream/.test(got) && got.includes('data: changed'), JSON.stringify(got.slice(0, 80)));
  if (process.platform === 'win32') {
    // Windows does not tell names apart by letter case: a file renamed to other letters
    // is still the file served (bug hunt E5).
    const renamed = path.join(dir, 'Flow.mmd');
    fs.renameSync(file, renamed);
    await new Promise((r) => setTimeout(r, 300));
    got = await new Promise((resolve) => {
      let d = '';
      const req = http.get({ host: '127.0.0.1', port, path: at('api/watch') }, (res) => {
        res.on('data', (c) => { d += c; });
        setTimeout(() => { fs.writeFileSync(renamed, original); }, 500);
        setTimeout(() => { req.destroy(); resolve(d); }, 2500);
      });
      req.on('error', () => resolve(d));
    });
    fs.renameSync(renamed, file);
    check('after a rename that changes only the letter case, the stream still says when the file changed (bug hunt E5)', got.includes('data: changed'), JSON.stringify(got.slice(0, 80)));
  }

  // ---- Highlights (D2.4): their own file beside the flowchart's, never the flowchart
  const naiad = path.join(dir, '.naiad');
  const hlFile = path.join(naiad, 'flow.mmd', 'highlights.txt');
  const hlAsk = (text, headers = { Origin: own, 'X-Naiad': '1' }) =>
    ask({ method: 'PUT', path: at('api/highlights'), headers: { ...headers, 'Content-Length': Buffer.byteLength(text) }, body: text });
  r = await ask({ path: at('api/highlights') });
  check('with no highlights file, the highlights read as null', r.status === 200 && r.body.toString() === '{"text":null}', `${r.status} ${r.body}`);
  for (const [name, headers] of [['no Origin', { 'X-Naiad': '1' }], ['no x-naiad header', { Origin: own }], ['another site\'s Origin', { Origin: 'https://evil.example', 'X-Naiad': '1' }]]) {
    r = await hlAsk('collect\n', headers);
    check(`a highlights write refused: ${name}`, (r.status === 403 || r.status === 'ECONNRESET' || r.status === 'broken' || r.status === 'EPIPE') && !fs.existsSync(naiad), r.status);
  }
  r = await ask({ path: at('api/highlights'), headers: { Origin: 'https://evil.example' } });
  check('the highlights are not read for another site', r.status === 403, r.status);
  const hl = '# the agent\ncollect\ncollect --> clean\n';
  r = await hlAsk(hl);
  check('the page\'s highlights are written to .naiad/flow.mmd/highlights.txt', r.status === 200 && fs.existsSync(hlFile) && fs.readFileSync(hlFile, 'utf8') === hl, r.status);
  check('no temporary file is left beside it', !fs.readdirSync(path.dirname(hlFile)).some((n) => n.endsWith('.naiad-tmp')), 'left');
  if (process.platform === 'win32') {
    const attrs = execFileSync('attrib', [naiad], { encoding: 'utf8' });
    // attrib prints the attribute letters, then the path.
    check('the .naiad folder is hidden', attrs.includes(naiad) && attrs.slice(0, attrs.indexOf(naiad)).includes('H'), attrs.trim());
  }
  r = await ask({ path: at('api/highlights') });
  check('and read back the same', r.status === 200 && JSON.parse(r.body.toString()).text === hl, r.status);
  check('the flowchart\'s file is untouched by highlights', sha() === before, 'changed');
  r = await hlAsk('');
  check('writing nothing deletes the file and the .naiad folder', r.status === 200 && !fs.existsSync(naiad), r.status);

  // Deleted when the last page closes (Q44): this server is the only view of the copy.
  const pid = (() => {
    const records = path.join(os.tmpdir(), 'naiad-serve');
    for (const name of fs.readdirSync(records)) {
      const lines = fs.readFileSync(path.join(records, name), 'utf8').split('\n');
      if (lines[1] === String(port)) return lines[0];
    }
  })();
  const view = path.join(os.tmpdir(), 'naiad-views', `${pid}.txt`);
  await hlAsk(hl);
  const stream = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: at('api/watch') }, (res) => resolve({ req, res }));
    req.on('error', () => resolve(null));
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('an open page makes a record of the view', fs.existsSync(view) && fs.realpathSync(fs.readFileSync(view, 'utf8')) === fs.realpathSync(file), fs.existsSync(view) ? fs.readFileSync(view, 'utf8') : 'none');
  check('while the page is open, the highlights stay', fs.existsSync(hlFile), 'gone');
  stream?.req.destroy();
  const closed = Date.now();
  while (fs.existsSync(hlFile) && Date.now() - closed < 45000) await new Promise((resolve) => setTimeout(resolve, 500));
  const after = (Date.now() - closed) / 1000;
  console.log(`note  the highlights were deleted ${after.toFixed(1)} s after the page closed`);
  check('the last page closed: the highlights file and its folders are deleted within about half a minute',
    !fs.existsSync(hlFile) && !fs.existsSync(naiad) && after < 40, `${after.toFixed(1)} s`);
  check('and the record of the view is removed', !fs.existsSync(view), 'still there');
  check('the file ends as it began', sha() === before, 'changed');

  cleanUp();
  console.log(`${count} trials, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { cleanUp(); console.log(String(e).replaceAll(secret, '<secret>')); process.exit(1); });
