use crate::fsops::e2s;
use crate::index::Index;
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

const MAX_MATCHES: usize = 5000;
const MAX_LINE: usize = 400;

#[derive(Default)]
pub struct SearchState {
    generation: Arc<AtomicU64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOpts {
    query: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    include: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct LineMatch {
    line: u64,
    text: String,
    ranges: Vec<(usize, usize)>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SearchEvent {
    File { path: String, matches: Vec<LineMatch> },
    Done { total: usize, truncated: bool },
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[tauri::command]
pub fn search_text(
    state: State<'_, SearchState>,
    index: State<'_, Index>,
    opts: SearchOpts,
    on_event: Channel<SearchEvent>,
) -> Result<(), String> {
    let root = index.root()?;
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if opts.query.is_empty() {
        return Ok(());
    }
    let current = state.generation.clone();
    search(root, opts, generation, current, move |ev| {
        let _ = on_event.send(ev);
    })?;
    Ok(())
}

/// Searches `root` on a background thread; stops early once `current` moves past `generation`.
fn search(
    root: std::path::PathBuf,
    opts: SearchOpts,
    generation: u64,
    current: Arc<AtomicU64>,
    emit: impl Fn(SearchEvent) + Clone + Send + Sync + 'static,
) -> Result<std::thread::JoinHandle<()>, String> {
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!opts.case_sensitive)
        .word(opts.whole_word)
        .fixed_strings(!opts.regex)
        .build(&opts.query)
        .map_err(e2s)?;
    let mut walker = WalkBuilder::new(&root);
    walker
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git");
    if let Some(globs) = opts.include.as_deref().filter(|g| !g.trim().is_empty()) {
        let mut ob = OverrideBuilder::new(&root);
        for g in globs.split(',').map(str::trim).filter(|g| !g.is_empty()) {
            ob.add(g).map_err(e2s)?;
        }
        walker.overrides(ob.build().map_err(e2s)?);
    }
    Ok(std::thread::spawn(move || {
        let total = AtomicUsize::new(0);
        walker.build_parallel().run(|| {
            let matcher = matcher.clone();
            let emit = emit.clone();
            let (current, total) = (&current, &total);
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(0))
                .line_number(true)
                .build();
            Box::new(move |entry| {
                if current.load(Ordering::Relaxed) != generation
                    || total.load(Ordering::Relaxed) >= MAX_MATCHES
                {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                let mut matches = Vec::new();
                let _ = searcher.search_path(
                    &matcher,
                    entry.path(),
                    UTF8(|line_no, line| {
                        let line = line.trim_end_matches(['\n', '\r']);
                        let cut = floor_char_boundary(line, line.len().min(MAX_LINE));
                        let text = &line[..cut];
                        let mut ranges = Vec::new();
                        let _ = matcher.find_iter(text.as_bytes(), |m| {
                            ranges.push((utf16_len(&text[..m.start()]), utf16_len(&text[..m.end()])));
                            ranges.len() < 50
                        });
                        matches.push(LineMatch { line: line_no, text: text.to_string(), ranges });
                        Ok(matches.len() < 500)
                    }),
                );
                if !matches.is_empty() {
                    total.fetch_add(matches.len(), Ordering::Relaxed);
                    emit(SearchEvent::File {
                        path: entry.path().to_string_lossy().into_owned(),
                        matches,
                    });
                }
                WalkState::Continue
            })
        });
        if current.load(Ordering::SeqCst) == generation {
            let total = total.load(Ordering::SeqCst);
            emit(SearchEvent::Done { total, truncated: total >= MAX_MATCHES });
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    fn project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("garnet-search-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("app/models")).unwrap();
        std::fs::create_dir_all(dir.join("log")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".gitignore"), "log/\n").unwrap();
        std::fs::write(dir.join("app/models/post.rb"), "class Post\n  # héllo Post\n  def postal; end\nend\n").unwrap();
        std::fs::write(dir.join("app/models/user.rb"), "class User\nend\n").unwrap();
        std::fs::write(dir.join("README.md"), "Post docs\n").unwrap();
        std::fs::write(dir.join("log/dev.log"), "Post\n").unwrap();
        std::fs::write(dir.join(".git/config"), "Post\n").unwrap();
        std::fs::write(dir.join("bin.dat"), b"Post\0\x01\x02").unwrap();
        dir
    }

    fn opts(query: &str) -> SearchOpts {
        SearchOpts { query: query.into(), regex: false, case_sensitive: true, whole_word: false, include: None }
    }

    type Hits = Vec<(String, Vec<(u64, Vec<(usize, usize)>)>)>;

    fn run(root: &Path, o: SearchOpts) -> (Hits, usize) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        search(root.to_path_buf(), o, 1, Arc::new(AtomicU64::new(1)), move |e| sink.lock().unwrap().push(e)).unwrap().join().unwrap();
        let mut files = Vec::new();
        let mut done = None;
        for e in events.lock().unwrap().drain(..) {
            match e {
                SearchEvent::File { path, matches } => files.push((
                    Path::new(&path).strip_prefix(root).unwrap().to_string_lossy().into_owned(),
                    matches.into_iter().map(|m| (m.line, m.ranges)).collect(),
                )),
                SearchEvent::Done { total, .. } => done = Some(total),
            }
        }
        files.sort();
        (files, done.expect("search finished with a Done event"))
    }

    #[test]
    fn literal_search_skips_ignored_git_and_binary_files() {
        let root = project("literal");
        let (files, total) = run(&root, opts("Post"));
        let names: Vec<_> = files.iter().map(|f| f.0.as_str()).collect();
        assert_eq!(names, vec!["README.md", "app/models/post.rb"]);
        assert_eq!(total, 3);
        // utf-16 columns: "  # héllo Post" puts Post at 10..14
        assert_eq!(files[1].1, vec![(1, vec![(6, 10)]), (2, vec![(10, 14)])]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn case_word_regex_and_include_options() {
        let root = project("options");
        let mut o = opts("post");
        o.case_sensitive = false;
        o.whole_word = true;
        o.include = Some("*.rb".into());
        let (files, total) = run(&root, o);
        assert_eq!(files.len(), 1);
        assert_eq!(total, 2);
        let mut o = opts(r"def \w+");
        o.regex = true;
        assert_eq!(run(&root, o).1, 1);
        let mut bad = opts("(");
        bad.regex = true;
        assert!(search(root.clone(), bad, 1, Arc::new(AtomicU64::new(1)), |_| {}).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_newer_search_cancels_the_old_one() {
        let root = project("cancel");
        let events = Arc::new(Mutex::new(0));
        let sink = events.clone();
        search(root.clone(), opts("Post"), 1, Arc::new(AtomicU64::new(2)), move |_| *sink.lock().unwrap() += 1).unwrap().join().unwrap();
        assert_eq!(*events.lock().unwrap(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}
