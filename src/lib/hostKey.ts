/**
 * Recognising the SSH failure the app can fix: a host that isn't in `known_hosts` yet.
 *
 * Every SSH connection here runs the system's `ssh` with `BatchMode=yes`, so the first one to a new
 * host fails where a terminal would have asked "are you sure you want to continue connecting?". The
 * backend marks that failure with a fixed phrase (`HOST_KEY_UNKNOWN` in `src-tauri/src/known_hosts.rs`
 * — keep the two identical), and this is the matcher every caller uses to offer the trust dialog.
 *
 * Only the *unknown* case: a key that changed is what an interception looks like, and the backend's
 * own message for it says so and offers nothing to click.
 */
export const HOST_KEY_UNKNOWN = "SSH host key not trusted yet";

export function isUnknownHostKeyError(error: unknown): boolean {
  return String(error).includes(HOST_KEY_UNKNOWN);
}
