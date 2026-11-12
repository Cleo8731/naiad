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

/// The highlights file of a flowchart's file, once it is clear that nothing on the way
/// to it is a link. `.naiad`, its folder for the flowchart and `highlights.txt` are
/// Naiad's own: a link there (a symbolic link, or a junction, which anyone can make on
/// Windows) would lead reads, writes and deletes to files elsewhere, so it is refused,
/// never followed and never removed.
fn checked(flowchart: &Path) -> Result<PathBuf, String> {
    let file = file_of(flowchart)?;
    let folder = file.parent().ok_or("No folder.")?;
    let naiad = folder.parent().ok_or("No folder.")?;
    for step in [naiad, folder, file.as_path()] {
        if !no_link(step)? {
            break;
        }
    }
    Ok(file)
}

/// Whether `path` is there, once it is clear that it is not a link (an error if it is).
fn no_link(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Err(link_error(path)),
        Ok(_) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

fn link_error(path: &Path) -> String {
    format!("{} is a link; Naiad does not follow links in its .naiad folder.", path.display())
}

/// `.naiad`, or its folder for a flowchart, made first if `make` and it is missing,
/// then held open until the answer is dropped (None: missing, and not `make`). While it
/// is held, Windows lets nobody delete or rename it, so a link cannot be put in its place
/// between Naiad's look at it and Naiad's use of it: the look is made through the held
/// folder itself (bug hunt round 3, F15: a junction made between a check and a write led
/// the write outside). A folder taken away while Naiad makes it is an error, never None:
/// a write would go on unheld.
fn hold(dir: &Path, make: bool) -> Result<Option<fs::File>, String> {
    if !no_link(dir)? {
        if !make {
            return Ok(None);
        }
        match fs::create_dir(dir) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    let held = match open_held(dir) {
        Ok(held) => held,
        Err(e) if e.kind() == ErrorKind::NotFound && make => {
            return Err(format!("{} was taken away while Naiad made it.", dir.display()))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let what = held.metadata().map_err(|e| e.to_string())?;
    if what.file_type().is_symlink() {
        return Err(link_error(dir));
    }
    if !what.is_dir() {
        return Err(format!("{} is not a folder.", dir.display()));
    }
    Ok(Some(held))
}

/// The folder itself, never where a link there leads, shared with others for reading
/// and writing but never for deleting.
#[cfg(windows)]
fn open_held(dir: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    // Listing, not only its attributes: Windows keeps a handle's sharing terms only for
    // a handle that may read, write or delete.
    const LIST_DIRECTORY: u32 = 0x1;
    const READ_ATTRIBUTES: u32 = 0x80;
    const SHARE_READ: u32 = 0x1;
    const SHARE_WRITE: u32 = 0x2;
    const BACKUP_SEMANTICS: u32 = 0x0200_0000; // needed to open a folder
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000; // the link itself, if it is one
    fs::OpenOptions::new()
        .access_mode(LIST_DIRECTORY | READ_ATTRIBUTES)
        .share_mode(SHARE_READ | SHARE_WRITE)
        .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
        .open(dir)
}

#[cfg(not(windows))]
fn open_held(dir: &Path) -> std::io::Result<fs::File> {
    fs::File::open(dir)
}

/// The highlights file's text, or None if there is none.
pub fn read(flowchart: &Path) -> Result<Option<String>, String> {
    let file = checked(flowchart)?;
    let folder = file.parent().ok_or("No folder.")?;
    let naiad = folder.parent().ok_or("No folder.")?;
    let Some(_naiad) = hold(naiad, false)? else { return Ok(None) };
    let Some(_folder) = hold(folder, false)? else { return Ok(None) };
    if !no_link(&file)? {
        return Ok(None);
    }
    let Some(bytes) = read_unlinked(&file)? else { return Ok(None) };
    let text = String::from_utf8(bytes).map_err(|_| unreadable(&file))?;
    // An agent may have made the folder: hide it as Naiad's own (Q26).
    hide(naiad);
    Ok(Some(text))
}

/// The bytes of `file`, never those of a file a link there leads to (None: there is no
/// file). The name is opened as it is, a link there not followed, and held so that
/// nobody can delete it, rename it or put a link in its place until the read is done,
/// and the look is made through the held name itself: a link put there between Naiad's
/// look and its read led the read to another file (bug hunt round 4, E19, F20).
fn read_unlinked(file: &Path) -> Result<Option<Vec<u8>>, String> {
    let held = match open_pinned(file) {
        Ok(held) => held,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let what = held.metadata().map_err(|e| e.to_string())?;
    if what.file_type().is_symlink() {
        return Err(link_error(file));
    }
    if !what.is_file() {
        return Err(format!("{} is not a file.", file.display()));
    }
    // Read by its name, as any program reads it, while the held name stays on the file
    // just looked at.
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    drop(held);
    Ok(Some(bytes))
}

/// The file itself, never where a link there leads, shared with others for reading and
/// writing but never for deleting or renaming.
#[cfg(windows)]
fn open_pinned(file: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    const SHARE_READ: u32 = 0x1;
    const SHARE_WRITE: u32 = 0x2;
    const BACKUP_SEMANTICS: u32 = 0x0200_0000; // a folder or a junction opens too, to be refused
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000; // the link itself, if it is one
    fs::OpenOptions::new()
        .read(true)
        .share_mode(SHARE_READ | SHARE_WRITE)
        .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
        .open(file)
}

#[cfg(not(windows))]
fn open_pinned(file: &Path) -> std::io::Result<fs::File> {
    fs::File::open(file)
}

/// Writes the highlights file whole, through a temporary file and a rename
/// (`replace_file`, lib.rs), with `.naiad` and its folder held (`hold`). A text with
/// nothing but blank lines deletes it instead. A file Naiad cannot read is an error,
/// left as it is (`readable`).
pub fn write(flowchart: &Path, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return remove(flowchart, true);
    }
    let file = checked(flowchart)?;
    let folder = file.parent().ok_or("No folder.")?;
    let naiad = folder.parent().ok_or("No folder.")?;
    let _naiad = hold(naiad, true)?.ok_or("No .naiad folder.")?;
    let _folder = hold(folder, true)?.ok_or("No folder in .naiad.")?;
    hide(naiad);
    if no_link(&file)? && !readable(&file)? {
        return Err(unreadable(&file));
    }
    super::replace_file(&file, text.as_bytes())
}

/// Whether Naiad may replace or delete the highlights file: there is none, or it is
/// UTF-8 text. A file Naiad cannot read (UTF-16, as Windows PowerShell 5 writes it) may
/// hold an agent's notes that Naiad never showed, so it is left as it is (bug hunt
/// round 3, F16). Read as `read` reads it, never through a link (`read_unlinked`).
fn readable(file: &Path) -> Result<bool, String> {
    Ok(match read_unlinked(file)? {
        Some(bytes) => std::str::from_utf8(&bytes).is_ok(),
        None => true,
    })
}

fn unreadable(file: &Path) -> String {
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{name} is not UTF-8 text, so Naiad leaves it alone.")
}

/// Deletes the highlights file, then its folder and the `.naiad` folder if they are
/// left empty (Q24: with nothing in it, there is no `.naiad` folder). Nothing is
/// removed when the way holds a link (`checked`, `hold`), nor a file Naiad cannot read
/// (`readable`): it is kept, with its folders.
pub fn delete(flowchart: &Path) -> Result<(), String> {
    remove(flowchart, false)
}

/// `delete`; with `refuse`, a file Naiad cannot read is an error (Clear, a blank write)
/// rather than only kept (the last view closing).
fn remove(flowchart: &Path, refuse: bool) -> Result<(), String> {
    let file = checked(flowchart)?;
    let folder = file.parent().ok_or("No folder.")?;
    let naiad = folder.parent().ok_or("No folder.")?;
    let Some(held_naiad) = hold(naiad, false)? else { return Ok(()) };
    if let Some(held_folder) = hold(folder, false)? {
        if no_link(&file)? {
            if !readable(&file)? {
                return if refuse { Err(unreadable(&file)) } else { Ok(()) };
            }
            match fs::remove_file(&file) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        // A held folder cannot be removed, even by Naiad: let it go, look again, remove.
        // Each removal fails, as it should, when the folder still holds something.
        drop(held_folder);
        if no_link(folder)? {
            let _ = fs::remove_dir(folder);
        }
    }
    drop(held_naiad);
    if no_link(naiad)? {
        let _ = fs::remove_dir(naiad);
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
        let left: Vec<_> = fs::read_dir(naiad.join("flow.mmd")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, ["highlights.txt"], "no temporary file left");
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

    /// Bug hunt round 3, F16 and oF4: a file Naiad cannot read (UTF-16, as Windows
    /// PowerShell 5 writes it) may hold an agent's notes. Clear (a blank write), a text
    /// write and the last view closing all leave it as it is.
    #[test]
    fn a_file_naiad_cannot_read_is_never_replaced_or_deleted() {
        let dir = folder("utf16");
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "flowchart TD\n    a --> b\n").unwrap();
        let file = file_of(&flow).unwrap();
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain("a\r\n# a note\r\n".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        fs::write(&file, &utf16).unwrap();
        assert!(read(&flow).is_err());
        assert!(write(&flow, "").unwrap_err().contains("not UTF-8"));
        assert!(write(&flow, "b\n").unwrap_err().contains("not UTF-8"));
        delete(&flow).unwrap();
        assert_eq!(fs::read(&file).unwrap(), utf16);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt S6 (F3): a file named like the old temporary file is the user's.
    #[test]
    fn a_file_named_like_a_temporary_file_is_kept() {
        let dir = folder("tmpname");
        let flow = dir.join("flow.mmd");
        let theirs = dir.join(".naiad").join("flow.mmd").join(".highlights.txt.naiad-tmp");
        fs::create_dir_all(theirs.parent().unwrap()).unwrap();
        fs::write(&theirs, "theirs\n").unwrap();
        write(&flow, "a\n").unwrap();
        assert_eq!(fs::read_to_string(&theirs).unwrap(), "theirs\n");
        assert_eq!(read(&flow).unwrap().as_deref(), Some("a\n"));
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

    /// Makes a junction, a link to a folder that Windows lets anyone make.
    #[cfg(windows)]
    fn junction(link: &Path, to: &Path) {
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(to)
            .output()
            .unwrap();
        assert!(made.status.success(), "mklink /J failed");
    }

    /// Bug hunt S7 (F1, F2): a link in the `.naiad` folder is never followed or removed.
    #[cfg(windows)]
    #[test]
    fn a_link_in_the_naiad_folder_is_never_followed() {
        let dir = folder("link");
        let flow = dir.join("flow.mmd");
        fs::write(&flow, "flowchart TD\n").unwrap();
        let outside = dir.join("outside");
        let theirs = outside.join("flow.mmd").join("highlights.txt");
        fs::create_dir_all(theirs.parent().unwrap()).unwrap();
        fs::write(&theirs, "theirs\n").unwrap();
        let naiad = dir.join(".naiad");

        // `.naiad` itself, then the flowchart's folder in it, is a junction to elsewhere.
        for (link, to) in [(naiad.clone(), outside.clone()), (naiad.join("flow.mmd"), outside.join("flow.mmd"))] {
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            junction(&link, &to);
            assert!(read(&flow).is_err(), "read through {}", link.display());
            assert!(write(&flow, "a\n").is_err(), "write through {}", link.display());
            assert!(write(&flow, " \n").is_err(), "delete through {}", link.display());
            assert!(delete(&flow).is_err());
            show(Some(&flow));
            show(None); // a closing view deletes highlights: not through a link
            assert_eq!(fs::read_to_string(&theirs).unwrap(), "theirs\n", "the file elsewhere is untouched");
            assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "the link is kept");
            fs::remove_dir(&link).unwrap(); // removes the junction only
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt round 3 (F15): while Naiad holds its folders, nobody can delete or rename
    /// them, so a junction cannot take their place between Naiad's look and its write.
    #[cfg(windows)]
    #[test]
    fn a_held_folder_cannot_be_swapped_for_a_link() {
        let dir = folder("held");
        let naiad = dir.join(".naiad");
        let held = hold(&naiad, true).unwrap().expect("made and held");
        assert!(fs::remove_dir(&naiad).is_err(), "removed while held");
        assert!(fs::rename(&naiad, dir.join("moved")).is_err(), "renamed while held");
        // Naiad's own work in it goes on: a folder made and held, a file written by rename.
        let inner = hold(&naiad.join("flow.mmd"), true).unwrap().expect("made and held");
        assert!(fs::rename(&naiad.join("flow.mmd"), naiad.join("moved")).is_err(), "inner renamed while held");
        crate::replace_file(&naiad.join("flow.mmd").join("highlights.txt"), b"a\n").unwrap();
        assert_eq!(fs::read_to_string(naiad.join("flow.mmd").join("highlights.txt")).unwrap(), "a\n");
        drop(inner);
        drop(held);
        fs::rename(&naiad, dir.join("moved")).unwrap();
        // A junction where the folder was is refused, never held.
        junction(&naiad, &dir.join("moved"));
        assert!(hold(&naiad, true).is_err());
        assert!(hold(&naiad, false).is_err());
        // The look through the held folder sees it too, as when the junction is made after the first look.
        assert!(open_held(&naiad).unwrap().metadata().unwrap().file_type().is_symlink());
        fs::remove_dir(&naiad).unwrap(); // the junction only
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt round 4 (E19, F20): while Naiad reads `highlights.txt`, nobody can delete,
    /// rename or replace it, so a link cannot take its place between Naiad's look and
    /// its read; and the look, made through the held name, sees a link there.
    #[cfg(windows)]
    #[test]
    fn the_highlights_file_cannot_be_swapped_for_a_link_while_read() {
        let dir = folder("held-file");
        let flow = dir.join("flow.mmd");
        write(&flow, "a\n").unwrap();
        let file = file_of(&flow).unwrap();
        let other = file.with_file_name("other.txt");
        fs::write(&other, "theirs\n").unwrap();
        let held = open_pinned(&file).unwrap();
        assert!(fs::remove_file(&file).is_err(), "deleted while held");
        assert!(fs::rename(&file, file.with_file_name("moved.txt")).is_err(), "renamed while held");
        assert!(fs::rename(&other, &file).is_err(), "replaced while held");
        assert_eq!(fs::read_to_string(&file).unwrap(), "a\n", "others still read it");
        drop(held);
        assert_eq!(read(&flow).unwrap().as_deref(), Some("a\n"));

        // A junction in its place (Windows lets anyone make one; a symbolic link to a file
        // needs a right most accounts lack): refused, never followed, never removed.
        let outside = dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("theirs.txt"), "theirs\n").unwrap();
        fs::remove_file(&file).unwrap();
        junction(&file, &outside);
        assert!(open_pinned(&file).unwrap().metadata().unwrap().file_type().is_symlink());
        assert!(read_unlinked(&file).unwrap_err().contains("is a link"));
        assert!(read(&flow).is_err());
        assert!(write(&flow, "b\n").is_err());
        assert!(write(&flow, " \n").is_err());
        assert!(delete(&flow).is_err());
        assert!(fs::symlink_metadata(&file).unwrap().file_type().is_symlink(), "the link is kept");
        assert_eq!(fs::read_to_string(outside.join("theirs.txt")).unwrap(), "theirs\n");
        fs::remove_dir(&file).unwrap(); // the junction only
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
