use crate::env::user_shell;
use crate::fsops::e2s;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

impl Ptys {
    fn kill(&self, id: u32) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(&id) {
            if let Some(pid) = s.child.process_id() {
                // The shell is a session leader, so its pid is the process group id.
                unsafe { libc::killpg(pid as i32, libc::SIGHUP) };
            }
            let _ = s.child.kill();
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<u32> = self.sessions.lock().unwrap().keys().copied().collect();
        ids.into_iter().for_each(|id| self.kill(id));
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

/// Length of the longest prefix that does not end inside a multi-byte UTF-8 sequence.
fn complete_utf8_len(buf: &[u8]) -> usize {
    match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => buf.len(),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, Ptys>,
    cwd: String,
    command: Option<String>,
    env: Option<HashMap<String, String>>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(e2s)?;
    let mut cmd = CommandBuilder::new(shell.filter(|s| !s.is_empty()).unwrap_or_else(user_shell));
    match &command {
        Some(c) => cmd.args(["-ilc", c]),
        None => cmd.arg("-l"),
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Garnet");
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }
    let child = pair.slave.spawn_command(cmd).map_err(e2s)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(e2s)?;
    let writer = pair.master.take_writer().map_err(e2s)?;
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    state
        .sessions
        .lock()
        .unwrap()
        .insert(id, Session { master: pair.master, writer, child });

    std::thread::spawn(move || {
        let mut buf = [0u8; 32 * 1024];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let len = complete_utf8_len(&pending);
                    if len > 0 {
                        let data = String::from_utf8_lossy(&pending[..len]).into_owned();
                        pending.drain(..len);
                        let _ = on_event.send(PtyEvent::Data { data });
                    }
                }
            }
        }
        let session = app.state::<Ptys>().sessions.lock().unwrap().remove(&id);
        let code = session.and_then(|mut s| s.child.wait().ok()).map(|s| s.exit_code());
        let _ = on_event.send(PtyEvent::Exit { code });
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, Ptys>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("terminal closed")?;
    s.writer.write_all(data.as_bytes()).map_err(e2s)
}

#[tauri::command]
pub fn pty_resize(state: State<'_, Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("terminal closed")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(e2s)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, Ptys>, id: u32) {
    state.kill(id);
}

#[cfg(test)]
mod tests {
    use super::complete_utf8_len;

    #[test]
    fn holds_back_split_multibyte_sequences() {
        let s = "aé".as_bytes();
        assert_eq!(complete_utf8_len(s), 3);
        assert_eq!(complete_utf8_len(&s[..2]), 1);
        assert_eq!(complete_utf8_len(b"\xff"), 1);
    }
}
