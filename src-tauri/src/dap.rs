use crate::fsops::e2s;
use crate::rpc::{read_messages, write_message, RpcEvent};
use std::io::{self, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::unix::net::UnixStream;
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

#[derive(Default)]
pub struct Dap(Mutex<Option<Stream>>);

impl Dap {
    pub fn stop(&self) {
        if let Some(s) = self.0.lock().unwrap().take() {
            s.shutdown();
        }
    }
}

/// Connects to an rdbg DAP server (`rdbg --open`), retrying while the app boots.
#[tauri::command]
pub async fn dap_connect(state: State<'_, Dap>, target: String, timeout_secs: u64, on_event: Channel<RpcEvent>) -> Result<(), String> {
    state.stop();
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
    *state.0.lock().unwrap() = Some(stream);
    Ok(())
}

#[tauri::command]
pub fn dap_send(state: State<'_, Dap>, body: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let stream = guard.as_mut().ok_or("debugger is not connected")?;
    write_message(&mut stream.writer(), &body).map_err(e2s)
}

#[tauri::command]
pub fn dap_disconnect(state: State<'_, Dap>) {
    state.stop();
}

#[tauri::command]
pub fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(e2s)?;
    Ok(l.local_addr().map_err(e2s)?.port())
}
