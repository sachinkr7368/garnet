use ignore::{WalkBuilder, WalkState};
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct Index {
    root: RwLock<Option<PathBuf>>,
    files: RwLock<Arc<Vec<String>>>,
}

#[derive(Serialize, Clone)]
struct IndexReady {
    count: usize,
    ms: u128,
}

impl Index {
    pub fn root(&self) -> Result<PathBuf, String> {
        self.root.read().unwrap().clone().ok_or_else(|| "no project open".into())
    }

    pub fn set_root(&self, root: PathBuf) {
        *self.root.write().unwrap() = Some(root);
        *self.files.write().unwrap() = Arc::default();
    }

    fn files(&self) -> Arc<Vec<String>> {
        self.files.read().unwrap().clone()
    }
}

/// Rebuilds the file index for the current root and tells the frontend.
pub fn rebuild(app: &AppHandle) {
    let index = app.state::<Index>();
    let Ok(root) = index.root() else { return };
    let started = Instant::now();
    let files = walk(&root);
    if index.root().ok().as_deref() != Some(root.as_path()) {
        return;
    }
    let count = files.len();
    *index.files.write().unwrap() = Arc::new(files);
    let _ = app.emit("index-ready", IndexReady { count, ms: started.elapsed().as_millis() });
}

fn walk(root: &Path) -> Vec<String> {
    struct Flush<'a> {
        local: Vec<String>,
        sink: &'a Mutex<Vec<String>>,
    }
    impl Drop for Flush<'_> {
        fn drop(&mut self) {
            self.sink.lock().unwrap().append(&mut self.local);
        }
    }
    let files = Mutex::new(Vec::new());
    WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build_parallel()
        .run(|| {
            let mut buf = Flush { local: Vec::new(), sink: &files };
            Box::new(move |entry| {
                if let Ok(e) = entry {
                    if e.file_type().is_some_and(|t| t.is_file()) {
                        if let Ok(rel) = e.path().strip_prefix(root) {
                            buf.local.push(rel.to_string_lossy().into_owned());
                        }
                    }
                }
                WalkState::Continue
            })
        });
    let mut v = files.into_inner().unwrap();
    v.sort_unstable();
    v
}

#[tauri::command]
pub async fn find_files(index: State<'_, Index>, query: String, limit: usize) -> Result<Vec<String>, String> {
    Ok(rank(&index.files(), &query, limit))
}

fn rank(files: &[String], query: &str, limit: usize) -> Vec<String> {
    if query.trim().is_empty() {
        return files.iter().take(limit).cloned().collect();
    }
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
    let mut hits = pattern.match_list(files.iter(), &mut matcher);
    hits.truncate(limit);
    hits.into_iter().map(|(p, _)| p.clone()).collect()
}

#[tauri::command]
pub async fn index_files(index: State<'_, Index>) -> Result<Arc<Vec<String>>, String> {
    Ok(index.files())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walk_respects_gitignore_and_skips_git_dir() {
        let dir = std::env::temp_dir().join(format!("garnet-index-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("app/models")).unwrap();
        std::fs::create_dir_all(dir.join("log")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".gitignore"), "log/\n").unwrap();
        std::fs::write(dir.join("app/models/user.rb"), "").unwrap();
        std::fs::write(dir.join("log/dev.log"), "").unwrap();
        std::fs::write(dir.join(".git/HEAD"), "").unwrap();
        let files = walk(&dir);
        assert_eq!(files, vec![".gitignore", "app/models/user.rb"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rank_is_fuzzy_case_insensitive_and_limited() {
        let files: Vec<String> = ["app/controllers/posts_controller.rb", "app/models/post.rb", "app/views/posts/index.html.erb", "config/routes.rb"]
            .map(String::from)
            .to_vec();
        assert_eq!(rank(&files, "", 2), files[..2].to_vec());
        assert_eq!(rank(&files, "models/post", 10), vec!["app/models/post.rb"]);
        assert_eq!(rank(&files, "pc", 10)[0], "app/controllers/posts_controller.rb");
        assert_eq!(rank(&files, "Routes", 10), vec!["config/routes.rb"]);
        assert_eq!(rank(&files, "routes", 10), vec!["config/routes.rb"]);
        assert!(rank(&files, "Post", 10).contains(&"app/models/post.rb".to_string()));
        assert_eq!(rank(&files, "PostsController", 10)[0], "app/controllers/posts_controller.rb");
        assert_eq!(rank(&files, "rb", 1).len(), 1);
        assert!(rank(&files, "zzz", 10).is_empty());
    }
}
