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
    // While another program changes the file, Windows refuses this hold: wait for it.
    let held = match waiting(|| open_pinned(file)) {
        Ok(held) => held,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    a_file(file, &held)?;
    // Read by its name, as any program reads it, while the held name stays on the file
    // just looked at.
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    drop(held);
    Ok(Some(bytes))
}

/// The held name's metadata, once it is clear that it is a file and not a link.
fn a_file(file: &Path, held: &fs::File) -> Result<fs::Metadata, String> {
    let what = held.metadata().map_err(|e| e.to_string())?;
    if what.file_type().is_symlink() {
        return Err(link_error(file));
    }
    if !what.is_file() {
        return Err(format!("{} is not a file.", file.display()));
    }
    Ok(what)
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

/// One change to a highlights file at a time in this program, so that the look at what
/// a file holds and the change made from it are one step for every view it serves.
static CHANGING: Mutex<()> = Mutex::new(());

/// Writes the highlights file whole, through a temporary file and a rename
/// (`change_file`), with `.naiad` and its folder held (`hold`). A text with
/// nothing but blank lines deletes it instead. A file Naiad cannot read is an error,
/// left as it is: it may hold an agent's notes that Naiad never showed (UTF-16, as
/// Windows PowerShell 5 writes it; bug hunt round 3, F16). With `same`, it writes only
/// if `same` says yes to the file's bytes (no file: none), and otherwise writes nothing
/// and answers false: another view or an agent changed it since it was read (bug hunt
/// round 4, E16). A missing file has nothing to lose, so a delete then goes ahead. The
/// look and the change are one step for other programs too (`change_file`).
pub fn write(flowchart: &Path, text: &str, same: Same) -> Result<bool, String> {
    let _one = CHANGING.lock().unwrap_or_else(|e| e.into_inner());
    if text.trim().is_empty() {
        return remove(flowchart, true, same);
    }
    let file = checked(flowchart)?;
    let folder = file.parent().ok_or("No folder.")?;
    let naiad = folder.parent().ok_or("No folder.")?;
    let _naiad = hold(naiad, true)?.ok_or("No .naiad folder.")?;
    let _folder = hold(folder, true)?.ok_or("No folder in .naiad.")?;
    hide(naiad);
    match change_file(&file, Some(text.as_bytes()), same)? {
        Looked::Done => Ok(true),
        Looked::Changed => Ok(false),
        Looked::Unreadable => Err(unreadable(&file)),
    }
}

/// A test of the highlights file's bytes before a change (`write`): no means it changed
/// since it was read.
pub type Same<'a> = Option<&'a dyn Fn(&[u8]) -> bool>;

/// What `change_file` found, and so did.
enum Looked {
    /// The change is made (for a delete, there may have been nothing there).
    Done,
    /// The file is not UTF-8: left as it is.
    Unreadable,
    /// `same` said no: left as it is.
    Changed,
}

/// Replaces the highlights file with `new`, through a temporary file and a rename, or
/// deletes it (None), once it is clear that it is UTF-8 and `same` says yes to its
/// bytes (no file: a delete has nothing to do; a write asks `same` about no bytes).
///
/// On Windows the file is held from the look to the change, so that no other program
/// can write, rename or delete it in between (bug hunt round 4, E18: an agent's UTF-16
/// notes written after the look were replaced or deleted; and E16 between programs).
/// Windows refuses other programs' writes for that moment (a few milliseconds), and
/// most programs' reads too: they can try again, and Naiad's own reads wait
/// (`waiting`).
#[cfg(windows)]
fn change_file(file: &Path, new: Option<&[u8]>, same: Same) -> Result<Looked, String> {
    // Made before the file is held, so that it is held for as short a time as can be.
    let tmp = new.map(|bytes| super::temp_beside(file, bytes)).transpose()?;
    let aside = match new {
        Some(_) => match super::temp_beside(file, b"") {
            Ok(path) => Some(Aside { path, keep: std::cell::Cell::new(false) }),
            Err(e) => {
                let _ = tmp.as_deref().map(fs::remove_file);
                return Err(e);
            }
        },
        None => None,
    };
    let mut looked = None;
    for _ in 0..TRIES {
        looked = change_once(file, tmp.as_deref(), aside.as_ref(), same).transpose();
        if looked.is_some() {
            break;
        }
    }
    let looked = looked.unwrap_or_else(|| Err(kept_changing(file)));
    if let Some(tmp) = &tmp {
        if !matches!(looked, Ok(Looked::Done)) {
            let _ = fs::remove_file(tmp);
        }
    }
    looked
}

/// How many times a change looks again at a file another program keeps making anew.
#[cfg(windows)]
const TRIES: usize = 5;

#[cfg(windows)]
fn kept_changing(file: &Path) -> String {
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{name} kept changing while Naiad changed it, so Naiad changed nothing. Try again.")
}

/// A free name next to the highlights file, where its old text goes while the new one
/// is moved in (`change_once`); removed at the end unless the old text is left there.
#[cfg(windows)]
struct Aside {
    path: PathBuf,
    keep: std::cell::Cell<bool>,
}

#[cfg(windows)]
impl Drop for Aside {
    fn drop(&mut self) {
        if !self.keep.get() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// One look and change, with the file held from the look to the change. None: there was
/// no file at the look, and another program made one before Naiad's could be moved in;
/// look again.
#[cfg(windows)]
fn change_once(file: &Path, tmp: Option<&Path>, aside: Option<&Aside>, same: Same) -> Result<Option<Looked>, String> {
    let held = match waiting(|| open_locked(file)) {
        Ok(held) => held,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            // Nothing there: nothing to delete, and a write makes the file, unless
            // `same` looked for one. Moved in only where no file is: one made meanwhile
            // is looked at again.
            let Some(tmp) = tmp else { return Ok(Some(Looked::Done)) };
            if same.is_some_and(|same| !same(b"")) {
                return Ok(Some(Looked::Changed));
            }
            stage("checked");
            return match move_in(tmp, file) {
                Ok(()) => Ok(Some(Looked::Done)),
                Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(None),
                Err(e) => Err(e.to_string()),
            };
        }
        Err(e) => return Err(e.to_string()),
    };
    let what = a_file(file, &held)?;
    let mut now = Vec::new();
    std::io::Read::read_to_end(&mut &held, &mut now).map_err(|e| e.to_string())?;
    if std::str::from_utf8(&now).is_err() {
        return Ok(Some(Looked::Unreadable));
    }
    if same.is_some_and(|same| !same(&now)) {
        return Ok(Some(Looked::Changed));
    }
    stage("checked");
    let (Some(tmp), Some(aside)) = (tmp, aside) else {
        delete_held(&held).map_err(|e| e.to_string())?;
        return Ok(Some(Looked::Done));
    };
    // Windows lets nobody replace a file held this way, Naiad included: the old file is
    // moved aside through the hold (still held), the new one moved in where no file is,
    // and the old one deleted. A read-only file is not replaced, as Windows refuses it.
    if what.permissions().readonly() {
        return Err(std::io::Error::from_raw_os_error(5).to_string());
    }
    rename_held(&held, &aside.path, true).map_err(|e| e.to_string())?;
    stage("moved away");
    match move_in(tmp, file) {
        Ok(()) => {
            let _ = delete_held(&held); // if it stays, `Aside` removes it once let go
            Ok(Some(Looked::Done))
        }
        // Another program made the file while its name was free. A program appending to
        // it then makes a file holding only what it appended, which Naiad cannot tell
        // from a whole new file; so both are kept, the old text beside the file, and
        // nothing is changed (bug hunt round 5, F23: the old highlights were deleted).
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            aside.keep.set(true);
            let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            Err(format!(
                "{name} was made anew while Naiad changed it, so Naiad changed nothing. What it held before is kept beside it, in {}.",
                aside.path.display()
            ))
        }
        Err(e) => match rename_held(&held, file, false) {
            Ok(()) => Err(e.to_string()),
            Err(_) => {
                aside.keep.set(true);
                Err(format!("{e}; Naiad could not put the highlights file back: its text is in {}.", aside.path.display()))
            }
        },
    }
}

/// The file itself, never where a link there leads, held so that other programs can
/// neither write, rename nor delete it (nor read it, unless they let it be deleted
/// meanwhile), while Naiad reads it, renames it and deletes it through this hold.
#[cfg(windows)]
fn open_locked(file: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    const GENERIC_READ: u32 = 0x8000_0000;
    const DELETE: u32 = 0x0001_0000;
    const SHARE_READ: u32 = 0x1;
    const BACKUP_SEMANTICS: u32 = 0x0200_0000; // a folder or a junction opens too, to be refused
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000; // the link itself, if it is one
    fs::OpenOptions::new()
        .access_mode(GENERIC_READ | DELETE)
        .share_mode(SHARE_READ)
        .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
        .open(file)
}

#[cfg(windows)]
extern "system" {
    fn SetFileInformationByHandle(file: *mut std::ffi::c_void, class: i32, info: *const std::ffi::c_void, size: u32) -> i32;
}

/// Renames the held file to `to`; an error if a file is there, unless `replace`.
#[cfg(windows)]
fn rename_held(held: &fs::File, to: &Path, replace: bool) -> std::io::Result<()> {
    use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};
    /// FILE_RENAME_INFO; the name runs on past the end.
    #[repr(C)]
    struct RenameInfo {
        replace: u32,
        root: *mut std::ffi::c_void,
        length: u32,
        name: [u16; 1],
    }
    const FILE_RENAME_INFO: i32 = 3;
    let to: Vec<u16> = std::path::absolute(to)?.as_os_str().encode_wide().collect();
    let start = std::mem::offset_of!(RenameInfo, name);
    let size = (start + 2 * (to.len() + 1)).max(std::mem::size_of::<RenameInfo>());
    // Zeroed, so no root folder, and the name ends in a nul.
    let mut buffer = vec![0u64; size.div_ceil(8)];
    let info = buffer.as_mut_ptr().cast::<RenameInfo>();
    // SAFETY: the buffer is aligned for RenameInfo and holds `size` bytes: the struct,
    // then the name from `start`.
    let done = unsafe {
        (*info).replace = u32::from(replace);
        (*info).length = (2 * to.len()) as u32;
        std::ptr::copy_nonoverlapping(to.as_ptr(), info.cast::<u8>().add(start).cast::<u16>(), to.len());
        SetFileInformationByHandle(held.as_raw_handle(), FILE_RENAME_INFO, info.cast(), size as u32)
    };
    if done == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Deletes the held file: at once where Windows can (from Windows 10 1809, on NTFS),
/// otherwise when the hold is let go. A read-only file is deleted too, as
/// `fs::remove_file` deletes it.
#[cfg(windows)]
fn delete_held(held: &fs::File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    const FILE_DISPOSITION_INFO: i32 = 4;
    const FILE_DISPOSITION_INFO_EX: i32 = 21;
    const DELETE: u32 = 0x1;
    const POSIX_SEMANTICS: u32 = 0x2;
    const IGNORE_READONLY: u32 = 0x10;
    let flags = DELETE | POSIX_SEMANTICS | IGNORE_READONLY;
    let yes: u8 = 1;
    // SAFETY: each buffer is the size given, and lives through the call.
    let done = unsafe {
        SetFileInformationByHandle(held.as_raw_handle(), FILE_DISPOSITION_INFO_EX, (&flags as *const u32).cast(), 4) != 0
            || SetFileInformationByHandle(held.as_raw_handle(), FILE_DISPOSITION_INFO, (&yes as *const u8).cast(), 1) != 0
    };
    if !done {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Moves `tmp` to `file`, only where no file is (an error of kind AlreadyExists if one is).
#[cfg(windows)]
fn move_in(tmp: &Path, file: &Path) -> std::io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    const DELETE: u32 = 0x0001_0000;
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let held = fs::OpenOptions::new().access_mode(DELETE).custom_flags(OPEN_REPARSE_POINT).open(tmp)?;
    rename_held(&held, file, false)
}

/// `change_file` where nothing holds a file against other programs: the look, then the
/// change.
#[cfg(not(windows))]
fn change_file(file: &Path, new: Option<&[u8]>, same: Same) -> Result<Looked, String> {
    let Some(now) = read_unlinked(file)? else {
        let Some(new) = new else { return Ok(Looked::Done) };
        if same.is_some_and(|same| !same(b"")) {
            return Ok(Looked::Changed);
        }
        return super::replace_file(file, new).map(|()| Looked::Done);
    };
    if std::str::from_utf8(&now).is_err() {
        return Ok(Looked::Unreadable);
    }
    if same.is_some_and(|same| !same(&now)) {
        return Ok(Looked::Changed);
    }
    stage("checked");
    match new {
        Some(new) => super::replace_file(file, new)?,
        None => match fs::remove_file(file) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        },
    }
    Ok(Looked::Done)
}

/// Opens with `open`, trying again for up to half a second while another program holds
/// the file (Windows' sharing violation), and, after that, while its name is free for
/// the moment another program's change takes (`change_once` moves the old file aside,
/// then the new one in).
fn waiting(open: impl Fn() -> std::io::Result<fs::File>) -> std::io::Result<fs::File> {
    const IN_USE: i32 = 32; // ERROR_SHARING_VIOLATION
    let mut held_elsewhere = false;
    let mut free = 0;
    for _ in 0..50 {
        match open() {
            Err(e) if cfg!(windows) && e.raw_os_error() == Some(IN_USE) => held_elsewhere = true,
            Err(e) if e.kind() == ErrorKind::NotFound && held_elsewhere && free < 3 => free += 1,
            done => return done,
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    open()
}

#[cfg(test)]
thread_local! {
    /// Run at each named stage of a change to the highlights file (tests only): another
    /// program acting there.
    pub(crate) static STAGE: std::cell::RefCell<Option<Box<dyn Fn(&str)>>> = const { std::cell::RefCell::new(None) };
}

fn stage(_name: &str) {
    #[cfg(test)]
    STAGE.with(|run| {
        if let Some(run) = &*run.borrow() {
            run(_name);
        }
    });
}

fn unreadable(file: &Path) -> String {
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{name} is not UTF-8 text, so Naiad leaves it alone.")
}

/// Deletes the highlights file, then its folder and the `.naiad` folder if they are
/// left empty (Q24: with nothing in it, there is no `.naiad` folder). Nothing is
/// removed when the way holds a link (`checked`, `hold`), nor a file Naiad cannot read
/// (`write`): it is kept, with its folders. With `same`, the file is deleted only if
/// `same` says yes to its bytes, and otherwise kept, with its folders.
pub fn delete(flowchart: &Path, same: Same) -> Result<(), String> {
    let _one = CHANGING.lock().unwrap_or_else(|e| e.into_inner());
    remove(flowchart, false, same).map(|_| ())
}

/// `delete`; with `refuse`, a file Naiad cannot read is an error (Clear, a blank write)
/// rather than only kept (the last view closing). False: `same` said no.
fn remove(flowchart: &Path, refuse: bool, same: Same) -> Result<bool, String> {
    let file = checked(flowchart)?;
    let folder = file.parent().ok_or("No folder.")?;
    let naiad = folder.parent().ok_or("No folder.")?;
    let Some(held_naiad) = hold(naiad, false)? else { return Ok(true) };
    if let Some(held_folder) = hold(folder, false)? {
        match change_file(&file, None, same)? {
            Looked::Done => {}
            Looked::Changed => return Ok(false),
            Looked::Unreadable => return if refuse { Err(unreadable(&file)) } else { Ok(true) },
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
    Ok(true)
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
    change(flowchart, None);
}

/// As `show(None)`, once the last page of `naiad serve` has said it closes and gone: its
/// highlights are deleted only if they still hold `left`, what they held when it said so
/// (None: not known), so that highlights an agent wrote after it went are kept, to show
/// at the next opening (bug hunt round 4, F21).
pub fn stop_showing(left: Option<&[u8]>) {
    match left {
        Some(left) => change(None, Some(&|now: &[u8]| now == left)),
        None => change(None, Some(&|_: &[u8]| false)),
    }
}

/// `show`, the highlights of a flowchart no longer shown deleted only if `delete_if` says
/// yes to them (`delete`).
fn change(flowchart: Option<&Path>, delete_if: Option<&dyn Fn(&[u8]) -> bool>) {
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
            let _ = delete(Path::new(&old), delete_if);
        }
    }
}

/// The flowchart this program shows, for a test.
#[cfg(test)]
pub(crate) fn shown() -> Option<String> {
    SHOWN.lock().unwrap().clone()
}

/// Taken by every test that changes what this program shows (`SHOWN` is one for all).
#[cfg(test)]
pub(crate) static SHOWING: Mutex<()> = Mutex::new(());

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
        write(&flow, "a\na --> b\n", None).unwrap();
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
        write(&flow, "\n  \n", None).unwrap();
        assert_eq!(read(&flow).unwrap(), None);
        assert!(!naiad.exists());
        // The flowchart's own file is untouched.
        assert_eq!(fs::read_to_string(&flow).unwrap(), "flowchart TD\n    a --> b\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Bug hunt round 4, E16: two views switch an item each from the same read. The
    /// second write, made from what the file no longer holds, is refused and changes
    /// nothing; so is taking the last item off. A file gone has nothing to lose.
    #[test]
    fn a_write_from_what_the_file_no_longer_holds_is_refused() {
        let dir = folder("stale");
        let flow = dir.join("flow.mmd");
        let file = file_of(&flow).unwrap();
        let read = |text: &'static str| move |now: &[u8]| now == text.as_bytes();
        assert_eq!(write(&flow, "a\n", Some(&read(""))), Ok(true), "no file reads as none");
        assert_eq!(write(&flow, "b\n", Some(&read(""))), Ok(false));
        assert_eq!(fs::read_to_string(&file).unwrap(), "a\n");
        assert_eq!(write(&flow, "", Some(&read(""))), Ok(false));
        assert_eq!(fs::read_to_string(&file).unwrap(), "a\n");
        assert_eq!(write(&flow, "a\nb\n", Some(&read("a\n"))), Ok(true));
        assert_eq!(write(&flow, " \n", Some(&read("a\nb\n"))), Ok(true));
        assert!(!dir.join(".naiad").exists());
        assert_eq!(write(&flow, "", Some(&read("a\n"))), Ok(true), "nothing there to lose");
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
        assert!(write(&flow, "", None).unwrap_err().contains("not UTF-8"));
        assert!(write(&flow, "b\n", None).unwrap_err().contains("not UTF-8"));
        delete(&flow, None).unwrap();
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
        write(&flow, "a\n", None).unwrap();
        assert_eq!(fs::read_to_string(&theirs).unwrap(), "theirs\n");
        assert_eq!(read(&flow).unwrap().as_deref(), Some("a\n"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_holding_something_else_is_kept() {
        let dir = folder("keep");
        let flow = dir.join("flow.mmd");
        write(&flow, "a\n", None).unwrap();
        let proposal = dir.join(".naiad").join("flow.mmd").join("a-proposal.mmd");
        fs::write(&proposal, "flowchart TD\n").unwrap();
        delete(&flow, None).unwrap();
        assert!(proposal.exists());
        assert!(!dir.join(".naiad").join("flow.mmd").join("highlights.txt").exists());
        delete(&flow, None).unwrap(); // deleting what is not there is no error
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
        let _showing = SHOWING.lock().unwrap_or_else(|e| e.into_inner());
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
            assert!(write(&flow, "a\n", None).is_err(), "write through {}", link.display());
            assert!(write(&flow, " \n", None).is_err(), "delete through {}", link.display());
            assert!(delete(&flow, None).is_err());
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
        write(&flow, "a\n", None).unwrap();
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
        assert!(write(&flow, "b\n", None).is_err());
        assert!(write(&flow, " \n", None).is_err());
        assert!(delete(&flow, None).is_err());
        assert!(fs::symlink_metadata(&file).unwrap().file_type().is_symlink(), "the link is kept");
        assert_eq!(fs::read_to_string(outside.join("theirs.txt")).unwrap(), "theirs\n");
        fs::remove_dir(&file).unwrap(); // the junction only
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The bytes Windows PowerShell 5 writes: UTF-16, with its mark.
    #[cfg(windows)]
    fn utf16(text: &str) -> Vec<u8> {
        [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(|u| u.to_le_bytes())).collect()
    }

    /// Runs `agent` once, at the next `stage` named `at` on this thread.
    #[cfg(windows)]
    fn at_stage(at: &'static str, agent: impl FnOnce() + 'static) {
        let agent = std::cell::RefCell::new(Some(agent));
        STAGE.with(|run| {
            *run.borrow_mut() = Some(Box::new(move |stage: &str| {
                if stage == at {
                    let once = agent.borrow_mut().take();
                    if let Some(agent) = once {
                        agent();
                    }
                }
            }))
        });
    }

    #[cfg(windows)]
    fn no_stage() {
        STAGE.with(|run| *run.borrow_mut() = None);
    }

    /// What the folder of `file` holds beside it (nothing, if there is no folder).
    #[cfg(windows)]
    fn beside(file: &Path) -> Vec<String> {
        let Ok(names) = fs::read_dir(file.parent().unwrap()) else { return Vec::new() };
        let name = file.file_name().unwrap();
        names.map(|e| e.unwrap().file_name()).filter(|n| n != name).map(|n| n.to_string_lossy().into_owned()).collect()
    }

    /// Bug hunt round 4, E18: another program writes the highlights file between Naiad's
    /// look at it and its change (an agent's notes in UTF-16, which Naiad must never
    /// replace or delete). A write that went through is never lost: on Windows the file
    /// is held from the look to the change, so the agent's write fails (and it can try
    /// again), and Naiad's change goes on.
    #[cfg(windows)]
    #[test]
    fn a_file_written_while_naiad_changes_it_is_never_lost() {
        use std::{cell::RefCell, rc::Rc};
        let dir = folder("e18");
        let flow = dir.join("flow.mmd");
        let file = file_of(&flow).unwrap();
        let theirs = utf16("a\r\n# the agent's note\r\n");
        let from_a = |now: &[u8]| now == b"a\n";
        let changes: [(&str, &dyn Fn() -> Result<bool, String>); 4] = [
            ("a write", &|| write(&flow, "b\n", None)),
            ("a write from what was read", &|| write(&flow, "b\n", Some(&from_a))),
            ("Clear", &|| write(&flow, " \n", None)),
            ("the last view closing", &|| delete(&flow, None).map(|()| true)),
        ];
        let mut lost = Vec::new();
        for (change, run) in changes {
            write(&flow, "a\n", None).unwrap();
            let agent = Rc::new(RefCell::new(None));
            let (into, path, bytes) = (agent.clone(), file.clone(), theirs.clone());
            at_stage("checked", move || *into.borrow_mut() = Some(fs::write(&path, &bytes)));
            let naiad = run();
            no_stage();
            let agent = agent.take().unwrap_or_else(|| panic!("{change}: the agent did not write"));
            if agent.is_ok() && fs::read(&file).ok() != Some(theirs.clone()) {
                lost.push(change);
            } else if agent.is_err() {
                assert_eq!(naiad, Ok(true), "{change}: Naiad's change goes on");
            }
            assert_eq!(beside(&file), Vec::<String>::new(), "{change}: left beside the file");
            let _ = fs::remove_file(&file);
        }
        assert_eq!(lost, Vec::<&str>::new(), "the agent's write went through, then was lost");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// While Naiad moves its text in (the old text moved aside), the name is free for a
    /// moment. A file another program makes there then is kept, and so is the old text:
    /// a program appending to the file makes a new one holding only what it appended
    /// (bug hunt round 5, F23), and Naiad cannot tell that from a whole new file. So the
    /// old text stays beside the file, Naiad changes nothing, and its error names where
    /// the old text is; with a precondition or without one.
    #[cfg(windows)]
    #[test]
    fn a_file_made_while_naiad_moves_its_text_in_is_kept_and_so_is_the_old_text() {
        use std::io::Write;
        let dir = folder("moved-in");
        let flow = dir.join("flow.mmd");
        let file = file_of(&flow).unwrap();
        let from_old = |now: &[u8]| now == b"a\n# a note\n";
        let preconditions: [(&str, Same); 2] = [("from what was read", Some(&from_old)), ("with no precondition", None)];
        for append in [true, false] {
            for (precondition, same) in preconditions {
                let case = format!("{} {precondition}", if append { "an append" } else { "a whole file" });
                write(&flow, "a\n# a note\n", None).unwrap();
                let path = file.clone();
                at_stage("moved away", move || {
                    let mut theirs = fs::OpenOptions::new().append(append).write(!append).create(true).open(&path).unwrap();
                    theirs.write_all(b"b\n").unwrap();
                });
                let wrote = write(&flow, "a\nc\n# a note\n", same);
                no_stage();
                assert_eq!(fs::read_to_string(&file).unwrap(), "b\n", "{case}: the file made meanwhile is kept");
                let kept = beside(&file);
                assert_eq!(kept.len(), 1, "{case}: {kept:?}");
                let old = file.with_file_name(&kept[0]);
                assert_eq!(fs::read_to_string(&old).unwrap(), "a\n# a note\n", "{case}: the old text is kept");
                let why = wrote.expect_err(&case);
                assert!(why.contains(&kept[0]), "{case}: {why}");
                fs::remove_file(&old).unwrap();
            }
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    /// While one program changes the file, another's read waits for the change, rather
    /// than failing (Windows refuses it the file for that moment), and reads the new text.
    #[cfg(windows)]
    #[test]
    fn a_read_while_another_program_changes_the_file_waits_for_it() {
        use std::{cell::RefCell, rc::Rc};
        let dir = folder("wait");
        let flow = dir.join("flow.mmd");
        write(&flow, "a\n", None).unwrap();
        let reader = Rc::new(RefCell::new(None));
        let (into, from) = (reader.clone(), flow.clone());
        at_stage("checked", move || {
            *into.borrow_mut() = Some(std::thread::spawn(move || read(&from)));
            std::thread::sleep(std::time::Duration::from_millis(100));
        });
        write(&flow, "b\n", None).unwrap();
        no_stage();
        let read = reader.take().unwrap().join().unwrap();
        assert_eq!(read, Ok(Some("b\n".to_string())));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// A read-only highlights file is never replaced (Windows refuses it, as it did before
    /// E18's fix), and is deleted as any other when the last view closes or on Clear.
    #[cfg(windows)]
    #[test]
    fn a_read_only_file_is_not_replaced_but_is_deleted() {
        let dir = folder("read-only");
        let flow = dir.join("flow.mmd");
        let file = file_of(&flow).unwrap();
        let changes: [(&str, &dyn Fn() -> Result<bool, String>); 2] =
            [("delete", &|| delete(&flow, None).map(|()| true)), ("Clear", &|| write(&flow, " \n", None))];
        for (change, run) in changes {
            write(&flow, "a\n", None).unwrap();
            let mut read_only = fs::metadata(&file).unwrap().permissions();
            read_only.set_readonly(true);
            fs::set_permissions(&file, read_only).unwrap();
            assert_eq!(write(&flow, "b\n", None), Err("Access is denied. (os error 5)".into()));
            assert_eq!(fs::read_to_string(&file).unwrap(), "a\n");
            assert_eq!(beside(&file), Vec::<String>::new());
            assert_eq!(run(), Ok(true), "{change}");
            assert!(!file.exists(), "{change}");
        }
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
