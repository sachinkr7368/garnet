use crate::{env, ruby};
use serde::Serialize;
use crate::fsops::e2s;
use crate::rpc::{read_messages, write_message, RpcEvent};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
use tauri::ipc::Channel;
use tauri::State;

struct Server {
    id: u64,
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Lsp(Arc<Mutex<Option<Server>>>);

impl Lsp {
    pub fn stop(&self) {
        if let Some(mut s) = self.0.lock().unwrap().take() {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }
}

#[derive(Serialize)]
pub struct Launch {
    command: String,
    manager: String,
    reason: String,
    /// Runs a command with the project's Ruby, e.g. `mise exec --`; used for `gem install ruby-lsp`.
    prefix: Vec<String>,
}

/// Like the official VS Code extension: the global `ruby-lsp` (never `bundle exec`) run with the project's Ruby,
/// so a broken project bundle cannot stop the server; ruby-lsp composes its own bundle in `.ruby-lsp/`.
/// `--use-launcher` keeps the server up (without the project's gems) when that bundle cannot be set up.
fn resolve(root: &Path, manager: &str, launcher: bool) -> Result<(Vec<String>, ruby::Detection, Vec<String>), String> {
    let shell = env::shell_env(root);
    let mut path: Vec<PathBuf> = shell.get("PATH").map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    path.extend(ruby::EXTRA_PATH.iter().map(PathBuf::from));
    let home = PathBuf::from(shell.get("HOME").cloned().unwrap_or_default());
    let mut d = ruby::detect(root, &path, &home, manager);
    if d.manager != "none" && d.tool.is_empty() {
        d.manager = "none".into();
    }
    let prefix = ruby::exec_prefix(&d, root);
    let mut argv = prefix.clone();
    if prefix.is_empty() {
        let found = env::which(root, "ruby-lsp").ok_or("ruby-lsp-missing")?;
        argv.push(found.to_string_lossy().into_owned());
    } else {
        argv.push("ruby-lsp".into());
    }
    if launcher {
        argv.push("--use-launcher".into());
    }
    Ok((argv, d, prefix))
}

#[tauri::command]
pub async fn lsp_start(
    state: State<'_, Lsp>,
    root: String,
    command: Option<String>,
    manager: Option<String>,
    launcher: Option<bool>,
    on_event: Channel<RpcEvent>,
) -> Result<Launch, String> {
    state.stop();
    let root = Path::new(&root);
    let (argv, detection, prefix) = match command.filter(|c| !c.trim().is_empty()) {
        Some(c) => (
            vec!["/bin/sh".into(), "-c".into(), format!("exec {c}")],
            ruby::Detection { manager: "custom".into(), tool: String::new(), reason: "ruby.lspCommand setting".into() },
            vec![],
        ),
        None => resolve(root, manager.as_deref().unwrap_or("auto"), launcher.unwrap_or(true))?,
    };
    let mut child = env::command(root, &argv[0])
        .args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(e2s)?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let errors = on_event.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = errors.send(RpcEvent::Stderr { line });
        }
    });
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    *state.0.lock().unwrap() = Some(Server { id, child, stdin });
    let slot = state.0.clone();
    std::thread::spawn(move || {
        read_messages(BufReader::new(stdout), |body| {
            let _ = on_event.send(RpcEvent::Message { body });
        });
        let mine = {
            let mut guard = slot.lock().unwrap();
            if guard.as_ref().is_some_and(|s| s.id == id) { guard.take() } else { None }
        };
        let code = mine.and_then(|mut s| s.child.wait().ok()).and_then(|s| s.code());
        let _ = on_event.send(RpcEvent::Exit { code });
    });
    Ok(Launch { command: argv.join(" "), manager: detection.manager, reason: detection.reason, prefix })
}

#[tauri::command]
pub fn lsp_send(state: State<'_, Lsp>, body: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let server = guard.as_mut().ok_or("ruby-lsp is not running")?;
    write_message(&mut server.stdin, &body).map_err(e2s)
}

#[tauri::command]
pub fn lsp_stop(state: State<'_, Lsp>) {
    state.stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launches_global_ruby_lsp_with_the_launcher_never_bundle_exec() {
        let dir = std::env::temp_dir().join(format!("garnet-lsp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Gemfile.lock"), "GEM\n  specs:\n    ruby-lsp (0.26.0)\n").unwrap();
        match resolve(&dir, "auto", true) {
            Ok((argv, d, prefix)) => {
                assert!(!argv.iter().any(|a| a == "bundle"), "{argv:?}");
                assert_eq!(argv.last().map(String::as_str), Some("--use-launcher"));
                assert!(argv[argv.len() - 2].ends_with("ruby-lsp"));
                assert_eq!(argv[..prefix.len()], prefix[..]);
                assert!(!d.reason.is_empty());
            }
            Err(e) => assert_eq!(e, "ruby-lsp-missing"),
        }
        if let Ok((argv, d, prefix)) = resolve(&dir, "none", false) {
            assert_eq!((argv.len(), d.manager.as_str(), prefix.len()), (1, "none", 0));
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
