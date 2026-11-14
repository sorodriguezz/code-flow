import { RealtimeClient, type RealtimeChannel } from "@supabase/realtime-js";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { patchLiveSession } from "../../state/liveStore";
import { minimalEdit, seedClientId } from "./text";
import {
  Reassembler,
  docId,
  fromBase64,
  open,
  seal,
  sealingKey,
  split,
  toBase64,
  topicOf,
  type Envelope,
  type LiveFile,
  type LiveMessage,
  type Peer,
} from "./wire";

/**
 * One shared session's live channel: a Supabase Realtime Broadcast topic on the host's project, and
 * the Yjs documents of the files this window has open in the session's projects.
 *
 * - **Documents.** Only the people who have a file open hold its document. Opening one asks the others
 *   for what they have (sync step 1); whoever has it answers with what is missing (step 2). If nobody
 *   answers in a moment, the document is seeded from the buffer under a client id derived from the
 *   text (`seedClientId`), so two people opening the same file at once seed the same items.
 * - **Updates** of a document are batched for a few milliseconds and broadcast; **awareness** carries
 *   each person's cursor and selection.
 * - **Presence** (`here`, every few seconds) says who is connected and which file they are in.
 * - **Turns.** The answer this person's engine is writing is relayed as it streams.
 *
 * Nothing here is durable. The files' durable state is still the sync round's (`collab::sync`); a
 * document is how the people with a file open stay on one text between rounds.
 */

/** Origin of changes that came from the channel: never sent back out. */
export const REMOTE = Symbol("cf-live-remote");

/** How long an opened document waits for someone to answer before seeding itself. */
const SYNC_WAIT_MS = 700;
const PRESENCE_EVERY_MS = 8_000;
const BATCH_MS = 30;
const TURN_EVERY_MS = 300;

export class LiveDoc {
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: Awareness;
  refs = 0;
  private synced = false;
  private wake: (() => void) | null = null;
  /** Resolves once the document holds the session's text: someone answered, or nobody did in time. */
  readonly ready: Promise<void>;

  constructor(
    readonly id: string,
    readonly file: LiveFile,
  ) {
    this.text = this.doc.getText("t");
    this.awareness = new Awareness(this.doc);
    this.ready = new Promise<void>((resolve) => {
      this.wake = resolve;
      setTimeout(resolve, SYNC_WAIT_MS);
    });
  }

  markSynced(): void {
    if (this.synced) return;
    this.synced = true;
    this.wake?.();
  }

  /** Seeds an empty document with `text` (see the class comment). Does nothing to one with content. */
  seed(text: string): void {
    if (this.text.length > 0 || text === "") return;
    const first = new Y.Doc();
    first.clientID = seedClientId(text);
    first.getText("t").insert(0, text);
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(first), "seed");
    first.destroy();
  }

  /** Makes the document's text `next` with the smallest replacement. Returns whether it changed. */
  replaceWith(next: string, origin: unknown): boolean {
    const edit = minimalEdit(this.text.toString(), next);
    if (!edit) return false;
    this.doc.transact(() => {
      if (edit.remove > 0) this.text.delete(edit.index, edit.remove);
      if (edit.insert) this.text.insert(edit.index, edit.insert);
    }, origin);
    return true;
  }

  /** Whether `personId` has this document open on some other machine right now. */
  hasPerson(personId: string): boolean {
    for (const [client, state] of this.awareness.getStates()) {
      if (client !== this.doc.clientID && (state as { person?: string }).person === personId) return true;
    }
    return false;
  }
}

export interface LiveConnectionInfo {
  url: string;
  anonKey: string;
}

export class LiveSession {
  private client: RealtimeClient | null = null;
  private channel: RealtimeChannel | null = null;
  private key: CryptoKey | null = null;
  private channelKey: string | null = null;
  private connected = false;
  private generation = 0;
  private readonly docs = new Map<string, LiveDoc>();
  private readonly reassembler = new Reassembler();
  private readonly batches = new Map<string, { updates: Uint8Array[]; timer: ReturnType<typeof setTimeout> }>();
  private sending: Promise<void> = Promise.resolve();
  private focus: LiveFile | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private turn: { text: string; engine: string | null; done: boolean } | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTurnSent = 0;

  constructor(
    readonly sessionId: string,
    readonly me: Peer,
    private readonly connection: LiveConnectionInfo,
  ) {}

  /** Connects with a channel key, or reconnects when it rotated. */
  async setChannelKey(channelKey: string | null): Promise<void> {
    if (!channelKey || channelKey === this.channelKey) return;
    this.channelKey = channelKey;
    this.teardown();
    const generation = ++this.generation;
    const [key, topic] = await Promise.all([sealingKey(channelKey), topicOf(channelKey)]);
    if (generation !== this.generation) return;
    this.key = key;
    const endpoint = `${this.connection.url.replace(/^http/, "ws")}/realtime/v1`;
    const client = new RealtimeClient(endpoint, { params: { apikey: this.connection.anonKey } });
    const channel = client.channel(topic, { config: { broadcast: { self: false, ack: false } } });
    channel.on("broadcast", { event: "m" }, ({ payload }) => void this.receive(payload as Envelope, generation));
    channel.subscribe((status) => {
      if (generation !== this.generation) return;
      const up = status === "SUBSCRIBED";
      this.connected = up;
      patchLiveSession(this.sessionId, (s) => ({ ...s, connected: up }));
      if (!up) return;
      this.send({ k: "hello", from: this.me });
      this.sendHere();
      // Back after a drop: everyone's documents catch up both ways.
      for (const doc of this.docs.values()) this.send({ k: "s1", doc: doc.id, sv: toBase64(Y.encodeStateVector(doc.doc)), reply: true });
    });
    this.client = client;
    this.channel = channel;
    this.presenceTimer = setInterval(() => this.sendHere(), PRESENCE_EVERY_MS);
  }

  private teardown(): void {
    this.connected = false;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    if (this.channel && this.client) void this.client.removeChannel(this.channel);
    this.client?.disconnect();
    this.client = null;
    this.channel = null;
    patchLiveSession(this.sessionId, (s) => ({ ...s, connected: false }));
  }

  dispose(): void {
    if (this.connected) this.send({ k: "bye", from: this.me });
    // Let the goodbye leave before the socket closes.
    const docs = [...this.docs.values()];
    this.docs.clear();
    setTimeout(() => {
      this.generation++;
      this.teardown();
      for (const doc of docs) doc.doc.destroy();
    }, 150);
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  private send(message: LiveMessage): void {
    const key = this.key;
    const channel = this.channel;
    if (!this.connected || !key || !channel) return;
    // One after another: sealing is asynchronous, and the parts of a large message must not interleave.
    this.sending = this.sending
      .then(async () => {
        const sealed = await seal(key, message);
        for (const payload of split(sealed, crypto.randomUUID())) {
          await channel.send({ type: "broadcast", event: "m", payload });
        }
      })
      .catch(() => {});
  }

  private sendHere(): void {
    this.send({ k: "here", from: this.me, file: this.focus });
  }

  /** The file this person is looking at, for the others' avatars and «Seguir». */
  setFocus(file: LiveFile | null): void {
    if (this.focus?.repoKey === file?.repoKey && this.focus?.path === file?.path) return;
    this.focus = file;
    this.sendHere();
  }

  /** Stops saying this person is in `file`, if that is where they were. */
  clearFocus(file: LiveFile): void {
    if (this.focus?.repoKey === file.repoKey && this.focus?.path === file.path) this.setFocus(null);
  }

  /** The answer this person's engine is writing, relayed a few times a second. */
  relayTurn(text: string, engine: string | null, done: boolean): void {
    this.turn = { text, engine, done };
    // The end goes out at once: nobody should watch a finished answer spin for another beat.
    if (done && this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    if (this.turnTimer) return;
    const wait = done ? 0 : Math.max(0, TURN_EVERY_MS - (Date.now() - this.lastTurnSent));
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      const turn = this.turn;
      if (!turn) return;
      this.lastTurnSent = Date.now();
      this.send({ k: "turn", from: this.me, ...turn });
    }, wait);
  }

  private queueUpdate(doc: string, update: Uint8Array): void {
    const batch = this.batches.get(doc);
    if (batch) {
      batch.updates.push(update);
      return;
    }
    this.batches.set(doc, {
      updates: [update],
      timer: setTimeout(() => {
        const done = this.batches.get(doc);
        this.batches.delete(doc);
        if (!done) return;
        this.send({ k: "up", doc, up: toBase64(Y.mergeUpdates(done.updates)) });
      }, BATCH_MS),
    });
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  private async receive(envelope: Envelope, generation: number): Promise<void> {
    const key = this.key;
    if (!key || generation !== this.generation || !envelope || typeof envelope !== "object") return;
    const sealed = this.reassembler.push(envelope);
    if (!sealed) return;
    const message = await open(key, sealed);
    if (!message || generation !== this.generation) return;
    const now = Date.now();
    switch (message.k) {
      case "hello":
        this.notePeer(message.from, null, now);
        this.sendHere();
        return;
      case "here":
        this.notePeer(message.from, message.file, now);
        return;
      case "bye":
        patchLiveSession(this.sessionId, (s) => {
          const { [message.from.id]: _gone, ...peers } = s.peers;
          return { ...s, peers };
        });
        return;
      case "turn":
        patchLiveSession(this.sessionId, (s) => ({
          ...s,
          turns: { ...s.turns, [message.from.id]: { nick: message.from.nick, text: message.text, engine: message.engine, done: message.done, at: now } },
        }));
        return;
      case "s1": {
        const doc = this.docs.get(message.doc);
        if (!doc) return;
        this.send({ k: "s2", doc: doc.id, up: toBase64(Y.encodeStateAsUpdate(doc.doc, fromBase64(message.sv))) });
        if (message.reply) this.send({ k: "s1", doc: doc.id, sv: toBase64(Y.encodeStateVector(doc.doc)), reply: false });
        // So the newcomer sees this cursor without waiting for it to move.
        this.send({ k: "aw", doc: doc.id, up: toBase64(encodeAwarenessUpdate(doc.awareness, [doc.doc.clientID])) });
        return;
      }
      case "s2":
      case "up": {
        const doc = this.docs.get(message.doc);
        if (!doc) return;
        Y.applyUpdate(doc.doc, fromBase64(message.up), REMOTE);
        if (doc.text.length > 0) doc.markSynced();
        return;
      }
      case "aw": {
        const doc = this.docs.get(message.doc);
        if (doc) applyAwarenessUpdate(doc.awareness, fromBase64(message.up), REMOTE);
        return;
      }
    }
  }

  private notePeer(from: Peer, file: LiveFile | null, at: number): void {
    if (from.id === this.me.id) return;
    patchLiveSession(this.sessionId, (s) => ({ ...s, peers: { ...s.peers, [from.id]: { nick: from.nick, file, at } } }));
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  /** Opens (or takes another reference to) a file's document. */
  openDoc(file: LiveFile, hue: number): LiveDoc {
    const id = docId(file);
    const existing = this.docs.get(id);
    if (existing) {
      existing.refs++;
      return existing;
    }
    const doc = new LiveDoc(id, file);
    doc.refs = 1;
    doc.awareness.setLocalState({ person: this.me.id, nick: this.me.nick, hue });
    doc.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) this.queueUpdate(id, update);
    });
    doc.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === REMOTE) return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length) this.send({ k: "aw", doc: id, up: toBase64(encodeAwarenessUpdate(doc.awareness, changed)) });
    });
    this.docs.set(id, doc);
    this.send({ k: "s1", doc: id, sv: toBase64(Y.encodeStateVector(doc.doc)), reply: true });
    return doc;
  }

  closeDoc(doc: LiveDoc): void {
    if (--doc.refs > 0) return;
    this.docs.delete(doc.id);
    removeAwarenessStates(doc.awareness, [doc.doc.clientID], "local");
    const batch = this.batches.get(doc.id);
    if (batch) {
      clearTimeout(batch.timer);
      this.batches.delete(doc.id);
      this.send({ k: "up", doc: doc.id, up: toBase64(Y.mergeUpdates(batch.updates)) });
    }
    setTimeout(() => doc.doc.destroy(), 200);
  }

  /** The files open live here, for the sync round (`collab_tick`'s `live`). */
  liveFiles(): LiveFile[] {
    return [...this.docs.values()].map((d) => d.file);
  }

  /**
   * What the sync round found in the session for a file open live here. Merged into the document,
   * unless its author has the document open too: then the change already came through the channel,
   * and what the round read is only an older save of it. One's own earlier saves are dropped the same
   * way.
   */
  mergeRemote(file: LiveFile, text: string | null, updatedBy: string | null): void {
    const doc = this.docs.get(docId(file));
    if (!doc || text === null) return;
    if (updatedBy && (updatedBy === this.me.id || doc.hasPerson(updatedBy))) return;
    doc.replaceWith(text, "sync");
  }
}
