use crate::env::user_shell;
use crate::fsops::e2s;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Input for the session's writer thread: in order, and never blocking the caller.
    input: Sender<Vec<u8>>,
    child: Box<dyn Child + Send + Sync>,
}

/// One thread per terminal writes its input, so a shell that stops reading blocks only that thread; it ends when
/// the session (and with it the sender) is dropped.
fn writer_thread(mut writer: Box<dyn Write + Send>) -> Sender<Vec<u8>> {
    let (tx, rx) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in rx {
            if writer.write_all(&data).is_err() {
                break;
            }
        }
    });
    tx
}

#[derive(Default)]
pub struct Ptys {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

/// SIGHUP to the shell's process group, then SIGKILL if it is still there after a grace period, and always reaped.
fn reap(mut s: Session) {
    let pid = s.child.process_id().map(|p| p as i32);
    if let Some(pid) = pid {
        // The shell is a session leader, so its pid is the process group id.
        unsafe { libc::killpg(pid, libc::SIGHUP) };
    }
    // A deadline, not a count of sleeps: on a loaded machine each 10ms sleep can overrun several times over.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    while std::time::Instant::now() < deadline {
        if matches!(s.child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    match pid {
        Some(pid) => drop(unsafe { libc::killpg(pid, libc::SIGKILL) }),
        // portable-pty's kill() starts with SIGHUP and its own 200ms grace, so only use it without a pid.
        None => drop(s.child.kill()),
    };
    let _ = s.child.wait();
}

impl Ptys {
    fn kill(&self, id: u32) {
        let session = self.sessions.lock().unwrap().remove(&id);
        if let Some(s) = session {
            reap(s);
        }
    }

    /// Queues input for the terminal's writer thread; returns at once, so a backed-up terminal cannot stall the UI.
    fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions.get(&id).ok_or("terminal closed")?;
        s.input.send(data.to_vec()).map_err(|_| "terminal closed".to_string())
    }

    /// Every terminal at once, so quitting waits for one grace period, not one per terminal.
    pub fn kill_all(&self) {
        let sessions: Vec<Session> = self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        let reapers: Vec<_> = sessions.into_iter().map(|s| std::thread::spawn(move || reap(s))).collect();
        reapers.into_iter().for_each(|r| drop(r.join()));
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

/// A login shell (running `command`, or interactive) with Garnet's environment minus the launching shell's Ruby state,
/// terminal variables, and the caller's `env` on top.
fn shell_command(shell: String, command: Option<&str>, cwd: &str, parent: impl IntoIterator<Item = (String, String)>, env: HashMap<String, String>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    match command {
        Some(c) => cmd.args(["-ilc", c]),
        None => cmd.arg("-l"),
    }
    cmd.cwd(cwd);
    cmd.env_clear();
    for (k, v) in crate::env::inherited(parent) {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Garnet");
    if cmd.get_env("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd
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
    if !crate::git::trusted() {
        return Err("Trust project to open a terminal".into());
    }
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(e2s)?;
    let shell = shell.filter(|s| !s.is_empty()).unwrap_or_else(user_shell);
    let cmd = shell_command(shell, command.as_deref(), &cwd, crate::env::parent_env(), env.unwrap_or_default());
    let child = pair.slave.spawn_command(cmd).map_err(e2s)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(e2s)?;
    let writer = pair.master.take_writer().map_err(e2s)?;
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    state
        .sessions
        .lock()
        .unwrap()
        .insert(id, Session { master: pair.master, input: writer_thread(writer), child });

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

/// Never blocks (the main thread runs it): input is queued, in order, for the terminal's writer thread.
#[tauri::command]
pub fn pty_write(state: State<'_, Ptys>, id: u32, data: String) -> Result<(), String> {
    state.write(id, data.as_bytes())
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
pub async fn pty_kill(app: AppHandle, id: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Ptys>().kill(id)).await.map_err(e2s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_env_drops_the_launching_shells_ruby_state_and_keeps_the_callers() {
        let parent = ["PATH", "HOME", "__MISE_DIFF", "DIRENV_DIR", "BUNDLE_GEMFILE", "RUBYOPT", "RBENV_VERSION"].map(|k| (k.to_string(), "x".to_string()));
        let cmd = shell_command("/bin/zsh".into(), Some("true"), "/tmp", parent, HashMap::from([("FOO".to_string(), "1".to_string())]));
        let mut keys: Vec<&str> = cmd.iter_full_env_as_str().map(|(k, _)| k).collect();
        keys.sort();
        assert_eq!(keys, ["COLORTERM", "FOO", "HOME", "LANG", "PATH", "TERM", "TERM_PROGRAM"]);
        assert_eq!(cmd.get_argv().iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>(), ["/bin/zsh", "-ilc", "true"]);
    }

    fn session(ptys: &Ptys, program: &str, writer: Box<dyn Write + Send>) -> (u32, u32) {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", program]);
        let child = pair.slave.spawn_command(cmd).unwrap();
        let pid = child.process_id().unwrap();
        let id = ptys.next.fetch_add(1, Ordering::SeqCst) + 1;
        ptys.sessions.lock().unwrap().insert(id, Session { master: pair.master, input: writer_thread(writer), child });
        (id, pid)
    }

    #[test]
    fn killed_terminals_are_reaped() {
        let ptys = Ptys::default();
        // A shell that ignores SIGHUP survives the grace period and is SIGKILLed, which portable-pty does not wait for.
        let (id, pid) = session(&ptys, "trap '' HUP; sleep 30", Box::new(std::io::sink()));
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0, "the shell was running");
        let started = std::time::Instant::now();
        ptys.kill(id);
        let took = started.elapsed();
        assert!(took < std::time::Duration::from_secs(2), "kill waited for the shell to exit on its own ({took:?})");
        // Already waited for: no zombie is left for anyone else to collect.
        let r = unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) };
        assert_eq!((r, std::io::Error::last_os_error().raw_os_error()), (-1, Some(libc::ECHILD)));
    }

    /// Blocks until released, then records what it was given.
    struct Gate(std::sync::mpsc::Receiver<()>, std::sync::Arc<Mutex<Vec<u8>>>);
    impl Write for Gate {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            let _ = self.0.recv();
            self.1.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn writes_never_block_on_a_stuck_terminal_and_stay_in_order() {
        let ptys = Ptys::default();
        let (release, gate) = channel();
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let (id, _) = session(&ptys, "sleep 5", Box::new(Gate(gate, seen.clone())));
        let started = std::time::Instant::now();
        for chunk in [b"a", b"b", b"c"] {
            ptys.write(id, chunk).unwrap();
        }
        assert!(started.elapsed() < std::time::Duration::from_millis(100), "pty_write blocked on the terminal");
        assert!(ptys.sessions.try_lock().is_ok());
        for _ in 0..3 {
            release.send(()).unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while seen.lock().unwrap().len() < 3 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(&*seen.lock().unwrap(), b"abc");
        ptys.kill_all();
    }

    #[test]
    fn holds_back_split_multibyte_sequences() {
        let s = "aé".as_bytes();
        assert_eq!(complete_utf8_len(s), 3);
        assert_eq!(complete_utf8_len(&s[..2]), 1);
        assert_eq!(complete_utf8_len(b"\xff"), 1);
    }
}
