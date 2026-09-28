import { describe, expect, it } from "vitest";
import { ansiToHtml, escapeHtml, stripAnsi } from "./ansi";

const ESC = "\u001b";

describe("ansiToHtml", () => {
  it("escapes the text before anything else", () => {
    expect(ansiToHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;",
    );
  });

  it("puts no byte of the text inside the markup it adds", () => {
    const hostile = `${ESC}[31m<img src=x onerror="alert(1)">${ESC}[0m"><b>`;
    const html = ansiToHtml(hostile);
    expect(html).toBe(
      '<span class="nb-ansi-fg-1">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</span>&quot;&gt;&lt;b&gt;',
    );
    // Only the tags this function writes survive as tags.
    expect(html.match(/<[a-z]/g)).toEqual(["<s"]);
  });

  it("cannot be steered into writing attributes through the escape parameters", () => {
    // Parameters that are not numbers are dropped; they never reach the output.
    const html = ansiToHtml(`${ESC}[38;2;255;0;0;"onmouseover=alert(1)mX`);
    expect(html).not.toContain("onmouseover");
    expect(ansiToHtml(`${ESC}[38;2;999;0;12mX${ESC}[0m`)).toBe('<span style="color: rgb(255, 0, 12)">X</span>');
    // A sequence that is not well-formed leaves no ESC behind in the text.
    expect(ansiToHtml(`${ESC}[38;2;-5mX`)).not.toContain(ESC);
  });

  it("renders IPython's traceback colours", () => {
    const line = `${ESC}[0;31mZeroDivisionError${ESC}[0m: division by zero`;
    expect(ansiToHtml(line)).toBe('<span class="nb-ansi-fg-1">ZeroDivisionError</span>: division by zero');
    const arrow = `${ESC}[1;32m----> 1${ESC}[0m 1${ESC}[38;5;241m/${ESC}[39m${ESC}[38;5;241m0${ESC}[39m`;
    expect(ansiToHtml(arrow)).toBe(
      '<span class="nb-ansi-fg-2 nb-ansi-bold">----&gt; 1</span> 1' +
        '<span style="color: rgb(98, 98, 98)">/</span><span style="color: rgb(98, 98, 98)">0</span>',
    );
  });

  it("maps bright, background and 256-colour escapes", () => {
    expect(ansiToHtml(`${ESC}[91;44mx`)).toBe('<span class="nb-ansi-fg-9 nb-ansi-bg-4">x</span>');
    expect(ansiToHtml(`${ESC}[38;5;3mx`)).toBe('<span class="nb-ansi-fg-3">x</span>');
    expect(ansiToHtml(`${ESC}[38;5;196mx`)).toBe('<span style="color: rgb(255, 0, 0)">x</span>');
    expect(ansiToHtml(`${ESC}[1mbold${ESC}[22m plain`)).toBe('<span class="nb-ansi-bold">bold</span> plain');
  });

  it("drops the escapes that are not colour", () => {
    expect(ansiToHtml(`a${ESC}[2Kb${ESC}[1Ac`)).toBe("abc");
    expect(ansiToHtml(`${ESC}]8;;https://example.test${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
    expect(ansiToHtml(`${ESC}]0;title\u0007text`)).toBe("text");
  });

  it("strips escapes for plain text", () => {
    expect(stripAnsi(`${ESC}[0;31mError${ESC}[0m: x`)).toBe("Error: x");
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });
});
