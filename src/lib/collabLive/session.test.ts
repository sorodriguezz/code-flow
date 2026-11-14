import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Two people's live sessions over an in-memory stand-in for Realtime Broadcast: same topic, same
 * channel key, the real sealing, parts and sync protocol. What it cannot cover is Supabase itself.
 */

type Handler = (message: { payload: unknown }) => void;
const topics = new Map<string, Set<FakeChannel>>();

class FakeChannel {
  handler: Handler | null = null;
  constructor(readonly topic: string) {}
  on(_type: string, _filter: unknown, handler: Handler) {
    this.handler = handler;
    return this;
  }
  subscribe(callback: (status: string) => void) {
    const set = topics.get(this.topic) ?? new Set();
    set.add(this);
    topics.set(this.topic, set);
    setTimeout(() => callback("SUBSCRIBED"), 0);
    return this;
  }
  async send({ payload }: { payload: unknown }) {
    for (const other of topics.get(this.topic) ?? []) {
      // Broadcast with `self: false`, delivered a moment later, as a copy (it went over the wire).
      if (other !== this) setTimeout(() => other.handler?.({ payload: JSON.parse(JSON.stringify(payload)) }), 1);
    }
    return "ok";
  }
  leave() {
    topics.get(this.topic)?.delete(this);
  }
}

vi.mock("@supabase/realtime-js", () => ({
  RealtimeClient: class {
    channel(topic: string) {
      return new FakeChannel(topic);
    }
    async removeChannel(channel: FakeChannel) {
      channel.leave();
    }
    disconnect() {}
  },
}));

const { LiveSession } = await import("./session");
const { useLiveStore } = await import("../../state/liveStore");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const connection = { url: "https://example.supabase.co", anonKey: "anon" };
const file = { repoKey: "github.com/a/b", path: "src/app.ts" };

async function two(keyA = "secret", keyB = "secret") {
  const a = new LiveSession("s1", { id: "pa", nick: "Ana" }, connection);
  const b = new LiveSession("s1", { id: "pb", nick: "Beto" }, connection);
  await a.setChannelKey(keyA);
  await b.setChannelKey(keyB);
  await wait(20);
  return { a, b };
}

afterEach(() => {
  topics.clear();
  useLiveStore.setState({ sessions: {}, openFiles: {}, targets: 0 });
});

describe("LiveSession", () => {
  it("connects, says who is here and in which file", async () => {
    const { a } = await two();
    a.setFocus(file);
    await wait(30);
    const state = useLiveStore.getState().sessions.s1;
    expect(state.connected).toBe(true);
    expect(state.peers.pa?.nick).toBe("Ana");
    expect(state.peers.pa?.file).toEqual(file);
  });

  it("gives a newcomer the document, then carries edits both ways", async () => {
    const { a, b } = await two();
    const docA = a.openDoc(file, 10);
    await docA.ready;
    docA.seed("export const x = 1;\n");
    const docB = b.openDoc(file, 20);
    await docB.ready;
    expect(docB.text.toString()).toBe("export const x = 1;\n");

    docB.text.insert(0, "// shared\n");
    await wait(80);
    expect(docA.text.toString()).toBe("// shared\nexport const x = 1;\n");
    docA.replaceWith("// shared\nexport const x = 2;\n", "typed");
    await wait(80);
    expect(docB.text.toString()).toBe("// shared\nexport const x = 2;\n");
    expect(docB.hasPerson("pa")).toBe(true);
    expect(a.liveFiles()).toEqual([file]);
  });

  it("carries a document far larger than one broadcast", async () => {
    const { a, b } = await two();
    const big = "const line = 'abcdefghijklmnopqrstuvwxyz';\n".repeat(4000);
    const docA = a.openDoc(file, 10);
    await docA.ready;
    docA.seed(big);
    const docB = b.openDoc(file, 20);
    await docB.ready;
    expect(docB.text.length).toBe(big.length);
  });

  it("relays a turn as it is written", async () => {
    const { a } = await two();
    a.relayTurn("Voy a", "codex", false);
    await wait(30);
    a.relayTurn("Voy a cambiar el login", "codex", true);
    await wait(120);
    const turn = useLiveStore.getState().sessions.s1.turns.pa;
    expect(turn).toMatchObject({ nick: "Ana", text: "Voy a cambiar el login", engine: "codex", done: true });
  });

  it("hears nothing from someone holding an old channel key", async () => {
    const { a, b } = await two("new-key", "old-key");
    const docA = a.openDoc(file, 10);
    await docA.ready;
    docA.seed("private\n");
    const docB = b.openDoc(file, 20);
    await docB.ready;
    expect(docB.text.toString()).toBe("");
    expect(useLiveStore.getState().sessions.s1.peers.pa).toBeUndefined();
  });

  it("drops what the round read when the author has the document open", async () => {
    const { a, b } = await two();
    const docA = a.openDoc(file, 10);
    await docA.ready;
    docA.seed("v2 typed live\n");
    const docB = b.openDoc(file, 20);
    await docB.ready;
    await wait(30);
    // B's round read A's older save: A is in the document, so it is not merged.
    b.mergeRemote(file, "v1 saved\n", "pa");
    expect(docB.text.toString()).toBe("v2 typed live\n");
    // From someone not in it (their agent, the file closed on their side): merged.
    b.mergeRemote(file, "v2 typed live\nfrom C\n", "pc");
    expect(docB.text.toString()).toBe("v2 typed live\nfrom C\n");
  });
});
