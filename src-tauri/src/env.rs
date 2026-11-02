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
/// shims resolve the same way they do in Terminal. Captured once per project root.
pub fn shell_env(cwd: &Path) -> HashMap<String, String> {
    let mut cache = CACHE.lock().unwrap();
    if let Some((root, env)) = cache.as_ref() {
        if root == cwd {
            return env.clone();
        }
    }
    let mut env = capture(cwd).unwrap_or_else(|| std::env::vars().collect());
    env.entry("LANG".into()).or_insert_with(|| "en_US.UTF-8".into());
    *cache = Some((cwd.to_path_buf(), env.clone()));
    env
}

fn capture(cwd: &Path) -> Option<HashMap<String, String>> {
    const MARK: &str = "__GARNET_ENV__";
    let mut child = Command::new(user_shell())
        .args(["-ilc", &format!("printf '{MARK}'; env -0")])
        .current_dir(cwd)
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
