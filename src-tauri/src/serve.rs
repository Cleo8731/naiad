// The in-browser version: `naiad serve <file>`. The app, with no window, serves its
// own page and one flowchart file to this computer, so that the flowchart can be seen
// and changed in a browser pane beside a conversation with an agent. It prints one
// line, the address to open, and ends by itself ten minutes after its last page was
// closed.
//
// A web server on a computer can be reached by every program on it and, unless it is
// guarded, by any web page open in any browser. The guard (`route`, below):
//   1. it listens on 127.0.0.1 only;
//   2. every address it answers starts with a secret made at start, which exists
//      only in the address that is printed (and in this user's temporary folder);
//   3. a request that another web page caused is refused (Host, Origin,
//      Sec-Fetch-Site), and it never lets another site read an answer;
//   4. it reads and writes the one file it was started for; no request names a path;
//   5. it ends by itself.
// A program already running under the user's account is not guarded against: it can
// read and change the file directly, so this server gives it nothing new.

use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long the server lives with no page open.
const IDLE: Duration = Duration::from_secs(600);
/// How often each open page is pinged, which is how a closed one is noticed.
const PING: Duration = Duration::from_secs(10);
/// A connection that sends or takes nothing for this long is dropped.
const SLOW: Duration = Duration::from_secs(10);
const LONGEST_HEAD: usize = 16 * 1024;
const LONGEST_BODY: usize = 64 * 1024 * 1024;
const MOST_CONNECTIONS: usize = 64;
const MOST_PAGES: usize = 32;

/// What every answer carries. Nothing here lets another site read an answer, and the
/// page may load scripts from this server alone and may not be put in a frame.
const ALWAYS: &str = "Cache-Control: no-store\r\n\
X-Content-Type-Options: nosniff\r\n\
Referrer-Policy: no-referrer\r\n\
Cross-Origin-Resource-Policy: same-origin\r\n\
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; \
frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n\
Connection: close\r\n";

/// The arguments after `serve`, if that is how the program was started.
pub fn asked() -> Option<Vec<String>> {
    let mut args = std::env::args().skip(1);
    (args.next()? == "serve").then(|| args.collect())
}

// ---- Reading a request --------------------------------------------------------------

/// The first line and the headers of a request. Header names are in lower case.
#[derive(Debug)]
struct Head {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
}

impl Head {
    /// A header's value: `Ok(None)` if it was not sent, `Err` if it was sent twice.
    fn one(&self, name: &str) -> Result<Option<&str>, ()> {
        let mut found = self.headers.iter().filter(|(n, _)| n == name).map(|(_, v)| v.as_str());
        let first = found.next();
        if found.next().is_some() {
            return Err(());
        }
        Ok(first)
    }
}

fn parse_head(text: &str) -> Option<Head> {
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target, version) = (first.next()?, first.next()?, first.next()?);
    if first.next().is_some()
        || method.is_empty()
        || !method.bytes().all(|b| b.is_ascii_uppercase())
        || !target.starts_with('/')
        || !version.starts_with("HTTP/1.")
    {
        return None;
    }
    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line.split_once(':')?;
        if name.is_empty() || name.bytes().any(|b| b <= b' ' || b >= 0x7f) {
            return None;
        }
        headers.push((name.to_ascii_lowercase(), value.trim().to_string()));
    }
    Some(Head { method: method.to_string(), target: target.to_string(), headers })
}

/// Reads a request's head. Gives it with whatever bytes of the body came with it,
/// or the status to answer with (0: say nothing, the connection is dead or silent).
fn read_head(stream: &mut TcpStream) -> Result<(Head, Vec<u8>), u16> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        if buf.len() > LONGEST_HEAD {
            return Err(431);
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return Err(0),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = std::str::from_utf8(&buf[..end]).ok().and_then(parse_head).ok_or(400u16)?;
    Ok((head, buf[end + 4..].to_vec()))
}

/// Reads the body of a write: its length must be stated, and it has a limit.
fn read_body(stream: &mut TcpStream, head: &Head, mut body: Vec<u8>) -> Result<Vec<u8>, u16> {
    if head.one("transfer-encoding") != Ok(None) {
        return Err(400);
    }
    let length: usize = head.one("content-length").map_err(|_| 400u16)?.ok_or(411u16)?.parse().map_err(|_| 400u16)?;
    if length > LONGEST_BODY {
        return Err(413);
    }
    if body.len() > length {
        return Err(400);
    }
    let mut chunk = vec![0u8; 64 * 1024];
    while body.len() < length {
        let want = chunk.len().min(length - body.len());
        match stream.read(&mut chunk[..want]) {
            Ok(0) | Err(_) => return Err(0),
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    Ok(body)
}

// ---- The guard ----------------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum Route {
    /// The secret with no `/` after it: sent on to the folder.
    ToFolder,
    Page,
    Asset(String),
    Read,
    Write,
    Watch,
    Ping,
    /// The page says it is closing, not only losing its connection.
    Bye,
    /// The served file's highlights file (highlights.rs), found beside it, never named.
    ReadHighlights,
    WriteHighlights,
}

/// Whether two texts are the same, in a time that does not depend on where they differ.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// Decides what a request may do, or the status that refuses it. Everything the guard
/// checks about a request is checked here, before any of its body is read.
fn route(head: &Head, port: u16, secret: &str) -> Result<Route, u16> {
    // Another site's page reaching this server under a name of its own (DNS rebinding)
    // sends that name as Host.
    if head.one("host") != Ok(Some(format!("127.0.0.1:{port}").as_str())) {
        return Err(403);
    }
    // A browser names the page a request came from; only this server's own page may ask.
    let own = format!("http://127.0.0.1:{port}");
    let origin = head.one("origin").map_err(|_| 403u16)?;
    if origin.is_some_and(|o| o != own) {
        return Err(403);
    }
    match head.one("sec-fetch-site") {
        Ok(None) | Ok(Some("same-origin")) | Ok(Some("none")) => {}
        _ => return Err(403),
    }
    // The secret is the first folder of every address.
    let path = head.target.split('?').next().unwrap_or("");
    let path = path.strip_prefix('/').ok_or(404u16)?;
    let (first, rest) = match path.split_once('/') {
        Some((first, rest)) => (first, Some(rest)),
        None => (path, None),
    };
    if !same(first, secret) {
        return Err(404);
    }
    if head.method != "GET" && head.method != "PUT" {
        return Err(405);
    }
    let get = head.method == "GET";
    // A write must come from this server's own page: a browser always names the origin
    // of a PUT, and the extra header cannot be sent across sites.
    let from_the_page = |route: Route| {
        if origin.is_none() || head.one("x-naiad") != Ok(Some("1")) { Err(403) } else { Ok(route) }
    };
    match rest {
        None if get => Ok(Route::ToFolder),
        Some("" | "index.html") if get => Ok(Route::Page),
        Some("api/file") if get => Ok(Route::Read),
        Some("api/file") => from_the_page(Route::Write),
        Some("api/highlights") if get => Ok(Route::ReadHighlights),
        Some("api/highlights") => from_the_page(Route::WriteHighlights),
        Some("api/watch") if get => Ok(Route::Watch),
        Some("api/ping") if get => Ok(Route::Ping),
        Some("api/bye") if !get => from_the_page(Route::Bye),
        Some(rest) if get => {
            let name = rest.strip_prefix("assets/").ok_or(404u16)?;
            let plain = !name.is_empty()
                && !name.contains("..")
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
            if plain { Ok(Route::Asset(rest.to_string())) } else { Err(404) }
        }
        _ => Err(405),
    }
}

// ---- Answering ----------------------------------------------------------------------

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Content Too Large",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}

fn respond(stream: &mut TcpStream, status: u16, kind: &str, extra: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n{ALWAYS}{extra}\r\n",
        status_text(status),
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

/// A refusal says its status and nothing about why.
fn refuse(stream: &mut TcpStream, status: u16) {
    if status != 0 {
        respond(stream, status, "text/plain; charset=utf-8", "", status_text(status).as_bytes());
    }
}

/// A text as a JSON string.
fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn respond_json(stream: &mut TcpStream, status: u16, json: String) {
    respond(stream, status, "application/json; charset=utf-8", "", json.as_bytes());
}

fn kind_of(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

// ---- The server ---------------------------------------------------------------------

type Asset = Box<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

struct Server {
    port: u16,
    secret: String,
    /// The one file, as a full path.
    file: String,
    asset: Asset,
    /// The open pages: one stream each, told when the file changes.
    pages: Mutex<Vec<TcpStream>>,
    /// When a page was last open or last asked for the file.
    active: Mutex<Instant>,
    connections: AtomicUsize,
    /// Whether the last page to go said it was closing (`api/bye`). A page that only
    /// lost its connection, as when the computer sleeps, is still open: its highlights
    /// stay until it says so, or until this server stops (bug hunt round 3, oF5).
    said_bye: AtomicBool,
    /// What the highlights file held when a page last said it was closing (its bytes,
    /// empty if there was none; None if it could not be read): they are deleted after it
    /// only if still the same (`after_ping`).
    left: Mutex<Option<Vec<u8>>>,
}

impl Server {
    /// A sign of life from a page. Made with the open pages held, so that it comes
    /// wholly before or after the pinger's look and deed (`after_ping`).
    fn touch(&self) {
        let _pages = self.pages.lock();
        if let Ok(mut active) = self.active.lock() {
            *active = Instant::now();
        }
    }

    /// Writes to every open page and forgets the ones that are gone. The ten minutes
    /// are counted from the moment the last page is found gone, not from an earlier
    /// one: after the computer has slept, a page must get the time to connect again.
    fn tell(&self, text: &[u8]) {
        let Ok(mut pages) = self.pages.lock() else { return };
        let before = pages.len();
        pages.retain_mut(|page| page.write_all(text).and_then(|_| page.flush()).is_ok());
        if before > 0 {
            drop(pages);
            self.touch();
        }
    }

    /// How long no page has been open, given the open pages (None: one is open).
    fn idle(&self, pages: &[TcpStream]) -> Option<Duration> {
        pages.is_empty().then(|| self.active.lock().map(|a| a.elapsed()).unwrap_or(Duration::ZERO))
    }

    /// A page says it is closing: what the highlights hold now is kept to compare.
    fn bye(&self) {
        let left = super::highlights::read(Path::new(&self.file)).ok().map(|t| t.unwrap_or_default().into_bytes());
        if let Ok(mut was) = self.left.lock() {
            *was = left;
        }
        self.said_bye.store(true, Ordering::SeqCst);
    }

    /// After each ping. Once the last page has said it closes and been gone for a ping's
    /// time (a reload comes back sooner), this server no longer counts as a view of the
    /// flowchart (Q44), and its highlights go unless they changed since that goodbye
    /// (F21); a page that only lost its connection still counts, until this server stops
    /// (oF5). When the time is up, `end` runs. All of it is done with the open pages held,
    /// so that no page can connect or show a sign of life between the look and the deed
    /// and have its highlights deleted while it is open (bug hunt round 4, E17, F22).
    fn after_ping(&self, end: impl FnOnce()) {
        let pages = self.pages.lock().unwrap_or_else(|e| e.into_inner());
        let idle = self.idle(&pages);
        let gone = idle.is_some_and(|d| d >= PING) && self.said_bye.load(Ordering::SeqCst);
        between();
        if gone {
            let left = self.left.lock().map(|l| l.clone()).unwrap_or(None);
            super::highlights::stop_showing(left.as_deref());
        }
        if time_is_up(idle) {
            super::highlights::show(None);
            end();
        }
        drop(pages);
    }

    fn address(&self) -> String {
        format!("http://127.0.0.1:{}/{}/", self.port, self.secret)
    }
}

/// Whether the server's time is up: no page is open and none has been for `IDLE`.
fn time_is_up(idle: Option<Duration>) -> bool {
    idle.is_some_and(|d| d >= IDLE)
}

#[cfg(test)]
thread_local! {
    /// Run between the pinger's look and its deed, by a test of that moment.
    static BETWEEN: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}

fn between() {
    #[cfg(test)]
    BETWEEN.with(|run| {
        if let Some(run) = &*run.borrow() {
            run();
        }
    });
}

/// The hash of the file's bytes as the page read them (`x-naiad-expect`; src/core/hash.ts),
/// if it sent one: the write is refused if the file holds anything else now. Err: the
/// header is not one hexadecimal number.
fn expected(head: &Head) -> Result<Option<u64>, ()> {
    match head.one("x-naiad-expect")? {
        None => Ok(None),
        Some(hex) => u64::from_str_radix(hex.trim(), 16).map(Some).map_err(|_| ()),
    }
}

fn handle(mut stream: TcpStream, server: &Server) {
    let (head, early) = match read_head(&mut stream) {
        Ok(read) => read,
        Err(status) => return refuse(&mut stream, status),
    };
    let route = match route(&head, server.port, &server.secret) {
        Ok(route) => route,
        Err(status) => return refuse(&mut stream, status),
    };
    match route {
        Route::ToFolder => {
            let to = format!("Location: /{}/\r\n", server.secret);
            respond(&mut stream, 308, "text/plain; charset=utf-8", &to, b"");
        }
        Route::Page => match (server.asset)("index.html") {
            Some(body) => respond(&mut stream, 200, kind_of("index.html"), "", &body),
            None => refuse(&mut stream, 404),
        },
        Route::Asset(name) => match (server.asset)(&name) {
            Some(body) => respond(&mut stream, 200, kind_of(&name), "", &body),
            None => refuse(&mut stream, 404),
        },
        Route::Bye => {
            server.bye();
            respond_json(&mut stream, 200, "{\"ok\":true}".to_string());
        }
        Route::Ping => {
            server.touch();
            respond(&mut stream, 200, "text/plain; charset=utf-8", "", server.file.as_bytes());
        }
        Route::Read => {
            server.touch();
            match super::read_file(server.file.clone()) {
                Ok(text) => {
                    let json = format!("{{\"path\":{},\"text\":{}}}", json_string(&server.file), json_string(&text));
                    respond_json(&mut stream, 200, json);
                }
                Err(why) => respond_json(&mut stream, 500, format!("{{\"error\":{}}}", json_string(&why))),
            }
        }
        Route::Write => {
            server.touch();
            let Ok(expected) = expected(&head) else { return refuse(&mut stream, 400) };
            let body = match read_body(&mut stream, &head, early) {
                Ok(body) => body,
                Err(status) => return refuse(&mut stream, status),
            };
            let written = String::from_utf8(body)
                .map_err(|_| "The text is not valid UTF-8.".to_string())
                .and_then(|text| super::write_file_hashed(server.file.clone(), text, expected));
            match written {
                Ok(true) => respond_json(&mut stream, 200, "{\"ok\":true}".to_string()),
                Ok(false) => respond_json(&mut stream, 409, "{\"error\":\"The file changed on disk after it was read.\",\"changed\":true}".to_string()),
                Err(why) => respond_json(&mut stream, 500, format!("{{\"error\":{}}}", json_string(&why))),
            }
        }
        Route::ReadHighlights => {
            server.touch();
            match super::highlights::read(Path::new(&server.file)) {
                Ok(text) => {
                    let text = text.as_deref().map(json_string).unwrap_or_else(|| "null".to_string());
                    respond_json(&mut stream, 200, format!("{{\"text\":{text}}}"));
                }
                Err(why) => respond_json(&mut stream, 500, format!("{{\"error\":{}}}", json_string(&why))),
            }
        }
        Route::WriteHighlights => {
            server.touch();
            let Ok(expected) = expected(&head) else { return refuse(&mut stream, 400) };
            let body = match read_body(&mut stream, &head, early) {
                Ok(body) => body,
                Err(status) => return refuse(&mut stream, status),
            };
            let same = |now: &[u8]| expected.is_none_or(|hash| super::fnv1a64(now) == hash);
            let written = String::from_utf8(body)
                .map_err(|_| "The text is not valid UTF-8.".to_string())
                .and_then(|text| super::highlights::write(Path::new(&server.file), &text, Some(&same)));
            match written {
                Ok(true) => respond_json(&mut stream, 200, "{\"ok\":true}".to_string()),
                Ok(false) => respond_json(&mut stream, 409, "{\"error\":\"The file changed on disk after it was read.\",\"changed\":true}".to_string()),
                Err(why) => respond_json(&mut stream, 500, format!("{{\"error\":{}}}", json_string(&why))),
            }
        }
        Route::Watch => {
            let Ok(mut pages) = server.pages.lock() else { return };
            if pages.len() >= MOST_PAGES {
                drop(pages);
                return refuse(&mut stream, 503);
            }
            let start = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n{ALWAYS}\r\n: open\n\n");
            if stream.write_all(start.as_bytes()).and_then(|_| stream.flush()).is_ok() {
                let _ = stream.set_nodelay(true);
                pages.push(stream);
                drop(pages);
                server.said_bye.store(false, Ordering::SeqCst);
                server.touch();
                // A page shows the flowchart: it counts as a view of it (Q44).
                super::highlights::show(Some(Path::new(&server.file)));
            }
        }
    }
}

// ---- The record of running servers -----------------------------------------------------
// One small file per served flowchart file, in the user's temporary folder, so that
// `naiad serve` asked again for the same file gives the address it gave before.

/// A full path without the `\\?\` in front that Windows gives when it resolves one.
pub(crate) fn plain_path(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text
    }
}

fn record_of(file: &str) -> PathBuf {
    // FNV-1a over the path in lower case: a name for the record, not a secret.
    let hash = file
        .to_lowercase()
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3));
    std::env::temp_dir().join("naiad-serve").join(format!("{hash:016x}.txt"))
}

/// The address of a server on record for this file, if it still answers for it.
fn running(file: &str) -> Option<String> {
    let record = fs::read_to_string(record_of(file)).ok()?;
    let mut lines = record.lines();
    let (_pid, port, secret, path) = (lines.next()?, lines.next()?, lines.next()?, lines.next()?);
    let port: u16 = port.parse().ok()?;
    if path != file || secret.len() != 32 || !secret.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let to = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&to, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    let ask = format!("GET /{secret}/api/ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    stream.write_all(ask.as_bytes()).ok()?;
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer);
    let answer = String::from_utf8(answer).ok()?;
    let (head, body) = answer.split_once("\r\n\r\n")?;
    (head.starts_with("HTTP/1.1 200 ") && body == file).then(|| format!("http://127.0.0.1:{port}/{secret}/"))
}

fn write_record(server: &Server) {
    let record = record_of(&server.file);
    let Some(dir) = record.parent() else { return };
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let text = format!("{}\n{}\n{}\n{}\n", std::process::id(), server.port, server.secret, server.file);
    let tmp = record.with_extension("tmp");
    if fs::write(&tmp, text).is_ok() && fs::rename(&tmp, &record).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// Deletes the record, unless a newer server for the same file has put its own there.
fn delete_record(server: &Server) {
    let record = record_of(&server.file);
    let mine = fs::read_to_string(&record)
        .ok()
        .and_then(|text| text.lines().next().map(|pid| pid == std::process::id().to_string()))
        .unwrap_or(false);
    if mine {
        let _ = fs::remove_file(&record);
    }
}

// ---- Starting ---------------------------------------------------------------------------

fn fail(why: &str) -> i32 {
    super::print_out(&format!("naiad: {why}"));
    2
}

/// `naiad serve <file>`. `asset` gives one of the page's own files by its name
/// ("index.html", "assets/..."). Returns only to end the program, with its exit code:
/// at once if the file is already being served, or if serving cannot start.
pub fn run(args: Vec<String>, asset: impl Fn(&str) -> Option<Vec<u8>> + Send + Sync + 'static) -> i32 {
    let files: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    let [typed] = files[..] else {
        return fail("serve takes one file: naiad serve <file>");
    };
    if let Err(why) = super::check(typed) {
        return fail(&why);
    }
    let file = match fs::canonicalize(typed) {
        Ok(path) if path.is_file() => plain_path(&path),
        Ok(_) => return fail(&format!("{typed} is not a file.")),
        Err(e) => return fail(&format!("{typed} cannot be opened: {e}")),
    };
    if asset("index.html").is_none() {
        return fail("this program holds no page to serve (it is a development build).");
    }
    if let Some(address) = running(&file) {
        super::print_out(&address);
        return 0;
    }

    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) {
        Ok(listener) => listener,
        Err(e) => return fail(&format!("could not start serving: {e}")),
    };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else {
        return fail("could not start serving: no port.");
    };
    let mut random = [0u8; 16];
    if getrandom::fill(&mut random).is_err() {
        return fail("could not start serving: no random numbers for the secret.");
    }
    let server = Arc::new(Server {
        port,
        secret: random.iter().map(|b| format!("{b:02x}")).collect(),
        file,
        asset: Box::new(asset),
        pages: Mutex::new(Vec::new()),
        active: Mutex::new(Instant::now()),
        connections: AtomicUsize::new(0),
        said_bye: AtomicBool::new(false),
        left: Mutex::new(None),
    });

    // Tell the open pages when the file changes.
    let teller = server.clone();
    let _watcher = match super::watch_folder(Path::new(&server.file), move || teller.tell(b"data: changed\n\n")) {
        Ok(watcher) => watcher,
        Err(e) => return fail(&format!("could not watch the file: {e}")),
    };
    // Do not hold the folder the command was run in.
    let _ = std::env::set_current_dir(std::env::temp_dir());

    write_record(&server);
    super::print_out(&server.address());

    // Ping the open pages; stop counting as a view of the flowchart, and end, when none
    // has been open for long enough (`after_ping`).
    let pinger = server.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(PING);
        pinger.tell(b": ping\n\n");
        pinger.after_ping(|| {
            delete_record(&pinger);
            std::process::exit(0);
        });
    });

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if !stream.peer_addr().map(|a| a.ip().is_loopback()).unwrap_or(false) {
            continue;
        }
        let _ = stream.set_read_timeout(Some(SLOW));
        let _ = stream.set_write_timeout(Some(SLOW));
        if server.connections.fetch_add(1, Ordering::SeqCst) >= MOST_CONNECTIONS {
            server.connections.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let server = server.clone();
        std::thread::spawn(move || {
            handle(stream, &server);
            server.connections.fetch_sub(1, Ordering::SeqCst);
        });
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 50123;
    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    fn head(method: &str, target: &str, headers: &[(&str, &str)]) -> Head {
        let mut text = format!("{method} {target} HTTP/1.1");
        for (name, value) in headers {
            text.push_str(&format!("\r\n{name}: {value}"));
        }
        parse_head(&text).expect("a well-formed request")
    }
    const HOST: (&str, &str) = ("Host", "127.0.0.1:50123");
    const OWN: (&str, &str) = ("Origin", "http://127.0.0.1:50123");
    fn at(rest: &str) -> String {
        format!("/{SECRET}/{rest}")
    }
    fn ask(method: &str, target: &str, headers: &[(&str, &str)]) -> Result<Route, u16> {
        route(&head(method, target, headers), PORT, SECRET)
    }

    #[test]
    fn the_page_and_its_calls_are_reached_with_the_secret() {
        assert_eq!(ask("GET", &at(""), &[HOST]), Ok(Route::Page));
        assert_eq!(ask("GET", &at("index.html"), &[HOST]), Ok(Route::Page));
        assert_eq!(ask("GET", &format!("/{SECRET}"), &[HOST]), Ok(Route::ToFolder));
        assert_eq!(ask("GET", &at("assets/index-CLseIhKE.js"), &[HOST]), Ok(Route::Asset("assets/index-CLseIhKE.js".into())));
        assert_eq!(ask("GET", &at("api/file"), &[HOST, ("Sec-Fetch-Site", "same-origin")]), Ok(Route::Read));
        assert_eq!(ask("GET", &at("api/watch"), &[HOST]), Ok(Route::Watch));
        assert_eq!(ask("GET", &at("api/ping"), &[HOST]), Ok(Route::Ping));
        assert_eq!(ask("PUT", &at("api/bye"), &[HOST, OWN, ("X-Naiad", "1")]), Ok(Route::Bye));
        assert_eq!(ask("PUT", &at("api/bye"), &[HOST]), Err(403));
        assert_eq!(ask("PUT", &at("api/file"), &[HOST, OWN, ("X-Naiad", "1")]), Ok(Route::Write));
        assert_eq!(ask("GET", &at("api/highlights"), &[HOST]), Ok(Route::ReadHighlights));
        assert_eq!(ask("PUT", &at("api/highlights"), &[HOST, OWN, ("X-Naiad", "1")]), Ok(Route::WriteHighlights));
        // A page opened by typing its address or by the agent's tool.
        assert_eq!(ask("GET", &at(""), &[HOST, ("Sec-Fetch-Site", "none")]), Ok(Route::Page));
    }

    #[test]
    fn nothing_is_reached_without_the_secret() {
        for target in [
            "/".to_string(),
            "/index.html".to_string(),
            "/api/file".to_string(),
            "/assets/index.js".to_string(),
            format!("/{}/api/file", &SECRET[..31]),
            format!("/{SECRET}0/api/file"),
            format!("/{}/api/file", SECRET.to_uppercase()),
            format!("/x/{SECRET}/api/file"),
            format!("//{SECRET}/api/file"),
            format!("/api/file?{SECRET}"),
        ] {
            assert_eq!(ask("GET", &target, &[HOST]), Err(404), "{target}");
            assert_eq!(ask("PUT", &target, &[HOST, OWN, ("X-Naiad", "1")]), Err(404), "{target}");
        }
    }

    #[test]
    fn another_web_page_is_refused_even_with_the_secret() {
        let file = at("api/file");
        // Reached under another name (DNS rebinding), or with no or two Host headers.
        assert_eq!(ask("GET", &file, &[("Host", "evil.example:50123")]), Err(403));
        assert_eq!(ask("GET", &file, &[("Host", "localhost:50123")]), Err(403));
        assert_eq!(ask("GET", &file, &[("Host", "127.0.0.1:50124")]), Err(403));
        assert_eq!(ask("GET", &file, &[("Host", "127.0.0.1")]), Err(403));
        assert_eq!(ask("GET", &file, &[]), Err(403));
        assert_eq!(ask("GET", &file, &[HOST, HOST]), Err(403));
        // Asked by another site's page.
        assert_eq!(ask("GET", &file, &[HOST, ("Origin", "https://evil.example")]), Err(403));
        assert_eq!(ask("GET", &file, &[HOST, ("Origin", "null")]), Err(403));
        assert_eq!(ask("GET", &file, &[HOST, ("Origin", "http://127.0.0.1:50124")]), Err(403));
        assert_eq!(ask("GET", &file, &[HOST, ("Origin", "http://localhost:50123")]), Err(403));
        assert_eq!(ask("GET", &file, &[HOST, OWN, OWN]), Err(403));
        assert_eq!(ask("GET", &file, &[HOST, ("Sec-Fetch-Site", "cross-site")]), Err(403));
        assert_eq!(ask("GET", &file, &[HOST, ("Sec-Fetch-Site", "same-site")]), Err(403));
        assert_eq!(ask("GET", &at(""), &[HOST, ("Sec-Fetch-Site", "cross-site")]), Err(403));
    }

    #[test]
    fn a_write_must_come_from_the_page_itself() {
        for file in [at("api/file"), at("api/highlights")] {
            assert_eq!(ask("PUT", &file, &[HOST]), Err(403), "{file}");
            assert_eq!(ask("PUT", &file, &[HOST, OWN]), Err(403), "{file}");
            assert_eq!(ask("PUT", &file, &[HOST, ("X-Naiad", "1")]), Err(403), "{file}");
            assert_eq!(ask("PUT", &file, &[HOST, OWN, ("X-Naiad", "2")]), Err(403), "{file}");
            assert_eq!(ask("PUT", &file, &[HOST, ("Origin", "https://evil.example"), ("X-Naiad", "1")]), Err(403), "{file}");
        }
        let file = at("api/file");
        // Only the file call can be written to, and only with PUT.
        assert_eq!(ask("PUT", &at(""), &[HOST, OWN, ("X-Naiad", "1")]), Err(405));
        assert_eq!(ask("PUT", &at("api/watch"), &[HOST, OWN, ("X-Naiad", "1")]), Err(405));
        for method in ["POST", "DELETE", "PATCH", "OPTIONS", "HEAD"] {
            assert_eq!(ask(method, &file, &[HOST, OWN, ("X-Naiad", "1")]), Err(405), "{method}");
        }
    }

    #[test]
    fn no_request_names_a_path_on_the_disk() {
        for rest in [
            "assets/",
            "assets/../index.html",
            "assets/..%2f..%2fsecret.txt",
            "assets/a/b.js",
            "assets/a\\b.js",
            "assets/a%20b.js",
            "assets/..",
            "../index.html",
            "api/open",
            "api/file/",
            "api/file/C:/Windows/win.ini",
            "api/highlights/",
            "api/highlights/../../x.txt",
            ".naiad/flow.mmd/highlights.txt",
            "C:/Windows/win.ini",
            "index.htm",
        ] {
            assert_eq!(ask("GET", &at(rest), &[HOST]), Err(404), "{rest}");
        }
        // A query is cut off and ignored: it cannot name another file.
        assert_eq!(ask("GET", &at("api/file?path=C:/Windows/win.ini"), &[HOST]), Ok(Route::Read));
    }

    #[test]
    fn a_malformed_request_is_not_read() {
        for text in [
            "",
            "GET",
            "GET /",
            "GET / HTTP/1.1 extra",
            "get / HTTP/1.1",
            "GET x HTTP/1.1",
            "GET / HTTP/2",
            "GET / HTTP/1.1\r\nno colon",
            "GET / HTTP/1.1\r\nbad name: x",
            "GET / HTTP/1.1\r\n: x",
        ] {
            assert!(parse_head(text).is_none(), "{text:?}");
        }
        let ok = parse_head("PUT /a HTTP/1.1\r\nHost:  127.0.0.1:1 \r\nX-NAIAD:1").unwrap();
        assert_eq!(ok.one("host"), Ok(Some("127.0.0.1:1")));
        assert_eq!(ok.one("x-naiad"), Ok(Some("1")));
        assert_eq!(ok.one("origin"), Ok(None));
    }

    #[test]
    fn the_secret_is_compared_whole() {
        assert!(same(SECRET, SECRET));
        assert!(!same(SECRET, &SECRET[..31]));
        assert!(!same(SECRET, "0123456789abcdef0123456789abcdeg"));
        assert!(!same("", SECRET));
    }

    #[test]
    fn a_text_survives_as_json() {
        assert_eq!(json_string("a\"b\\c\nd\r\te\u{1}\u{feff}é"), "\"a\\\"b\\\\c\\nd\\r\\te\\u0001\u{feff}é\"");
    }

    #[test]
    fn a_resolved_path_is_shown_plain() {
        assert_eq!(plain_path(Path::new(r"\\?\C:\a\b.mmd")), r"C:\a\b.mmd");
        assert_eq!(plain_path(Path::new(r"\\?\UNC\server\share\b.mmd")), r"\\server\share\b.mmd");
        assert_eq!(plain_path(Path::new(r"C:\a\b.mmd")), r"C:\a\b.mmd");
        // The record's name does not depend on upper or lower case.
        assert_eq!(record_of(r"C:\A\B.mmd"), record_of(r"c:\a\b.MMD"));
        assert_ne!(record_of(r"C:\a\b.mmd"), record_of(r"C:\a\c.mmd"));
    }

    #[test]
    fn the_ten_minutes_start_when_the_last_page_is_found_gone() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let browser = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (page, _) = listener.accept().unwrap();
        let server = Server {
            port: 0,
            secret: String::new(),
            file: String::new(),
            asset: Box::new(|_| None),
            pages: Mutex::new(vec![page]),
            active: Mutex::new(Instant::now()),
            connections: AtomicUsize::new(0),
            said_bye: AtomicBool::new(false),
            left: Mutex::new(None),
        };
        assert_eq!(idle_now(&server), None); // a page is open
        // As after a long sleep: the last sign of life is long ago.
        let Some(long_ago) = Instant::now().checked_sub(IDLE * 2) else { return };
        drop(browser);
        for _ in 0..100 {
            *server.active.lock().unwrap() = long_ago;
            server.tell(b": ping

");
            if idle_now(&server).is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let idle = idle_now(&server).expect("the closed page is noticed");
        assert!(!time_is_up(Some(idle)), "{idle:?}");
        // With no page, time passes.
        *server.active.lock().unwrap() = long_ago;
        server.tell(b": ping

");
        assert!(time_is_up(idle_now(&server)));
    }

    #[test]
    fn it_ends_only_after_ten_minutes_with_no_page() {
        assert!(!time_is_up(None)); // a page is open
        assert!(!time_is_up(Some(Duration::from_secs(599))));
        assert!(time_is_up(Some(Duration::from_secs(600))));
    }

    fn idle_now(server: &Server) -> Option<Duration> {
        server.idle(&server.pages.lock().unwrap())
    }

    /// A flowchart in a folder of its own, with highlights, shown by this program, and a
    /// server of it whose last page said it closes and went long enough ago.
    fn after_goodbye(name: &str) -> (PathBuf, PathBuf, Server) {
        let dir = std::env::temp_dir().join(format!("naiad-serve-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "flowchart TD\n    a --> b\n").unwrap();
        super::super::highlights::write(&flow, "a\n", None).unwrap();
        super::super::highlights::show(Some(&flow));
        let server = Server {
            port: 0,
            secret: String::new(),
            file: flow.to_string_lossy().into_owned(),
            asset: Box::new(|_| None),
            pages: Mutex::new(Vec::new()),
            active: Mutex::new(Instant::now()),
            connections: AtomicUsize::new(0),
            said_bye: AtomicBool::new(false),
            left: Mutex::new(None),
        };
        server.bye();
        *server.active.lock().unwrap() = Instant::now().checked_sub(PING * 2).unwrap();
        (dir, flow, server)
    }

    /// Bug hunt round 4, F21: highlights an agent writes after the last page said it
    /// closes are kept by the cleanup that follows, to show at the next opening; the
    /// highlights left as they were at the goodbye go.
    #[test]
    fn highlights_written_after_the_goodbye_are_kept() {
        use super::super::highlights::{file_of, show, shown, write, SHOWING};
        let _showing = SHOWING.lock().unwrap_or_else(|e| e.into_inner());
        let (dir, flow, server) = after_goodbye("f21");
        let file = file_of(&flow).unwrap();
        write(&flow, "a\n# the agent's\nb\n", None).unwrap();
        let mut ended = false;
        server.after_ping(|| ended = true);
        assert!(!ended, "not yet ten minutes");
        assert_eq!(shown(), None, "no longer a view of the flowchart");
        assert_eq!(fs::read_to_string(&file).unwrap(), "a\n# the agent's\nb\n", "the agent's highlights are kept");
        // Left as they were at the goodbye: deleted.
        show(Some(&flow));
        server.bye();
        server.after_ping(|| {});
        assert_eq!(shown(), None);
        assert!(!file.exists(), "unchanged since the goodbye: deleted");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt round 4, E17 and F22: a page that comes while the cleanup after the last
    /// goodbye runs (its read of the highlights, then its connection) is a view of the
    /// flowchart once open, and the highlights it read are what the file holds.
    #[test]
    fn a_page_that_comes_during_the_cleanup_keeps_its_highlights() {
        use super::super::highlights::{read, shown, SHOWING};
        use std::sync::mpsc::channel;
        let _showing = SHOWING.lock().unwrap_or_else(|e| e.into_inner());
        let (dir, flow, server) = after_goodbye("e17");
        let server = Arc::new(server);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let _browser = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (stream, _) = listener.accept().unwrap();
        // The page, as `handle` serves it: a read of the highlights, then the watch.
        let (go, wait) = channel::<()>();
        let (done, finished) = channel::<()>();
        let page = {
            let (server, flow) = (server.clone(), flow.clone());
            std::thread::spawn(move || {
                wait.recv().unwrap();
                server.touch();
                let read = read(&flow).unwrap();
                server.pages.lock().unwrap().push(stream);
                server.said_bye.store(false, Ordering::SeqCst);
                server.touch();
                super::super::highlights::show(Some(&flow));
                let _ = done.send(());
                read
            })
        };
        // It comes between the pinger's look and its deed, and may finish meanwhile.
        BETWEEN.with(|run| {
            *run.borrow_mut() = Some(Box::new(move || {
                go.send(()).unwrap();
                let _ = finished.recv_timeout(Duration::from_millis(500));
            }))
        });
        server.after_ping(|| {});
        BETWEEN.with(|run| *run.borrow_mut() = None);
        let read = page.join().unwrap();
        assert!(shown().is_some(), "the open page counts as a view");
        assert_eq!(read, super::super::highlights::read(&flow).unwrap(), "the page shows what the file holds");
        super::super::highlights::show(None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
