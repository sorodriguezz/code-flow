import { describe, expect, it } from "vitest";
import {
  binaryToText,
  compressToBase64,
  decodeBase64,
  decodeHtmlEntities,
  decodeQuotedPrintable,
  decodeUrl,
  decompressFromBase64,
  domainToAscii,
  domainToUnicode,
  encodeBase64,
  encodeHtmlEntities,
  encodeQuotedPrintable,
  encodeUrl,
  escapeUnicode,
  hexToText,
  parseDataUri,
  punycodeDecode,
  punycodeEncode,
  textToBinary,
  textToHex,
  unescapeUnicode,
} from "./encoding";

describe("Base64", () => {
  it("encodes UTF-8, not Latin-1", () => {
    expect(encodeBase64("ñ")).toBe("w7E=");
    expect(encodeBase64("hello world")).toBe("aGVsbG8gd29ybGQ=");
  });
  it("writes and reads Base64URL without padding", () => {
    const text = "¿?>>";
    const url = encodeBase64(text, true);
    expect(url).not.toMatch(/[+/=]/);
    expect(decodeBase64(url)).toBe(text);
  });
  it("tolerates whitespace and missing padding, refuses garbage", () => {
    expect(decodeBase64("aGVs\nbG8")).toBe("hello");
    expect(() => decodeBase64("***")).toThrow();
  });
  it("reads a data URI", () => {
    expect(parseDataUri("data:image/png;base64,AAAA")).toEqual({ mime: "image/png", base64: "AAAA" });
    expect(parseDataUri("hello")).toBeNull();
  });
});

describe("URL", () => {
  it("component vs full", () => {
    expect(encodeUrl("a b&c/d", "component")).toBe("a%20b%26c%2Fd");
    expect(encodeUrl("https://x.cl/a b?q=1&r=ñ", "full")).toBe("https://x.cl/a%20b?q=1&r=%C3%B1");
  });
  it("decodes + as a space when asked", () => {
    expect(decodeUrl("a+b%20c")).toBe("a b c");
    expect(decodeUrl("a+b", false)).toBe("a+b");
    expect(() => decodeUrl("%E0%A4%A")).toThrow();
  });
});

describe("HTML entities", () => {
  it("round-trips", () => {
    const s = `<a href="x">Tom & 'Jerry'</a>`;
    expect(encodeHtmlEntities(s)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
    expect(decodeHtmlEntities(encodeHtmlEntities(s))).toBe(s);
  });
  it("named, decimal and hex entities; non-ASCII on request", () => {
    expect(decodeHtmlEntities("&ntilde;&#241;&#xF1;&unknown;")).toBe("ññ&#xF1;&unknown;".replace("&#xF1;", "ñ"));
    expect(encodeHtmlEntities("é", true)).toBe("&#xE9;");
  });
});

describe("Unicode escapes", () => {
  it("uses surrogate pairs for \\u and one escape for \\u{}", () => {
    expect(escapeUnicode("a😀")).toBe("a\\uD83D\\uDE00");
    expect(escapeUnicode("😀", "braces")).toBe("\\u{1F600}");
    expect(unescapeUnicode("\\uD83D\\uDE00 \\u{1F600} \\x41")).toBe("😀 😀 A");
  });
});

describe("hex and binary", () => {
  it("are UTF-8 bytes", () => {
    expect(textToHex("Añ")).toBe("41 c3 b1");
    expect(hexToText("0x41:C3:B1")).toBe("Añ");
    expect(() => hexToText("abc")).toThrow();
    expect(textToBinary("A")).toBe("01000001");
    expect(binaryToText("0100000101000010")).toBe("AB");
    expect(binaryToText("01000001 01000010")).toBe("AB");
  });
});

describe("quoted-printable", () => {
  it("encodes non-ASCII and = and breaks long lines softly", () => {
    expect(encodeQuotedPrintable("café = ok")).toBe("caf=C3=A9 =3D ok");
    const long = "x".repeat(200);
    const qp = encodeQuotedPrintable(long);
    expect(qp.split("\r\n").every((l) => l.length <= 76)).toBe(true);
    expect(decodeQuotedPrintable(qp)).toBe(long);
    expect(decodeQuotedPrintable("caf=C3=A9 =\r\nseguido")).toBe("café seguido");
  });
});

describe("Punycode", () => {
  it("matches RFC 3492 and the URL parser", () => {
    expect(punycodeEncode("bücher")).toBe("bcher-kva");
    expect(punycodeDecode("bcher-kva")).toBe("bücher");
    expect(domainToAscii("ñandú.cl")).toBe(new URL("http://ñandú.cl").hostname);
    expect(domainToUnicode(domainToAscii("mañana.example.com"))).toBe("mañana.example.com");
    expect(domainToUnicode("xn--wgv71a119e.jp")).toBe("日本語.jp");
  });
});

describe("gzip / deflate", () => {
  it("round-trips each format", async () => {
    for (const kind of ["gzip", "deflate", "deflate-raw"] as const) {
      const packed = await compressToBase64("hola hola hola ñ", kind);
      expect(await decompressFromBase64(packed, kind)).toBe("hola hola hola ñ");
    }
  });
  it("says when the data is not compressed", async () => {
    await expect(decompressFromBase64("aGVsbG8=", "gzip")).rejects.toThrow();
  });
});
