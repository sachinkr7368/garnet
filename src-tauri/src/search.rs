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
const MAX_LINES: usize = 500;

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
    /// `truncated`: the file has more matches than listed (over MAX_LINES lines or MAX_RANGES on a line).
    File { path: String, matches: Vec<LineMatch>, truncated: bool },
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
        .multi_line(true)
        .line_terminator(Some(b'\n'))
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
                let mut more = false;
                let _ = searcher.search_path(
                    &matcher,
                    entry.path(),
                    UTF8(|line_no, line| {
                        let line = line.trim_end_matches(['\n', '\r']);
                        if matches.len() >= MAX_LINES {
                            more = true;
                            return Ok(false);
                        }
                        let m = line_match(&matcher, line_no, line, replace.as_ref());
                        more |= m.ranges.len() >= MAX_RANGES;
                        matches.push(m);
                        Ok(true)
                    }),
                );
                // A newer search (e.g. the next keystroke in Replace) supersedes this one; its results must not land.
                if !matches.is_empty() && current.load(Ordering::SeqCst) == generation {
                    total.fetch_add(matches.iter().map(|m| m.ranges.len()).sum(), Ordering::Relaxed);
                    emit(SearchEvent::File {
                        path: entry.path().to_string_lossy().into_owned(),
                        matches,
                        truncated: more,
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
                SearchEvent::File { path, matches, .. } => files.push((
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
    fn anchors_match_at_line_starts() {
        let root = project("anchors");
        let (files, _) = run(&root, SearchOpts { regex: true, ..opts(r"^\s*def \w+") });
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].1, vec![(3, vec![(0, 12)])]);
        std::fs::remove_dir_all(root).unwrap();
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
    fn counts_matches_not_lines_and_flags_truncated_files() {
        let root = project("counts");
        std::fs::write(root.join("many.txt"), "x\n".repeat(MAX_LINES + 20)).unwrap();
        std::fs::write(root.join("wide.txt"), "x".repeat(MAX_RANGES + 5)).unwrap();
        std::fs::write(root.join("two.txt"), "x x\nx\n").unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let mut o = opts("x");
        o.include = Some("*.txt".into());
        search(root.clone(), o, 1, Arc::new(AtomicU64::new(1)), move |e| sink.lock().unwrap().push(e)).unwrap().join().unwrap();
        let mut by_name = std::collections::HashMap::new();
        let mut total = 0;
        for e in events.lock().unwrap().drain(..) {
            match e {
                SearchEvent::File { path, matches, truncated } => {
                    by_name.insert(Path::new(&path).file_name().unwrap().to_string_lossy().into_owned(), (matches.iter().map(|m| m.ranges.len()).sum::<usize>(), truncated));
                }
                SearchEvent::Done { total: t, .. } => total = t,
            }
        }
        assert_eq!(by_name["two.txt"], (3, false));
        assert_eq!(by_name["many.txt"], (MAX_LINES, true));
        assert_eq!(by_name["wide.txt"], (MAX_RANGES, true));
        assert_eq!(total, 3 + MAX_LINES + MAX_RANGES);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replace_refuses_symlinks_and_paths_outside_the_project() {
        let root = project("guard");
        let outside = root.with_extension("outside");
        std::fs::write(&outside, "foo\n").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link.rb")).unwrap();
        let roots = [std::fs::canonicalize(&root).unwrap()];
        let e = vec![ReplaceEdit { line: 1, start: 0, end: 3, old: "foo".into(), new: "bar".into() }];
        let link = root.join("link.rb").to_string_lossy().into_owned();
        assert!(replace_file(&link, &e, &roots).unwrap_err().contains("symlink"));
        assert!(replace_file(&outside.to_string_lossy(), &e, &roots).unwrap_err().contains("outside the project"));
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "foo\n");
        let inside = root.join("app/models/user.rb");
        let e = vec![ReplaceEdit { line: 1, start: 6, end: 10, old: "User".into(), new: "Member".into() }];
        assert_eq!(replace_file(&inside.to_string_lossy(), &e, &roots), Ok(1));
        assert_eq!(std::fs::read_to_string(&inside).unwrap(), "class Member\nend\n");
        std::fs::remove_file(outside).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replace_writes_atomically_and_never_walks_a_symlinked_directory() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = project("atomic");
        let file = root.join("app/models/user.rb");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o664)).unwrap();
        let before = std::fs::metadata(&file).unwrap().ino();
        let roots = [std::fs::canonicalize(&root).unwrap()];
        let e = vec![ReplaceEdit { line: 1, start: 6, end: 10, old: "User".into(), new: "Member".into() }];
        assert_eq!(replace_file(&file.to_string_lossy(), &e, &roots), Ok(1));
        let meta = std::fs::metadata(&file).unwrap();
        assert_ne!(meta.ino(), before, "written to a new file and renamed into place");
        assert_eq!(meta.permissions().mode() & 0o777, 0o664, "group-write survives the umask");
        let leftovers: Vec<_> = std::fs::read_dir(root.join("app/models")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".garnet-")).collect();
        assert!(leftovers.is_empty());
        // A directory swapped for a symlink after the check: the component-wise O_NOFOLLOW walk refuses it.
        let outside = root.with_extension("outside-dir");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
        assert!(nofollow::open_dir(&roots[0].join("linked")).is_err());
        assert!(nofollow::open_dir(&roots[0].join("app/models")).is_ok());
        std::fs::remove_dir_all(outside).unwrap();
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
pub async fn replace_in_file(app: tauri::AppHandle, index: State<'_, Index>, path: String, edits: Vec<ReplaceEdit>) -> Result<usize, String> {
    replace_file(&path, &edits, &crate::fsops::write_roots(&app, &index))
}

/// Same guard as `write_file` (inside the project, never through a symlink), without a window between the check
/// and the write: the checked directory is opened component by component without following symlinks, the file is
/// read and a temp file written relative to that handle, and the temp file is renamed over the original.
fn replace_file(path: &str, edits: &[ReplaceEdit], roots: &[std::path::PathBuf]) -> Result<usize, String> {
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;
    crate::fsops::check_write(path, roots, false)?;
    let p = std::path::Path::new(path);
    let name = p.file_name().ok_or_else(|| format!("{path} has no file name"))?;
    let parent = std::fs::canonicalize(p.parent().unwrap_or(p)).map_err(e2s)?;
    if !roots.iter().any(|r| parent.starts_with(r)) {
        return Err(format!("refusing to write {path}: outside the project"));
    }
    let dir = nofollow::open_dir(&parent)?;
    let mut file = nofollow::open_at(&dir, name, libc::O_RDONLY, 0)?;
    let meta = file.metadata().map_err(e2s)?;
    if !meta.is_file() {
        return Err(format!("{path} is not a regular file"));
    }
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(|_| format!("{path} is not UTF-8"))?;
    let (next, applied) = apply_edits(&text, edits);
    if applied == 0 {
        return Ok(0);
    }
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let tmp = std::ffi::OsString::from(format!(".{}.garnet-{}-{nanos}", name.to_string_lossy(), std::process::id()));
    let mode = meta.permissions().mode() & 0o7777;
    let mut out = nofollow::open_at(&dir, &tmp, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, mode)?;
    // openat's mode is masked by the umask; fchmod restores the original bits exactly.
    let written = out.set_permissions(std::fs::Permissions::from_mode(mode)).and_then(|_| out.write_all(next.as_bytes())).and_then(|_| out.sync_all()).map_err(e2s);
    let moved = written.and_then(|_| nofollow::rename_at(&dir, &tmp, name));
    if moved.is_err() {
        nofollow::unlink_at(&dir, &tmp);
    }
    moved?;
    nofollow::sync(&dir);
    Ok(applied)
}

/// openat/renameat relative to a directory handle, never following a symlink.
mod nofollow {
    use std::ffi::{CString, OsStr};
    use std::fs::File;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Component, Path};

    fn cstr(s: &OsStr) -> Result<CString, String> {
        CString::new(s.as_bytes()).map_err(|_| "path contains a NUL byte".to_string())
    }

    fn check(fd: i32, what: &OsStr) -> Result<i32, String> {
        if fd < 0 {
            Err(format!("{}: {}", what.to_string_lossy(), std::io::Error::last_os_error()))
        } else {
            Ok(fd)
        }
    }

    /// Opens `path` (absolute) one component at a time with O_NOFOLLOW, so no component can be a symlink.
    pub fn open_dir(path: &Path) -> Result<OwnedFd, String> {
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let root = cstr(OsStr::new("/"))?;
        // SAFETY: plain syscalls on NUL-terminated paths; each fd is owned by an OwnedFd right away.
        let mut dir = unsafe { OwnedFd::from_raw_fd(check(libc::open(root.as_ptr(), flags), OsStr::new("/"))?) };
        for c in path.components() {
            let Component::Normal(part) = c else { continue };
            let name = cstr(part)?;
            dir = unsafe { OwnedFd::from_raw_fd(check(libc::openat(dir.as_raw_fd(), name.as_ptr(), flags), part)?) };
        }
        Ok(dir)
    }

    pub fn open_at(dir: &OwnedFd, name: &OsStr, flags: i32, mode: u32) -> Result<File, String> {
        let n = cstr(name)?;
        let fd = unsafe { libc::openat(dir.as_raw_fd(), n.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_CLOEXEC, mode as libc::c_uint) };
        Ok(unsafe { File::from_raw_fd(check(fd, name)?) })
    }

    pub fn rename_at(dir: &OwnedFd, from: &OsStr, to: &OsStr) -> Result<(), String> {
        let (f, t) = (cstr(from)?, cstr(to)?);
        let r = unsafe { libc::renameat(dir.as_raw_fd(), f.as_ptr(), dir.as_raw_fd(), t.as_ptr()) };
        check(r, to).map(|_| ())
    }

    /// fsync the directory so the rename itself is durable.
    pub fn sync(dir: &OwnedFd) {
        unsafe { libc::fsync(dir.as_raw_fd()) };
    }

    pub fn unlink_at(dir: &OwnedFd, name: &OsStr) {
        if let Ok(n) = cstr(name) {
            unsafe { libc::unlinkat(dir.as_raw_fd(), n.as_ptr(), 0) };
        }
    }
}

#[cfg(test)]
mod replace_tests {
    use super::*;

    fn matcher(q: &str, regex: bool, word: bool) -> RegexMatcher {
        RegexMatcherBuilder::new().multi_line(true).line_terminator(Some(b'\n')).word(word).fixed_strings(!regex).build(q).unwrap()
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
    fn implementation_pattern_from_frontend_compiles() {
        // implementationPattern("ApplicationRecord") in src/implementations.ts
        let pattern = r"^\s*(class\s+[\w:]+\s*<\s*([\w:]*::)?ApplicationRecord([^\w:]|$)|(include|extend|prepend)(\s+|\s*\()(.*[\s,(])?([\w:]*::)?ApplicationRecord([^\w:]|$))";
        let m = matcher(pattern, true, false);
        assert_eq!(line_match(&m, 1, "class Post < ApplicationRecord", None).ranges.len(), 1);
        assert!(line_match(&m, 1, "class ApplicationRecord < ActiveRecord::Base", None).ranges.is_empty());
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
