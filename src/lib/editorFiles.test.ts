import { describe, expect, it } from "vitest";
import {
  CHANGED_ON_DISK,
  describePath,
  failedLoad,
  isChangedOnDisk,
  isWritable,
  loadedFrom,
  MAX_EDITOR_READ_BYTES,
  sameDiskContent,
  sameLoadedState,
  sweepStep,
} from "./editorFiles";
import type { DiskVersion } from "./tauri/commands";

/**
 * The rules that decide what an editor tab *is* — a buffer, or something shown and never written.
 * Every one of them guards a file against being overwritten with something that is not its content.
 */

const version = (hash: string, size = 3, mtime_ms = 1): DiskVersion => ({ hash, size, mtime_ms });

describe("loadedFrom", () => {
  it("makes text an editable buffer that remembers the version it was read at", () => {
    const loaded = loadedFrom({ kind: "text", text: "abc", version: version("h1") });
    expect(loaded).toEqual({ content: "abc", version: version("h1"), notice: null, readOnly: null });
    expect(isWritable(loaded)).toBe(true);
  });

  it("shows another encoding decoded, and never as something a save would write", () => {
    const loaded = loadedFrom({ kind: "legacy", text: "café", encoding: "windows-1252", version: version("h") });
    expect(loaded.content).toBe("café");
    expect(loaded.readOnly).toEqual({ kind: "encoding", encoding: "windows-1252" });
    expect(isWritable(loaded)).toBe(false);
  });

  it("keeps text past the read cap read-only — it can only have been opened anyway", () => {
    const big = loadedFrom({ kind: "text", text: "x", version: version("h", MAX_EDITOR_READ_BYTES + 1) });
    expect(big.readOnly).toEqual({ kind: "large" });
    expect(isWritable(big)).toBe(false);
  });

  it("gives an image, a binary and a file too large to read no buffer at all", () => {
    const image = loadedFrom({ kind: "image", mime: "image/png", base64: "iVBOR", version: version("h", 5) });
    expect(image.content).toBe("");
    expect(image.notice).toEqual({ kind: "image", src: "data:image/png;base64,iVBOR", mime: "image/png", size: 5 });

    const binary = loadedFrom({ kind: "binary", size: 9, version: version("h", 9) });
    expect(binary).toMatchObject({ content: "", notice: { kind: "binary", size: 9 } });

    const large = loadedFrom({ kind: "tooLarge", size: 99, can_force: true, version: version("", 99) });
    expect(large).toMatchObject({ content: "", notice: { kind: "tooLarge", size: 99, canForce: true } });

    for (const loaded of [image, binary, large]) expect(isWritable(loaded)).toBe(false);
  });

  it("turns a read that failed into a notice, never into a buffer holding the error", () => {
    const failed = failedLoad("permission denied");
    expect(failed.content).toBe("");
    expect(failed.notice).toEqual({ kind: "error", message: "permission denied" });
    expect(failed.version).toBeNull();
    expect(isWritable(failed)).toBe(false);
  });
});

describe("isChangedOnDisk", () => {
  it("recognises the backend's refusal, wrapped or not, and nothing else", () => {
    const refusal = `${CHANGED_ON_DISK}: src/a.ts changed on disk since it was opened`;
    expect(isChangedOnDisk(refusal)).toBe(true);
    expect(isChangedOnDisk(new Error(refusal))).toBe(true);
    expect(isChangedOnDisk("No space left on device (os error 28)")).toBe(false);
    expect(isChangedOnDisk("changed-on-disk")).toBe(false);
  });
});

describe("sameDiskContent", () => {
  it("is decided by the bytes, not by the timestamp", () => {
    expect(sameDiskContent(version("h", 3, 1), version("h", 3, 99))).toBe(true);
    expect(sameDiskContent(version("h", 3, 1), version("g", 3, 1))).toBe(false);
    expect(sameDiskContent(version("h", 3), version("h", 4))).toBe(false);
  });

  it("falls back to the stamp for a file too large to hash", () => {
    expect(sameDiskContent(version("", 50, 1), version("", 50, 1))).toBe(true);
    expect(sameDiskContent(version("", 50, 1), version("", 50, 2))).toBe(false);
  });

  it("treats a file that is gone as a change, and two absences as the same", () => {
    expect(sameDiskContent(null, version("h"))).toBe(false);
    expect(sameDiskContent(version("h"), null)).toBe(false);
    expect(sameDiskContent(null, null)).toBe(true);
  });
});

describe("sameLoadedState", () => {
  const tab = { version: version("h"), notice: null, readOnly: null };

  it("says a re-read of the same bytes changes nothing", () => {
    expect(sameLoadedState(tab, loadedFrom({ kind: "text", text: "abc", version: version("h", 3, 50) }))).toBe(true);
    expect(sameLoadedState(tab, loadedFrom({ kind: "text", text: "abd", version: version("g") }))).toBe(false);
  });

  it("notices a file that became something else under the same bytes' version", () => {
    expect(sameLoadedState(tab, loadedFrom({ kind: "binary", size: 3, version: version("h") }))).toBe(false);
  });

  it("compares errors by their message, so a repeated failure is not an update", () => {
    const failed = { version: null, notice: { kind: "error" as const, message: "denied" }, readOnly: null };
    expect(sameLoadedState(failed, failedLoad("denied"))).toBe(true);
    expect(sameLoadedState(failed, failedLoad("gone"))).toBe(false);
  });
});

describe("sweepStep", () => {
  const clean = { version: version("h", 3, 1), notice: null, diskChanged: false };

  it("leaves a tab alone when the file is what it holds — the common case, which must not write state", () => {
    expect(sweepStep(clean, false, version("h", 3, 1))).toEqual({ kind: "none" });
    expect(sweepStep(clean, true, version("h", 3, 1))).toEqual({ kind: "none" });
  });

  it("reloads a clean tab whose file changed, and never a dirty one — that one is marked instead", () => {
    expect(sweepStep(clean, false, version("g", 3, 2))).toEqual({ kind: "reload" });
    // The version stays the one the buffer started from: a save must still see the change and ask.
    expect(sweepStep(clean, true, version("g", 3, 2))).toEqual({
      kind: "mark",
      diskChanged: true,
      version: version("h", 3, 1),
    });
  });

  it("takes the mark off again when the file changes back", () => {
    const marked = { ...clean, diskChanged: true };
    expect(sweepStep(marked, true, version("h", 3, 1))).toEqual({
      kind: "mark",
      diskChanged: false,
      version: version("h", 3, 1),
    });
    expect(sweepStep(marked, true, version("g", 3, 1))).toEqual({ kind: "none" });
  });

  it("keeps a newer stamp on the same bytes, so the next sweep is a bare stat", () => {
    expect(sweepStep(clean, false, version("h", 3, 9))).toEqual({ kind: "stamp", version: version("h", 3, 9) });
    expect(sweepStep(clean, true, version("h", 3, 9))).toEqual({
      kind: "mark",
      diskChanged: false,
      version: version("h", 3, 9),
    });
  });

  it("keeps what a clean text tab last read when its file is gone, and marks a dirty one", () => {
    expect(sweepStep(clean, false, null)).toEqual({ kind: "none" });
    expect(sweepStep(clean, true, null)).toMatchObject({ kind: "mark", diskChanged: true });
  });

  it("reads a notice again when its file appears or changes", () => {
    const failed = { version: null, notice: { kind: "error" as const, message: "gone" }, diskChanged: false };
    expect(sweepStep(failed, false, version("h"))).toEqual({ kind: "reload" });
    expect(sweepStep(failed, false, null)).toEqual({ kind: "none" });
    const image = { version: version("h"), notice: { kind: "binary" as const, size: 3 }, diskChanged: false };
    expect(sweepStep(image, false, null)).toEqual({ kind: "reload" });
  });
});

describe("describePath", () => {
  it("splits a path into the name and the folder it is in", () => {
    expect(describePath("src/lib/a.ts")).toEqual({ name: "a.ts", dir: "src/lib" });
    expect(describePath("README.md")).toEqual({ name: "README.md", dir: "" });
  });
});
