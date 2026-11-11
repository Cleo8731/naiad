// The desktop shell. It gives the web front end (src/) the few things a web page cannot
// do on its own: read, write and watch the open flowchart file, and open a link in the
// user's browser. The front end's side of these calls is src/backend.ts.
// Started as `naiad serve <file>` it makes no window and serves the page instead
// (serve.rs). Highlights, and the record of which flowchart a window shows:
// highlights.rs.

mod highlights;
mod serve;

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

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

/// The one file watcher; replaced whenever another file is opened.
#[derive(Default)]
struct Watching(Mutex<Option<RecommendedWatcher>>);

/// The shell only ever touches flowchart files and Markdown files (which can hold a
/// flowchart block), whatever the page asks for. On Windows a ':' inside a name names a
/// hidden part (a stream) of another file (`notes.txt:flow.mmd`), so such a path is
/// refused whatever its extension.
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
    if matches!(ext.as_str(), "mmd" | "mermaid" | "md" | "markdown") {
        Ok(p)
    } else {
        Err("Only .mmd, .mermaid and .md files can be opened.".into())
    }
}

/// The file the app was started with (a path on the command line, which is also how
/// Windows passes a double-clicked file), if there is one.
#[tauri::command]
fn initial_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| std::path::absolute(&a).ok())
        .find(|p| p.is_file() && check(&p.to_string_lossy()).is_ok())
        .map(|p| p.to_string_lossy().into_owned())
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

/// `replace_file`, but when `holds` is given, only if it says yes to the file's bytes
/// read just before the rename (a missing file says no): otherwise the temporary file
/// is removed, the file is left as it is, and the answer is false.
pub(crate) fn replace_file_if(target: &Path, contents: &[u8], holds: Option<&dyn Fn(&[u8]) -> bool>) -> Result<bool, String> {
    use std::io::{ErrorKind, Write};
    use std::sync::atomic::Ordering;
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
        let done = written
            .and_then(|()| unchanged())
            .and_then(|go| if go { fs::rename(&tmp, target).map(|()| true) } else { Ok(false) });
        if !matches!(done, Ok(true)) {
            let _ = fs::remove_file(&tmp);
        }
        return done.map_err(|e| e.to_string());
    }
    Err("No free name for a temporary file next to the file.".into())
}

/// Starts watching a file. Emits "file-changed" with the path whenever it changes on
/// disk.
#[tauri::command]
fn watch_file(path: String, app: AppHandle, state: State<Watching>) -> Result<(), String> {
    let p = check(&path)?;
    let watcher = watch_folder(&p, move || {
        let _ = app.emit("file-changed", path.clone());
    })?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

/// Calls `on_change` whenever the file at `path` changes on disk, for the window and for
/// `naiad serve`. The folder is watched rather than the file, because many editors save
/// by replacing the file.
pub(crate) fn watch_folder(path: &Path, on_change: impl Fn() + Send + 'static) -> Result<RecommendedWatcher, String> {
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or("The path has no folder.")?;
    let name = path.file_name().ok_or("The path names no file.")?.to_os_string();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if event.paths.iter().any(|q| names_file(q, &name)) {
                on_change();
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    Ok(watcher)
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

/// Writes the flowchart's highlights file whole; blank text deletes it.
#[tauri::command]
fn write_highlights(path: String, contents: String) -> Result<(), String> {
    highlights::write(&check(&path)?, &contents)
}

/// The window now shows this flowchart (and no longer the one before, if another).
#[tauri::command]
fn view_file(path: String) -> Result<(), String> {
    highlights::show(Some(&check(&path)?));
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Watching::default())
        .on_window_event(|_window, event| {
            // The window is closing: it shows no flowchart any more (Q44).
            if let tauri::WindowEvent::Destroyed = event {
                highlights::show(None);
            }
        })
        .setup(|app| {
            if cli_args().is_none() {
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
            read_file,
            write_file,
            watch_file,
            read_highlights,
            write_highlights,
            view_file,
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
        assert_eq!(write_file(path, "x".into(), Some("next".into())), Ok(false), "a file gone has changed");
        assert!(names(&dir).is_empty());
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
    fn only_flowchart_and_markdown_files_are_touched() {
        assert!(check(r"C:\a\flow.mmd").is_ok());
        assert!(check(r"C:\a\flow.Mermaid").is_ok());
        assert!(check(r"\\?\C:\a\notes.MD").is_ok());
        assert!(check("notes.markdown").is_ok());
        assert!(check(r"C:\a\notes.txt").is_err());
        assert!(check(r"C:\a\flow").is_err());
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
        assert!(write_highlights(stream.clone(), "a\n".into()).is_err());
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
    fn watching(watched: &Path) -> (RecommendedWatcher, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
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

    #[test]
    fn a_change_to_another_file_is_not_heard() {
        let dir = folder("case-other");
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "flowchart TD\n    a\n").unwrap();
        let (_watcher, calls) = watching(&flow);
        assert_eq!(heard(&calls, || fs::write(dir.join("other.mmd"), "flowchart LR\n    o\n").unwrap()), 0);
        fs::remove_dir_all(&dir).unwrap();
    }
}
