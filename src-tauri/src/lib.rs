// The desktop shell. It gives the web front end (src/) the few things a web page cannot
// do on its own: read, write and watch the open flowchart file, and open a link in the
// user's browser. The front end's side of these calls is src/backend.ts.
// Started as `naiad serve <file>` it makes no window and serves the page instead
// (serve.rs).

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

/// Writes through a temporary file in the same folder and then renames it over the
/// target, so a crash mid-write cannot leave a half-written flowchart.
#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    let p = check(&path)?;
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("The path has no file name.")?;
    let tmp = p.with_file_name(format!(".{name}.naiad-tmp"));
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
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
            open_link
        ])
        .run(context)
        .expect("error while running Naiad");
}
