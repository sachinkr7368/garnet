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
/// (version managers in the login shell read the project's version files, and mise can run its config); until then
/// Garnet's own environment.
pub fn shell_env(cwd: &Path) -> HashMap<String, String> {
    let trusted = crate::git::trusted();
    let mut cache = CACHE.lock().unwrap();
    if let Some((root, env)) = cache.as_ref().filter(|_| trusted) {
        if root == cwd {
            return env.clone();
        }
    }
    let mut env = trusted.then(|| capture(cwd)).flatten().unwrap_or_else(|| inherited(std::env::vars()).into_iter().collect());
    env.entry("LANG".into()).or_insert_with(|| "en_US.UTF-8".into());
    if trusted {
        *cache = Some((cwd.to_path_buf(), env.clone()));
    }
    env
}

/// Drops when trust is revoked or another project opens, so a trusted capture is never served afterwards.
pub fn clear_cache() {
    *CACHE.lock().unwrap() = None;
}

/// Ruby and version-manager state of the shell that launched Garnet: mise's `__MISE_*` record of its PATH changes
/// (a login shell that inherits it skips mise and leaves the system Ruby first), direnv's record of the directory it
/// loaded, and another project's Bundler/Ruby selection.
fn is_parent_shell_state(key: &str) -> bool {
    key.starts_with("__MISE_")
        || matches!(
            key,
            "DIRENV_DIFF" | "DIRENV_DIR" | "DIRENV_FILE" | "DIRENV_WATCHES" | "BUNDLE_GEMFILE" | "BUNDLE_BIN_PATH" | "RUBYOPT" | "RBENV_VERSION" | "ASDF_RUBY_VERSION" | "RUBY_AUTO_VERSION"
        )
}

/// The environment a login shell or terminal inherits from Garnet: Garnet's own, minus the launching shell's state.
pub fn inherited(parent: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    parent.into_iter().filter(|(k, _)| !is_parent_shell_state(k)).collect()
}

fn login_shell(cwd: &Path, script: &str, parent: impl IntoIterator<Item = (String, String)>) -> Command {
    let mut cmd = Command::new(user_shell());
    cmd.args(["-ilc", script]).current_dir(cwd).env_clear().envs(inherited(parent));
    cmd
}

fn capture(cwd: &Path) -> Option<HashMap<String, String>> {
    const MARK: &str = "__GARNET_ENV__";
    let mut child = login_shell(cwd, &format!("printf '{MARK}'; env -0"), std::env::vars())
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
        let parent = ["PATH", "HOME", "__MISE_DIFF", "__MISE_ORIG_PATH", "DIRENV_DIFF", "DIRENV_DIR", "BUNDLE_GEMFILE", "RUBYOPT", "RBENV_VERSION", "ASDF_RUBY_VERSION", "RUBY_AUTO_VERSION", "MISE_SHELL"]
            .map(|k| (k.to_string(), "x".to_string()));
        let mut passed: Vec<String> = login_shell(&dir, "true", parent).get_envs().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        passed.sort();
        assert_eq!(passed, ["HOME", "MISE_SHELL", "PATH"]);
        crate::git::TRUSTED.store(true, std::sync::atomic::Ordering::SeqCst);
        shell_env(&dir);
        clear_cache();
        assert!(CACHE.lock().unwrap().is_none());
        crate::git::TRUSTED.store(false, std::sync::atomic::Ordering::SeqCst);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
