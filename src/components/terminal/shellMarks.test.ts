import { describe, expect, it } from "vitest";
import { formatDuration, parseOsc133, parseOsc633, parseOsc7 } from "./shellMarks";

describe("shell marks", () => {
  it("reads the command marks", () => {
    expect(parseOsc133("A")).toEqual({ kind: "prompt" });
    expect(parseOsc133("C")).toEqual({ kind: "start" });
    expect(parseOsc133("D;3")).toEqual({ kind: "end", exit: 3 });
    expect(parseOsc133("D")).toEqual({ kind: "end", exit: null });
    expect(parseOsc133("B")).toBeNull();
  });

  it("decodes the command line as UTF-8", () => {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode("echo ñandú")));
    expect(parseOsc633(`E;${b64}`)).toBe("echo ñandú");
    expect(parseOsc633("E;%%%")).toBeNull();
    expect(parseOsc633("P;Cwd=/x")).toBeNull();
  });

  it("reads the folder, unix and Windows", () => {
    expect(parseOsc7("file://mac.local/Users/me/my%20repo")).toBe("/Users/me/my repo");
    expect(parseOsc7("file:///C:/Users/me/repo")).toBe("C:\\Users\\me\\repo");
    expect(parseOsc7("nonsense")).toBeNull();
  });

  it("says how long a command took", () => {
    expect(formatDuration(8_200)).toBe("8 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatDuration(3_780_000)).toBe("1 h 3 min");
  });
});
