use crate::env;
use crate::fsops::e2s;
use crate::rpc::{read_messages, write_message, RpcEvent};
use std::io::{BufRead, BufReader};
use std::path::Path;
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

/// `bundle exec ruby-lsp` when the project's bundle includes it, otherwise a global `ruby-lsp`.
fn resolve(root: &Path) -> Option<Vec<String>> {
    let lock = std::fs::read_to_string(root.join("Gemfile.lock")).unwrap_or_default();
    if lock.lines().any(|l| l.trim_start().starts_with("ruby-lsp ")) {
        return Some(vec!["bundle".into(), "exec".into(), "ruby-lsp".into()]);
    }
    env::which(root, "ruby-lsp").map(|p| vec![p.to_string_lossy().into_owned()])
}

#[tauri::command]
pub async fn lsp_start(state: State<'_, Lsp>, root: String, command: Option<String>, on_event: Channel<RpcEvent>) -> Result<String, String> {
    state.stop();
    let root = Path::new(&root);
    let argv = match command.filter(|c| !c.trim().is_empty()) {
        Some(c) => vec!["/bin/sh".into(), "-c".into(), format!("exec {c}")],
        None => resolve(root).ok_or("ruby-lsp-missing")?,
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
    Ok(argv.join(" "))
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
