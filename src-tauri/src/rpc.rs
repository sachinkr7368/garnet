use serde::Serialize;
use std::io::{self, BufRead, Write};

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RpcEvent {
    Message { body: String },
    Stderr { line: String },
    Exit { code: Option<i32> },
}

/// Reads `Content-Length` framed JSON-RPC messages (LSP and DAP share the framing).
pub fn read_messages(mut r: impl BufRead, mut on_message: impl FnMut(String)) {
    loop {
        let mut len = None;
        loop {
            let mut line = String::new();
            match r.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some(v) = line.strip_prefix("Content-Length:") {
                len = v.trim().parse::<usize>().ok();
            }
        }
        let Some(n) = len else { continue };
        let mut body = vec![0; n];
        if r.read_exact(&mut body).is_err() {
            return;
        }
        on_message(String::from_utf8_lossy(&body).into_owned());
    }
}

pub fn write_message(w: &mut impl Write, body: &str) -> io::Result<()> {
    write!(w, "Content-Length: {}\r\n\r\n", body.len())?;
    w.write_all(body.as_bytes())?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_framed_messages() {
        let mut buf = Vec::new();
        write_message(&mut buf, r#"{"id":1}"#).unwrap();
        write_message(&mut buf, r#"{"jsonrpc":"2.0","method":"é"}"#).unwrap();
        let mut got = Vec::new();
        read_messages(io::Cursor::new(buf), |m| got.push(m));
        assert_eq!(got, vec![r#"{"id":1}"#, r#"{"jsonrpc":"2.0","method":"é"}"#]);
    }
}
