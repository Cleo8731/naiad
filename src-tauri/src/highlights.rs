// Highlights (D2.4): the highlights file beside a flowchart's file, and the record of
// which flowchart each Naiad view shows, so that the file is deleted when the last view
// of that flowchart closes (Q44), never when one opens.
//
// The file is `.naiad/<the flowchart file's name>/highlights.txt`, one item per line
// (FILE-FORMAT.md, Highlights; the page reads and changes the lines, src/core/highlights.ts).
// The flowchart's own file is never touched here.
//
// The views: every window and every `naiad serve` server that shows a flowchart keeps
// one small file in the temporary folder, `naiad-views/<process id>.txt`, holding the
// flowchart's full path, and removes it when it stops showing it. A view that stops
// showing a flowchart deletes its highlights only if no other running program's record
// names it. When in doubt (a record that cannot be read), the highlights are kept: a
// highlight left over is shown again and goes at the next closing.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The highlights file of a flowchart's file.
pub fn file_of(flowchart: &Path) -> Result<PathBuf, String> {
    let name = flowchart.file_name().ok_or("The path has no file name.")?;
    let dir = flowchart.parent().ok_or("The path has no folder.")?;
    Ok(dir.join(".naiad").join(name).join("highlights.txt"))
}

/// The highlights file's text, or None if there is none.
pub fn read(flowchart: &Path) -> Result<Option<String>, String> {
    let file = file_of(flowchart)?;
    match fs::read_to_string(&file) {
        Ok(text) => {
            // An agent may have made the folder: hide it as Naiad's own (Q26).
            if let Some(naiad) = file.parent().and_then(Path::parent) {
                hide(naiad);
            }
            Ok(Some(text))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes the highlights file whole, through a temporary file and a rename. A text with
/// nothing but blank lines deletes it instead.
pub fn write(flowchart: &Path, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return delete(flowchart);
    }
    let file = file_of(flowchart)?;
    let folder = file.parent().ok_or("No folder.")?;
    fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    if let Some(naiad) = folder.parent() {
        hide(naiad);
    }
    let tmp = folder.join(".highlights.txt.naiad-tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Deletes the highlights file, then its folder and the `.naiad` folder if they are
/// left empty (Q24: with nothing in it, there is no `.naiad` folder).
pub fn delete(flowchart: &Path) -> Result<(), String> {
    let file = file_of(flowchart)?;
    match fs::remove_file(&file) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    if let Some(folder) = file.parent() {
        // Each fails, as it should, when the folder still holds something.
        let _ = fs::remove_dir(folder);
        if let Some(naiad) = folder.parent() {
            let _ = fs::remove_dir(naiad);
        }
    }
    Ok(())
}

/// Sets Windows' "hidden" mark on the `.naiad` folder, as git does for `.git` (Q26).
#[cfg(windows)]
fn hide(folder: &Path) {
    use std::os::windows::ffi::OsStrExt;
    extern "system" {
        fn GetFileAttributesW(name: *const u16) -> u32;
        fn SetFileAttributesW(name: *const u16, attributes: u32) -> i32;
    }
    const HIDDEN: u32 = 0x2;
    const DIRECTORY: u32 = 0x10;
    const INVALID: u32 = u32::MAX;
    let wide: Vec<u16> = folder.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let now = GetFileAttributesW(wide.as_ptr());
        if now != INVALID && now & DIRECTORY != 0 && now & HIDDEN == 0 {
            SetFileAttributesW(wide.as_ptr(), (now & !DIRECTORY) | HIDDEN);
        }
    }
}

#[cfg(not(windows))]
fn hide(_folder: &Path) {}

// ---- Which flowchart each view shows ------------------------------------------------

/// The flowchart this program shows, as its full path.
static SHOWN: Mutex<Option<String>> = Mutex::new(None);

fn records() -> PathBuf {
    std::env::temp_dir().join("naiad-views")
}

/// A flowchart's full path in one form, so that two views of one file name it alike.
fn full(flowchart: &Path) -> String {
    fs::canonicalize(flowchart)
        .map(|p| super::serve::plain_path(&p))
        .unwrap_or_else(|_| flowchart.to_string_lossy().into_owned())
}

/// Records that this program now shows `flowchart`, or nothing. If it stops showing
/// another flowchart by this, and no other view shows that one, its highlights file is
/// deleted.
pub fn show(flowchart: Option<&Path>) {
    let next = flowchart.map(full);
    let before = match SHOWN.lock() {
        Ok(mut shown) => std::mem::replace(&mut *shown, next.clone()),
        Err(_) => return,
    };
    let dir = records();
    let me = std::process::id();
    let record = dir.join(format!("{me}.txt"));
    match &next {
        Some(path) => {
            if before.as_deref() != Some(path.as_str()) && fs::create_dir_all(&dir).is_ok() {
                let tmp = dir.join(format!("{me}.tmp"));
                if fs::write(&tmp, path).is_ok() && fs::rename(&tmp, &record).is_err() {
                    let _ = fs::remove_file(&tmp);
                }
            }
        }
        None => {
            if before.is_some() {
                let _ = fs::remove_file(&record);
            }
        }
    }
    if let Some(old) = before {
        let same = next.as_deref().is_some_and(|n| n.to_lowercase() == old.to_lowercase());
        if !same && !shown_elsewhere(&dir, me, &old) {
            let _ = delete(Path::new(&old));
        }
    }
}

/// Whether a running program other than `me` has a record that names `flowchart`.
/// Records left by programs that ended without removing theirs (a crash) are removed.
fn shown_elsewhere(dir: &Path, me: u32, flowchart: &str) -> bool {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return false,
        Err(_) => return true,
    };
    let wanted = flowchart.to_lowercase();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = name.strip_suffix(".txt").and_then(|p| p.parse::<u32>().ok()) else { continue };
        if pid == me {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else { return true };
        if text.trim().to_lowercase() != wanted {
            continue;
        }
        if alive(pid) {
            return true;
        }
        let _ = fs::remove_file(entry.path());
    }
    false
}

/// Whether a program with this process id is running. Says yes when it cannot tell.
#[cfg(windows)]
fn alive(pid: u32) -> bool {
    use std::ffi::c_void;
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }
    const QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    const INVALID_PARAMETER: u32 = 87; // no process has this id
    unsafe {
        let process = OpenProcess(QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return GetLastError() != INVALID_PARAMETER;
        }
        let mut code = 0u32;
        let read = GetExitCodeProcess(process, &mut code) != 0;
        CloseHandle(process);
        !read || code == STILL_ACTIVE
    }
}

#[cfg(not(windows))]
fn alive(_pid: u32) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("naiad-hl-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_file_sits_in_a_folder_named_for_the_flowchart_file() {
        let got = file_of(Path::new(r"C:\a\flow.mmd")).unwrap();
        assert_eq!(got, Path::new(r"C:\a\.naiad\flow.mmd\highlights.txt"));
        let got = file_of(Path::new(r"C:\a\notes.md")).unwrap();
        assert_eq!(got, Path::new(r"C:\a\.naiad\notes.md\highlights.txt"));
    }

    #[test]
    fn written_read_and_deleted_with_its_empty_folders() {
        let dir = folder("rw");
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "flowchart TD\n    a --> b\n").unwrap();
        assert_eq!(read(&flow).unwrap(), None);
        write(&flow, "a\na --> b\n").unwrap();
        assert_eq!(read(&flow).unwrap().as_deref(), Some("a\na --> b\n"));
        let naiad = dir.join(".naiad");
        assert!(!naiad.join("flow.mmd").join(".highlights.txt.naiad-tmp").exists());
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_ne!(fs::metadata(&naiad).unwrap().file_attributes() & 0x2, 0, "the .naiad folder is hidden");
        }
        // Blank text deletes the file and the folders it leaves empty.
        write(&flow, "\n  \n").unwrap();
        assert_eq!(read(&flow).unwrap(), None);
        assert!(!naiad.exists());
        // The flowchart's own file is untouched.
        assert_eq!(fs::read_to_string(&flow).unwrap(), "flowchart TD\n    a --> b\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_holding_something_else_is_kept() {
        let dir = folder("keep");
        let flow = dir.join("flow.mmd");
        write(&flow, "a\n").unwrap();
        let proposal = dir.join(".naiad").join("flow.mmd").join("a-proposal.mmd");
        fs::write(&proposal, "flowchart TD\n").unwrap();
        delete(&flow).unwrap();
        assert!(proposal.exists());
        assert!(!dir.join(".naiad").join("flow.mmd").join("highlights.txt").exists());
        delete(&flow).unwrap(); // deleting what is not there is no error
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_record_counts_only_while_its_program_runs() {
        let dir = folder("views");
        let flow = r"C:\Work\Flow.mmd";
        let other = std::process::id();
        // A program that has ended: start one and wait for it.
        let ended = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
            .args(if cfg!(windows) { &["/c", "exit"][..] } else { &[][..] })
            .spawn()
            .unwrap();
        let ended_id = ended.id();
        let mut ended = ended;
        ended.wait().unwrap();

        assert!(!shown_elsewhere(&dir, 1, flow), "no records");
        fs::write(dir.join(format!("{ended_id}.txt")), flow).unwrap();
        if cfg!(windows) {
            assert!(!shown_elsewhere(&dir, 1, flow), "a record of a program that has ended");
            assert!(!dir.join(format!("{ended_id}.txt")).exists(), "and it is removed");
        }
        fs::write(dir.join(format!("{other}.txt")), r"c:\work\flow.MMD").unwrap();
        assert!(shown_elsewhere(&dir, 1, flow), "a running program, the path in another case");
        assert!(!shown_elsewhere(&dir, other, flow), "its own record does not count");
        assert!(!shown_elsewhere(&dir, 1, r"C:\Work\Other.mmd"), "another flowchart");
        fs::remove_dir_all(&dir).unwrap();
    }
}
