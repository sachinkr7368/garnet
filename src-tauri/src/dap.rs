use crate::fsops::e2s;
use crate::rpc::{read_messages, write_message, RpcEvent};
use std::io::{self, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::unix::net::UnixStream;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;

enum Stream {
    Tcp(TcpStream),
    Unix(UnixStream),
}

impl Stream {
    /// `12345`, `host:12345` or a unix socket path.
    fn connect(target: &str) -> io::Result<Stream> {
        if target.contains('/') {
            return UnixStream::connect(target).map(Stream::Unix);
        }
        let addr = if target.contains(':') { target.to_string() } else { format!("127.0.0.1:{target}") };
        TcpStream::connect(addr).map(Stream::Tcp)
    }

    fn try_clone(&self) -> io::Result<Box<dyn Read + Send>> {
        Ok(match self {
            Stream::Tcp(s) => Box::new(s.try_clone()?),
            Stream::Unix(s) => Box::new(s.try_clone()?),
        })
    }

    fn shutdown(&self) {
        let _ = match self {
            Stream::Tcp(s) => s.shutdown(Shutdown::Both),
            Stream::Unix(s) => s.shutdown(Shutdown::Both),
        };
    }

    fn writer(&mut self) -> &mut dyn Write {
        match self {
            Stream::Tcp(s) => s,
            Stream::Unix(s) => s,
        }
    }
}

/// Live rdbg connections keyed by session id; several debug sessions can run at once.
#[derive(Default)]
pub struct Dap {
    sessions: Mutex<HashMap<u32, Stream>>,
    next: AtomicU32,
}

impl Dap {
    fn insert(&self, stream: Stream) -> u32 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().unwrap().insert(id, stream);
        id
    }

    fn send(&self, id: u32, body: &str) -> io::Result<()> {
        let mut guard = self.sessions.lock().unwrap();
        let stream = guard.get_mut(&id).ok_or_else(|| io::Error::new(io::ErrorKind::NotConnected, "debugger is not connected"))?;
        write_message(&mut stream.writer(), body)
    }

    fn remove(&self, id: u32) {
        if let Some(s) = self.sessions.lock().unwrap().remove(&id) {
            s.shutdown();
        }
    }

    pub fn stop(&self) {
        for (_, s) in self.sessions.lock().unwrap().drain() {
            s.shutdown();
        }
    }
}

/// Connects to an rdbg DAP server (`rdbg --open`), retrying while the app boots. Returns the session id.
#[tauri::command]
pub async fn dap_connect(state: State<'_, Dap>, target: String, timeout_secs: u64, on_event: Channel<RpcEvent>) -> Result<u32, String> {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let stream = loop {
        match Stream::connect(&target) {
            Ok(s) => break s,
            Err(e) if Instant::now() > deadline => return Err(format!("could not connect to {target}: {e}")),
            Err(_) => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    };
    let reader = stream.try_clone().map_err(e2s)?;
    std::thread::spawn(move || {
        read_messages(BufReader::new(reader), |body| {
            let _ = on_event.send(RpcEvent::Message { body });
        });
        let _ = on_event.send(RpcEvent::Exit { code: None });
    });
    Ok(state.insert(stream))
}

#[tauri::command]
pub fn dap_send(state: State<'_, Dap>, id: u32, body: String) -> Result<(), String> {
    state.send(id, &body).map_err(e2s)
}

#[tauri::command]
pub fn dap_disconnect(state: State<'_, Dap>, id: u32) {
    state.remove(id);
}

#[tauri::command]
pub fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(e2s)?;
    Ok(l.local_addr().map_err(e2s)?.port())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::os::unix::net::UnixListener;

    fn read_frame(stream: &mut impl Read) -> String {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        while !buf.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            buf.push(byte[0]);
        }
        let header = String::from_utf8(buf).unwrap();
        let len: usize = header.trim().trim_start_matches("Content-Length:").trim().parse().unwrap();
        let mut body = vec![0u8; len];
        stream.read_exact(&mut body).unwrap();
        String::from_utf8(body).unwrap()
    }

    #[test]
    fn sessions_are_independent() {
        let a = TcpListener::bind("127.0.0.1:0").unwrap();
        let b = TcpListener::bind("127.0.0.1:0").unwrap();
        let dap = Dap::default();
        let id_a = dap.insert(Stream::connect(&a.local_addr().unwrap().port().to_string()).unwrap());
        let id_b = dap.insert(Stream::connect(&format!("127.0.0.1:{}", b.local_addr().unwrap().port())).unwrap());
        assert_ne!(id_a, id_b);
        let (mut peer_a, _) = a.accept().unwrap();
        let (mut peer_b, _) = b.accept().unwrap();
        dap.send(id_b, r#"{"seq":1}"#).unwrap();
        dap.send(id_a, r#"{"seq":2}"#).unwrap();
        assert_eq!(read_frame(&mut peer_a), r#"{"seq":2}"#);
        assert_eq!(read_frame(&mut peer_b), r#"{"seq":1}"#);

        dap.remove(id_a);
        assert!(dap.send(id_a, "{}").is_err());
        let mut rest = Vec::new();
        assert_eq!(peer_a.read_to_end(&mut rest).unwrap(), 0, "removed session is shut down");
        dap.send(id_b, r#"{"seq":3}"#).unwrap();
        assert_eq!(read_frame(&mut peer_b), r#"{"seq":3}"#);

        dap.stop();
        assert!(dap.send(id_b, "{}").is_err());
    }

    #[test]
    fn connects_to_unix_socket() {
        let dir = std::env::temp_dir().join(format!("garnet-dap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rdbg.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let dap = Dap::default();
        let id = dap.insert(Stream::connect(path.to_str().unwrap()).unwrap());
        let (mut peer, _) = listener.accept().unwrap();
        dap.send(id, r#"{"ok":true}"#).unwrap();
        assert_eq!(read_frame(&mut peer), r#"{"ok":true}"#);
        dap.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_session_is_an_error() {
        assert!(Dap::default().send(42, "{}").is_err());
    }
}
