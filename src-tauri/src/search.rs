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
    let current = state.generation.clone();
    std::thread::spawn(move || {
        let total = AtomicUsize::new(0);
        walker.build_parallel().run(|| {
            let matcher = matcher.clone();
            let chan = on_event.clone();
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
                    let _ = chan.send(SearchEvent::File {
                        path: entry.path().to_string_lossy().into_owned(),
                        matches,
                    });
                }
                WalkState::Continue
            })
        });
        if current.load(Ordering::SeqCst) == generation {
            let total = total.load(Ordering::SeqCst);
            let _ = on_event.send(SearchEvent::Done { total, truncated: total >= MAX_MATCHES });
        }
    });
    Ok(())
}
