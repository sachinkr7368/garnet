use crate::index;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::BTreeSet;
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

fn gitignore(root: &Path) -> Gitignore {
    let mut b = GitignoreBuilder::new(root);
    b.add(root.join(".gitignore"));
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

pub fn start(app: AppHandle, root: PathBuf) -> notify::Result<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    std::thread::spawn(move || {
        let ignored = gitignore(&root);
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
                    if rel.starts_with(".git") {
                        git |= rel == Path::new(".git/HEAD")
                            || rel == Path::new(".git/index")
                            || rel.starts_with(".git/refs");
                        continue;
                    }
                    if ignored.matched_path_or_any_parents(rel, p.is_dir()).is_ignore() {
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
