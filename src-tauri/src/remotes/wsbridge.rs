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
//!
//! **A target that cannot be reached is reported, not dropped.** The webview has no way to see a
//! TCP error, and a bridge that just hangs up leaves noVNC with a code-1006 close carrying nothing
//! — which is how "the VNC server is off" and macOS's Local Network gate answering `EPERM` became
//! the same sentence on screen, while `nc` in a terminal reached the very same port. So the connect
//! error is classified here and handed over as the `reason` of a close frame. See [`diagnose`].

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::SocketAddr;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// The close code that marks a close frame as the bridge's own diagnosis.
///
/// 4000-4999 is the range the WebSocket spec reserves for the application, so nothing else can mint
/// it: a 1000 or a 1006 arriving at the webview is a real network close and still means what it
/// always did. `src/lib/remote/vncBridge.ts` reads the same number.
const DIAGNOSIS_CLOSE_CODE: u16 = 4000;

/// How long the target may take to accept before the bridge calls it a timeout.
///
/// Shorter than the canvas's own handshake timer (`HANDSHAKE_TIMEOUT_MS`, 20s) on purpose. macOS
/// sits on an unanswered SYN for around 75 seconds; left to the OS, the canvas would always give up
/// first and report a server that "stopped answering" — the one wording that is wrong here, because
/// nothing ever answered. Ten seconds is still ample for a real connect over a slow tunnel.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for the peer to acknowledge a close frame before dropping the socket.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

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

/// What the webview is told about a target that could not be reached, as a stable token.
///
/// A token rather than the OS's own text, for two reasons. A close frame's reason is capped at 123
/// bytes — and, the real one, every sentence a user reads in this app is translated in
/// `src/lib/i18n`; an errno string from a Rust process is neither translated nor phrased for
/// someone who wants to know what to *do* about it. `VncCanvas` maps each token to that sentence.
///
/// `blocked` is the token this whole path exists for. macOS 15 puts a connection to a local network
/// address behind a permission, and a connect the app has not been granted fails with `EPERM` —
/// which from in here is indistinguishable from a host that is simply switched off, while `nc` in a
/// terminal that *does* hold the permission reaches the same port happily.
fn diagnose(error: &std::io::Error) -> String {
    match error.kind() {
        ErrorKind::ConnectionRefused => "refused".to_string(),
        ErrorKind::TimedOut => "timeout".to_string(),
        ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable => "unreachable".to_string(),
        ErrorKind::PermissionDenied => "blocked".to_string(),
        // Unrecognised is not the same as unknown: the OS's text rides along after the token, and a
        // sentence with the real error in it beats a shrug.
        _ => clip(format!("failed:{error}")),
    }
}

/// Trims a reason to what a close frame can carry.
///
/// A control frame's payload is 125 bytes and two of them are the code, so 123 are left. Cut on a
/// char boundary: the reason is a UTF-8 field, and half a character is a protocol error rather than
/// a truncated word.
fn clip(mut reason: String) -> String {
    const LIMIT: usize = 123;
    if reason.len() > LIMIT {
        let mut end = LIMIT;
        while !reason.is_char_boundary(end) {
            end -= 1;
        }
        reason.truncate(end);
    }
    reason
}

/// Hangs up with the reason attached, rather than dropping the socket and leaving nothing behind.
async fn refuse(mut ws: WebSocketStream<TcpStream>, reason: String) -> Result<(), String> {
    let frame =
        CloseFrame { code: CloseCode::from(DIAGNOSIS_CLOSE_CODE), reason: reason.clone().into() };
    if ws.send(Message::Close(Some(frame))).await.is_ok() {
        // Then read until the peer echoes the close. The frame is already flushed, but dropping a
        // socket whose receive buffer still holds the reply is what turns a clean close into an RST
        // — and a reset reaches the webview as precisely the code 1006 with no reason that this
        // function exists to avoid. Bounded, so a peer that never answers cannot park the task.
        let drain = async { while ws.next().await.is_some() {} };
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, drain).await;
    }
    // Returned for the caller's sake, which today is a `let _` — the socket has already carried the
    // only copy that matters.
    Err(reason)
}

async fn serve(stream: TcpStream) -> Result<(), String> {
    // Nagle off on *this* socket too, not only on the one to the far host below.
    //
    // This is the half the webview reads, and it carries the same interactive traffic: a burst of
    // framebuffer chunks whose last one is a few hundred bytes, then silence until the client asks
    // for the next update. That tail is precisely what Nagle holds back, waiting for an ACK that
    // the peer's delayed-ACK timer will not send for tens of milliseconds — so every frame ends
    // late and the screen feels sluggish however fast the link is. Loopback does not save it:
    // Nagle lives in the sender, and the sender here is us.
    let _ = stream.set_nodelay(true);

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

    let tcp = match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(target)).await {
        Ok(Ok(tcp)) => tcp,
        Ok(Err(e)) => return refuse(ws, diagnose(&e)).await,
        // Our own deadline, so there is no `io::Error` to classify — but to the person waiting it
        // means exactly what the OS's own `ETIMEDOUT` would have.
        Err(_) => return refuse(ws, "timeout".to_string()).await,
    };
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
        // 256 KB rather than 32, and it costs nothing to wait for: `read` returns the moment one
        // byte is there, so a bigger buffer never delays anything — it only takes more per call
        // when more has already arrived. Which is the normal case here. A full repaint of a Retina
        // desktop is megabytes, and at 32 KB that was hundreds of round trips through a write
        // syscall, a WebSocket frame header and a `message` event the webview allocates for and
        // hands to noVNC one at a time. Eight times fewer of each, for the same pixels.
        let mut buffer = vec![0u8; 256 * 1024];
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

        // --- a target nothing is listening on says *why* ----------------------------------
        //
        // The point of the whole close-frame path: the webview cannot see a TCP error, so the only
        // thing it can report is what crosses this wire. Without the reason, a refused connection
        // and a dead tunnel and a denied Local Network permission are one message.
        let dead = {
            let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = probe.local_addr().unwrap();
            drop(probe); // ...and now nothing is listening there.
            address
        };
        let (dead_url, _) = publish(dead).await.unwrap();
        let (mut socket, _) = tokio_tungstenite::connect_async(&dead_url).await.unwrap();
        let farewell = socket.next().await.unwrap().unwrap();
        let Message::Close(Some(frame)) = farewell else {
            panic!("an unreachable target must close with a reason, got {farewell:?}");
        };
        assert_eq!(u16::from(frame.code), DIAGNOSIS_CLOSE_CODE);
        assert_eq!(frame.reason.as_str(), "refused");
    }

    /// The errno-to-token mapping, which is the contract `vncBridge.ts` reads.
    ///
    /// Held down by name because the tokens are a wire format: renaming one here without renaming
    /// it there doesn't fail to compile, it silently drops the panel back to the generic sentence.
    #[test]
    fn every_reachability_failure_gets_its_own_token() {
        let token = |kind| diagnose(&std::io::Error::from(kind));

        assert_eq!(token(ErrorKind::ConnectionRefused), "refused");
        assert_eq!(token(ErrorKind::TimedOut), "timeout");
        assert_eq!(token(ErrorKind::HostUnreachable), "unreachable");
        assert_eq!(token(ErrorKind::NetworkUnreachable), "unreachable");
        // The one the panel exists for: macOS's Local Network gate denies the connect outright.
        assert_eq!(token(ErrorKind::PermissionDenied), "blocked");

        // Anything else still carries its text, rather than arriving as a bare shrug.
        let other = diagnose(&std::io::Error::other("the wheels came off"));
        assert_eq!(other, "failed:the wheels came off");
    }

    /// A close frame's reason is 123 bytes, and an OS message is not obliged to fit.
    #[test]
    fn a_long_reason_is_cut_to_fit_a_close_frame() {
        // Multi-byte on purpose: cutting at byte 123 mid-character would make the frame invalid
        // UTF-8, and the browser would drop the whole close rather than show a shortened reason.
        let long = clip(format!("failed:{}", "é".repeat(200)));
        assert!(long.len() <= 123, "{} bytes is more than a close frame carries", long.len());
        assert!(std::str::from_utf8(long.as_bytes()).is_ok(), "the cut must land on a character");

        // ...and something that already fits is left exactly as it was.
        assert_eq!(clip("refused".to_string()), "refused");
    }
}
