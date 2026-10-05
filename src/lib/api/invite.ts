/**
 * The invitation codes of shared collections and shared flows — one format for both, so either
 * join can tell a code meant for the other one (`kind`). Its own module so the Flows app can read
 * one without loading the API client's sync.
 */

/** The invitation a host hands out: everything a guest needs to reach the collection, in one blob. */
export interface Invite {
  url: string;
  key: string;
  token: string;
  /** The collection's name, so the guest can be told what they are about to accept. */
  name: string;
  /** `flow` for a flow shared from the Flows app; absent for an API collection. The same code
   *  format, so the two joins can tell an invitation meant for the other one. */
  kind?: "flow";
}

/**
 * Encoded rather than shown as raw JSON so it survives being pasted through a chat client that
 * would otherwise linkify or reflow it. This is obfuscation, not protection — the token inside is
 * a real credential, and the code should be shared the way a password would be.
 */
export function encodeInvite(invite: Invite): string {
  const json = JSON.stringify(invite);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `codeflow:${btoa(binary)}`;
}

export function decodeInvite(code: string): Invite {
  const trimmed = code.trim().replace(/^codeflow:/, "");
  let invite: Invite;
  try {
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    invite = JSON.parse(new TextDecoder().decode(bytes)) as Invite;
  } catch {
    throw new Error("that is not a CodeFlow invitation code");
  }
  if (!invite?.url || !invite.key || !invite.token) {
    throw new Error("that invitation code is incomplete");
  }
  return invite;
}
