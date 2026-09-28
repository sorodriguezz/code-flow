import { HOST_KEY_UNKNOWN, isUnknownHostKeyError } from "../hostKey";
import type { HostKeyTarget } from "../../state/hostKeyStore";

/**
 * Which machine the trust dialog should ask about, for a Remote connection that failed because a
 * host key is not in `known_hosts` yet — `null` for any other failure, a *changed* key included.
 *
 * **Not always the row's own machine.** Behind a `jump` host the key `ssh` does not know is as
 * likely to be the bastion's, and scanning the target instead would show a key whose trust changes
 * nothing. So the backend names the host the way `ssh` did (`remotes::host_key_failure`) — `name`
 * on port 22, `[name]:port` otherwise — and this reads it back, falling back to the row's address
 * when `ssh` named none.
 *
 * The user only travels with the row's own machine: `~/.ssh/config` rules may match on it, and a
 * bastion is reached as that file says, not as the row's account.
 */
export function hostKeyTarget(
  error: unknown,
  fallback: { host: string; port: number; user: string },
): HostKeyTarget | null {
  if (!isUnknownHostKeyError(error)) return null;
  const named = new RegExp(`${HOST_KEY_UNKNOWN}: (\\S+) isn't`).exec(String(error))?.[1] ?? "";
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(named);
  const host = bracketed ? bracketed[1] : named || fallback.host.trim();
  // A bare name is port 22 to `ssh`, which brackets every other; 0 lets `~/.ssh/config` say so
  // rather than overriding a `Port` it may set for that name.
  const port = bracketed ? Number(bracketed[2]) : named ? 0 : fallback.port;
  const user = host === fallback.host.trim() ? fallback.user.trim() : "";
  return host ? { host, port, user } : null;
}
