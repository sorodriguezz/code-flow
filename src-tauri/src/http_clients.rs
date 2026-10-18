//! HTTP clients built once per configuration and shared.
//!
//! A `reqwest::Client` is a connection pool plus a TLS configuration; building one per request
//! throws both away — a fresh rustls setup and a new connection (DNS, TCP, TLS handshake) for every
//! call. That was the shape of the flow nodes' helpers, which run per item, and of the services'
//! health probe, which runs every few hundred milliseconds while a service starts. A clone of a
//! client is an `Arc`, so handing out the same one costs nothing.
//!
//! Keyed by the caller's own description of the configuration (timeout, agent…): the set of keys
//! is the handful of distinct settings the code uses, so the map stays small.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// The client for `key`, built by `build` the first time it is asked for.
pub fn cached(key: &str, build: impl FnOnce() -> reqwest::ClientBuilder) -> Result<reqwest::Client, String> {
    static CLIENTS: OnceLock<Mutex<HashMap<String, reqwest::Client>>> = OnceLock::new();
    let clients = CLIENTS.get_or_init(Default::default);
    if let Some(client) = clients.lock().ok().and_then(|map| map.get(key).cloned()) {
        return Ok(client);
    }
    let client = build().build().map_err(|e| e.to_string())?;
    if let Ok(mut map) = clients.lock() {
        map.entry(key.to_string()).or_insert_with(|| client.clone());
    }
    Ok(client)
}

/// A plain client with reqwest's defaults — for callers that set a timeout per request.
pub fn plain() -> reqwest::Client {
    cached("plain", reqwest::Client::builder).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[test]
    fn hands_out_one_client_per_key() {
        let mut built = 0;
        for _ in 0..3 {
            super::cached("test-key", || {
                built += 1;
                reqwest::Client::builder()
            })
            .unwrap();
        }
        assert_eq!(built, 1);
    }
}
