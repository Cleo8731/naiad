// The desktop shell. It gives the web front end (src/) the few things a web page cannot
// do on its own: read, write and watch the open flowchart file, and open a link in the
// user's browser. The front end's side of these calls is src/backend.ts.
// Started as `naiad serve <file>` it makes no window and serves the page instead
// (serve.rs). Highlights, and the record of which flowchart a window shows:
// highlights.rs.

mod highlights;
mod serve;

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
/// flowchart block), whatever the page asks for.
fn check(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
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

/// Writes a flowchart's file whole (see `replace_file`).
#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    let p = check(&path)?;
    replace_file(&p, contents.as_bytes())
}

/// The number in the next temporary file's name (`replace_file`).
static NEXT_TMP: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Writes `contents` to `target` through a temporary file in the same folder, then
/// renames it over the target, so a crash mid-write cannot leave a half-written file.
/// The temporary file is made new, under a short name no file has
/// (`.naiad-<process>-<n>.tmp`): a file that happens to have such a name is never
/// overwritten, two writes at once never share one, and a long file name still fits.
pub(crate) fn replace_file(target: &Path, contents: &[u8]) -> Result<(), String> {
    use std::io::{ErrorKind, Write};
    use std::sync::atomic::Ordering;
    if target.file_name().is_none() {
        return Err("The path has no file name.".into());
    }
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
        return written.and_then(|()| fs::rename(&tmp, target)).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            e.to_string()
        });
    }
    Err("No free name for a temporary file next to the file.".into())
}

/// Starts watching a file. Emits "file-changed" with the path whenever it changes on
/// disk. The folder is watched rather than the file, because many editors save by
/// replacing the file.
#[tauri::command]
fn watch_file(path: String, app: AppHandle, state: State<Watching>) -> Result<(), String> {
    let p = check(&path)?;
    let dir = p
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .ok_or("The path has no folder.")?;
    let name = p.file_name().map(|n| n.to_os_string());
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if event.paths.iter().any(|q| q.file_name().map(|n| n.to_os_string()) == name) {
                let _ = app.emit("file-changed", path.clone());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
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
        write_file(flow.to_string_lossy().into_owned(), "new".into()).unwrap();
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
}
