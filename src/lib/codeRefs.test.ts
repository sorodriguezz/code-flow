import { describe, expect, it } from "vitest";
import { markCodeRefs, pathsFromToolArgs, resolveCodeRef } from "./codeRefs";

describe("markCodeRefs", () => {
  it("marks a path with a line", () => {
    expect(markCodeRefs("<p>see <code>src/a/b.ts:42</code></p>")).toBe('<p>see <code class="cf-code-ref" data-ref="src/a/b.ts" data-line="42">src/a/b.ts:42</code></p>');
  });

  it("marks a bare file", () => {
    expect(markCodeRefs("<code>Cargo.toml</code>")).toContain('data-ref="Cargo.toml"');
  });

  it("leaves calls, plain words and code blocks alone", () => {
    for (const html of ["<code>foo.bar()</code>", "<code>npm run build</code>", "<code>a/b</code>", "<pre><code>src/a.ts:3</code></pre>"]) {
      expect(markCodeRefs(html)).toBe(html);
    }
  });
});

describe("resolveCodeRef", () => {
  const paths = ["/repo/src/app/dto/trakcare.dto.ts", "/repo/src/data.ts", "C:\\repo\\src\\win.ts"];

  it("finds the full path of a bare or partial name", () => {
    expect(resolveCodeRef("trakcare.dto.ts", paths)).toBe("/repo/src/app/dto/trakcare.dto.ts");
    expect(resolveCodeRef("dto/trakcare.dto.ts", paths)).toBe("/repo/src/app/dto/trakcare.dto.ts");
    expect(resolveCodeRef("src/win.ts", paths)).toBe("C:\\repo\\src\\win.ts");
  });

  it("matches whole segments only and gives null when nothing fits", () => {
    expect(resolveCodeRef("a.ts", paths)).toBeNull();
    expect(resolveCodeRef("other.ts", paths)).toBeNull();
  });

  it("joins a folder-qualified reference to the repository, never a bare name", () => {
    expect(resolveCodeRef("src/lib/x.ts", paths, "/Users/me/repo/")).toBe("/Users/me/repo/src/lib/x.ts");
    expect(resolveCodeRef("x.ts", paths, "/Users/me/repo")).toBeNull();
    // What the turn touched still wins over the guess.
    expect(resolveCodeRef("dto/trakcare.dto.ts", paths, "/other")).toBe("/repo/src/app/dto/trakcare.dto.ts");
  });
});

describe("pathsFromToolArgs", () => {
  it("takes the paths out of commands, quoted ones and $HOME included", () => {
    const args = [
      'sqlite3 -readonly "$HOME/Library/Application Support/CodeFlow/codeflow.db" "SELECT 1;"',
      "cat src/a.ts && ls",
      "https://example.com/x.html",
      "src/very/long/cut…",
    ];
    const found = pathsFromToolArgs(args);
    expect(found).toContain("~/Library/Application Support/CodeFlow/codeflow.db");
    expect(found).toContain("src/a.ts");
    expect(found.some((p) => p.startsWith("http"))).toBe(false);
    expect(found.some((p) => p.endsWith("…"))).toBe(false);
    expect(resolveCodeRef("codeflow.db", found)).toBe("~/Library/Application Support/CodeFlow/codeflow.db");
  });
});
