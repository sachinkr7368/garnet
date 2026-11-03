use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

static CACHE: Mutex<Option<(PathBuf, HashMap<String, String>)>> = Mutex::new(None);

pub fn user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

/// Environment of the user's interactive login shell in `cwd`, so rbenv/asdf/mise/chruby
/// shims resolve the same way they do in Terminal. Captured once per project root, and only for a trusted project
/// (the login shell runs the project's .envrc and version manager hooks); until then Garnet's own environment.
pub fn shell_env(cwd: &Path) -> HashMap<String, String> {
    let trusted = crate::git::trusted();
    let mut cache = CACHE.lock().unwrap();
    if let Some((root, env)) = cache.as_ref().filter(|_| trusted) {
        if root == cwd {
            return env.clone();
        }
    }
    let mut env = trusted.then(|| capture(cwd)).flatten().unwrap_or_else(|| std::env::vars().filter(|(k, _)| !is_parent_shell_state(k)).collect());
    env.entry("LANG".into()).or_insert_with(|| "en_US.UTF-8".into());
    if trusted {
        *cache = Some((cwd.to_path_buf(), env.clone()));
    }
    env
}

/// Session state the launching shell exported (mise's `__MISE_*` record of its own PATH changes). A login shell that
/// inherits it believes mise already ran and leaves the system Ruby first on PATH.
fn is_parent_shell_state(key: &str) -> bool {
    key.starts_with("__MISE_")
}

pub fn parent_shell_state() -> Vec<String> {
    std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).filter(|k| is_parent_shell_state(k)).collect()
}

fn login_shell(cwd: &Path, script: &str) -> Command {
    let mut cmd = Command::new(user_shell());
    cmd.args(["-ilc", script]).current_dir(cwd);
    for key in parent_shell_state() {
        cmd.env_remove(key);
    }
    cmd
}

fn capture(cwd: &Path) -> Option<HashMap<String, String>> {
    const MARK: &str = "__GARNET_ENV__";
    let mut child = login_shell(cwd, &format!("printf '{MARK}'; env -0"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let out = rx.recv_timeout(Duration::from_secs(10));
    let _ = child.kill();
    let _ = child.wait();
    let out = String::from_utf8_lossy(&out.ok()?).into_owned();
    let body = &out[out.rfind(MARK)? + MARK.len()..];
    Some(
        body.split('\0')
            .filter_map(|kv| kv.split_once('='))
            .map(|(k, v)| (k.trim_start_matches('\n').to_string(), v.to_string()))
            .collect(),
    )
}

pub fn which(cwd: &Path, program: &str) -> Option<PathBuf> {
    let env = shell_env(cwd);
    let path = env.get("PATH")?;
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(program))
        .find(|p| p.is_file())
}

pub fn command(cwd: &Path, program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.current_dir(cwd).env_clear().envs(shell_env(cwd));
    cmd
}

pub fn tokio_command(cwd: &Path, program: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.current_dir(cwd).env_clear().envs(shell_env(cwd)).kill_on_drop(true);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_the_login_shell_environment_and_resolves_programs() {
        let dir = std::env::temp_dir().join(format!("garnet-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let env = capture(&dir).expect("login shell environment");
        assert!(env.get("PATH").is_some_and(|p| p.contains("/usr/bin")));
        assert!(env.contains_key("HOME"));
        assert!(env.keys().all(|k| !k.is_empty() && !k.contains('\n')));
        let cached = shell_env(&dir);
        assert_eq!(cached.get("LANG").map(String::is_empty), Some(false));
        assert_eq!(which(&dir, "sh").as_deref(), Some(std::path::Path::new("/bin/sh")));
        assert!(which(&dir, "definitely-not-a-program-xyz").is_none());
        let out = command(&dir, "/bin/sh").args(["-c", "pwd -P"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), std::fs::canonicalize(&dir).unwrap().to_string_lossy());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn login_shell_runs_only_after_trust_and_drops_the_parent_shells_mise_state() {
        let _g = crate::git::GLOBALS.lock().unwrap();
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("garnet-env-trust-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let in_dir = |env: &HashMap<String, String>| env.get("PWD").and_then(|p| std::fs::canonicalize(p).ok()).as_deref() == Some(dir.as_path());
        crate::git::TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(!in_dir(&shell_env(&dir)), "no login shell before trust");
        crate::git::TRUSTED.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(in_dir(&shell_env(&dir)), "trusting refreshes the environment from the login shell");
        crate::git::TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(!in_dir(&shell_env(&dir)), "the trusted capture is not served after trust is revoked");
        std::env::set_var("__MISE_GARNET_TEST", "1");
        let removed: Vec<_> = login_shell(&dir, "true").get_envs().filter(|(_, v)| v.is_none()).map(|(k, _)| k.to_owned()).collect();
        std::env::remove_var("__MISE_GARNET_TEST");
        assert!(removed.iter().any(|k| k == "__MISE_GARNET_TEST"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
