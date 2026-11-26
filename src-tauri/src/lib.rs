// The desktop shell. It gives the web front end (src/) the few things a web page cannot
// do on its own: read, write and watch the open flowchart file, and open a link in the
// user's browser. The front end's side of these calls is src/backend.ts.
// Started as `naiad serve <file>` it makes no window and serves the page instead
// (serve.rs). Highlights, and the record of which flowchart a window shows:
// highlights.rs.

mod highlights;
mod serve;
mod window_set;

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use window_set::WindowSet;

/// `naiad check <file>...` and `naiad fix <file>...`: the checker, run from a terminal.
/// The page does the work with Mermaid's own parser (src/cli.ts) in a window that is
/// never shown, and hands the result to `cli_done`. Returns the word and, for each
/// file, the name as it was typed and its full path.
fn cli_args() -> Option<(String, Vec<(String, String)>)> {
    let mut args = std::env::args().skip(1);
    let mode = args.next()?;
    if mode != "check" && mode != "fix" {
        return None;
    }
    let files = args
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let full = std::path::absolute(&a)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| a.clone());
            (a, full)
        })
        .collect();
    Some((mode, files))
}

#[tauri::command]
fn cli_job() -> Option<(String, Vec<(String, String)>)> {
    cli_args()
}

/// Prints the checker's result and ends the program with its exit code.
#[tauri::command]
fn cli_done(code: i32, output: String, app: AppHandle) {
    print_out(&output);
    app.exit(code);
}

/// Writes to the terminal the program was started from. The release program is built
/// without a console (src/main.rs), so it has an output only when the caller gave it
/// one (a pipe or a file, which is what an agent's tools and the `naiad` command do);
/// started bare from a terminal, it borrows that terminal's.
fn print_out(text: &str) {
    use std::io::Write;
    let mut line = text.to_string();
    if !line.ends_with('\n') {
        line.push('\n');
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        let handle = std::io::stdout().as_raw_handle();
        if handle.is_null() || handle as isize == -1 {
            extern "system" {
                fn AttachConsole(process: u32) -> i32;
            }
            // u32::MAX is ATTACH_PARENT_PROCESS.
            if unsafe { AttachConsole(u32::MAX) } != 0 {
                if let Ok(mut console) = fs::OpenOptions::new().write(true).open("CONOUT$") {
                    let _ = console.write_all(line.as_bytes());
                }
            }
            return;
        }
    }
    let mut out = std::io::stdout();
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
}

/// The windows' file watches, one per file a window shows (a tab each).
#[derive(Default)]
struct Watching(Mutex<WatchList>);

/// A watch's key: the window's label and the path its page named (T6.2). A tab moved to
/// another window is watched there under its own key, so the old window's late stop
/// ends nothing of the new window's.
fn watch_key(label: &str, path: &str) -> String {
    format!("{label}\n{path}")
}

/// The watches by `watch_key`, each with the number `watch_file` gave it.
#[derive(Default)]
struct WatchList {
    last: u64,
    by_path: HashMap<String, (u64, Watch)>,
}

impl WatchList {
    /// Keeps `watch` for `path`, ending the one before for that path, if any; returns
    /// the new watch's number.
    fn add(&mut self, path: String, watch: Watch) -> u64 {
        self.last += 1;
        self.by_path.insert(path, (self.last, watch));
        self.last
    }

    /// Ends the watch of `path` numbered `id`. A later watch of the same path is left
    /// alone: a stop that arrives after its file was watched again ends nothing.
    fn remove(&mut self, path: &str, id: u64) -> bool {
        if self.by_path.get(path).is_some_and(|(n, _)| *n == id) {
            self.by_path.remove(path);
            return true;
        }
        false
    }

    /// Ends every watch of the window `label` (it closed).
    fn forget_window(&mut self, label: &str) {
        let prefix = format!("{label}\n");
        self.by_path.retain(|key, _| !key.starts_with(&prefix));
    }
}

/// The shell only ever touches flowchart files, whatever the page asks for. On Windows
/// a ':' inside a name names a hidden part (a stream) of another file
/// (`notes.txt:flow.mmd`), so such a path is refused whatever its extension.
fn check(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let stream = |c: std::path::Component| matches!(c, std::path::Component::Normal(n) if n.to_string_lossy().contains(':'));
    if cfg!(windows) && p.components().any(stream) {
        return Err("A name in this path holds a ':', which names a hidden part (a stream) of another file. Naiad opens only whole files.".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(ext.as_str(), "mmd" | "mermaid") {
        Ok(p)
    } else {
        Err("Only .mmd and .mermaid files can be opened.".into())
    }
}

/// The file the app was started with (a path on the command line, which is also how
/// Windows passes a double-clicked file), if there is one.
#[tauri::command]
fn initial_file() -> Option<String> {
    let here = std::env::current_dir().unwrap_or_default();
    flowchart_files(std::env::args().skip(1), &here).into_iter().next()
}

/// The flowchart files among a start's arguments (the program's own name left out), in
/// their order: options skipped, a relative path read against `cwd`, the folder that
/// start was made from; only files that are there and that `check` lets through.
fn flowchart_files(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| cwd.join(a))
        .filter_map(|p| std::path::absolute(p).ok())
        .filter(|p| p.is_file() && check(&p.to_string_lossy()).is_ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// The program's windows (T6.2): what waits for each page, what each shows, the window
/// used last (window_set.rs).
#[derive(Default)]
struct Windows(Mutex<WindowSet>, Mutex<Option<Aim>>);

/// Where a dragged tab was let go (`drag_release`): the Naiad window there, if any, and
/// the pointer's place on the screen. Kept so the tab lands there even when the page
/// asks a question first, while the pointer moves away (`drop_tab`).
struct Aim {
    to: Option<String>,
    at: tauri::PhysicalPosition<f64>,
}

/// A window's place: its top-left corner and inner size in screen pixels, and whether
/// it is maximized.
type Place = (i32, i32, u32, u32, bool);

/// The window `label`, or, if it is gone, any of the program's windows.
fn window_or_any(app: &AppHandle, label: &str) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(label).or_else(|| app.webview_windows().into_values().next())
}

fn bring_forward(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Tells a window's page that something waits for it (`arrivals`).
fn wake(app: &AppHandle, label: &str) {
    let _ = app.emit_to(label, "arrivals", ());
}

/// Records what every window shows, together (highlights.rs, the view record). Called
/// with the set held, so that two changes reach the record in the order they were made.
fn publish(set: &mut WindowSet) {
    let all: Vec<PathBuf> = set.shown(std::time::Instant::now()).into_iter().map(PathBuf::from).collect();
    let flowcharts: Vec<&Path> = all.iter().map(PathBuf::as_path).collect();
    highlights::show_all(&flowcharts);
}

/// A later start's arguments reach this program (T6.1): each flowchart file goes to the
/// window that shows it (Q214), or else to the window used last (Q213), and waits there
/// for the page, which the event "arrivals" wakes; that window comes to the front. Only
/// a start that shows a window hands over: `naiad check`, `fix` and `serve` never take
/// part (`run`).
fn hand_over(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let files = flowchart_files(argv.into_iter().skip(1), Path::new(&cwd));
    let mut woken: Vec<String> = Vec::new();
    let front = {
        let state = app.state::<Windows>();
        let mut set = state.0.lock().unwrap();
        let last = window_or_any(app, &set.last).map(|w| w.label().to_string()).unwrap_or_default();
        for file in files {
            let to = set.showing(&file).unwrap_or_else(|| last.clone());
            set.arrive(&to, serde_json::json!({ "file": file }).to_string());
            if !woken.contains(&to) {
                woken.push(to);
            }
        }
        woken.last().cloned().unwrap_or(last)
    };
    for label in &woken {
        wake(app, label);
    }
    if let Some(window) = window_or_any(app, &front) {
        bring_forward(&window);
    }
}

/// What waits for this window's page, oldest first, as JSON texts: `{"file": path}` (a
/// file handed over or shown here, T6.1), `{"tab": ..., "at": [x, y]}` (a tab moved
/// in, T6.2) or `{"kept": ...}` (tabs to open again, Q216).
#[tauri::command]
fn arrivals(window: tauri::WebviewWindow, windows: State<Windows>) -> Vec<String> {
    windows.0.lock().unwrap().take(window.label())
}

/// The Naiad window under the pointer, other than `me`, with the pointer's place.
fn window_under(app: &AppHandle, me: &str) -> Option<(tauri::WebviewWindow, tauri::PhysicalPosition<f64>)> {
    let at = app.cursor_position().ok()?;
    let others: Vec<tauri::WebviewWindow> =
        app.webview_windows().into_values().filter(|w| w.label() != me).collect();
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[repr(C)]
        struct Point {
            x: i32,
            y: i32,
        }
        #[link(name = "user32")]
        extern "system" {
            fn WindowFromPoint(point: Point) -> *mut c_void;
            fn GetAncestor(window: *mut c_void, flags: u32) -> *mut c_void;
        }
        const ROOT: u32 = 2;
        // SAFETY: both calls take plain values and return a handle, null when none.
        let top = unsafe { GetAncestor(WindowFromPoint(Point { x: at.x as i32, y: at.y as i32 }), ROOT) };
        if top.is_null() {
            return None;
        }
        others.into_iter().find(|w| w.hwnd().is_ok_and(|h| h.0 as *mut c_void == top)).map(|w| (w, at))
    }
    #[cfg(not(windows))]
    {
        let inside = |w: &tauri::WebviewWindow| {
            let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) else { return false };
            at.x >= p.x as f64
                && at.y >= p.y as f64
                && at.x < (p.x + s.width as i32) as f64
                && at.y < (p.y + s.height as i32) as f64
        };
        others.into_iter().find(|w| inside(w)).map(|w| (w, at))
    }
}

/// The pointer's place inside `window`, in the page's own pixels.
fn in_page(window: &tauri::WebviewWindow, at: tauri::PhysicalPosition<f64>) -> (f64, f64) {
    let (cx, cy) = window.inner_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
    let scale = window.scale_factor().unwrap_or(1.0);
    ((at.x - cx as f64) / scale, (at.y - cy as f64) / scale)
}

/// A tab named `name` is being dragged outside its window (T6.2): the Naiad window
/// under the pointer is told where it is ("tab-drag-at", in its own pixels), and one it
/// has left is told so ("tab-drag-off").
#[tauri::command]
fn drag_over(name: String, window: tauri::WebviewWindow, app: AppHandle, windows: State<Windows>) {
    let under = window_under(&app, window.label());
    let now = under.as_ref().map(|(w, _)| w.label().to_string());
    let left = {
        let mut set = windows.0.lock().unwrap();
        let left = set.hovered.clone().filter(|h| Some(h) != now.as_ref());
        set.hovered = now;
        left
    };
    if let Some(left) = left {
        let _ = app.emit_to(left.as_str(), "tab-drag-off", ());
    }
    if let Some((w, at)) = under {
        let (x, y) = in_page(&w, at);
        let _ = app.emit_to(w.label(), "tab-drag-at", (x, y, name));
    }
}

/// The drag ended: the window it was over, if any, is told so.
#[tauri::command]
fn drag_end(app: AppHandle, windows: State<Windows>) {
    let left = windows.0.lock().unwrap().hovered.take();
    if let Some(left) = left {
        let _ = app.emit_to(left.as_str(), "tab-drag-off", ());
    }
}

/// A dragged tab is let go outside its window: notes where (`Aim`), tells the window it
/// was over that the drag ended, and says whether another Naiad window is there (a
/// window's only tab moves only into another window).
#[tauri::command]
fn drag_release(window: tauri::WebviewWindow, app: AppHandle, windows: State<Windows>) -> bool {
    let under = window_under(&app, window.label());
    let over = under.is_some();
    *windows.1.lock().unwrap() = app.cursor_position().ok().map(|at| Aim {
        to: under.map(|(w, _)| w.label().to_string()),
        at,
    });
    let left = windows.0.lock().unwrap().hovered.take();
    if let Some(left) = left {
        let _ = app.emit_to(left.as_str(), "tab-drag-off", ());
    }
    over
}

/// A tab let go outside its window (T6.2): it goes to the Naiad window under the
/// pointer, or else into a new window there (the user, 2026-11-25). `tab` is the page's
/// account of it (its file, Undo and Redo, selection, view), passed on as it is; its
/// file, `path`, counts as shown throughout (window_set.rs). Returns the window it went
/// to. The page has already saved the tab (`Tab.leave`), and drops it once this returns.
#[tauri::command]
async fn drop_tab(path: Option<String>, tab: String, window: tauri::WebviewWindow, app: AppHandle) -> Result<String, String> {
    let tab: serde_json::Value = serde_json::from_str(&tab).map_err(|e| e.to_string())?;
    if let Some(p) = &path {
        check(p)?;
    }
    let me = window.label().to_string();
    let windows = app.state::<Windows>();
    // Where it was let go (`drag_release`), or else where the pointer is now.
    let aim = windows.1.lock().unwrap().take();
    let (under, at) = match aim {
        Some(aim) => (aim.to.and_then(|l| app.get_webview_window(&l)).map(|w| (w, aim.at)), Some(aim.at)),
        None => (window_under(&app, &me), app.cursor_position().ok()),
    };
    let left = windows.0.lock().unwrap().hovered.take();
    if let Some(left) = left {
        let _ = app.emit_to(left.as_str(), "tab-drag-off", ());
    }
    let now = std::time::Instant::now();
    if let Some((to, at)) = under {
        let (x, y) = in_page(&to, at);
        {
            let mut set = windows.0.lock().unwrap();
            set.arrive(to.label(), serde_json::json!({ "tab": tab, "at": [x, y] }).to_string());
            if let Some(p) = &path {
                set.move_view(p, &me, to.label(), now);
                publish(&mut set);
            }
        }
        wake(&app, to.label());
        bring_forward(&to);
        return Ok(to.label().to_string());
    }
    // A new window, placed so the pointer is over its tabs, a little in from the left.
    let at = at.ok_or("Naiad could not tell where the pointer is.")?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let place = ((at.x - 160.0 * scale) as i32, (at.y - 18.0 * scale) as i32, size.width, size.height, false);
    let label = {
        let mut set = windows.0.lock().unwrap();
        let label = set.new_label();
        set.arrive(&label, serde_json::json!({ "tab": tab }).to_string());
        if let Some(p) = &path {
            set.move_view(p, &me, &label, now);
            publish(&mut set);
        }
        label
    };
    if let Err(e) = make_window(&app, &label, Some(place)) {
        let others: Vec<String> = app.webview_windows().into_keys().collect();
        let mut set = windows.0.lock().unwrap();
        set.forget(&label, &others);
        publish(&mut set);
        return Err(e);
    }
    Ok(label)
}

/// A new window for tabs kept at the last close (Q216): `kept` is the page's account of
/// them, opened by the new window's page; `place` is where the window was.
#[tauri::command]
async fn open_window(kept: String, place: Option<Place>, app: AppHandle) -> Result<String, String> {
    let kept: serde_json::Value = serde_json::from_str(&kept).map_err(|e| e.to_string())?;
    let windows = app.state::<Windows>();
    let label = {
        let mut set = windows.0.lock().unwrap();
        let label = set.new_label();
        set.arrive(&label, serde_json::json!({ "kept": kept }).to_string());
        label
    };
    if let Err(e) = make_window(&app, &label, place) {
        let others: Vec<String> = app.webview_windows().into_keys().collect();
        windows.0.lock().unwrap().forget(&label, &others);
        return Err(e);
    }
    Ok(label)
}

/// Makes a window like the first, named `label`, at `place` when given, and shows it.
fn make_window(app: &AppHandle, label: &str, place: Option<Place>) -> Result<(), String> {
    let mut config = app.config().app.windows.first().cloned().ok_or("Naiad has no window settings.")?;
    config.label = label.to_string();
    config.visible = false;
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())?;
    if let Some(place) = place {
        put(&window, place);
    }
    bring_forward(&window);
    Ok(())
}

/// Puts a window at `place`. A corner on no screen today (a screen since unplugged) is
/// left where Windows puts it; the size and maximizing still apply.
fn put(window: &tauri::WebviewWindow, (x, y, width, height, maximized): Place) {
    let on_screen = window.available_monitors().is_ok_and(|screens| {
        screens.iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            let (cx, cy) = (x + 40, y + 10);
            cx >= p.x && cy >= p.y && cx < p.x + s.width as i32 && cy < p.y + s.height as i32
        })
    });
    if on_screen {
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
    if width > 0 && height > 0 {
        let _ = window.set_size(tauri::PhysicalSize::new(width, height));
    }
    if maximized {
        let _ = window.maximize();
    }
}

/// Puts this window where it was at the last close (Q216).
#[tauri::command]
fn place_window(place: Place, window: tauri::WebviewWindow) {
    put(&window, place);
}

/// Where this window is now, for Remember opened files (Q216).
#[tauri::command]
fn window_place(window: tauri::WebviewWindow) -> Option<Place> {
    let p = window.outer_position().ok()?;
    let s = window.inner_size().ok()?;
    Some((p.x, p.y, s.width, s.height, window.is_maximized().unwrap_or(false)))
}

/// Whether another of the program's windows is open (a window closing then forgets its
/// kept tabs, Q216).
#[tauri::command]
fn others_open(window: tauri::WebviewWindow, app: AppHandle) -> bool {
    app.webview_windows().keys().any(|l| l != window.label())
}

/// Opening `path` from this window when another window shows it (Q214): that window
/// shows its tab and comes to the front, and this returns true.
#[tauri::command]
fn show_elsewhere(path: String, window: tauri::WebviewWindow, app: AppHandle, windows: State<Windows>) -> bool {
    let there = {
        let mut set = windows.0.lock().unwrap();
        match set.showing(&path).filter(|l| l != window.label()) {
            Some(label) => {
                set.arrive(&label, serde_json::json!({ "file": path }).to_string());
                label
            }
            None => return false,
        }
    };
    wake(&app, &there);
    if let Some(w) = app.get_webview_window(&there) {
        bring_forward(&w);
    }
    true
}

/// Whether another Naiad window was already running when this one started (T1.23,
/// Q157): the page then does not open the files kept at the last close, which are that
/// window's. Set once, as the window is made (`run`).
static OTHER_WINDOW: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// The marker every Naiad window holds while it runs, in the person's own Windows session.
/// `naiad serve` and `naiad check` hold none.
const WINDOW_MARKER: &str = r"Local\Naiad-window";

#[tauri::command]
fn other_window() -> bool {
    OTHER_WINDOW.get().copied().unwrap_or(false)
}

/// Takes hold of the named marker `name`, and says whether it was held already: by
/// another running program (or earlier by this one). Windows keeps a marker while any
/// running program holds it and frees it when the last one ends, so a window that
/// crashed counts no more. The marker is a named mutex that is never locked: only its
/// name is used. Returns the handle, which is closed when the program ends.
#[cfg(windows)]
fn take_marker(name: &str) -> (*mut std::ffi::c_void, bool) {
    use std::ffi::c_void;
    extern "system" {
        fn CreateMutexW(attributes: *const c_void, owner: i32, name: *const u16) -> *mut c_void;
        fn GetLastError() -> u32;
    }
    const ALREADY_EXISTS: u32 = 183;
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    // SAFETY: `wide` is a NUL-ended UTF-16 name that outlives the call; the error is read
    // at once, before another call can change it.
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, wide.as_ptr());
        let held = !handle.is_null() && GetLastError() == ALREADY_EXISTS;
        (handle, held)
    }
}

/// This window takes hold of the window marker for as long as it runs, and notes whether
/// another window held it already. When it cannot tell, it says no: the kept files open.
fn mark_window() {
    #[cfg(windows)]
    let other = take_marker(WINDOW_MARKER).1;
    #[cfg(not(windows))]
    let other = false;
    let _ = OTHER_WINDOW.set(other);
}

/// Which of these paths name a flowchart file that is there: the recent list greys out
/// the ones that are not (T1.15). A path `check` refuses counts as not there, and is
/// never looked at.
#[tauri::command]
fn existing_files(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| check(p).map(|p| p.is_file()).unwrap_or(false)).collect()
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let p = check(&path)?;
    fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// Writes a flowchart's file whole (see `replace_file`). Given `expected`, the file's
/// text as the page read it, it writes only if the file still holds exactly that, and
/// otherwise writes nothing and returns false: an agent saved meanwhile.
#[tauri::command]
fn write_file(path: String, contents: String, expected: Option<String>) -> Result<bool, String> {
    let p = check(&path)?;
    match expected {
        Some(text) => replace_file_if(&p, contents.as_bytes(), Some(&|now: &[u8]| now == text.as_bytes())),
        None => replace_file(&p, contents.as_bytes()).map(|()| true),
    }
}

/// `write_file` for `naiad serve`, whose page names the text it read by its hash
/// (`fnv1a64` of its bytes; src/core/hash.ts computes the same).
pub(crate) fn write_file_hashed(path: String, contents: String, expected: Option<u64>) -> Result<bool, String> {
    let p = check(&path)?;
    match expected {
        Some(hash) => replace_file_if(&p, contents.as_bytes(), Some(&|now: &[u8]| fnv1a64(now) == hash)),
        None => replace_file(&p, contents.as_bytes()).map(|()| true),
    }
}

/// FNV-1a, 64 bits: a short name for a file's bytes, to see that it changed. Not for secrets.
pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// The number in the next temporary file's name (`replace_file`).
static NEXT_TMP: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Writes `contents` to `target` through a temporary file in the same folder, then
/// renames it over the target, so a crash mid-write cannot leave a half-written file.
/// The temporary file is made new, under a short name no file has
/// (`.naiad-<process>-<n>.tmp`): a file that happens to have such a name is never
/// overwritten, two writes at once never share one, and a long file name still fits.
pub(crate) fn replace_file(target: &Path, contents: &[u8]) -> Result<(), String> {
    replace_file_if(target, contents, None).map(|_| ())
}

/// Held from a checked write's look at the file through its rename, so two checked
/// writes in this process never both see the file as it was read and both replace it
/// (bug hunt round 2, E7: two saves to `naiad serve` with the same hash were both done).
static CHECK_AND_RENAME: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// `replace_file`, but when `holds` is given, only if it says yes to the file's bytes
/// read just before the rename (a missing file says no): otherwise the temporary file
/// is removed, the file is left as it is, and the answer is false. The look and the
/// rename are one step for the checked writes of this process (`CHECK_AND_RENAME`).
pub(crate) fn replace_file_if(target: &Path, contents: &[u8], holds: Option<&dyn Fn(&[u8]) -> bool>) -> Result<bool, String> {
    use std::io::ErrorKind;
    if target.file_name().is_none() {
        return Err("The path has no file name.".into());
    }
    let unchanged = || match holds {
        None => Ok(true),
        Some(holds) => match fs::read(target) {
            Ok(now) => Ok(holds(&now)),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        },
    };
    let tmp = temp_beside(target, contents)?;
    // A panic elsewhere while holding the lock leaves nothing half done here: the lock
    // guards no data, so a poisoned one is taken as it is.
    let _one_at_a_time = holds.map(|_| CHECK_AND_RENAME.lock().unwrap_or_else(|e| e.into_inner()));
    let done = unchanged().and_then(|go| if go { fs::rename(&tmp, on_disk(target)).map(|()| true) } else { Ok(false) });
    if !matches!(done, Ok(true)) {
        let _ = fs::remove_file(&tmp);
    }
    done.map_err(|e| e.to_string())
}

/// A new temporary file next to `target`, holding `contents` (`replace_file`). Nothing
/// is left behind when it cannot be written whole.
pub(crate) fn temp_beside(target: &Path, contents: &[u8]) -> Result<PathBuf, String> {
    use std::io::{ErrorKind, Write};
    use std::sync::atomic::Ordering;
    let me = std::process::id();
    for _ in 0..100 {
        let n = NEXT_TMP.fetch_add(1, Ordering::Relaxed);
        let tmp = target.with_file_name(format!(".naiad-{me}-{n}.tmp"));
        let mut file = match fs::OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        };
        let written = file.write_all(contents);
        drop(file);
        return match written {
            Ok(()) => Ok(tmp),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err(e.to_string())
            }
        };
    }
    Err("No free name for a temporary file next to the file.".into())
}

/// `target` with the file's name as it is on disk. Windows ignores letter case, so a
/// rename over a file through a path typed in other letters (`FLOW.mmd` for `Flow.mmd`)
/// would rename the file to them (bug hunt C24). The name on disk is taken only when
/// exactly one name in the folder matches and none matches exactly; otherwise, and for
/// a new file, `target` as given.
#[cfg(windows)]
fn on_disk(target: &Path) -> PathBuf {
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return target.to_path_buf();
    };
    let dir = if dir.as_os_str().is_empty() { Path::new(".") } else { dir };
    let wanted = name.to_string_lossy().to_lowercase();
    let mut same = Vec::new();
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let n = entry.file_name();
        if n == name {
            return target.to_path_buf();
        }
        if n.to_string_lossy().to_lowercase() == wanted {
            same.push(n);
        }
    }
    match same.as_slice() {
        [only] => target.with_file_name(only),
        _ => target.to_path_buf(),
    }
}

/// Elsewhere a name in other letters is another file: `target` as given.
#[cfg(not(windows))]
fn on_disk(target: &Path) -> PathBuf {
    target.to_path_buf()
}

/// Starts watching a file, beside the window's other files. Emits "file-changed" with the
/// path to this window whenever the file changes on disk. Returns the watch's number,
/// for `unwatch_file`.
#[tauri::command]
fn watch_file(path: String, window: tauri::WebviewWindow, app: AppHandle, state: State<Watching>) -> Result<u64, String> {
    let p = check(&path)?;
    let named = path.clone();
    let label = window.label().to_string();
    let to = label.clone();
    let watcher = watch_folder(&p, move || {
        let _ = app.emit_to(to.as_str(), "file-changed", named.clone());
    })?;
    Ok(state.0.lock().map_err(|e| e.to_string())?.add(watch_key(&label, &path), watcher))
}

/// Ends the watch `watch_file` started on `path` and numbered `id` (its tab closed, or
/// shows another file).
#[tauri::command]
fn unwatch_file(path: String, id: u64, window: tauri::WebviewWindow, state: State<Watching>) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&watch_key(window.label(), &path), id);
    Ok(())
}

/// A watch made by `watch_folder`; dropping it ends the watch.
pub(crate) struct Watch {
    _watcher: Arc<Mutex<RecommendedWatcher>>,
}

/// Calls `on_change` whenever the file at `path` changes on disk, for the window and for
/// `naiad serve`. The folder is watched rather than the file, because many editors save
/// by replacing the file.
///
/// Every folder above is watched too, up to the root, each for the name of the folder
/// below it. A watch on Windows ends without a word when its folder is deleted, and
/// follows its folder when it is renamed; so when a folder of the name is made or renamed
/// into its place, the watch is made again on it and on each folder below it that is
/// there, and `on_change` is called once the file's folder is watched again, since the
/// file may have changed meanwhile (bug hunt round 2, E8; for a folder further up, round
/// 3, C34). The watches are made again on a thread of their own: the watcher cannot be
/// asked to watch from inside its own handler. A folder below one that is watched again
/// but made later is heard by that folder's watch.
pub(crate) fn watch_folder(path: &Path, on_change: impl Fn() + Send + Sync + 'static) -> Result<Watch, String> {
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or("The path has no folder.")?;
    let name = path.file_name().ok_or("The path names no file.")?.to_os_string();
    // Windows refuses a folder path past 260 characters unless it is written in its long
    // form (`\\?\C:\...`), which `canonicalize` gives; the watcher passes the path on as
    // it is (bug hunt E3).
    let dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    // The file's folder first, then each folder above it, up to the root.
    let chain: Vec<PathBuf> = dir.ancestors().map(Path::to_path_buf).collect();
    let on_change = Arc::new(on_change);
    // The place in `chain` of a folder made again.
    let (again, asked) = std::sync::mpsc::channel::<usize>();

    let tell = on_change.clone();
    let levels = chain.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let made = matches!(event.kind, EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_)));
        let mut told = false;
        for q in &event.paths {
            let Some(level) = levels.iter().position(|l| q.parent() == Some(l.as_path())) else { continue };
            if level == 0 {
                if !told && names_file(q, &name) {
                    told = true;
                    tell();
                }
            } else if made && levels[level - 1].file_name().is_some_and(|f| names_file(q, f)) {
                let _ = again.send(level - 1);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    let watcher = Arc::new(Mutex::new(watcher));
    {
        let mut w = watcher.lock().map_err(|e| e.to_string())?;
        w.watch(&dir, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
        for above in &chain[1..] {
            let _ = w.watch(above, RecursiveMode::NonRecursive);
        }
    }

    // Ends when the watch is dropped: the handler, and with it `again`, goes too.
    let held = Arc::downgrade(&watcher);
    std::thread::spawn(move || {
        while let Ok(first) = asked.recv() {
            let top = asked.try_iter().fold(first, usize::max);
            let Some(watcher) = held.upgrade() else { return };
            let Ok(mut w) = watcher.lock() else { return };
            // From the highest folder made again down: a folder not there yet has nothing
            // below it.
            let watched = chain[..=top].iter().rev().all(|f| {
                let _ = w.unwatch(f);
                w.watch(f, RecursiveMode::NonRecursive).is_ok()
            });
            if watched {
                on_change();
            }
        }
    });
    Ok(Watch { _watcher: watcher })
}

/// Whether a changed path names the watched file, by its name `name`. Letter case is set
/// aside, as Windows does: a path typed in other letters than the name on disk, or a file
/// renamed to other letters, is still the file (bug hunt C18, E5). A name matched by
/// mistake costs one read that finds nothing changed.
fn names_file(changed: &Path, name: &OsStr) -> bool {
    changed
        .file_name()
        .is_some_and(|n| n.to_string_lossy().to_lowercase() == name.to_string_lossy().to_lowercase())
}

/// The flowchart's highlights file, or None. The page names the flowchart, never the
/// highlights file: it is always the one beside the flowchart (highlights.rs).
#[tauri::command]
fn read_highlights(path: String) -> Result<Option<String>, String> {
    highlights::read(&check(&path)?)
}

/// Writes the flowchart's highlights file whole; blank text deletes it. Given
/// `expected`, the file's text as the page read it ('' for none), it writes only if the
/// file still holds exactly that, and otherwise writes nothing and returns false.
#[tauri::command]
fn write_highlights(path: String, contents: String, expected: Option<String>) -> Result<bool, String> {
    let p = check(&path)?;
    match expected {
        Some(text) => highlights::write(&p, &contents, Some(&|now: &[u8]| now == text.as_bytes())),
        None => highlights::write(&p, &contents, None),
    }
}

/// The window now shows these flowcharts, one per tab, and no others. The view record
/// names every window's flowcharts together (`publish`).
#[tauri::command]
fn view_files(paths: Vec<String>, window: tauri::WebviewWindow, windows: State<Windows>) -> Result<(), String> {
    let checked = paths.iter().map(|p| check(p)).collect::<Result<Vec<_>, _>>()?;
    let mut set = windows.0.lock().unwrap();
    set.set_views(window.label(), checked.iter().map(|p| p.to_string_lossy().into_owned()).collect());
    publish(&mut set);
    Ok(())
}

/// Opens a link from a description in the user's browser (web and mail links only).
#[tauri::command]
fn open_link(url: String, app: AppHandle) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")) {
        return Err("Only web and mail links can be opened.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    if let Some(args) = serve::asked() {
        // The in-browser version: no window; the page's files are the ones built
        // into this program for the window.
        let context: &'static tauri::Context = Box::leak(Box::new(context));
        let assets = context.assets();
        let code = serve::run(args, move |name| assets.get(&name.into()).map(|bytes| bytes.into_owned()));
        std::process::exit(code);
    }
    let mut builder = tauri::Builder::default();
    if cli_args().is_none() {
        // T6.1: a start while a Naiad window runs hands its files to that window and
        // ends. Registered first, as the plugin asks, and only for a start that shows a
        // window: `naiad check` and `fix` (here) and `naiad serve` (above) run on their
        // own, beside a window or not.
        builder = builder.plugin(tauri_plugin_single_instance::init(hand_over));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Watching::default())
        .manage(Windows::default())
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                // The window used last, where a file opened from outside goes (Q213).
                tauri::WindowEvent::Focused(true) => {
                    app.state::<Windows>().0.lock().unwrap().last = window.label().to_string();
                }
                // A window closed: it shows no flowchart any more (Q44), and its watches end.
                tauri::WindowEvent::Destroyed => {
                    let others: Vec<String> =
                        app.webview_windows().into_keys().filter(|l| l != window.label()).collect();
                    let state = app.state::<Windows>();
                    let mut set = state.0.lock().unwrap();
                    set.forget(window.label(), &others);
                    publish(&mut set);
                    drop(set);
                    if let Ok(mut watches) = app.state::<Watching>().0.lock() {
                        watches.forget_window(window.label());
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            if cli_args().is_none() {
                mark_window();
                app.state::<Windows>().0.lock().unwrap().last = "main".into();
                // The window is made hidden (tauri.conf.json) so that the checker never
                // shows one; in ordinary use it is shown here, before the page loads.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            } else {
                // The checker must always end: if the page never reports, give up.
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    print_out("naiad: the check did not finish within 60 seconds.");
                    std::process::exit(2);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cli_job,
            cli_done,
            initial_file,
            arrivals,
            drag_over,
            drag_end,
            drag_release,
            drop_tab,
            open_window,
            place_window,
            window_place,
            others_open,
            show_elsewhere,
            other_window,
            existing_files,
            read_file,
            write_file,
            watch_file,
            unwatch_file,
            read_highlights,
            write_highlights,
            view_files,
            open_link
        ])
        .build(context)
        .expect("error while running Naiad")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                highlights::show(None);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("naiad-lib-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_write_replaces_the_file_and_leaves_nothing_beside_it() {
        let dir = folder("replace");
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "old").unwrap();
        write_file(flow.to_string_lossy().into_owned(), "new".into(), None).unwrap();
        assert_eq!(fs::read_to_string(&flow).unwrap(), "new");
        assert_eq!(names(&dir), ["flow.mmd"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt S6 (D5, F3): a file that has the name of a temporary file is the user's.
    #[test]
    fn a_file_named_like_a_temporary_file_is_never_touched() {
        let dir = folder("clash");
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "old").unwrap();
        // The name used before the fix, and the next 20 names this program would use.
        fs::write(dir.join(".flow.mmd.naiad-tmp"), "the user's").unwrap();
        let (me, next) = (std::process::id(), NEXT_TMP.load(Ordering::Relaxed));
        let taken: Vec<PathBuf> = (0..20).map(|k| dir.join(format!(".naiad-{me}-{}.tmp", next + k))).collect();
        for (k, path) in taken.iter().enumerate() {
            fs::write(path, format!("the user's {k}")).unwrap();
        }
        replace_file(&flow, b"new").unwrap();
        assert_eq!(fs::read_to_string(&flow).unwrap(), "new");
        assert_eq!(fs::read_to_string(dir.join(".flow.mmd.naiad-tmp")).unwrap(), "the user's");
        for (k, path) in taken.iter().enumerate() {
            assert_eq!(fs::read_to_string(path).unwrap(), format!("the user's {k}"));
        }
        assert_eq!(names(&dir).len(), 22, "nothing left behind");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt S6 (E4): the temporary name must fit beside a file name of 250 characters.
    #[test]
    fn a_long_file_name_can_be_written() {
        let dir = folder("long");
        let flow = dir.join(format!("{}.mmd", "g".repeat(246)));
        fs::write(&flow, "old").unwrap();
        replace_file(&flow, b"new").unwrap();
        assert_eq!(fs::read_to_string(&flow).unwrap(), "new");
        assert_eq!(names(&dir).len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt round 2, E7 (C27): of several checked writes started at once against the
    /// same reading of the file, exactly one is done; the others see the file changed.
    #[test]
    fn of_checked_writes_at_once_only_one_is_done() {
        let dir = folder("checked-at-once");
        let flow = dir.join("flow.mmd");
        for round in 0..30 {
            fs::write(&flow, "base").unwrap();
            let start = std::sync::Arc::new(std::sync::Barrier::new(8));
            let writers: Vec<_> = (0..8)
                .map(|k| {
                    let (flow, start) = (flow.clone(), start.clone());
                    std::thread::spawn(move || {
                        start.wait();
                        replace_file_if(&flow, format!("writer {k}").as_bytes(), Some(&|now: &[u8]| now == b"base")).unwrap()
                    })
                })
                .collect();
            let done = writers.into_iter().map(|w| w.join().unwrap()).filter(|&d| d).count();
            assert_eq!(done, 1, "round {round}: {done} writes done");
            assert_eq!(names(&dir), ["flow.mmd"], "round {round}: nothing left behind");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt C24: a save through a path in other letters than the file's name on disk
    /// keeps that name, checked or not; a new file is made under the name given.
    #[cfg(windows)]
    #[test]
    fn a_save_through_a_path_in_other_letters_keeps_the_name_on_disk() {
        let dir = folder("case-save");
        fs::write(dir.join("Flow.mmd"), "old").unwrap();
        let typed = |name: &str| dir.join(name).to_string_lossy().into_owned();
        assert!(write_file(typed("FLOW.mmd"), "new".into(), None).unwrap());
        assert_eq!(names(&dir), ["Flow.mmd"]);
        assert!(write_file(typed("flow.MMD"), "newer".into(), Some("new".into())).unwrap());
        assert_eq!(names(&dir), ["Flow.mmd"]);
        assert_eq!(fs::read_to_string(dir.join("Flow.mmd")).unwrap(), "newer");
        assert!(write_file(typed("Fresh.mmd"), "made".into(), None).unwrap());
        assert_eq!(names(&dir), ["Flow.mmd", "Fresh.mmd"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt S17 (C7): a save is refused when the file changed after the page read
    /// it, and nothing is left beside the file.
    #[test]
    fn a_write_is_refused_when_the_file_changed_since_it_was_read() {
        let dir = folder("expect");
        let flow = dir.join("flow.mmd");
        let path = flow.to_string_lossy().into_owned();
        fs::write(&flow, "read").unwrap();
        assert_eq!(write_file(path.clone(), "mine".into(), Some("read".into())), Ok(true));
        assert_eq!(fs::read_to_string(&flow).unwrap(), "mine");
        fs::write(&flow, "the agent's").unwrap();
        assert_eq!(write_file(path.clone(), "stale".into(), Some("mine".into())), Ok(false));
        assert_eq!(fs::read_to_string(&flow).unwrap(), "the agent's");
        assert_eq!(write_file_hashed(path.clone(), "stale".into(), Some(fnv1a64(b"mine"))), Ok(false));
        assert_eq!(fs::read_to_string(&flow).unwrap(), "the agent's");
        assert_eq!(write_file_hashed(path.clone(), "next".into(), Some(fnv1a64("the agent's".as_bytes()))), Ok(true));
        assert_eq!(fs::read_to_string(&flow).unwrap(), "next");
        assert_eq!(names(&dir), ["flow.mmd"], "nothing left beside it");
        fs::remove_file(&flow).unwrap();
        assert_eq!(write_file(path.clone(), "x".into(), Some("next".into())), Ok(false), "a file gone has changed");
        assert!(names(&dir).is_empty());
        // The highlights too (bug hunt round 4, E16), the text read named as it is.
        fs::write(&flow, "flowchart TD\n").unwrap();
        assert_eq!(write_highlights(path.clone(), "a\n".into(), Some(String::new())), Ok(true));
        assert_eq!(write_highlights(path.clone(), "b\n".into(), Some(String::new())), Ok(false));
        assert_eq!(highlights::read(&flow).unwrap().as_deref(), Some("a\n"));
        assert_eq!(write_highlights(path, "".into(), Some("a\n".into())), Ok(true));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The same hash as src/core/hash.ts (FNV-1a, 64 bits; its published test values).
    #[test]
    fn the_hash_is_fnv1a_64() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn only_flowchart_files_are_touched() {
        assert!(check(r"C:\a\flow.mmd").is_ok());
        assert!(check(r"C:\a\flow.Mermaid").is_ok());
        assert!(check(r"\\?\C:\a\notes.MD").is_err());
        assert!(check("notes.markdown").is_err());
        assert!(check(r"C:\a\notes.txt").is_err());
        assert!(check(r"C:\a\flow").is_err());
    }

    /// The recent list's check (T1.15): a flowchart file that is there, yes; one that is
    /// not, a folder, or a file of another kind, no.
    #[test]
    fn existing_files_finds_only_flowchart_files() {
        let dir = folder("existing");
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "flowchart TD\n").unwrap();
        let notes = dir.join("notes.txt");
        fs::write(&notes, "notes").unwrap();
        fs::create_dir(dir.join("box.mmd")).unwrap();
        let paths = [flow.clone(), dir.join("gone.mmd"), notes, dir.join("box.mmd")]
            .map(|p| p.to_string_lossy().into_owned());
        assert_eq!(existing_files(paths.to_vec()), [true, false, false, false]);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt S9 (E2): a path naming a stream of another file is refused, and so
    /// nothing is read, written or made beside it.
    #[cfg(windows)]
    #[test]
    fn a_stream_of_a_file_is_refused() {
        for path in [r"C:\a\notes.txt:flow.mmd", r"C:\a\flow.mmd:x.mmd", r"C:\a\flow.mmd::$DATA", r"C:\a\b:c\flow.mmd", r"\\?\C:\a\notes.txt:flow.md"] {
            assert!(check(path).is_err(), "{path}");
        }
        let dir = folder("stream");
        let notes = dir.join("notes.txt");
        fs::write(&notes, "the user's notes").unwrap();
        let stream = format!("{}:flow.mmd", notes.display());
        assert!(read_file(stream.clone()).is_err());
        assert!(write_file(stream.clone(), "flowchart TD\n".into(), None).is_err());
        assert!(write_highlights(stream.clone(), "a\n".into(), None).is_err());
        assert!(read_highlights(stream).is_err());
        assert_eq!(names(&dir), ["notes.txt"], "nothing made beside it");
        assert_eq!(fs::read_to_string(&notes).unwrap(), "the user's notes");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt S6 (E1): two writes at once each leave a whole text, never a mix.
    #[test]
    fn writes_at_once_never_mix() {
        let dir = folder("race");
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "old").unwrap();
        let texts: Vec<String> = (0..4).map(|k| format!("{k}").repeat(200_000)).collect();
        let mut failed = 0;
        for _ in 0..25 {
            let runs: Vec<_> = texts
                .iter()
                .map(|text| {
                    let (flow, text) = (flow.clone(), text.clone());
                    std::thread::spawn(move || replace_file(&flow, text.as_bytes()))
                })
                .collect();
            failed += runs.into_iter().map(|r| r.join().unwrap()).filter(Result::is_err).count();
            let now = fs::read_to_string(&flow).unwrap();
            assert!(texts.contains(&now), "the file holds one whole text");
        }
        assert_eq!(names(&dir), ["flow.mmd"], "nothing left behind ({failed} writes refused)");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt C18, E5: the watched file is told apart from others by its name, letter
    /// case set aside.
    #[test]
    fn a_name_in_other_letters_names_the_file() {
        let name = OsStr::new("Flow.mmd");
        for same in ["flow.mmd", "FLOW.MMD", "Flow.mmd", "C:/a/fLoW.mmd"] {
            assert!(names_file(Path::new(same), name), "{same}");
        }
        for other in ["other.mmd", "flow.md", "flow.mmd.tmp", "C:/flow.mmd/x.mmd"] {
            assert!(!names_file(Path::new(other), name), "{other}");
        }
        assert!(names_file(Path::new("ÉTÉ.mmd"), OsStr::new("été.mmd")));
    }

    /// Watches `watched`; the count is how many times `on_change` has been called.
    fn watching(watched: &Path) -> (Watch, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let watcher = watch_folder(watched, move || {
            count.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        (watcher, calls)
    }

    /// Calls of `on_change` caused by `act`: counted from 300 ms after `act` starts (so
    /// that what came before has arrived) to 900 ms after it ends.
    fn heard(calls: &std::sync::atomic::AtomicUsize, act: impl FnOnce()) -> usize {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let before = calls.load(Ordering::SeqCst);
        act();
        std::thread::sleep(std::time::Duration::from_millis(900));
        calls.load(Ordering::SeqCst) - before
    }

    /// T1.16, tabs: the window watches each of its files at once. A stop names the watch
    /// it ends, so a stop that arrives after its file was watched again (the tab opened it
    /// again) leaves the newer watch running.
    #[test]
    fn each_file_has_its_own_watch_and_a_stop_ends_only_its_own() {
        let dir = folder("tabs");
        let (flow, other) = (dir.join("flow.mmd"), dir.join("other.mmd"));
        fs::write(&flow, "flowchart TD\n    a\n").unwrap();
        fs::write(&other, "flowchart TD\n    o\n").unwrap();
        let (flow_name, other_name) = (flow.to_string_lossy().into_owned(), other.to_string_lossy().into_owned());
        let mut list = WatchList::default();
        let (w1, first) = watching(&flow);
        let (w2, second) = watching(&other);
        let old = list.add(flow_name.clone(), w1);
        let theirs = list.add(other_name.clone(), w2);
        assert!(heard(&first, || fs::write(&flow, "flowchart TD\n    b\n").unwrap()) > 0, "the first file");
        assert!(heard(&second, || fs::write(&other, "flowchart TD\n    p\n").unwrap()) > 0, "the second, at the same time");

        let (w3, again) = watching(&flow);
        let new = list.add(flow_name.clone(), w3);
        assert_eq!(heard(&first, || fs::write(&flow, "flowchart TD\n    c\n").unwrap()), 0, "the watch replaced has ended");
        assert!(!list.remove(&flow_name, old), "a late stop of the old watch ends nothing");
        assert!(heard(&again, || fs::write(&flow, "flowchart TD\n    d\n").unwrap()) > 0, "the newer watch runs on");
        assert!(list.remove(&flow_name, new));
        assert_eq!(heard(&again, || fs::write(&flow, "flowchart TD\n    e\n").unwrap()), 0, "stopped");
        assert!(heard(&second, || fs::write(&other, "flowchart TD\n    q\n").unwrap()) > 0, "the other file's watch runs on");
        assert!(list.remove(&other_name, theirs));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt C18: the window opened by a path typed in other letters than the name on
    /// disk still hears of a change.
    #[cfg(windows)]
    #[test]
    fn a_path_in_other_letters_still_hears_of_a_change() {
        let dir = folder("case-typed");
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "flowchart TD\n    a\n").unwrap();
        let (_watcher, calls) = watching(&dir.join("FLOW.mmd"));
        assert!(heard(&calls, || fs::write(&flow, "flowchart TD\n    b\n").unwrap()) > 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt E5: after the file is renamed to other letters, a change is still heard.
    #[cfg(windows)]
    #[test]
    fn a_file_renamed_to_other_letters_still_hears_of_a_change() {
        let dir = folder("case-renamed");
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "flowchart TD\n    a\n").unwrap();
        let (_watcher, calls) = watching(&flow);
        let renamed = dir.join("Flow.mmd");
        std::thread::sleep(std::time::Duration::from_millis(300));
        fs::rename(&flow, &renamed).unwrap();
        assert!(heard(&calls, || fs::write(&renamed, "flowchart TD\n    b\n").unwrap()) > 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt E3: a file in a folder whose path is past 260 characters is watched.
    #[test]
    fn a_file_in_a_folder_past_260_characters_is_watched() {
        let dir = folder("deep");
        let deep =(0..6).fold(dir.clone(), |d, k| d.join(format!("{k}{}", "x".repeat(49))));
        fs::create_dir_all(&deep).unwrap();
        assert!(deep.as_os_str().len() > 260, "{}", deep.as_os_str().len());
        let flow = deep.join("flow.mmd");
        fs::write(&flow, "flowchart TD\n    a\n").unwrap();
        let (_watcher, calls) = watching(&flow);
        assert!(heard(&calls, || fs::write(&flow, "flowchart TD\n    b\n").unwrap()) > 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_change_to_another_file_is_not_heard() {
        let dir = folder("case-other");
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "flowchart TD\n    a\n").unwrap();
        let (_watcher, calls) = watching(&flow);
        assert_eq!(heard(&calls, || fs::write(dir.join("other.mmd"), "flowchart LR\n    o\n").unwrap()), 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt round 2, E8: after the file's folder is deleted and made again, a change
    /// to the file is still heard.
    #[test]
    fn a_folder_deleted_and_made_again_is_still_watched() {
        let dir = folder("remade");
        let inner = dir.join("inner");
        let flow = inner.join("flow.mmd");
        fs::create_dir_all(&inner).unwrap();
        fs::write(&flow, "flowchart TD\n    a\n").unwrap();
        let (_watcher, calls) = watching(&flow);
        heard(&calls, || fs::remove_dir_all(&inner).unwrap());
        heard(&calls, || {
            fs::create_dir(&inner).unwrap();
            fs::write(&flow, "flowchart TD\n    b\n").unwrap();
        });
        assert!(heard(&calls, || fs::write(&flow, "flowchart TD\n    c\n").unwrap()) > 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt round 3, C34 (E13, oE1): after a folder above the file's folder is deleted
    /// and made again, a change to the file is still heard: one folder up or two, the
    /// folders made at once or one after another.
    #[test]
    fn a_folder_above_deleted_and_made_again_is_still_watched() {
        for (depth, slow) in [(1, false), (1, true), (2, false), (2, true)] {
            let dir = folder(&format!("remade-above-{depth}-{slow}"));
            let top = dir.join("a");
            let inner = (0..depth).fold(top.clone(), |d, _| d.join("b"));
            let flow = inner.join("flow.mmd");
            fs::create_dir_all(&inner).unwrap();
            fs::write(&flow, "flowchart TD\n    a\n").unwrap();
            let (_watcher, calls) = watching(&flow);
            heard(&calls, || fs::remove_dir_all(&top).unwrap());
            heard(&calls, || {
                let mut made = top.clone();
                fs::create_dir(&made).unwrap();
                for _ in 0..depth {
                    if slow {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                    }
                    made = made.join("b");
                    fs::create_dir(&made).unwrap();
                }
                fs::write(&flow, "flowchart TD\n    b\n").unwrap();
            });
            let later = heard(&calls, || fs::write(&flow, "flowchart TD\n    c\n").unwrap());
            fs::remove_dir_all(&dir).unwrap();
            assert!(later > 0, "{depth} folders up, made one after another: {slow}");
        }
    }

    /// The same when another folder is renamed into the folder's place: the watch must
    /// not follow the old folder to its new name.
    #[test]
    fn a_folder_renamed_into_the_place_is_watched() {
        let dir = folder("swapped");
        let inner = dir.join("inner");
        let next = dir.join("next");
        fs::create_dir_all(&inner).unwrap();
        fs::create_dir_all(&next).unwrap();
        let flow = inner.join("flow.mmd");
        fs::write(&flow, "flowchart TD\n    a\n").unwrap();
        fs::write(next.join("flow.mmd"), "flowchart TD\n    b\n").unwrap();
        let (_watcher, calls) = watching(&flow);
        heard(&calls, || {
            fs::rename(&inner, dir.join("old")).unwrap();
            fs::rename(&next, &inner).unwrap();
        });
        assert!(heard(&calls, || fs::write(&flow, "flowchart TD\n    c\n").unwrap()) > 0);
        assert_eq!(heard(&calls, || fs::write(dir.join("old").join("flow.mmd"), "flowchart TD\n    d\n").unwrap()), 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Watching the folder above holds it no more than before: the whole tree can still
    /// be deleted while the file is watched. (Renaming a folder above a watched folder is
    /// refused by Windows, "Access is denied", with or without the watch above.)
    #[test]
    fn the_folder_above_can_still_be_deleted() {
        let dir = folder("above");
        let inner = dir.join("x").join("inner");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("flow.mmd"), "flowchart TD\n    a\n").unwrap();
        let (_watcher, _calls) = watching(&inner.join("flow.mmd"));
        std::thread::sleep(std::time::Duration::from_millis(200));
        fs::remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    /// T1.23, Q157: a second holder of a window marker sees the first; once no one holds
    /// it (a window closed, or crashed), the next one does not.
    #[cfg(windows)]
    #[test]
    fn a_window_marker_counts_while_it_is_held_and_not_after() {
        use std::ffi::c_void;
        extern "system" {
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        let name = format!(r"Local\naiad-test-marker-{}", std::process::id());
        let (first, held) = take_marker(&name);
        assert!(!first.is_null());
        assert!(!held, "no one held it before");
        let (second, held) = take_marker(&name);
        assert!(held, "the second holder sees the first");
        // SAFETY: both handles came from `take_marker` and are closed once each.
        unsafe {
            CloseHandle(first);
            CloseHandle(second);
        }
        let (third, held) = take_marker(&name);
        assert!(!held, "a marker no one holds is gone");
        // SAFETY: as above.
        unsafe {
            CloseHandle(third);
        }
    }
    /// T6.1: a later start's files are read against the folder that start was made
    /// from, not this program's; options, missing files and other kinds are left out;
    /// the order is kept.
    #[test]
    fn handed_over_arguments_keep_only_flowchart_files() {
        let dir = folder("handover");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("a.mmd"), "flowchart TD
").unwrap();
        fs::write(dir.join("b.MERMAID"), "flowchart TD
").unwrap();
        fs::write(dir.join("notes.md"), "# notes
").unwrap();
        let args = ["--flag", "b.MERMAID", "notes.md", "gone.mmd", r"sub\a.mmd"].map(String::from);
        let got = flowchart_files(args, &dir);
        let want: Vec<String> = [dir.join("b.MERMAID"), dir.join("sub").join("a.mmd")]
            .iter()
            .map(|p| std::path::absolute(p).unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(got, want);
        // A full path stays as it is, whatever the folder.
        let full = want[1].clone();
        assert_eq!(flowchart_files([full.clone()], Path::new(r"C:\")), vec![full]);
        let _ = fs::remove_dir_all(&dir);
    }
}
