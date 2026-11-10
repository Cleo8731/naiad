// The desktop shell. It gives the web front end (src/) the few things a web page cannot
// do on its own: read, write and watch the open flowchart file, and open a link in the
// user's browser. The front end's side of these calls is src/backend.ts.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

/// The one file watcher; replaced whenever another file is opened.
#[derive(Default)]
struct Watching(Mutex<Option<RecommendedWatcher>>);

/// The shell only ever touches flowchart files, whatever the page asks for.
fn check(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "mmd" || ext == "mermaid" {
        Ok(p)
    } else {
        Err("Only .mmd and .mermaid files can be opened.".into())
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Watching::default())
        .invoke_handler(tauri::generate_handler![
            initial_file,
            read_file,
            write_file,
            watch_file,
            open_link
        ])
        .run(tauri::generate_context!())
        .expect("error while running Naiad");
}
