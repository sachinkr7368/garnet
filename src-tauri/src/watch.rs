use crate::index;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct Watch(pub Mutex<Option<RecommendedWatcher>>);

#[derive(Serialize, Clone)]
struct FsChanged {
    paths: Vec<String>,
    structural: bool,
}

/// Every .gitignore from the root down to a path's folder, plus .git/info/exclude; built lazily per folder and
/// dropped when an ignore file changes.
struct Ignores {
    root: PathBuf,
    dirs: HashMap<PathBuf, Gitignore>,
}

impl Ignores {
    fn new(root: &Path) -> Self {
        Ignores { root: root.to_path_buf(), dirs: HashMap::new() }
    }

    fn matcher(&mut self, dir: &Path) -> &Gitignore {
        let root = self.root.clone();
        self.dirs.entry(dir.to_path_buf()).or_insert_with(|| {
            let mut b = GitignoreBuilder::new(dir);
            b.add(dir.join(".gitignore"));
            if dir == root {
                b.add(root.join(".git/info/exclude"));
            }
            b.build().unwrap_or_else(|_| Gitignore::empty())
        })
    }

    /// The deepest ignore file with a matching rule decides, as in git.
    fn ignored(&mut self, path: &Path, is_dir: bool) -> bool {
        let dirs: Vec<PathBuf> = path.ancestors().skip(1).take_while(|d| d.starts_with(&self.root)).map(Path::to_path_buf).collect();
        for dir in dirs {
            let m = self.matcher(&dir).matched_path_or_any_parents(path, is_dir);
            if m.is_ignore() {
                return true;
            }
            if m.is_whitelist() {
                return false;
            }
        }
        false
    }

    fn invalidate_if_rules(&mut self, rel: &Path) {
        if rel.file_name().is_some_and(|n| n == ".gitignore") || rel == Path::new(".git/info/exclude") {
            self.dirs.clear();
        }
    }
}

pub fn start(app: AppHandle, root: PathBuf) -> notify::Result<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    std::thread::spawn(move || {
        let mut ignores = Ignores::new(&root);
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            let deadline = Instant::now() + Duration::from_millis(150);
            let mut closed = false;
            loop {
                match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(e) => batch.push(e),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        closed = true;
                        break;
                    }
                }
            }
            let mut paths = BTreeSet::new();
            let (mut structural, mut git) = (false, false);
            for ev in batch.into_iter().flatten() {
                let shape = matches!(
                    ev.kind,
                    EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
                );
                for p in ev.paths {
                    let Ok(rel) = p.strip_prefix(&root) else { continue };
                    ignores.invalidate_if_rules(rel);
                    if rel.starts_with(".git") {
                        git |= rel == Path::new(".git/HEAD")
                            || rel == Path::new(".git/index")
                            || rel.starts_with(".git/refs");
                        continue;
                    }
                    if !rel.as_os_str().is_empty() && ignores.ignored(&p, p.is_dir()) {
                        continue;
                    }
                    structural |= shape;
                    paths.insert(p.to_string_lossy().into_owned());
                }
            }
            let changed = !paths.is_empty();
            if structural {
                index::rebuild(&app);
            }
            if changed {
                let _ = app.emit("fs-changed", FsChanged { paths: paths.into_iter().collect(), structural });
            }
            if git || changed {
                let _ = app.emit("git-changed", ());
            }
            if closed {
                return;
            }
        }
    });
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn honours_nested_ignores_exclude_and_rule_edits() {
        let dir = std::env::temp_dir().join(format!("garnet-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".git/info")).unwrap();
        std::fs::create_dir_all(dir.join("app/cache")).unwrap();
        std::fs::write(dir.join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(dir.join("app/.gitignore"), "cache/\n!keep.log\n").unwrap();
        std::fs::write(dir.join(".git/info/exclude"), "secret.txt\n").unwrap();
        let mut ig = Ignores::new(&dir);
        assert!(ig.ignored(&dir.join("x.log"), false));
        assert!(ig.ignored(&dir.join("app/cache/a.rb"), false), "nested .gitignore");
        assert!(!ig.ignored(&dir.join("app/keep.log"), false), "nested negation wins over the root rule");
        assert!(ig.ignored(&dir.join("app/secret.txt"), false), ".git/info/exclude");
        assert!(!ig.ignored(&dir.join("app/a.rb"), false));

        std::fs::write(dir.join(".gitignore"), "*.log\n*.tmp\n").unwrap();
        assert!(!ig.ignored(&dir.join("a.tmp"), false), "cached until the rules change");
        ig.invalidate_if_rules(Path::new(".gitignore"));
        assert!(ig.ignored(&dir.join("a.tmp"), false), "edited .gitignore is picked up");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
