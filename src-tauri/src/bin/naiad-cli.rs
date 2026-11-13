// The `naiad` command: a small terminal program that sits in the `bin` folder of the
// installed app and starts the app itself. The app is built without a console, so a
// terminal neither waits for it nor gets its output; this program does both.
//
//   naiad <file>            opens the file in Naiad and returns at once
//   naiad check <file>...   checks the files; prints the problems; exit code 0, 1 or 2
//   naiad fix <file>...     puts right what is safe to, then checks
//   naiad serve <file>      serves the file to a browser on this computer; prints the address
//   naiad --version
//   naiad --add-to-path, naiad --remove-from-path   run by the installer (see below)

use std::path::PathBuf;
use std::process::{exit, Command, Stdio};

const USAGE: &str = "Naiad, a viewer and editor for Mermaid flowchart files.

  naiad <file>            open a .mmd or .mermaid file in Naiad
  naiad check <file>...   report where the files break the Naiad file format
                          (exit code 0: no problems, 1: problems, 2: not checked)
  naiad fix <file>...     put right what cannot change the flowchart, then check
  naiad serve <file>      show the file in a browser on this computer: prints the
                          address to open; it ends by itself ten minutes after
                          the page is closed
  naiad --version";

/// The app: one folder up when installed (`<install>\\bin\\naiad.exe`), or beside this
/// program in a build folder.
fn app() -> Option<PathBuf> {
    let me = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "naiad.exe" } else { "naiad" };
    let dir = me.parent()?;
    [dir.parent().map(|d| d.join(name)), Some(dir.join(name))]
        .into_iter()
        .flatten()
        .find(|p| p.is_file() && *p != me)
}

/// Stops the app from inheriting this program's input and output. Otherwise an app
/// opened with `naiad <file>` would hold the terminal's output open, and whatever
/// started this command (an agent's tool, a script) would wait until the window closed.
#[cfg(windows)]
fn keep_my_handles() {
    use std::os::windows::io::AsRawHandle;
    extern "system" {
        fn SetHandleInformation(handle: *mut core::ffi::c_void, mask: u32, flags: u32) -> i32;
    }
    const HANDLE_FLAG_INHERIT: u32 = 1;
    let handles = [
        std::io::stdin().as_raw_handle(),
        std::io::stdout().as_raw_handle(),
        std::io::stderr().as_raw_handle(),
    ];
    for handle in handles {
        if !handle.is_null() && handle as isize != -1 {
            unsafe { SetHandleInformation(handle as *mut _, HANDLE_FLAG_INHERIT, 0) };
        }
    }
}
#[cfg(not(windows))]
fn keep_my_handles() {}

/// Starts the app on its own, apart from this terminal (Ctrl+C here does not close it).
fn detached(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command
}

// ---- The user's PATH -------------------------------------------------------------
// The installer runs `naiad --add-to-path` after an install and
// `naiad --remove-from-path` before an uninstall, so that terminals know the `naiad`
// command. The PATH is changed here and not by the installer's own script because
// that script cuts a long text short when it reads one. Here the PATH is read whole
// and without expanding the variables in it, only this program's folder is added or
// taken out, every other character stays as it was, and the kind of the stored value
// is kept.

/// Whether two entries of a PATH name the same folder: spaces and quotes around them,
/// a backslash at the end, and upper or lower case make no difference.
fn same_folder(a: &str, b: &str) -> bool {
    fn bare(s: &str) -> String {
        s.trim().trim_matches('"').trim_end_matches(['\\', '/']).to_lowercase()
    }
    bare(a) == bare(b)
}

/// The PATH with `dir` added at the end, or `None` if it is there already.
fn path_with(old: &str, dir: &str) -> Option<String> {
    if old.split(';').any(|entry| same_folder(entry, dir)) {
        return None;
    }
    Some(if old.is_empty() {
        dir.to_string()
    } else if old.ends_with(';') {
        format!("{old}{dir};")
    } else {
        format!("{old};{dir}")
    })
}

/// The PATH with every entry for `dir` taken out, or `None` if there is none.
/// Undoes `path_with` exactly.
fn path_without(old: &str, dir: &str) -> Option<String> {
    let entries: Vec<&str> = old.split(';').collect();
    let kept: Vec<&str> = entries.iter().copied().filter(|e| !same_folder(e, dir)).collect();
    (kept.len() != entries.len()).then(|| kept.join(";"))
}

#[cfg(windows)]
mod user_path {
    use super::{path_with, path_without};
    use core::ffi::c_void;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            size: *mut u32,
        ) -> i32;
        fn RegSetKeyValueW(
            key: isize,
            subkey: *const u16,
            value: *const u16,
            kind: u32,
            data: *const c_void,
            size: u32,
        ) -> i32;
        fn RegDeleteKeyValueW(key: isize, subkey: *const u16, value: *const u16) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(
            window: isize,
            message: u32,
            wparam: usize,
            lparam: isize,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }

    pub const CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
    const REG_SZ: u32 = 1;
    const REG_EXPAND_SZ: u32 = 2;
    const TEXT_UNEXPANDED: u32 = 0x2 | 0x4 | 0x1000_0000; // RRF_RT_REG_SZ | _EXPAND_SZ | RRF_NOEXPAND
    const NOT_FOUND: i32 = 2;
    const MORE_DATA: i32 = 234;
    /// Windows allows an environment variable 32,767 characters.
    const LONGEST: usize = 32_000;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The stored text and its kind, or `None` if there is no such value.
    pub fn read(subkey: &str, value: &str) -> Result<Option<(String, u32)>, String> {
        let (subkey, value) = (wide(subkey), wide(value));
        loop {
            let (mut kind, mut size) = (0u32, 0u32);
            let code = unsafe {
                RegGetValueW(
                    CURRENT_USER,
                    subkey.as_ptr(),
                    value.as_ptr(),
                    TEXT_UNEXPANDED,
                    &mut kind,
                    std::ptr::null_mut(),
                    &mut size,
                )
            };
            if code == NOT_FOUND {
                return Ok(None);
            }
            if code != 0 {
                return Err(format!("it could not be read (Windows error {code})"));
            }
            let mut text = vec![0u16; size as usize / 2 + 1];
            let mut size = (text.len() * 2) as u32;
            let code = unsafe {
                RegGetValueW(
                    CURRENT_USER,
                    subkey.as_ptr(),
                    value.as_ptr(),
                    TEXT_UNEXPANDED,
                    &mut kind,
                    text.as_mut_ptr() as *mut c_void,
                    &mut size,
                )
            };
            if code == MORE_DATA {
                continue; // it grew between the two calls
            }
            if code != 0 {
                return Err(format!("it could not be read (Windows error {code})"));
            }
            let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
            let text = String::from_utf16(&text[..end])
                .map_err(|_| "it holds text that is not valid Unicode".to_string())?;
            return Ok(Some((text, kind)));
        }
    }

    fn write(subkey: &str, value: &str, text: &str, kind: u32) -> Result<(), String> {
        let data = wide(text);
        let code = unsafe {
            RegSetKeyValueW(
                CURRENT_USER,
                wide(subkey).as_ptr(),
                wide(value).as_ptr(),
                kind,
                data.as_ptr() as *const c_void,
                (data.len() * 2) as u32,
            )
        };
        if code == 0 { Ok(()) } else { Err(format!("it could not be written (Windows error {code})")) }
    }

    fn delete(subkey: &str, value: &str) -> Result<(), String> {
        let code = unsafe { RegDeleteKeyValueW(CURRENT_USER, wide(subkey).as_ptr(), wide(value).as_ptr()) };
        if code == 0 || code == NOT_FOUND {
            Ok(())
        } else {
            Err(format!("it could not be written (Windows error {code})"))
        }
    }

    /// Adds `dir` to the PATH kept in `subkey`\`value`, or takes it out. `Ok(true)` if
    /// the stored text changed, `Ok(false)` if there was nothing to do. On any doubt
    /// it changes nothing and says why.
    pub fn change(subkey: &str, value: &str, dir: &str, add: bool) -> Result<bool, String> {
        if dir.contains(';') || dir.contains('%') || dir.contains('"') {
            return Err(format!("the folder's name ({dir}) holds a character a PATH cannot carry"));
        }
        for _ in 0..3 {
            let before = read(subkey, value)?;
            let (old, kind) = match &before {
                Some((text, kind)) => (text.as_str(), *kind),
                None => ("", REG_EXPAND_SZ),
            };
            if kind != REG_SZ && kind != REG_EXPAND_SZ {
                return Err("it is not stored as text".to_string());
            }
            let Some(new) = (if add { path_with(old, dir) } else { path_without(old, dir) }) else {
                return Ok(false);
            };
            if new.encode_utf16().count() > LONGEST {
                return Err("it would become longer than Windows allows".to_string());
            }
            // Another program may have changed the PATH since it was read: look again.
            if read(subkey, value)? != before {
                continue;
            }
            let expected = if new.is_empty() {
                delete(subkey, value)?;
                None
            } else {
                write(subkey, value, &new, kind)?;
                Some((new, kind))
            };
            if read(subkey, value)? != expected {
                return Err("it does not read back as written".to_string());
            }
            return Ok(true);
        }
        Err("it kept changing while it was being read".to_string())
    }

    /// Tells running programs that the environment changed, so that terminals opened
    /// from now on see the new PATH.
    pub fn announce() {
        let what = wide("Environment");
        let mut result = 0usize;
        // HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG
        unsafe { SendMessageTimeoutW(0xffff, 0x001A, 0, what.as_ptr() as isize, 0x0002, 5000, &mut result) };
    }
}

/// `naiad --add-to-path` and `naiad --remove-from-path`.
fn change_path(add: bool) -> ! {
    #[cfg(windows)]
    {
        let dir = std::env::current_exe()
            .ok()
            .and_then(|me| me.parent().map(|d| d.to_path_buf()))
            .and_then(|d| d.to_str().map(str::to_string));
        let Some(dir) = dir else {
            eprintln!("naiad: your PATH was not changed: this program's folder could not be read.");
            exit(1);
        };
        match user_path::change("Environment", "Path", &dir, add) {
            Ok(true) => {
                user_path::announce();
                if add {
                    println!("naiad: added {dir} to your PATH. Terminals opened from now on know the naiad command.");
                } else {
                    println!("naiad: took {dir} out of your PATH.");
                }
                exit(0);
            }
            Ok(false) => {
                println!("naiad: {dir} is {} your PATH; nothing changed.", if add { "already on" } else { "not on" });
                exit(0);
            }
            Err(why) => {
                eprintln!("naiad: your PATH was not changed: {why}.");
                if add {
                    eprintln!("To use the naiad command, add this folder to your PATH yourself: {dir}");
                }
                exit(1);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = add;
        eprintln!("naiad: this step is for Windows only.");
        exit(2);
    }
}

/// `naiad serve <file>`: starts the app as a server, apart from this terminal, and
/// passes on its first line: the address to open, or why it could not start. The
/// server goes on running after this command has returned.
fn serve(app: &PathBuf, args: &[std::ffi::OsString]) -> ! {
    use std::io::{BufRead, BufReader, Write};
    let mut command = Command::new(app);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = match detached(&mut command).spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("naiad: could not start the app: {e}");
            exit(2);
        }
    };
    let (send, receive) = std::sync::mpsc::channel();
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(out).read_line(&mut line);
            let _ = send.send(line);
        });
    }
    match receive.recv_timeout(std::time::Duration::from_secs(20)) {
        Ok(line) if line.starts_with("http://127.0.0.1:") => {
            println!("{}", line.trim_end());
            let _ = std::io::stdout().flush();
            exit(0);
        }
        Ok(line) => {
            if !line.trim().is_empty() {
                eprintln!("{}", line.trim_end());
            }
            let code = child.wait().ok().and_then(|status| status.code()).unwrap_or(2);
            exit(if code == 0 { 2 } else { code });
        }
        Err(_) => {
            let _ = child.kill();
            eprintln!("naiad: the app did not answer within 20 seconds.");
            exit(2);
        }
    }
}

fn main() {
    keep_my_handles();
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let first = args.first().map(|a| a.to_string_lossy().into_owned()).unwrap_or_default();
    match first.as_str() {
        "" | "-h" | "--help" | "help" => {
            println!("{USAGE}");
            return;
        }
        "-V" | "--version" | "version" => {
            println!("naiad {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        "--add-to-path" => change_path(true),
        "--remove-from-path" => change_path(false),
        _ => {}
    }
    let Some(app) = app() else {
        eprintln!("naiad: the Naiad app was not found next to this command. Install Naiad again.");
        exit(2);
    };
    if first == "serve" {
        serve(&app, &args);
    }
    if first != "check" && first != "fix" {
        // Open the file in the app's window; do not wait for the window to close.
        let mut command = Command::new(&app);
        command.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        match detached(&mut command).spawn() {
            Ok(_) => return,
            Err(e) => {
                eprintln!("naiad: could not start the app: {e}");
                exit(2);
            }
        }
    }
    // The checker: wait for the app, pass on what it printed and its exit code. What
    // the app's browser view writes to the error output is noise and is dropped.
    match Command::new(&app).args(&args).stdin(Stdio::null()).stderr(Stdio::null()).output() {
        Ok(out) => {
            print!("{}", String::from_utf8_lossy(&out.stdout));
            exit(out.status.code().unwrap_or(2));
        }
        Err(e) => {
            eprintln!("naiad: could not start the app: {e}");
            exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = r"D:\Programs\Naiad\bin";

    #[test]
    fn adding_keeps_every_other_character() {
        let cases = [
            ("", DIR.to_string()),
            (r"C:\a;C:\b", format!(r"C:\a;C:\b;{DIR}")),
            (r"C:\a;C:\b;", format!(r"C:\a;C:\b;{DIR};")),
            (r"%USERPROFILE%\bin;;C:\x y\z ;", format!(r"%USERPROFILE%\bin;;C:\x y\z ;{DIR};")),
        ];
        for (old, new) in cases {
            assert_eq!(path_with(old, DIR).as_deref(), Some(new.as_str()), "adding to {old:?}");
            // Taking it out again gives back the PATH as it was, to the character.
            assert_eq!(path_without(&new, DIR).as_deref(), Some(old), "undoing on {old:?}");
        }
    }

    #[test]
    fn adding_twice_changes_nothing() {
        for there in [
            DIR.to_string(),
            format!(r"C:\a;{DIR};C:\b"),
            format!(r"C:\a;{}\;C:\b", DIR.to_uppercase()),
            format!(r#"C:\a; "{DIR}" "#),
        ] {
            assert_eq!(path_with(&there, DIR), None, "{there:?}");
        }
    }

    #[test]
    fn removing_takes_only_its_own_entries() {
        assert_eq!(path_without(r"C:\a;C:\b", DIR), None);
        assert_eq!(path_without(&format!(r"{DIR};C:\a;{DIR}\;C:\b"), DIR).as_deref(), Some(r"C:\a;C:\b"));
        // A folder that only starts the same way is another folder.
        let near = format!(r"{DIR}2;{DIR}\sub");
        assert_eq!(path_without(&near, DIR), None);
        assert_eq!(path_with(&near, DIR), Some(format!("{near};{DIR}")));
    }

    /// The same steps against the registry, on a value of its own that is deleted
    /// again; the real PATH is never touched by a test.
    #[cfg(windows)]
    #[test]
    fn a_stored_path_is_changed_whole_and_undone() {
        extern "system" {
            fn RegDeleteKeyW(key: isize, subkey: *const u16) -> i32;
            fn RegSetKeyValueW(
                key: isize,
                subkey: *const u16,
                value: *const u16,
                kind: u32,
                data: *const core::ffi::c_void,
                size: u32,
            ) -> i32;
        }
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let subkey = format!(r"Software\Naiad path test {}", std::process::id());
        let put = |text: &str, kind: u32| {
            let data = wide(text);
            let code = unsafe {
                RegSetKeyValueW(
                    user_path::CURRENT_USER,
                    wide(&subkey).as_ptr(),
                    wide("Path").as_ptr(),
                    kind,
                    data.as_ptr() as *const _,
                    (data.len() * 2) as u32,
                )
            };
            assert_eq!(code, 0);
        };
        let get = || user_path::read(&subkey, "Path").unwrap();

        // A long PATH (far past the 1,024 characters an installer script can hold),
        // with a variable in it, stored as text that Windows expands.
        let long: String = (0..400).map(|i| format!(r"%USERPROFILE%\tools\folder {i};")).collect();
        assert!(long.len() > 10_000);
        put(&long, 2);
        assert_eq!(user_path::change(&subkey, "Path", DIR, true), Ok(true));
        assert_eq!(get(), Some((format!("{long}{DIR};"), 2)));
        assert_eq!(user_path::change(&subkey, "Path", DIR, true), Ok(false));
        assert_eq!(user_path::change(&subkey, "Path", DIR, false), Ok(true));
        assert_eq!(get(), Some((long.clone(), 2)));
        assert_eq!(user_path::change(&subkey, "Path", DIR, false), Ok(false));

        // Plain text stays plain text.
        put(r"C:\a", 1);
        assert_eq!(user_path::change(&subkey, "Path", DIR, true), Ok(true));
        assert_eq!(get(), Some((format!(r"C:\a;{DIR}"), 1)));

        // No PATH at all: one is made, and taken away again.
        put(DIR, 2);
        assert_eq!(user_path::change(&subkey, "Path", DIR, false), Ok(true));
        assert_eq!(get(), None);
        assert_eq!(user_path::change(&subkey, "Path", DIR, true), Ok(true));
        assert_eq!(get(), Some((DIR.to_string(), 2)));

        // Anything that is not text is left alone.
        put("x", 4);
        assert!(user_path::change(&subkey, "Path", DIR, true).is_err());
        // A folder name a PATH cannot carry is refused.
        assert!(user_path::change(&subkey, "Path", r"C:\a;b", true).is_err());

        assert_eq!(unsafe { RegDeleteKeyW(user_path::CURRENT_USER, wide(&subkey).as_ptr()) }, 0);
    }
}
