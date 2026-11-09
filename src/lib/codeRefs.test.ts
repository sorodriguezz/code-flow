import { describe, expect, it } from "vitest";
import { markCodeRefs, resolveCodeRef } from "./codeRefs";

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
});
