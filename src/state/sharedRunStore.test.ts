import { describe, expect, it } from "vitest";
import { freshOffers, guestViews, waitingOffers } from "./sharedRunStore";
import { authorName, isExternal } from "../lib/team/externalNotes";
import type { CollabRunTick, CollabRemoteTask } from "../lib/tauri/collabRunCommands";
import type { CollabSessionView } from "../lib/tauri/collabCommands";

const offer = (itemId: string, attempt = 1): CollabRemoteTask => ({
  itemId,
  attempt,
  memberId: "tests",
  personId: "pb",
  repoKey: "github.com/acme/api",
  kind: "work",
  title: "Pruebas",
  message: "…",
  writes: true,
  target: "main",
  startSha: "a".repeat(40),
  status: "offered",
  updatedAt: "",
});

const tick = (owner: boolean, offers: CollabRemoteTask[], sessionId = "s1"): CollabRunTick => ({
  sessionId,
  owner,
  ended: false,
  people: [],
  seats: [],
  run: null,
  offers,
  jobs: [],
  errors: [],
});

describe("shared run offers", () => {
  it("announces each offer once, and a retry again", () => {
    const seen = new Set<string>();
    const first = freshOffers(tick(false, [offer("i1"), offer("i2")]), seen);
    expect(first).toHaveLength(2);
    first.forEach((k) => seen.add(k));
    expect(freshOffers(tick(false, [offer("i1"), offer("i2")]), seen)).toEqual([]);
    expect(freshOffers(tick(false, [offer("i1", 2)]), seen)).toHaveLength(1);
  });

  it("never announces on the owner's machine", () => {
    expect(freshOffers(tick(true, [offer("i1")]), new Set())).toEqual([]);
  });

  it("counts what waits for this person across runs", () => {
    expect(waitingOffers({ s1: tick(false, [offer("a")]), s2: tick(false, [offer("b"), offer("c")], "s2"), s3: tick(true, [offer("d")], "s3") })).toBe(3);
  });

  it("lists only the runs shared with this person", () => {
    const view = (id: string, isOwner: boolean) => ({ session: { id }, isOwner }) as unknown as CollabSessionView;
    expect(guestViews({ a: view("a", true), b: view("b", false) }).map((v) => v.session.id)).toEqual(["b"]);
  });
});

describe("external messages", () => {
  it("are recognised by their marker, which the name drops", () => {
    expect(isExternal("Beto (externo)")).toBe(true);
    expect(isExternal("Tests · Beto (externo)")).toBe(true);
    expect(isExternal("Backend")).toBe(false);
    expect(authorName("Tests · Beto (externo)")).toBe("Tests · Beto");
    expect(authorName("Backend")).toBe("Backend");
  });
});
