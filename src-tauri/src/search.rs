use crate::fsops::e2s;
use crate::index::Index;
use grep_matcher::{Captures, Matcher};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
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
const MAX_RANGES: usize = 200;

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
    #[serde(default)]
    replace: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct LineMatch {
    line: u64,
    text: String,
    ranges: Vec<(usize, usize)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    replacements: Option<Vec<String>>,
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
    let replace = opts.replace.map(|r| (r, opts.regex));
    Ok(std::thread::spawn(move || {
        let total = AtomicUsize::new(0);
        walker.build_parallel().run(|| {
            let matcher = matcher.clone();
            let replace = replace.clone();
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
                        matches.push(line_match(&matcher, line_no, line, replace.as_ref()));
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
        SearchOpts { query: query.into(), regex: false, case_sensitive: true, whole_word: false, include: None, replace: None }
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

/// One matching line. With a replacement, the full line is kept (so edits can be verified against it) and each
/// match carries its replacement text; `$1`/`${name}` groups are expanded in regex mode only.
fn line_match(matcher: &RegexMatcher, line_no: u64, line: &str, replace: Option<&(String, bool)>) -> LineMatch {
    let text = match replace {
        Some(_) => line,
        None => &line[..floor_char_boundary(line, line.len().min(MAX_LINE))],
    };
    let mut ranges = Vec::new();
    let mut replacements = replace.map(|_| Vec::new());
    let Ok(mut caps) = matcher.new_captures() else {
        return LineMatch { line: line_no, text: text.to_string(), ranges, replacements };
    };
    let _ = matcher.captures_iter(text.as_bytes(), &mut caps, |caps| {
        let Some(m) = caps.get(0) else { return false };
        if m.is_empty() {
            return true;
        }
        ranges.push((utf16_len(&text[..m.start()]), utf16_len(&text[..m.end()])));
        if let (Some(list), Some((with, regex))) = (replacements.as_mut(), replace) {
            if *regex {
                let mut dst = Vec::new();
                caps.interpolate(|name| matcher.capture_index(name), text.as_bytes(), with.as_bytes(), &mut dst);
                list.push(String::from_utf8_lossy(&dst).into_owned());
            } else {
                list.push(with.clone());
            }
        }
        ranges.len() < MAX_RANGES
    });
    LineMatch { line: line_no, text: text.to_string(), ranges, replacements }
}

#[derive(Deserialize, Debug, Clone)]
pub struct ReplaceEdit {
    line: u64,
    start: usize,
    end: usize,
    old: String,
    new: String,
}

fn utf16_to_byte(s: &str, col: usize) -> Option<usize> {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units == col {
            return Some(i);
        }
        units += c.len_utf16();
    }
    (units == col).then_some(s.len())
}

/// Applies line/column (UTF-16) edits to `text`. An edit is skipped when the text at its range is no longer
/// `old` (the file changed since the search). Returns the new text and the number of edits applied.
pub fn apply_edits(text: &str, edits: &[ReplaceEdit]) -> (String, usize) {
    let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_string).collect();
    let mut sorted = edits.to_vec();
    sorted.sort_by_key(|e| std::cmp::Reverse((e.line, e.start)));
    let mut applied = 0;
    let mut floor: Option<(u64, usize)> = None;
    for e in &sorted {
        if floor.is_some_and(|(line, start)| line == e.line && e.end > start) {
            continue;
        }
        let Some(line) = e.line.checked_sub(1).and_then(|i| lines.get_mut(i as usize)) else { continue };
        let body_len = line.trim_end_matches(['\n', '\r']).len();
        let body = &line[..body_len];
        let (Some(s), Some(t)) = (utf16_to_byte(body, e.start), utf16_to_byte(body, e.end)) else { continue };
        if s > t || body[s..t] != e.old {
            continue;
        }
        line.replace_range(s..t, &e.new);
        floor = Some((e.line, e.start));
        applied += 1;
    }
    (lines.concat(), applied)
}

#[tauri::command]
pub async fn replace_in_file(path: String, edits: Vec<ReplaceEdit>) -> Result<usize, String> {
    let bytes = std::fs::read(&path).map_err(e2s)?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{path} is not UTF-8"))?;
    let (next, applied) = apply_edits(&text, &edits);
    if applied > 0 {
        std::fs::write(&path, next).map_err(e2s)?;
    }
    Ok(applied)
}

#[cfg(test)]
mod replace_tests {
    use super::*;

    fn matcher(q: &str, regex: bool, word: bool) -> RegexMatcher {
        RegexMatcherBuilder::new().word(word).fixed_strings(!regex).build(q).unwrap()
    }

    fn edit(line: u64, start: usize, end: usize, old: &str, new: &str) -> ReplaceEdit {
        ReplaceEdit { line, start, end, old: old.into(), new: new.into() }
    }

    #[test]
    fn expands_regex_groups() {
        let m = matcher(r"(\w+)_id", true, false);
        let r = ("${1}Id".to_string(), true);
        let lm = line_match(&m, 3, "user_id = post_id", Some(&r));
        assert_eq!(lm.ranges, vec![(0, 7), (10, 17)]);
        assert_eq!(lm.replacements.unwrap(), vec!["userId", "postId"]);
    }

    #[test]
    fn literal_replacement_outside_regex_mode() {
        let m = matcher("a.b", false, false);
        let r = ("$1".to_string(), false);
        let lm = line_match(&m, 1, "a.b axb", Some(&r));
        assert_eq!(lm.ranges, vec![(0, 3)]);
        assert_eq!(lm.replacements.unwrap(), vec!["$1"]);
    }

    #[test]
    fn whole_word_and_utf16_columns() {
        let m = matcher("post", false, true);
        let lm = line_match(&m, 1, "é post posts", None);
        assert_eq!(lm.ranges, vec![(2, 6)]);
        assert!(lm.replacements.is_none());
    }

    #[test]
    fn keeps_full_line_when_replacing() {
        let m = matcher("x", false, false);
        let long = format!("{}x", "a".repeat(600));
        assert_eq!(line_match(&m, 1, &long, None).text.len(), MAX_LINE);
        let r = ("y".to_string(), false);
        let lm = line_match(&m, 1, &long, Some(&r));
        assert_eq!(lm.text.len(), 601);
        assert_eq!(lm.ranges, vec![(600, 601)]);
    }

    #[test]
    fn applies_edits_and_skips_stale() {
        let text = "foo foo\r\nbar é foo\nfoo";
        let edits = [
            edit(1, 0, 3, "foo", "x"),
            edit(1, 4, 7, "foo", "yy"),
            edit(2, 6, 9, "foo", "z"),
            edit(3, 0, 3, "bar", "w"),
        ];
        let (out, n) = apply_edits(text, &edits);
        assert_eq!(n, 3);
        assert_eq!(out, "x yy\r\nbar é z\nfoo");
    }

    #[test]
    fn skips_out_of_range_and_overlaps() {
        let (out, n) = apply_edits("abc\n", &[edit(9, 0, 1, "a", "b"), edit(1, 0, 2, "ab", "X"), edit(1, 1, 3, "bc", "Y")]);
        assert_eq!(n, 1);
        assert_eq!(out, "aY\n");
    }
}
