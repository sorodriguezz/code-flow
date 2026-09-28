//! The connection file: the five ports a kernel binds and the key its messages are signed with,
//! handed to the kernel as `-f <file>` and read back by nobody but it.
//!
//! See <https://jupyter-client.readthedocs.io/en/stable/kernels.html#connection-files>.

use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConnectionInfo {
    pub ip: String,
    pub transport: String,
    pub shell_port: u16,
    pub iopub_port: u16,
    pub stdin_port: u16,
    pub control_port: u16,
    pub hb_port: u16,
    pub signature_scheme: String,
    pub key: String,
    pub kernel_name: String,
}

impl ConnectionInfo {
    /// A connection on loopback with a fresh key. `ports` is shell, iopub, stdin, control,
    /// heartbeat — the order [`reserve_ports`] hands them out in.
    pub fn loopback(ports: [u16; 5], kernel_name: &str) -> Self {
        Self {
            ip: "127.0.0.1".to_string(),
            transport: "tcp".to_string(),
            shell_port: ports[0],
            iopub_port: ports[1],
            stdin_port: ports[2],
            control_port: ports[3],
            hb_port: ports[4],
            signature_scheme: "hmac-sha256".to_string(),
            // 128 random bits as hex, the shape `jupyter_client` writes. The key is what stops any
            // other process on this machine from driving the kernel — it can reach the ports, being
            // local, but it cannot sign.
            key: uuid::Uuid::new_v4().simple().to_string(),
            kernel_name: kernel_name.to_string(),
        }
    }

    pub fn endpoint(&self, port: u16) -> String {
        format!("{}://{}:{}", self.transport, self.ip, port)
    }
}

/// Five free loopback ports, and the listeners holding them.
///
/// The listeners are what keeps another process from taking a port between choosing it and the
/// kernel binding it — dropped by the caller right after the kernel is spawned, before the kernel
/// has got as far as binding (Python takes a good half second to reach that line).
pub fn reserve_ports() -> std::io::Result<([u16; 5], Vec<TcpListener>)> {
    let mut ports = [0u16; 5];
    let mut listeners = Vec::with_capacity(5);
    for port in &mut ports {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        *port = listener.local_addr()?.port();
        listeners.push(listener);
    }
    Ok((ports, listeners))
}

/// Writes the connection file for kernel `id` into `dir` and returns its path.
///
/// Owner-only on Unix, as `jupyter_client` makes it: the file holds the signing key.
pub fn write_connection_file(dir: &Path, id: &str, info: &ConnectionInfo) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("kernel-{id}.json"));
    let body = serde_json::to_vec_pretty(info).map_err(std::io::Error::other)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    file.write_all(&body)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_five_distinct_ports() {
        let (ports, listeners) = reserve_ports().unwrap();
        assert_eq!(listeners.len(), 5);
        let mut unique = ports.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), 5);
        assert!(ports.iter().all(|port| *port > 0));
    }

    #[test]
    fn writes_the_file_a_kernel_reads() {
        let dir = std::env::temp_dir().join(format!("cf-jupyter-test-{}", uuid::Uuid::new_v4()));
        let info = ConnectionInfo::loopback([5001, 5002, 5003, 5004, 5005], "python3");
        let path = write_connection_file(&dir, "abc", &info).unwrap();
        assert_eq!(path.file_name().unwrap(), "kernel-abc.json");

        let written: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // The keys ipykernel reads, spelled the way it reads them.
        assert_eq!(written["transport"], "tcp");
        assert_eq!(written["ip"], "127.0.0.1");
        assert_eq!(written["shell_port"], 5001);
        assert_eq!(written["iopub_port"], 5002);
        assert_eq!(written["stdin_port"], 5003);
        assert_eq!(written["control_port"], 5004);
        assert_eq!(written["hb_port"], 5005);
        assert_eq!(written["signature_scheme"], "hmac-sha256");
        assert_eq!(written["key"].as_str().unwrap().len(), 32);
        assert_eq!(serde_json::from_value::<ConnectionInfo>(written).unwrap(), info);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "the key must not be readable by other users");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn every_connection_gets_its_own_key() {
        let a = ConnectionInfo::loopback([1, 2, 3, 4, 5], "k");
        let b = ConnectionInfo::loopback([1, 2, 3, 4, 5], "k");
        assert_ne!(a.key, b.key);
        assert_eq!(a.endpoint(a.shell_port), "tcp://127.0.0.1:1");
    }
}
