// SPDX-License-Identifier: MIT

//! A raw-TCP HTTP/1.1 server for wire tests (#803).
//!
//! It records each request head exactly as the bytes arrived — the
//! request line's target is never parsed, decoded or normalised — so a
//! test compares the path the SDK put ON THE WIRE, not a mock's parsed
//! view of it (`url::Url` may re-encode, wiremock re-parses).
//!
//! Every accepted connection is recorded and answered with the same
//! [`Behavior`]; [`RawServer::requests`] returns them all, so a test can
//! also assert how many requests the SDK issued.

#![allow(dead_code)]

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

/// One request head as received.
#[derive(Debug, Clone)]
pub struct RawRequest {
    /// The request line, verbatim (`GET <target> HTTP/1.1`).
    pub request_line: String,
    /// Header lines, names and values trimmed, in arrival order.
    pub headers: Vec<(String, String)>,
}

impl RawRequest {
    /// The request-target, verbatim (second token of the request line).
    pub fn target(&self) -> &str {
        self.request_line.split(' ').nth(1).unwrap_or("")
    }

    /// The raw path: the request-target up to the first `?`.
    pub fn path(&self) -> &str {
        let target = self.target();
        target.split('?').next().unwrap_or(target)
    }

    /// First header named `name` (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// How the server answers every connection.
#[derive(Debug, Clone)]
pub enum Behavior {
    /// A complete response, then the connection closes.
    Respond {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    /// Never answer; hold the connection open.
    Hang,
    /// Promise `body.len() + 4096` bytes, send the first 16, close.
    CloseMidBody {
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
}

pub struct RawServer {
    pub base_url: String,
    rx: mpsc::UnboundedReceiver<RawRequest>,
    handle: tokio::task::JoinHandle<()>,
}

impl RawServer {
    pub async fn start(behavior: Behavior) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind raw listener");
        let base_url = format!("http://{}", listener.local_addr().expect("local_addr"));
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let tx = tx.clone();
                let behavior = behavior.clone();
                tokio::spawn(serve(socket, tx, behavior));
            }
        });
        Self {
            base_url,
            rx,
            handle,
        }
    }

    /// Every request head received so far.
    pub fn requests(&mut self) -> Vec<RawRequest> {
        let mut out = Vec::new();
        while let Ok(r) = self.rx.try_recv() {
            out.push(r);
        }
        out
    }
}

impl Drop for RawServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn serve(mut socket: TcpStream, tx: mpsc::UnboundedSender<RawRequest>, behavior: Behavior) {
    let Some(request) = read_head(&mut socket).await else {
        return;
    };
    // Recorded BEFORE answering: once the client has a response (or gave
    // up), the request is already in the channel.
    let _ = tx.send(request);
    match behavior {
        Behavior::Respond {
            status,
            headers,
            body,
        } => {
            let reason = reqwest::StatusCode::from_u16(status)
                .ok()
                .and_then(|s| s.canonical_reason())
                .unwrap_or("Status");
            let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
            for (k, v) in &headers {
                head.push_str(&format!("{k}: {v}\r\n"));
            }
            // A 304 carries no body; everything else is length-delimited.
            if status != 304 {
                head.push_str(&format!("Content-Length: {}\r\n", body.len()));
            }
            head.push_str("Connection: close\r\n\r\n");
            let _ = socket.write_all(head.as_bytes()).await;
            if status != 304 {
                let _ = socket.write_all(&body).await;
            }
            let _ = socket.flush().await;
            let _ = socket.shutdown().await;
        }
        Behavior::Hang => {
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        Behavior::CloseMidBody { headers, body } => {
            let mut head = String::from("HTTP/1.1 200 OK\r\n");
            for (k, v) in &headers {
                head.push_str(&format!("{k}: {v}\r\n"));
            }
            head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len() + 4096));
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(&body[..body.len().min(16)]).await;
            let _ = socket.flush().await;
            // Dropping the socket closes it before the promised bytes land.
        }
    }
}

/// Reads up to the blank line ending the head. The bytes are kept as
/// received; only the split into lines happens here.
async fn read_head(socket: &mut TcpStream) -> Option<RawRequest> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 || buf.len() > 64 * 1024 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let end = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    // Lossy: a non-ASCII byte shows up as U+FFFD and fails a path check
    // loudly instead of hiding the request.
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?.to_string();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_string(), v.trim().to_string()))
        .collect();
    Some(RawRequest {
        request_line,
        headers,
    })
}
