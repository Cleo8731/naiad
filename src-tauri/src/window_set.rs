// Several windows in one program (T6.2, docs/windows.md). The program's first window is
// "main"; each window made later, for a tab dragged out of a window or one brought back
// by Remember opened files, is "w1", "w2"... Kept here, for every window by its label:
// - what arrives for its page (a file handed over, a tab moved in, kept tabs to open
//   again), as JSON texts, until the page takes them (`arrivals`);
// - the flowcharts it shows, from its page (`view_files`). The view record
//   (highlights.rs) names all of them together, so a file's highlights are deleted only
//   when no window shows it;
// - flowcharts on their way into it: a moved tab's file counts as shown from the moment
//   it leaves one window until the other window's page lists it (or 30 seconds pass),
//   so its highlights are never deleted in between;
// - which window was used last (Q213), and which one a dragged tab is over.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long a moved tab's file counts as shown while the window it went to has not
/// listed it (a page that never loads, a file that cannot be read).
pub const COMING_FOR: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct WindowSet {
    arrivals: HashMap<String, Vec<String>>,
    views: HashMap<String, Vec<String>>,
    coming: HashMap<String, Vec<(String, Instant)>>,
    /// The window used last, by label: a file handed over goes there (Q213).
    pub last: String,
    /// The window a dragged tab is over, told so with "tab-drag-at".
    pub hovered: Option<String>,
    made: u32,
}

/// Two paths name one file on Windows when they differ only in letter case or in the
/// slash between folders.
fn same(a: &str, b: &str) -> bool {
    let plain = |p: &str| p.to_lowercase().replace('/', "\\");
    plain(a) == plain(b)
}

impl WindowSet {
    /// A label for a new window, never used before in this run.
    pub fn new_label(&mut self) -> String {
        self.made += 1;
        format!("w{}", self.made)
    }

    /// Something for `label`'s page to take: a JSON text.
    pub fn arrive(&mut self, label: &str, item: String) {
        self.arrivals.entry(label.to_string()).or_default().push(item);
    }

    /// What waits for `label`'s page, in the order it came; taken.
    pub fn take(&mut self, label: &str) -> Vec<String> {
        self.arrivals.remove(label).unwrap_or_default()
    }

    /// `label`'s page now shows these flowcharts. One on its way in that it lists is no
    /// longer counted as coming.
    pub fn set_views(&mut self, label: &str, paths: Vec<String>) {
        if let Some(coming) = self.coming.get_mut(label) {
            coming.retain(|(c, _)| !paths.iter().any(|p| same(p, c)));
        }
        self.views.insert(label.to_string(), paths);
    }

    /// A tab's file leaves `from` for `to`, in one step: shown by neither page, it counts
    /// as coming into `to` until `to`'s page lists it.
    pub fn move_view(&mut self, path: &str, from: &str, to: &str, now: Instant) {
        if let Some(list) = self.views.get_mut(from) {
            list.retain(|p| !same(p, path));
        }
        self.coming.entry(to.to_string()).or_default().push((path.to_string(), now));
    }

    /// The window that shows `path`, if one does.
    pub fn showing(&self, path: &str) -> Option<String> {
        self.views
            .iter()
            .find(|(_, list)| list.iter().any(|p| same(p, path)))
            .map(|(label, _)| label.clone())
    }

    /// A window closed: it shows nothing, waits for nothing, and is not the one used
    /// last (`others`: the windows still open).
    pub fn forget(&mut self, label: &str, others: &[String]) {
        self.views.remove(label);
        self.coming.remove(label);
        self.arrivals.remove(label);
        if self.hovered.as_deref() == Some(label) {
            self.hovered = None;
        }
        if self.last == label {
            self.last = others.first().cloned().unwrap_or_default();
        }
    }

    /// Every flowchart shown by a window or on its way into one, each once. Files on
    /// their way for longer than `COMING_FOR` are dropped first.
    pub fn shown(&mut self, now: Instant) -> Vec<String> {
        for list in self.coming.values_mut() {
            list.retain(|(_, since)| now.duration_since(*since) < COMING_FOR);
        }
        let mut all: Vec<String> = Vec::new();
        let coming = self.coming.values().flatten().map(|(p, _)| p);
        for p in self.views.values().flatten().chain(coming) {
            if !all.iter().any(|a| same(a, p)) {
                all.push(p.clone());
            }
        }
        all
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    #[test]
    fn every_window_s_files_count_as_shown_each_once() {
        let mut w = WindowSet::default();
        let now = Instant::now();
        w.set_views("main", vec!["C:\\a.mmd".into(), "C:\\b.mmd".into()]);
        w.set_views("w1", vec!["c:\\A.MMD".into(), "C:\\c.mmd".into()]);
        assert_eq!(sorted(w.shown(now)), ["C:\\a.mmd", "C:\\b.mmd", "C:\\c.mmd"]);
        // A window's new list replaces its old one.
        w.set_views("main", vec![]);
        assert_eq!(sorted(w.shown(now)), ["C:\\c.mmd", "c:\\A.MMD"]);
    }

    /// The case T6.2 guards against: a tab moving between windows never leaves its file
    /// unshown, whatever order the two pages report in.
    #[test]
    fn a_moved_tab_s_file_stays_shown_until_the_new_window_lists_it() {
        let mut w = WindowSet::default();
        let t0 = Instant::now();
        w.set_views("main", vec!["C:\\a.mmd".into(), "C:\\b.mmd".into()]);
        w.move_view("C:\\b.mmd", "main", "w1", t0);
        assert!(w.shown(t0).contains(&"C:\\b.mmd".to_string()));
        // The old window reports first, without it; the new one has listed nothing yet.
        w.set_views("main", vec!["C:\\a.mmd".into()]);
        w.set_views("w1", vec![]);
        assert!(w.shown(t0).contains(&"C:\\b.mmd".to_string()));
        assert_eq!(w.showing("C:\\b.mmd"), None);
        // Listed by the new window: shown by it, no longer coming.
        w.set_views("w1", vec!["C:\\b.mmd".into()]);
        assert_eq!(w.showing("c:\\B.mmd").as_deref(), Some("w1"));
        w.set_views("w1", vec![]);
        assert!(!w.shown(t0).contains(&"C:\\b.mmd".to_string()));
    }

    #[test]
    fn a_file_that_never_arrives_stops_counting_after_30_seconds() {
        let mut w = WindowSet::default();
        let t0 = Instant::now();
        w.set_views("main", vec!["C:\\a.mmd".into()]);
        w.move_view("C:\\a.mmd", "main", "w1", t0);
        assert_eq!(w.shown(t0 + COMING_FOR - Duration::from_millis(1)), ["C:\\a.mmd"]);
        assert!(w.shown(t0 + COMING_FOR).is_empty());
    }

    #[test]
    fn a_closed_window_shows_nothing_and_hands_on_being_used_last() {
        let mut w = WindowSet::default();
        let now = Instant::now();
        w.set_views("main", vec!["C:\\a.mmd".into()]);
        w.set_views("w1", vec!["C:\\b.mmd".into()]);
        w.move_view("C:\\a.mmd", "main", "w1", now);
        w.arrive("w1", "{}".into());
        w.last = "w1".into();
        w.hovered = Some("w1".into());
        w.forget("w1", &["main".to_string()]);
        assert!(w.shown(now).is_empty());
        assert!(w.take("w1").is_empty());
        assert_eq!(w.last, "main");
        assert_eq!(w.hovered, None);
    }

    #[test]
    fn arrivals_come_in_order_once_and_labels_are_new() {
        let mut w = WindowSet::default();
        w.arrive("main", "1".into());
        w.arrive("main", "2".into());
        assert_eq!(w.take("main"), ["1", "2"]);
        assert!(w.take("main").is_empty());
        assert_eq!((w.new_label(), w.new_label()), ("w1".to_string(), "w2".to_string()));
    }
}
