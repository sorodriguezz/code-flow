import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Here rather than in the release job, which only finds out at the signing step — after a full
// macOS build of half an hour (v2.3.18, 2026-10-09).
const plist = readFileSync(new URL("../src-tauri/Entitlements.plist", import.meta.url), "utf8");

describe("the macOS entitlements", () => {
  // codesign's parser (AMFIUnserializeXML) keeps XML's rule that a comment holds no `--`, and fails
  // the signature on one ("syntax error near line N") while `plutil -lint` passes the file.
  it("has no double hyphen inside a comment", () => {
    const comments = [...plist.matchAll(/<!--([\s\S]*?)-->/g)].map((match) => match[1]);
    for (const comment of comments) {
      const line = comment.split("\n").find((text) => text.includes("--"));
      expect(line, `codesign rejects "--" in a comment: ${line}`).toBeUndefined();
    }
  });

  it("still claims the microphone and the downloaded libraries", () => {
    expect(plist).toMatch(/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\/>/);
  });
});
