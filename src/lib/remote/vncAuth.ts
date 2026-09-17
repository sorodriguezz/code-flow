/**
 * What noVNC is handed as credentials, and what to say when it asks for the half that is missing.
 *
 * **macOS is why this module exists.** Screen Sharing answers `RFB 003.889` and offers security
 * types `30, 33, 36, 31, 32, 2, 35`: Apple's Diffie-Hellman (30) first, and plain VNC auth (2)
 * sixth — present only when the legacy "VNC viewers may control screen with password" box is
 * ticked. noVNC takes the first type it supports *in the server's own order*, so a Mac is always
 * type 30, and type 30 authenticates a macOS **account**: it wants a username as much as a
 * password. Given a password-only bag it asks for both and stops there, which is a screen that
 * never opens — on the one platform whose VNC server is always on and never asks for less.
 *
 * So the username is not an RDP-only field, and a VNC host that names one is not a
 * misunderstanding. It is what a Mac needs.
 */

/** noVNC's credential bag — only the fields the auth schemes reached here actually read. */
export interface VncCredentials {
  username?: string;
  password?: string;
}

/**
 * A host's credentials, with the blanks left out rather than sent empty.
 *
 * noVNC tests for its credentials with `=== undefined`, so an empty string *is* a credential: it
 * would send a Mac a nameless account and get back "authentication failed", which says nothing
 * about the field that was left blank. Omitted, noVNC asks instead — and [`vncMissingCredential`]
 * turns that question into the sentence naming the field to fill.
 *
 * The username is trimmed because a macOS short name never has edge whitespace and a stray space
 * is invisible in the form; the password is not, because there it could be deliberate.
 */
export function vncCredentials(username: string, password: string): VncCredentials {
  const credentials: VncCredentials = {};
  const user = username.trim();
  if (user) credentials.username = user;
  if (password) credentials.password = password;
  return credentials;
}

/**
 * Which blank field a `credentialsrequired` event is really about.
 *
 * noVNC names every type the scheme needs, not the ones it lacks — Apple DH asks for
 * `["username", "password"]` even when only the password is missing. Reporting the event verbatim
 * would send someone to a field they had already filled, so what was supplied decides.
 */
export function vncMissingCredential(
  types: string[] | undefined,
  supplied: VncCredentials,
): "username" | "password" {
  const wantsUser = types?.includes("username") ?? false;
  return wantsUser && supplied.username === undefined ? "username" : "password";
}
