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

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    if !TRUSTED.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Trust project to enable Git".into());
    }
    let bin = GIT.read().unwrap().clone();
    let out = Command::new(if bin.is_empty() { "git" } else { bin.as_str() })
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(e2s)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Serialize)]
pub struct StatusEntry {
    path: String,
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
        if index == 'R' || index == 'C' {
            parts.next();
        }
        entries.push(StatusEntry { path: rec[3..].to_string(), index, worktree });
    }
    entries
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<Vec<StatusEntry>, String> {
    git(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]).map(|o| parse_status(&o))
}

#[tauri::command]
pub async fn git_branch(root: String) -> Result<String, String> {
    git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string())
}

/// File content at `rev` ("HEAD" or "" for the index); empty when the file is new.
#[tauri::command]
pub async fn git_show(root: String, path: String, rev: String) -> Result<String, String> {
    let rel = rel(&root, &path);
    Ok(git(&root, &["show", "--no-textconv", "--no-ext-diff", &format!("{rev}:{rel}")]).unwrap_or_default())
}

fn rel(root: &str, path: &str) -> String {
    Path::new(path)
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

#[derive(Serialize, PartialEq, Debug)]
pub struct Hunk {
    kind: &'static str,
    start: u32,
    end: u32,
}

/// Parses `git diff -U0` hunk headers into added/modified/deleted line ranges (1-based, new file).
fn parse_hunks(diff: &str) -> Vec<Hunk> {
    let range = |s: &str| -> (u32, u32) {
        let mut it = s.splitn(2, ',');
        let start = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let count = it.next().and_then(|v| v.parse().ok()).unwrap_or(1);
        (start, count)
    };
    diff.lines()
        .filter_map(|l| l.strip_prefix("@@ -"))
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let (_, old_count) = range(it.next()?);
            let (new_start, new_count) = range(it.next()?.trim_start_matches('+'));
            Some(match (old_count, new_count) {
                (_, 0) => Hunk { kind: "deleted", start: new_start.max(1), end: new_start.max(1) },
                (0, n) => Hunk { kind: "added", start: new_start, end: new_start + n - 1 },
                (_, n) => Hunk { kind: "modified", start: new_start, end: new_start + n - 1 },
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_diff_hunks(root: String, path: String) -> Result<Vec<Hunk>, String> {
    // ponytail: diffs the saved file against HEAD; unsaved edits show after Cmd+S.
    let rel = rel(&root, &path);
    if git(&root, &["ls-files", "--error-unmatch", &rel]).is_err() {
        return Ok(Vec::new());
    }
    git(&root, &["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD", "--", &rel]).map(|d| parse_hunks(&d))
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(&root, &args).map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["reset", "-q", "HEAD", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(&root, &args).or_else(|_| {
        let mut args = vec!["rm", "--cached", "-q", "--"];
        args.extend(paths.iter().map(String::as_str));
        git(&root, &args)
    }).map(|_| ())
}

/// Runs an arbitrary git subcommand in the project (branch/worktree/stash/push/pull UI).
#[tauri::command]
pub async fn git_run(root: String, args: Vec<String>) -> Result<String, String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    git(&root, &args)
}

#[tauri::command]
pub async fn git_fetch(root: String) -> Result<String, String> {
    git(&root, &["fetch", "--quiet", "--all", "--prune"])
}

#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<String, String> {
    git(&root, &["commit", "-m", &message])
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_path_must_be_absolute_executable() {
        assert!(git_set_path("git".into()).is_ok());
        assert!(git_set_path("./git".into()).is_err());
        assert!(git_set_path("bin/git".into()).is_err());
        assert!(git_set_path("/etc/hosts".into()).is_err());
        assert!(git_set_path("/bin/sh".into()).is_ok());
        assert!(git_set_path(String::new()).is_ok());
    }

    #[test]
    fn parses_hunks() {
        let diff = "@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-x\n+y\n@@ -20,2 +21,0 @@\n-c\n-d\n";
        assert_eq!(
            parse_hunks(diff),
            vec![
                Hunk { kind: "added", start: 4, end: 5 },
                Hunk { kind: "modified", start: 12, end: 12 },
                Hunk { kind: "deleted", start: 21, end: 21 },
            ]
        );
    }

    #[test]
    fn parses_porcelain_z_with_renames() {
        let out = " M app/a.rb\0R  new.rb\0old.rb\0?? b.rb\0";
        let e = parse_status(out);
        assert_eq!(e.len(), 3);
        assert_eq!((e[1].path.as_str(), e[1].index), ("new.rb", 'R'));
        assert_eq!((e[2].path.as_str(), e[2].worktree), ("b.rb", '?'));
    }
}
