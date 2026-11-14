/**
 * What travels on a session's live channel, and how.
 *
 * The channel is a Supabase Realtime **Broadcast** topic on the host's own project. Anyone holding
 * the project's anon key (it is in every invitation) can join any public topic, so the channel keeps
 * its own secrets: the topic name is derived from the session's channel key, and every message is
 * encrypted with AES-GCM under a key derived from it too. The channel key is read from
 * `cf_collab_watermark`, which answers members only, and it rotates when the host removes someone.
 *
 * Realtime caps a message's size, so an encrypted message past `CHUNK` characters goes in parts that
 * the other side puts back together.
 */

/** Who sent a message. */
export interface Peer {
  /** The person's id in the session (`cf_collab_people.id`). */
  id: string;
  nick: string;
}

/** A file in a session: the repository by its canonical remote, the path inside it. */
export interface LiveFile {
  repoKey: string;
  path: string;
}

export type LiveMessage =
  /** Just connected: everyone answers with `here`. */
  | { k: "hello"; from: Peer }
  /** Still here, and in which file (for the avatars and «Seguir»). */
  | { k: "here"; from: Peer; file: LiveFile | null }
  | { k: "bye"; from: Peer }
  /** Sync step 1: my state vector of a document. `reply` asks for theirs back. */
  | { k: "s1"; doc: string; sv: string; reply: boolean }
  /** Sync step 2: what the asker lacks of a document. */
  | { k: "s2"; doc: string; up: string }
  /** An update to a document as it is typed. */
  | { k: "up"; doc: string; up: string }
  /** Cursors and selections in a document (y-protocols awareness). */
  | { k: "aw"; doc: string; up: string }
  /** The answer being written in this person's turn, as it streams. The whole text so far. */
  | { k: "turn"; from: Peer; text: string; engine: string | null; done: boolean };

/** A document's id on the channel: the repository and the path. */
export function docId(file: LiveFile): string {
  return `${file.repoKey}\n${file.path}`;
}

export function fileOf(doc: string): LiveFile {
  const cut = doc.indexOf("\n");
  return { repoKey: doc.slice(0, cut), path: doc.slice(cut + 1) };
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// The channel's secrets
// ---------------------------------------------------------------------------

/** The Realtime topic of a channel key: nothing about the session can be read from it. */
export async function topicOf(channelKey: string): Promise<string> {
  return `cf-collab-${hex(await sha256(`cf-collab-topic:${channelKey}`)).slice(0, 40)}`;
}

/** The AES-GCM key messages are sealed with. */
export async function sealingKey(channelKey: string): Promise<CryptoKey> {
  const raw = await sha256(`cf-collab-live:${channelKey}`);
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, message: LiveMessage): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(message));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain as BufferSource));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64(out);
}

/** The message inside, or `null` for anything that was not sealed with this key (an old key after a
 *  rotation, a stranger on the topic, a damaged message). */
export async function open(key: CryptoKey, sealed: string): Promise<LiveMessage | null> {
  try {
    const bytes = fromBase64(sealed);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) as BufferSource }, key, bytes.subarray(12) as BufferSource);
    const message = JSON.parse(new TextDecoder().decode(plain)) as LiveMessage;
    return typeof message === "object" && message && typeof message.k === "string" ? message : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/** Characters per broadcast payload. Realtime's default cap is far above it; this leaves headroom. */
export const CHUNK = 60_000;

/** One broadcast payload: a whole sealed message, or one part of a large one. */
export type Envelope = { c: string } | { p: string; i: number; n: number; c: string };

export function split(sealed: string, id: string, size = CHUNK): Envelope[] {
  if (sealed.length <= size) return [{ c: sealed }];
  const n = Math.ceil(sealed.length / size);
  return Array.from({ length: n }, (_, i) => ({ p: id, i, n, c: sealed.slice(i * size, (i + 1) * size) }));
}

/** Puts parts back together. Parts of a message that never completes are dropped after `ttlMs`. */
export class Reassembler {
  private pending = new Map<string, { parts: string[]; got: number; at: number }>();

  constructor(private ttlMs = 30_000) {}

  /** The whole sealed message once its last part is in, `null` until then. */
  push(envelope: Envelope, now = Date.now()): string | null {
    if (!("p" in envelope)) return envelope.c;
    for (const [id, entry] of this.pending) if (now - entry.at > this.ttlMs) this.pending.delete(id);
    if (envelope.n < 1 || envelope.n > 2000 || envelope.i < 0 || envelope.i >= envelope.n) return null;
    let entry = this.pending.get(envelope.p);
    if (!entry) {
      entry = { parts: new Array(envelope.n), got: 0, at: now };
      this.pending.set(envelope.p, entry);
    }
    if (entry.parts[envelope.i] === undefined) {
      entry.parts[envelope.i] = envelope.c;
      entry.got++;
    }
    if (entry.got < envelope.n) return null;
    this.pending.delete(envelope.p);
    return entry.parts.join("");
  }
}
