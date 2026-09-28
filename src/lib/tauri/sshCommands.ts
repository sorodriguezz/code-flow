import { invoke } from "@tauri-apps/api/core";

/**
 * SSH host-key trust — generic, for every part of the app that connects through the system's `ssh`
 * (the database tunnel today, the Remote workspace next). See `src-tauri/src/known_hosts.rs`.
 */

export interface ScannedHostKey {
  key_type: string;
  /** The public key blob, base64. Sent back verbatim to trust it, so what is written is what was shown. */
  key: string;
  /** `SHA256:…`, as `ssh` prints it. */
  fingerprint: string;
  trusted: boolean;
}

export interface HostKeyScan {
  host: string;
  port: number;
  /** The name `ssh` really dials, after `~/.ssh/config`. */
  hostname: string;
  /** How the host is recorded in known_hosts: `host`, `[host]:port` or a `HostKeyAlias`. */
  known_as: string;
  known_hosts_file: string;
  hashed: boolean;
  keys: ScannedHostKey[];
}

/** Reads the keys a host presents. Writes nothing. `port` 0 lets `~/.ssh/config` decide. */
export const sshScanHostKey = (host: string, port: number, user: string) =>
  invoke<HostKeyScan>("ssh_scan_host_key", { host, port, user });

/** Adds one scanned key to known_hosts. Returns the file written. */
export const sshTrustHostKey = (host: string, port: number, user: string, keyType: string, key: string) =>
  invoke<string>("ssh_trust_host_key", { host, port, user, keyType, key });
