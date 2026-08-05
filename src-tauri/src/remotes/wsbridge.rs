//! A loopback WebSocket that carries a raw TCP stream, so the webview can speak VNC.
//!
//! **Why this has to exist.** A browser cannot open a TCP socket, and VNC (RFB) is a TCP protocol.
//! Every in-browser VNC client therefore talks to a WebSocket that something else bridges — the
//! canonical one is `websockify`. This is that, in-process: no extra binary to ship, no port
//! management for the user, and it dies with the app.
//!
//! **What it composes with is the whole point.** The target is usually `127.0.0.1:<some port>` —
//! the local end of the SSH forward [`super::screen`] already raises. So the chain is: webview →
//! this bridge → loopback → `ssh -L` → the far host's `127.0.0.1:5900`. A VNC server bound to
//! loopback on the far side, which is the only sane way to run one, becomes visible in the app
//! without being exposed to any network at any point.
//!
//! **Security, since this is a listening socket.**
//!
//! - Bound to `127.0.0.1`, never `0.0.0.0`. Nothing off this machine can reach it.
//! - Every session gets a random path token. A local process that guessed the port still cannot
//!   connect without it, and the token is only ever handed to our own webview.
//! - A token maps to exactly one target address, registered before the URL is given out. There is
//!   no way to ask the bridge to connect somewhere of the caller's choosing — which is the failure
//!   mode that turns a helper like this into an open proxy.
//! - Tokens are removed when the screen closes, so a stale URL connects to nothing.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Mutex, OnceLock};

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;

/// Where a token points, and how many times it may be used.
struct Route {
    target: SocketAddr,
}

type Routes = Mutex<HashMap<String, Route>>;

fn routes() -> &'static Routes {
    static ROUTES: OnceLock<Routes> = OnceLock::new();
    ROUTES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The port the bridge is listening on, once started. `OnceLock` because the listener is started
/// at most once per process and every screen shares it.
fn port() -> &'static OnceLock<u16> {
    static PORT: OnceLock<u16> = OnceLock::new();
    &PORT
}

/// Registers a target and returns the `ws://` URL the webview should open.
///
/// Starts the listener on first use rather than at boot: an app whose user never opens a screen
/// should not be holding a socket open for the whole session.
pub async fn publish(target: SocketAddr) -> Result<(String, String), String> {
    let port = ensure_listening().await?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    routes()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(token.clone(), Route { target });
    Ok((format!("ws://127.0.0.1:{port}/{token}"), token))
}

/// Retires a token. Any URL holding it stops working immediately.
pub fn revoke(token: &str) {
    if let Ok(mut map) = routes().lock() {
        map.remove(token);
    }
}

async fn ensure_listening() -> Result<u16, String> {
    if let Some(existing) = port().get() {
        return Ok(*existing);
    }
    // Port 0: the OS picks a free one. A fixed port would collide with whatever else on the
    // machine had the same idea, and there is nothing here a user needs to type.
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("couldn't start the screen bridge: {e}"))?;
    let bound = listener
        .local_addr()
        .map_err(|e| format!("couldn't read the screen bridge's port: {e}"))?
        .port();

    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let _ = serve(stream).await;
            });
        }
    });

    // `set` can lose a race with another first-use; whoever won is as good an answer, and the
    // listener this one started is then simply unused.
    let _ = port().set(bound);
    Ok(*port().get().unwrap_or(&bound))
}

async fn serve(stream: TcpStream) -> Result<(), String> {
    // The token is the request path, captured during the handshake — this is the only place the
    // HTTP side of the upgrade is inspected at all.
    let mut token = String::new();
    let ws = tokio_tungstenite::accept_hdr_async(
        stream,
        |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
            token = request.uri().path().trim_start_matches('/').to_string();
            Ok(response)
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    let Some(target) = routes().lock().ok().and_then(|map| map.get(&token).map(|r| r.target)) else {
        // An unknown token is closed without explanation. There is nothing useful to tell a caller
        // that shouldn't be here, and a distinct error would confirm which tokens exist.
        return Err("unknown token".into());
    };

    let tcp = TcpStream::connect(target).await.map_err(|e| e.to_string())?;
    // Nagle off: RFB is a latency-sensitive interactive protocol, and coalescing a mouse move with
    // whatever comes next is exactly the wrong trade.
    let _ = tcp.set_nodelay(true);
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let (mut ws_write, mut ws_read) = ws.split();

    // Webview → host.
    let to_host = async move {
        while let Some(Ok(message)) = ws_read.next().await {
            match message {
                Message::Binary(data) => {
                    if tcp_write.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                // RFB is binary end to end. Text, ping and pong frames carry nothing for the far
                // side, and forwarding them would corrupt the stream.
                _ => {}
            }
        }
        let _ = tcp_write.shutdown().await;
    };

    // Host → webview.
    let to_webview = async move {
        let mut buffer = vec![0u8; 32 * 1024];
        loop {
            match tcp_read.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_write.send(Message::Binary(buffer[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = ws_write.close().await;
    };

    // Either direction ending ends the session: a half-open VNC connection is not a state worth
    // keeping, and leaving one would leak both sockets.
    tokio::select! {
        _ = to_host => {}
        _ = to_webview => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// All three behaviours in one test, on purpose.
    ///
    /// The listener is process-global and started once, and its accept loop is spawned onto
    /// whichever tokio runtime got there first. `#[tokio::test]` gives each test its own runtime and
    /// tears it down at the end — so a second test would inherit a port whose accept loop died with
    /// the first test's runtime, and fail for a reason that has nothing to do with the bridge. One
    /// runtime, one test, no flake. (The app has a single runtime for its whole life, which is why
    /// this is a testing artefact and not a defect.)
    #[tokio::test]
    async fn the_bridge_carries_bytes_and_honours_its_tokens() {
        // --- a real TCP server on one side, standing in for a VNC server ------------------
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = echo.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = echo.accept().await else { break };
                tokio::spawn(async move {
                    let mut buffer = [0u8; 64];
                    if let Ok(n) = stream.read(&mut buffer).await {
                        let _ = stream.write_all(&buffer[..n].to_ascii_uppercase()).await;
                    }
                });
            }
        });

        // --- bytes cross, both ways -------------------------------------------------------
        let (url, token) = publish(target).await.unwrap();
        let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        socket.send(Message::Binary(b"hello".to_vec().into())).await.unwrap();
        let reply = socket.next().await.unwrap().unwrap();
        assert_eq!(reply.into_data().as_ref(), b"HELLO");
        drop(socket);

        // --- an unknown token carries nothing ---------------------------------------------
        let bogus = url.replace(&token, "0123456789abcdef0123456789abcdef");
        if let Ok((mut socket, _)) = tokio_tungstenite::connect_async(&bogus).await {
            assert!(
                socket.next().await.map(|m| m.is_err()).unwrap_or(true),
                "an unknown token must carry nothing"
            );
        }

        // --- and a revoked one stops working ----------------------------------------------
        revoke(&token);
        if let Ok((mut socket, _)) = tokio_tungstenite::connect_async(&url).await {
            assert!(
                socket.next().await.map(|m| m.is_err()).unwrap_or(true),
                "a revoked token must not carry data"
            );
        }
    }
}
