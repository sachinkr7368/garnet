use crate::fsops::e2s;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

static GIT: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());
/// A repo's own .git/config can run programs (filters, textconv, hooks, sshCommand), so git stays off until the
/// project is trusted. Reset on every project open.
pub static TRUSTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub fn git_set_trusted(trusted: bool) {
    TRUSTED.store(trusted, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub fn git_set_path(path: String) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let path = path.trim().to_string();
    let path = if path == "git" { String::new() } else { path };
    if !path.is_empty() {
        let p = std::path::Path::new(&path);
        let executable = p.is_absolute() && std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false);
        if !executable {
            *GIT.write().unwrap() = String::new();
            return Err(format!("git.path must be an absolute path to an executable: {path}"));
        }
    }
    *GIT.write().unwrap() = path;
    Ok(())
}

fn run_git(root: &str, args: &[&str], stdin: Option<&str>) -> Result<std::process::Output, String> {
    use std::io::Write;
    if !TRUSTED.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Trust project to enable Git".into());
    }
    let bin = GIT.read().unwrap().clone();
    let mut child = Command::new(if bin.is_empty() { "git" } else { bin.as_str() })
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(e2s)?;
    if let Some(input) = stdin {
        child.stdin.take().unwrap().write_all(input.as_bytes()).map_err(e2s)?;
    }
    child.wait_with_output().map_err(e2s)
}

/// Runs blocking git work on the blocking pool so a slow fetch/push never stalls the async runtime (IPC).
async fn off<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(e2s)?
}

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    git_in(root, args, None)
}

fn git_in(root: &str, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let out = run_git(root, args, stdin)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Serialize)]
pub struct StatusEntry {
    path: String,
    /// Source path of a staged rename or copy.
    orig: Option<String>,
    index: char,
    worktree: char,
}

fn parse_status(out: &str) -> Vec<StatusEntry> {
    let mut entries = Vec::new();
    let mut parts = out.split('\0');
    while let Some(rec) = parts.next() {
        if rec.len() < 4 {
            continue;
        }
        let mut chars = rec.chars();
        let (index, worktree) = (chars.next().unwrap(), chars.next().unwrap());
        let orig = if index == 'R' || index == 'C' { parts.next().map(String::from) } else { None };
        entries.push(StatusEntry { path: rec[3..].to_string(), orig, index, worktree });
    }
    entries
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<Vec<StatusEntry>, String> {
    off(move || status(&root)).await
}

fn status(root: &str) -> Result<Vec<StatusEntry>, String> {
    git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]).map(|o| parse_status(&o))
}

#[tauri::command]
pub async fn git_branch(root: String) -> Result<String, String> {
    off(move || git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string())).await
}

/// File content at `rev` ("HEAD" or "" for the index); empty when the file is new.
#[tauri::command]
pub async fn git_show(root: String, path: String, rev: String) -> Result<String, String> {
    let rel = rel(&root, &path);
    off(move || Ok(git(&root, &["show", "--no-textconv", "--no-ext-diff", &format!("{rev}:{rel}")]).unwrap_or_default())).await
}

fn rel(root: &str, path: &str) -> String {
    Path::new(path)
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    off(move || {
        let mut args = vec!["--literal-pathspecs", "add", "--"];
        args.extend(paths.iter().map(String::as_str));
        git(&root, &args).map(|_| ())
    })
    .await
}

fn has_head(root: &str) -> bool {
    git(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

fn unstage(root: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = if has_head(root) { vec!["--literal-pathspecs", "reset", "-q", "HEAD", "--"] } else { vec!["--literal-pathspecs", "rm", "--cached", "-r", "-q", "--"] };
    args.extend(paths.iter().map(String::as_str));
    git(root, &args).map(|_| ())
}

/// Unstages paths; pass both sides of a staged rename so the deletion is unstaged too.
#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    off(move || unstage(&root, &paths)).await
}

const RUN_SUBCOMMANDS: &[&str] = &[
    "add", "branch", "checkout", "cherry-pick", "commit", "fetch", "for-each-ref", "log", "merge", "merge-base", "pull", "push", "rebase",
    "remote", "reset", "restore", "revert", "rev-list", "rev-parse", "rm", "show", "stash", "status", "switch", "tag", "worktree",
];
/// Options that run a program or redirect git elsewhere. Long options also match their abbreviations (git accepts `--upload-pa`).
const RUN_DENIED: &[&str] = &["--upload-pack", "--receive-pack", "--exec", "--config", "--output", "--git-dir", "--work-tree", "--exec-path", "--namespace"];

/// git_run is reachable from the webview, so only the subcommands the UI uses are allowed, and never an option that executes code.
fn check_run_args(args: &[String]) -> Result<(), String> {
    let sub = args.first().map(String::as_str).unwrap_or("");
    if !RUN_SUBCOMMANDS.contains(&sub) {
        return Err(format!("git {sub} is not allowed here"));
    }
    if sub == "remote" && !matches!(args.get(1).map(String::as_str), None | Some("get-url" | "-v")) {
        return Err("only git remote get-url is allowed here".into());
    }
    for a in args[1..].iter().take_while(|a| *a != "--") {
        let name = a.split('=').next().unwrap_or_default();
        let denied = if name.starts_with("--") {
            name.len() > 3 && RUN_DENIED.iter().any(|d| d.starts_with(name))
        } else {
            name.starts_with('-') && (name.starts_with("-c") || name.starts_with("-C") || (sub == "rebase" && name[1..].contains('x')))
        };
        if denied || a.contains('\0') {
            return Err(format!("git option {name} is not allowed here"));
        }
    }
    Ok(())
}

/// Runs a git subcommand from the allow list in the project (branch/worktree/stash/push/pull UI).
#[tauri::command]
pub async fn git_run(root: String, args: Vec<String>) -> Result<String, String> {
    check_run_args(&args)?;
    off(move || {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        git(&root, &args)
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(root: String) -> Result<String, String> {
    off(move || git(&root, &["fetch", "--quiet", "--all", "--prune"])).await
}

#[tauri::command]
pub async fn git_commit(root: String, message: String, amend: Option<bool>) -> Result<String, String> {
    off(move || {
        let mut args = vec!["commit", "-m", &message];
        if amend == Some(true) {
            args.push("--amend");
        }
        git(&root, &args)
    })
    .await
}

fn under(path: &str, p: &str) -> bool {
    path == p || path.strip_prefix(p).is_some_and(|rest| rest.starts_with('/'))
}

/// RubyMine's Rollback: tracked paths return to HEAD (index and working copy), added files leave the index and their
/// local copies are deleted only with `delete_added`, and a rename moves back to its old path. Paths may be folders.
fn rollback(root: &str, paths: &[String], delete_added: bool) -> Result<(), String> {
    let wanted = |e: &StatusEntry| paths.iter().any(|p| under(&e.path, p) || e.orig.as_deref().is_some_and(|o| under(o, p)));
    let (mut restore, mut unindex, mut remove) = (Vec::new(), Vec::new(), Vec::new());
    for e in status(root)?.into_iter().filter(wanted) {
        match (e.index, e.worktree) {
            ('?', _) => {
                if delete_added {
                    remove.push(e.path);
                }
            }
            ('R', _) => {
                restore.extend(e.orig);
                unindex.push(e.path.clone());
                remove.push(e.path);
            }
            ('A' | 'C', _) | (_, 'A') => {
                unindex.push(e.path.clone());
                if delete_added {
                    remove.push(e.path);
                }
            }
            _ => restore.push(e.path),
        }
    }
    if !unindex.is_empty() {
        let mut args = vec!["--literal-pathspecs", "rm", "--cached", "-f", "-q", "--"];
        args.extend(unindex.iter().map(String::as_str));
        git(root, &args)?;
    }
    if !restore.is_empty() {
        let mut args = vec!["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--"];
        args.extend(restore.iter().map(String::as_str));
        git(root, &args)?;
    }
    for p in remove {
        let file = Path::new(root).join(&p);
        if file.symlink_metadata().is_ok() {
            std::fs::remove_file(&file).map_err(|e| format!("{p}: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn git_rollback(root: String, paths: Vec<String>, delete_added: bool) -> Result<(), String> {
    off(move || rollback(&root, &paths, delete_added)).await
}

const NO_EXT: [&str; 2] = ["--no-ext-diff", "--no-textconv"];

fn check_rev(rev: &str) -> Result<(), String> {
    if rev.starts_with('-') || rev.contains('\0') {
        return Err(format!("invalid revision: {rev}"));
    }
    Ok(())
}

/// File content at `rev` (a commit, `:2` for a merge stage, "" for the index); None when it does not exist there.
#[tauri::command]
pub async fn git_file_at(root: String, rev: String, path: String) -> Result<Option<String>, String> {
    off(move || {
        check_rev(&rev)?;
        let spec = format!("{rev}:{}", rel(&root, &path));
        let mut args = vec!["show"];
        args.extend(NO_EXT);
        args.push(&spec);
        match run_git(&root, &args, None)? {
            out if out.status.success() => Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned())),
            _ => Ok(None),
        }
    })
    .await
}

#[derive(Serialize, PartialEq, Debug, Clone)]
pub struct Edge {
    from: usize,
    to: usize,
    /// 0: lane passes through the row, 1: lane ends in this row's node, 2: node continues to a parent lane.
    kind: u8,
}

#[derive(Serialize, Debug)]
pub struct LogCommit {
    hash: String,
    parents: Vec<String>,
    author: String,
    email: String,
    time: i64,
    refs: String,
    subject: String,
    col: usize,
    edges: Vec<Edge>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LogOpts {
    branch: String,
    author: String,
    text: String,
    path: String,
    limit: u32,
}

fn parse_log(out: &str) -> Vec<LogCommit> {
    out.split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').splitn(7, '\x1f').collect();
            (f.len() == 7).then(|| LogCommit {
                hash: f[0].to_string(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author: f[2].to_string(),
                email: f[3].to_string(),
                time: f[4].parse().unwrap_or(0),
                refs: f[5].to_string(),
                subject: f[6].trim_end().to_string(),
                col: 0,
                edges: Vec::new(),
            })
        })
        .collect()
}

/// Assigns each commit a lane and the line segments drawn through its row.
fn layout(commits: &mut [LogCommit]) {
    let mut lanes: Vec<Option<String>> = Vec::new();
    for c in commits.iter_mut() {
        let col = match lanes.iter().position(|l| l.as_deref() == Some(c.hash.as_str())) {
            Some(i) => i,
            None => match lanes.iter().position(Option::is_none) {
                Some(i) => i,
                None => {
                    lanes.push(None);
                    lanes.len() - 1
                }
            },
        };
        let mut next: Vec<Option<String>> = lanes.iter().map(|l| l.clone().filter(|h| *h != c.hash)).collect();
        for (k, p) in c.parents.iter().enumerate() {
            if next.iter().any(|l| l.as_deref() == Some(p.as_str())) {
                continue;
            }
            if k == 0 && next[col].is_none() {
                next[col] = Some(p.clone());
            } else if let Some(i) = next.iter().position(Option::is_none) {
                next[i] = Some(p.clone());
            } else {
                next.push(Some(p.clone()));
            }
        }
        let find = |next: &[Option<String>], h: &str| next.iter().position(|l| l.as_deref() == Some(h));
        let mut edges = Vec::new();
        for (i, l) in lanes.iter().enumerate() {
            match l {
                Some(h) if *h == c.hash => edges.push(Edge { from: i, to: col, kind: 1 }),
                Some(h) => edges.push(Edge { from: i, to: find(&next, h).unwrap_or(i), kind: 0 }),
                None => {}
            }
        }
        for p in &c.parents {
            if let Some(j) = find(&next, p) {
                edges.push(Edge { from: col, to: j, kind: 2 });
            }
        }
        while next.last() == Some(&None) {
            next.pop();
        }
        c.col = col;
        c.edges = edges;
        lanes = next;
    }
}

#[tauri::command]
pub async fn git_log(root: String, opts: LogOpts) -> Result<Vec<LogCommit>, String> {
    off(move || {
        let limit = format!("-n{}", opts.limit.clamp(1, 100_000));
        let author = format!("--author={}", opts.author);
        let grep = format!("--grep={}", opts.text);
        let mut args = vec!["log", "--no-color", "--date-order", &limit, "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e"];
        args.extend(NO_EXT);
        if !opts.author.is_empty() {
            args.extend(["--regexp-ignore-case", &author]);
        }
        if !opts.text.is_empty() {
            args.extend(["--regexp-ignore-case", "--fixed-strings", &grep]);
        }
        let path = rel(&root, &opts.path);
        let file = !path.is_empty() && Path::new(&root).join(&path).is_file();
        if file {
            args.push("--follow");
        }
        if opts.branch.is_empty() {
            args.extend(["--branches", "--remotes", "--tags", "HEAD"]);
        } else {
            check_rev(&opts.branch)?;
            args.push(&opts.branch);
        }
        args.push("--");
        if !path.is_empty() {
            args.push(&path);
        }
        let mut commits = parse_log(&git(&root, &args)?);
        if opts.author.is_empty() && opts.text.is_empty() && path.is_empty() {
            layout(&mut commits);
        }
        Ok(commits)
    })
    .await
}

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    path: String,
    old_path: Option<String>,
    status: String,
    added: Option<u32>,
    deleted: Option<u32>,
    old_rev: String,
    new_rev: String,
}

fn parse_name_status(out: &str) -> Vec<ChangedFile> {
    let mut files = Vec::new();
    let mut parts = out.split('\0').filter(|s| !s.is_empty());
    while let Some(status) = parts.next() {
        let renamed = status.starts_with('R') || status.starts_with('C');
        let first = parts.next().unwrap_or_default().to_string();
        let (path, old_path) = if renamed { (parts.next().unwrap_or_default().to_string(), Some(first)) } else { (first, None) };
        files.push(ChangedFile { path, old_path, status: status[..1].to_string(), ..Default::default() });
    }
    files
}

fn apply_numstat(files: &mut [ChangedFile], out: &str) {
    let mut parts = out.split('\0');
    while let Some(rec) = parts.next() {
        let f: Vec<&str> = rec.splitn(3, '\t').collect();
        if f.len() < 3 {
            continue;
        }
        let path = if f[2].is_empty() {
            parts.next();
            parts.next().unwrap_or_default()
        } else {
            f[2]
        };
        if let Some(file) = files.iter_mut().find(|x| x.path == path) {
            file.added = f[0].parse().ok();
            file.deleted = f[1].parse().ok();
        }
    }
}

fn diff_files(root: &str, spec: &[&str]) -> Result<Vec<ChangedFile>, String> {
    for s in spec {
        if *s != "--cached" {
            check_rev(s)?;
        }
    }
    let run = |kind: &str| {
        let mut args = vec!["diff", "--no-color", "-M", "-z", kind];
        args.extend(NO_EXT);
        args.extend(spec);
        args.push("--");
        git(root, &args)
    };
    let mut files = parse_name_status(&run("--name-status")?);
    apply_numstat(&mut files, &run("--numstat")?);
    Ok(files)
}

/// Changed files with line counts: `[]` = unstaged, `["--cached"]` = staged, `["main...HEAD"]` = branch.
#[tauri::command]
pub async fn git_diff_files(root: String, spec: Vec<String>) -> Result<Vec<ChangedFile>, String> {
    off(move || {
        let spec: Vec<&str> = spec.iter().map(String::as_str).collect();
        diff_files(&root, &spec)
    })
    .await
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    hash: String,
    parents: Vec<String>,
    author: String,
    email: String,
    time: i64,
    committer: String,
    commit_time: i64,
    body: String,
    files: Vec<ChangedFile>,
}

/// A commit (or stash) with the files it changed against its first parent; a stash also lists its untracked files.
#[tauri::command]
pub async fn git_commit_details(root: String, rev: String) -> Result<CommitDetails, String> {
    off(move || {
        check_rev(&rev)?;
        let mut args = vec!["show", "-s", "--no-color", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B"];
        args.extend(NO_EXT);
        args.extend([rev.as_str(), "--"]);
        let out = git(&root, &args)?;
        let f: Vec<&str> = out.splitn(8, '\x1f').collect();
        if f.len() < 8 {
            return Err(format!("cannot read {rev}"));
        }
        let hash = f[0].to_string();
        let parents: Vec<String> = f[1].split_whitespace().map(String::from).collect();
        let old = match parents.first() {
            Some(p) => p.clone(),
            None => git_in(&root, &["hash-object", "-t", "tree", "--stdin"], Some(""))?.trim().to_string(),
        };
        let mut files = diff_files(&root, &[&old, &hash])?;
        for file in files.iter_mut() {
            file.old_rev = old.clone();
            file.new_rev = hash.clone();
        }
        if rev.starts_with("stash@") && parents.len() == 3 {
            let empty = git_in(&root, &["hash-object", "-t", "tree", "--stdin"], Some(""))?.trim().to_string();
            for mut file in diff_files(&root, &[&empty, &parents[2]])? {
                file.status = "?".into();
                file.old_rev = empty.clone();
                file.new_rev = parents[2].clone();
                files.push(file);
            }
        }
        Ok(CommitDetails {
            hash,
            parents,
            author: f[2].into(),
            email: f[3].into(),
            time: f[4].parse().unwrap_or(0),
            committer: f[5].into(),
            commit_time: f[6].parse().unwrap_or(0),
            body: f[7].trim_end().into(),
            files,
        })
    })
    .await
}

/// The clean/smudge filter configured for `rel` in .gitattributes, if any (git-crypt, git-lfs, ...).
fn filter_of(root: &str, rel: &str) -> Result<Option<String>, String> {
    let out = git(root, &["check-attr", "filter", "--", rel])?;
    let value = out.trim().rsplit(": ").next().unwrap_or("").to_string();
    Ok((!matches!(value.as_str(), "" | "unspecified" | "unset")).then_some(value))
}

/// Applies a zero-context patch of selected hunks to the index (hunk staging/unstaging). Files with a clean
/// filter are refused so their content never reaches the index unfiltered.
#[tauri::command]
pub async fn git_stage_patch(root: String, path: String, patch: String) -> Result<(), String> {
    off(move || {
        let rel = rel(&root, &path);
        if let Some(name) = filter_of(&root, &rel)? {
            return Err(format!("This file uses the '{name}' filter; stage the whole file instead"));
        }
        git_in(&root, &["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "-"], Some(&patch)).map(|_| ())
    })
    .await
}

#[derive(Serialize)]
pub struct OpState {
    op: &'static str,
    conflicts: Vec<String>,
}

/// The merge/rebase/cherry-pick/revert in progress (op is "" when none) and the conflicted paths.
#[tauri::command]
pub async fn git_op_state(root: String) -> Result<OpState, String> {
    off(move || {
        let names = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
        let mut args = vec!["rev-parse"];
        for n in &names {
            args.extend(["--git-path", n]);
        }
        let paths = git(&root, &args)?;
        let exists: Vec<bool> = paths.lines().map(|p| Path::new(&root).join(p).exists()).collect();
        let at = |i: usize| exists.get(i).copied().unwrap_or(false);
        let op = if at(0) || at(1) {
            "rebase"
        } else if at(2) {
            "merge"
        } else if at(3) {
            "cherry-pick"
        } else if at(4) {
            "revert"
        } else {
            ""
        };
        let conflicts = git(&root, &["diff", "--name-only", "--diff-filter=U", "-z", "--no-ext-diff"])?
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        Ok(OpState { op, conflicts })
    })
    .await
}

#[derive(Serialize)]
pub struct MergeInput {
    /// A stage or the working path is a symlink: only whole-side resolution is safe.
    symlink: bool,
    /// A stage is not UTF-8 (Latin-1, binary): only whole-side resolution keeps its bytes intact.
    #[serde(rename = "nonUtf8")]
    non_utf8: bool,
    base: Option<String>,
    ours: Option<String>,
    theirs: Option<String>,
    /// Fresh diff3-style merge of the three stages (independent of the working file and merge.conflictStyle).
    merged: String,
}

#[tauri::command]
pub async fn git_merge_input(root: String, path: String) -> Result<MergeInput, String> {
    off(move || {
        let rel = rel(&root, &path);
        let stage = |n: u8| -> Result<Option<Vec<u8>>, String> {
            let spec = format!(":{n}:{rel}");
            let out = run_git(&root, &["show", "--no-ext-diff", "--no-textconv", &spec], None)?;
            Ok(out.status.success().then_some(out.stdout))
        };
        let symlink = git(&root, &["ls-files", "-u", "-s", "--", &rel])?.lines().any(|l| l.starts_with("120000"))
            || std::fs::symlink_metadata(Path::new(&root).join(&rel)).is_ok_and(|m| m.file_type().is_symlink());
        let stages = [stage(1)?, stage(2)?, stage(3)?];
        let non_utf8 = stages.iter().flatten().any(|b| std::str::from_utf8(b).is_err());
        let [base, ours, theirs] = stages.map(|b| b.map(|b| String::from_utf8_lossy(&b).into_owned()));
        let merged = match (&ours, &theirs) {
            _ if symlink || non_utf8 => String::new(),
            (Some(o), Some(t)) => {
                let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
                let dir = std::env::temp_dir().join(format!("garnet-merge-{}-{nanos}", std::process::id()));
                std::fs::create_dir_all(&dir).map_err(e2s)?;
                let file = |name: &str, text: &str| -> Result<String, String> {
                    let p = dir.join(name);
                    std::fs::write(&p, text).map_err(e2s)?;
                    Ok(p.to_string_lossy().into_owned())
                };
                let result = (|| {
                    let (fo, fb, ft) = (file("ours", o)?, file("base", base.as_deref().unwrap_or(""))?, file("theirs", t)?);
                    let out = run_git(&root, &["merge-file", "-p", "--diff3", "-L", "Yours", "-L", "Base", "-L", "Theirs", &fo, &fb, &ft], None)?;
                    match out.status.code() {
                        Some(c) if (0..128).contains(&c) => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
                        _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
                    }
                })();
                let _ = std::fs::remove_dir_all(&dir);
                result?
            }
            _ => String::new(),
        };
        Ok(MergeInput { symlink, non_utf8, base, ours, theirs, merged })
    })
    .await
}

#[derive(Serialize)]
pub struct Blame {
    hash: String,
    author: String,
    time: i64,
    summary: String,
}

#[tauri::command]
pub async fn git_blame_line(root: String, path: String, line: u32) -> Result<Blame, String> {
    off(move || {
        let range = format!("{line},{line}");
        let out = git(&root, &["blame", "--porcelain", "--no-textconv", "-L", &range, "--", &rel(&root, &path)])?;
        let field = |key: &str| {
            out.lines()
                .find_map(|l| l.strip_prefix(key))
                .unwrap_or_default()
                .to_string()
        };
        Ok(Blame {
            hash: out.split_whitespace().next().unwrap_or_default().chars().take(8).collect(),
            author: field("author "),
            time: field("author-time ").parse().unwrap_or(0),
            summary: field("summary "),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GIT and TRUSTED are process-wide; tests that touch them take this lock.
    static GLOBALS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn git_path_must_be_absolute_executable() {
        let _g = GLOBALS.lock().unwrap();
        assert!(git_set_path("git".into()).is_ok());
        assert!(git_set_path("./git".into()).is_err());
        assert!(git_set_path("bin/git".into()).is_err());
        assert!(git_set_path("/etc/hosts".into()).is_err());
        assert!(git_set_path("/bin/sh".into()).is_ok());
        assert!(git_set_path(String::new()).is_ok());
    }

    fn commit(hash: &str, parents: &[&str]) -> LogCommit {
        LogCommit { hash: hash.into(), parents: parents.iter().map(|p| p.to_string()).collect(), author: String::new(), email: String::new(), time: 0, refs: String::new(), subject: String::new(), col: 0, edges: vec![] }
    }

    #[test]
    fn lays_out_branch_and_merge() {
        // m merges b into a; a and b both come from r.
        let mut c = vec![commit("m", &["a", "b"]), commit("a", &["r"]), commit("b", &["r"]), commit("r", &[])];
        layout(&mut c);
        let cols: Vec<usize> = c.iter().map(|x| x.col).collect();
        assert_eq!(cols, vec![0, 0, 1, 0]);
        assert_eq!(c[0].edges, vec![Edge { from: 0, to: 0, kind: 2 }, Edge { from: 0, to: 1, kind: 2 }]);
        assert_eq!(c[1].edges, vec![Edge { from: 0, to: 0, kind: 1 }, Edge { from: 1, to: 1, kind: 0 }, Edge { from: 0, to: 0, kind: 2 }]);
        assert_eq!(c[2].edges, vec![Edge { from: 0, to: 0, kind: 0 }, Edge { from: 1, to: 1, kind: 1 }, Edge { from: 1, to: 0, kind: 2 }]);
        assert_eq!(c[3].edges, vec![Edge { from: 0, to: 0, kind: 1 }]);
    }

    #[test]
    fn parses_log_records() {
        let out = "h1\x1fp1 p2\x1fAnn\x1fa@x\x1f100\x1fHEAD -> main\x1fMerge it\x1e\nh2\x1f\x1fBob\x1fb@x\x1f50\x1f\x1fInit\x1e\n";
        let c = parse_log(out);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].parents, vec!["p1", "p2"]);
        assert_eq!((c[1].subject.as_str(), c[1].time), ("Init", 50));
    }

    #[test]
    fn parses_name_status_and_numstat() {
        let mut f = parse_name_status("M\0a.rb\0R100\0old.rb\0new.rb\0A\0bin.png\0");
        apply_numstat(&mut f, "3\t1\ta.rb\x000\t0\t\0old.rb\0new.rb\0-\t-\tbin.png\0");
        assert_eq!(f.len(), 3);
        assert_eq!((f[0].added, f[0].deleted), (Some(3), Some(1)));
        assert_eq!((f[1].path.as_str(), f[1].old_path.as_deref(), f[1].status.as_str(), f[1].added), ("new.rb", Some("old.rb"), "R", Some(0)));
        assert_eq!(f[2].added, None);
    }

    #[test]
    fn rejects_option_like_revisions() {
        assert!(check_rev("--output=/tmp/x").is_err());
        assert!(check_rev("stash@{0}").is_ok());
        assert!(check_rev(":2").is_ok());
    }

    #[test]
    fn git_is_gated_on_trust_and_ignores_repo_fsmonitor() {
        let _g = GLOBALS.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("garnet-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        let sh = |c: &str| assert!(Command::new("/bin/sh").args(["-c", c]).current_dir(&dir).status().unwrap().success());
        sh("git init -q && git config user.email t@example.com && git config user.name t && echo a > a.rb && git add a.rb && git commit -qm init");
        let pwned = dir.join("pwned");
        std::fs::write(dir.join("hook.sh"), format!("#!/bin/sh\ntouch {}\n", pwned.display())).unwrap();
        sh("chmod +x hook.sh && git config core.fsmonitor \"$PWD/hook.sh\" && echo b >> a.rb");

        TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(git(root, &["status"]).unwrap_err(), "Trust project to enable Git");
        TRUSTED.store(true, std::sync::atomic::Ordering::SeqCst);
        let status = git(root, &["status", "--porcelain=v1", "-z"]).unwrap();
        let entries = parse_status(&status);
        assert!(entries.iter().any(|e| e.path == "a.rb" && e.worktree == 'M'));
        assert!(!pwned.exists(), "core.fsmonitor from .git/config must not run");
        assert!(git(root, &["show", "no-such-revision"]).unwrap_err().contains("no-such-revision"));
        TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(f)
    }

    #[test]
    fn real_repo_log_details_stage_stash_and_conflict() {
        let _g = GLOBALS.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("garnet-git-ops-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap().to_string();
        let sh = |c: &str| assert!(Command::new("/bin/sh").args(["-c", c]).current_dir(&dir).status().unwrap().success(), "{c}");
        sh("git init -q -b main && git config user.email t@example.com && git config user.name t \
            && printf 'a\\nb\\nc\\n' > f.rb && git add f.rb && git commit -qm init \
            && git checkout -qb feature && printf 'a\\nTHEIRS\\nc\\n' > f.rb && git commit -qam theirs \
            && git checkout -q main && printf 'a\\nOURS\\nc\\n' > f.rb && git commit -qam ours");
        TRUSTED.store(true, std::sync::atomic::Ordering::SeqCst);

        let log = block(git_log(root.clone(), LogOpts { limit: 10, ..Default::default() })).unwrap();
        assert_eq!(log.len(), 3);
        assert_eq!(log.iter().filter(|c| c.subject == "init").count(), 1);
        let d = block(git_commit_details(root.clone(), "HEAD".into())).unwrap();
        assert_eq!((d.files.len(), d.files[0].path.as_str(), d.files[0].added, d.files[0].deleted), (1, "f.rb", Some(1), Some(1)));
        let first = block(git_commit_details(root.clone(), log.last().unwrap().hash.clone())).unwrap();
        assert_eq!(first.files[0].status, "A");
        let hist = block(git_log(root.clone(), LogOpts { limit: 10, path: format!("{root}/f.rb"), branch: "main".into(), ..Default::default() })).unwrap();
        assert_eq!(hist.len(), 2);
        assert!(block(git_log(root.clone(), LogOpts { limit: 10, branch: "--output=x".into(), ..Default::default() })).is_err());

        // Hunk staging applies a zero-context patch to the index only.
        let patch = "diff --git a/f.rb b/f.rb\n--- a/f.rb\n+++ b/f.rb\n@@ -2 +2 @@\n-OURS\n+STAGED\n@@ -3,0 +4 @@\n+d\n";
        block(git_stage_patch(root.clone(), format!("{root}/f.rb"), patch.into())).unwrap();
        assert_eq!(block(git_file_at(root.clone(), String::new(), "f.rb".into())).unwrap().as_deref(), Some("a\nSTAGED\nc\nd\n"));
        assert_eq!(std::fs::read_to_string(dir.join("f.rb")).unwrap(), "a\nOURS\nc\n");
        sh("git reset -q");
        // Filtered files (git-crypt, LFS) are never hunk-staged.
        sh("echo 'secret.env filter=crypt' > .gitattributes && echo x > secret.env");
        let err = block(git_stage_patch(root.clone(), format!("{root}/secret.env"), "diff --git a/secret.env b/secret.env\n".into())).unwrap_err();
        assert_eq!(err, "This file uses the 'crypt' filter; stage the whole file instead");
        sh("rm .gitattributes secret.env");

        // Stash with an untracked file lists it in the stash's details.
        sh("echo x >> f.rb && echo new > u.rb && git stash push -q --include-untracked -m wip");
        let st = block(git_commit_details(root.clone(), "stash@{0}".into())).unwrap();
        assert!(st.files.iter().any(|f| f.path == "f.rb" && f.status == "M"));
        assert!(st.files.iter().any(|f| f.path == "u.rb" && f.status == "?"));
        sh("git stash drop -q");

        // A real merge conflict: op state, the three stages and a diff3 merge for the resolver.
        assert!(git(&root, &["merge", "feature"]).is_err());
        let op = block(git_op_state(root.clone())).unwrap();
        assert_eq!((op.op, op.conflicts.clone()), ("merge", vec!["f.rb".to_string()]));
        let m = block(git_merge_input(root.clone(), format!("{root}/f.rb"))).unwrap();
        assert!(!m.symlink);
        assert_eq!((m.base.as_deref(), m.ours.as_deref(), m.theirs.as_deref()), (Some("a\nb\nc\n"), Some("a\nOURS\nc\n"), Some("a\nTHEIRS\nc\n")));
        assert!(m.merged.contains("<<<<<<< Yours\nOURS\n||||||| Base\nb\n=======\nTHEIRS\n>>>>>>> Theirs\n"), "{}", m.merged);
        std::fs::write(dir.join("f.rb"), "a\nOURS\nTHEIRS\nc\n").unwrap();
        git(&root, &["add", "--", "f.rb"]).unwrap();
        assert!(block(git_op_state(root.clone())).unwrap().conflicts.is_empty());
        git(&root, &["commit", "--no-edit"]).unwrap();
        assert_eq!(block(git_op_state(root.clone())).unwrap().op, "");
        let merged = block(git_log(root.clone(), LogOpts { limit: 10, ..Default::default() })).unwrap();
        assert_eq!(merged[0].parents.len(), 2);
        assert_eq!(merged[0].edges.iter().filter(|e| e.kind == 2).count(), 2);

        TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parses_porcelain_z_with_renames() {
        let out = " M app/a.rb\0R  new.rb\0old.rb\0?? b.rb\0";
        let e = parse_status(out);
        assert_eq!(e.len(), 3);
        assert_eq!((e[1].path.as_str(), e[1].index), ("new.rb", 'R'));
        assert_eq!((e[2].path.as_str(), e[2].worktree), ("b.rb", '?'));
    }

    fn repo(name: &str) -> (std::path::PathBuf, String, impl Fn(&str)) {
        let dir = std::env::temp_dir().join(format!("garnet-git-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap().to_string();
        let d = dir.clone();
        let sh = move |c: &str| assert!(Command::new("/bin/sh").args(["-c", c]).current_dir(&d).status().unwrap().success(), "{c}");
        sh("git init -q -b main && git config user.email t@example.com && git config user.name t && git config commit.gpgsign false");
        (dir, root, sh)
    }

    #[test]
    fn rollback_handles_modified_added_deleted_renamed_and_untracked() {
        let _g = GLOBALS.lock().unwrap();
        let (dir, root, sh) = repo("rollback");
        sh("printf 'one\n' > m.rb && printf 'gone\n' > d.rb && printf 'old\n' > old.rb && printf 'staged\n' > s.rb && git add . && git commit -qm init \
            && printf 'changed\n' > m.rb && printf 'changed\n' > s.rb && git add s.rb && printf 'again\n' >> s.rb && rm d.rb \
            && git mv old.rb new.rb && printf 'add\n' > a.rb && git add a.rb && printf 'u\n' > u.rb && printf 'keep\n' > keep.rb && mkdir -p lib && printf 'x\n' > 'lib/[g].rb'");
        TRUSTED.store(true, std::sync::atomic::Ordering::SeqCst);
        let all = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        block(git_rollback(root.clone(), all(&["m.rb", "s.rb", "d.rb", "new.rb", "a.rb", "u.rb", "lib"]), false)).unwrap();
        let read = |p: &str| std::fs::read_to_string(dir.join(p)).ok();
        assert_eq!(read("m.rb").as_deref(), Some("one\n"));
        assert_eq!(read("s.rb").as_deref(), Some("staged\n"), "staged and unstaged edits both go");
        assert_eq!(read("d.rb").as_deref(), Some("gone\n"));
        assert_eq!((read("old.rb").as_deref(), read("new.rb")), (Some("old\n"), None), "rename moves back");
        assert_eq!(read("a.rb").as_deref(), Some("add\n"), "added file kept without the checkbox");
        assert_eq!(read("u.rb").as_deref(), Some("u\n"));
        let left: Vec<(String, char, char)> = status(&root).unwrap().into_iter().map(|e| (e.path, e.index, e.worktree)).collect();
        assert_eq!(left, vec![("a.rb".into(), '?', '?'), ("keep.rb".into(), '?', '?'), ("lib/[g].rb".into(), '?', '?'), ("u.rb".into(), '?', '?')]);

        sh("git add a.rb");
        block(git_rollback(root.clone(), all(&["a.rb", "u.rb", "lib"]), true)).unwrap();
        assert_eq!((read("a.rb"), read("u.rb"), read("lib/[g].rb")), (None, None, None), "delete local copies of added files");
        assert_eq!(read("keep.rb").as_deref(), Some("keep\n"), "unselected files are untouched");
        TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unstage_rename_resets_both_sides_and_unborn_head_uses_rm_cached() {
        let _g = GLOBALS.lock().unwrap();
        let (dir, root, sh) = repo("unstage");
        TRUSTED.store(true, std::sync::atomic::Ordering::SeqCst);
        sh("printf 'a\n' > first.rb && git add first.rb");
        block(git_unstage(root.clone(), vec!["first.rb".into()])).unwrap();
        assert_eq!(status(&root).unwrap()[0].index, '?', "unborn HEAD unstages with rm --cached");
        sh("git add first.rb && git commit -qm init && git mv first.rb second.rb");
        let st = status(&root).unwrap();
        assert_eq!((st[0].path.as_str(), st[0].orig.as_deref(), st[0].index), ("second.rb", Some("first.rb"), 'R'));
        block(git_unstage(root.clone(), vec!["second.rb".into(), "first.rb".into()])).unwrap();
        let left: Vec<(String, char, char)> = status(&root).unwrap().into_iter().map(|e| (e.path, e.index, e.worktree)).collect();
        assert_eq!(left, vec![("first.rb".into(), ' ', 'D'), ("second.rb".into(), '?', '?')], "no staged deletion left behind");
        assert!(block(git_unstage(root.clone(), vec!["nope.rb".into()])).is_ok());
        TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn commit_amends_with_an_empty_index() {
        let _g = GLOBALS.lock().unwrap();
        let (dir, root, sh) = repo("amend");
        TRUSTED.store(true, std::sync::atomic::Ordering::SeqCst);
        sh("printf 'a\n' > a.rb && git add a.rb");
        block(git_commit(root.clone(), "first".into(), None)).unwrap();
        block(git_commit(root.clone(), "first, reworded".into(), Some(true))).unwrap();
        assert_eq!(git(&root, &["log", "--format=%s"]).unwrap(), "first, reworded\n");
        assert!(block(git_commit(root.clone(), "nothing".into(), Some(false))).is_err());
        TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn git_run_allows_ui_subcommands_and_rejects_code_execution() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        for ok in [&["status"][..], &["stash", "push", "-m", "x", "--", "-x", "--exec=y"], &["remote", "get-url", "origin"], &["rebase", "--continue"], &["log", "-1", "--format=%B"], &["branch", "-D", "x"], &["checkout", "-b", "x", "--track", "origin/x"]] {
            assert!(check_run_args(&s(ok)).is_ok(), "{ok:?}");
        }
        for bad in [
            &["-c", "core.pager=sh", "log"][..], &["config", "core.sshCommand", "x"], &["clone", "x"], &[], &["fetch", "--upload-pack=touch x", "."],
            &["fetch", "--upload-pa=x", "."], &["pull", "--upload-pack", "x"], &["push", "--receive-pack=x"], &["push", "--exec", "x"], &["rebase", "-x", "make"],
            &["rebase", "-ix", "make"], &["rebase", "--exec=make"], &["log", "--output=/tmp/x"], &["remote", "add", "x", "ext::sh"], &["commit", "-C", "HEAD"],
            &["status", "--git-dir=/x"], &["clone", "--config", "x"],
        ] {
            assert!(check_run_args(&s(bad)).is_err(), "{bad:?}");
        }
        let _g = GLOBALS.lock().unwrap();
        let (dir, root, _sh) = repo("run");
        TRUSTED.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(block(git_run(root.clone(), s(&["fetch", "--upload-pack=touch pwned", "."]))).is_err());
        assert!(!dir.join("pwned").exists());
        TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn merge_input_flags_non_utf8_stages() {
        let _g = GLOBALS.lock().unwrap();
        let (dir, root, sh) = repo("latin1");
        sh("printf 'caf\\351\\n' > l.txt && git add l.txt && git commit -qm init && git checkout -qb other && printf 'caf\\351 au lait\\n' > l.txt \
            && git commit -qam other && git checkout -q main && printf 'caf\\351 noir\\n' > l.txt && git commit -qam main");
        TRUSTED.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(git(&root, &["merge", "other"]).is_err());
        let m = block(git_merge_input(root.clone(), format!("{root}/l.txt"))).unwrap();
        assert!(m.non_utf8);
        assert_eq!(m.merged, "", "no lossy text merge offered");
        TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn slow_git_does_not_block_the_async_runtime() {
        let _g = GLOBALS.lock().unwrap();
        let (dir, root, sh) = repo("slow");
        sh("printf '#!/bin/sh\nsleep 1\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && printf 'a\n' > a.rb && git add a.rb");
        TRUSTED.store(true, std::sync::atomic::Ordering::SeqCst);
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        let start = std::time::Instant::now();
        let (commit, ticked) = rt.block_on(async {
            tokio::join!(git_commit(root.clone(), "slow".into(), None), async {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                start.elapsed()
            })
        });
        commit.unwrap();
        assert!(ticked < std::time::Duration::from_millis(500), "timer waited {ticked:?} for git");
        TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        std::fs::remove_dir_all(&dir).unwrap();
    }

}
