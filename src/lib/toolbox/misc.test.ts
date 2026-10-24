import { describe, expect, it } from "vitest";
import { convertCase, escapeText, inspectChars, lorem, processLines, slugify, splitWords, textStats, unescapeText } from "./text";
import { runRegex } from "./regex";
import { crc32, digest, formatDigest, hmac, md5 } from "./hash";
import { bytesToHex, utf8 } from "./encoding";
import { entropyBits, generatePassword, inspectUuid, nanoid, ulid, ulidTime, uuidV4, uuidV7 } from "./ids";
import { fakeRecords, formatRut, randomIban, randomRut, rutCheckDigit, seededRandom, validateIban, validateRut } from "./fake";
import { searchTools, TOOLS } from "./catalog";

describe("case", () => {
  it("splits identifiers and phrases", () => {
    expect(splitWords("HTTPServerError")).toEqual(["HTTP", "Server", "Error"]);
    expect(splitWords("user_id-2 fooBar")).toEqual(["user", "id", "2", "foo", "Bar"]);
  });
  it("converts to every style", () => {
    expect(convertCase("get user by ID", "camel")).toBe("getUserById");
    expect(convertCase("getUserById", "snake")).toBe("get_user_by_id");
    expect(convertCase("getUserById", "constant")).toBe("GET_USER_BY_ID");
    expect(convertCase("get_user_by_id", "pascal")).toBe("GetUserById");
    expect(convertCase("GetUserById", "kebab")).toBe("get-user-by-id");
    expect(convertCase("año nuevo", "title")).toBe("Año Nuevo");
    expect(convertCase("a_b\nc_d", "camel")).toBe("aB\ncD");
  });
});

describe("text", () => {
  it("counts", () => {
    const s = textStats("Hola mundo\n\nñ 👍🏽");
    expect(s.words).toBe(3);
    expect(s.lines).toBe(3);
    expect(s.paragraphs).toBe(2);
    expect(s.bytesUtf8).toBe(new TextEncoder().encode("Hola mundo\n\nñ 👍🏽").length);
    expect(s.graphemes).toBe(15);
  });
  it("processes lines", () => {
    const o = { sort: "natural" as const, dedupe: true, caseInsensitive: true, trim: true, removeEmpty: true };
    expect(processLines("b10\n b2\nB2\n\na1", o)).toBe("a1\nb2\nb10");
    expect(processLines("a\nb\nc", { ...o, sort: "reverse", dedupe: false })).toBe("c\nb\na");
  });
  it("escapes and unescapes", () => {
    expect(escapeText('di "hola"\n', "json")).toBe('di \\"hola\\"\\n');
    expect(unescapeText('di \\"hola\\"\\n', "json")).toBe('di "hola"\n');
    expect(escapeText("a.b*c", "regex")).toBe("a\\.b\\*c");
    expect(escapeText("O'Higgins", "sql")).toBe("'O''Higgins'");
    expect(unescapeText("'O''Higgins'", "sql")).toBe("O'Higgins");
    expect(escapeText("it's", "shell")).toBe("'it'\\''s'");
    expect(unescapeText(escapeText("it's", "shell"), "shell")).toBe("it's");
  });
  it("slugifies", () => {
    expect(slugify("¿Qué es el Árbol de Decisión? (2026)")).toBe("que-es-el-arbol-de-decision-2026");
    expect(slugify("Ñandú & Co", "_")).toBe("nandu_and_co");
  });
  it("generates lorem ipsum", () => {
    const r = seededRandom(1);
    expect(lorem(5, "words", true, r)).toBe("lorem ipsum dolor sit amet");
    expect(lorem(3, "paragraphs", true, r).split("\n\n")).toHaveLength(3);
  });
  it("flags invisible characters", () => {
    const chars = inspectChars("a​b ");
    expect(chars.filter((c) => c.suspicious).map((c) => c.label)).toEqual(["U+200B", "U+00A0"]);
    expect(chars[1].name).toBe("ZERO WIDTH SPACE");
  });
});

describe("regex", () => {
  it("returns matches with numbered and named groups", () => {
    const r = runRegex("(?<user>\\w+)@(\\w+)\\.cl", "g", "a@b.cl y c@d.cl", null);
    expect(r.matches.map((m) => m.value)).toEqual(["a@b.cl", "c@d.cl"]);
    expect(r.matches[1].groups).toEqual([
      { name: "user", value: "c", start: 9, end: 10 },
      { name: "2", value: "d", start: 11, end: 12 },
    ]);
  });
  it("survives zero-length matches and applies replacements", () => {
    expect(runRegex("x*", "g", "abc", null).matches).toHaveLength(4);
    expect(runRegex("(\\d+)", "g", "a1b22", "<$1>", 10).replaced).toBe("a<1>b<22>");
    expect(runRegex("a", "", "aaa", null).matches).toHaveLength(1);
    expect(() => runRegex("(", "g", "x", null)).toThrow();
  });
});

describe("hashes", () => {
  it("MD5 and CRC32 match the reference vectors", () => {
    expect(bytesToHex(md5(utf8("")))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(bytesToHex(md5(utf8("The quick brown fox jumps over the lazy dog")))).toBe("9e107d9d372bb6826bd81d3542a419d6");
    expect(bytesToHex(md5(utf8("a".repeat(1000))))).toBe("cabe45dcc9ae5b66ba86600cca6b8ba8");
    expect(crc32(utf8("123456789")).toString(16)).toBe("cbf43926");
  });
  it("SHA and HMAC via WebCrypto", async () => {
    expect(formatDigest(await digest("SHA-256", utf8("abc")), "hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(formatDigest(await digest("CRC32", utf8("123456789")), "HEX")).toBe("CBF43926");
    // RFC 4231 test case 2.
    expect(bytesToHex(await hmac("SHA-256", utf8("Jefe"), utf8("what do ya want for nothing?")))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("ids", () => {
  it("UUID v4 and v7 have their version and variant", () => {
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const at = Date.UTC(2026, 9, 23, 12);
    const v7 = uuidV7(at);
    expect(inspectUuid(v7)).toEqual({ version: 7, variant: "RFC 9562", date: new Date(at) });
    expect(inspectUuid("not-a-uuid")).toBeNull();
  });
  it("reads a v1 timestamp", () => {
    // The v1 example of RFC 9562 (appendix A.1): 2022-02-22 14:22:22 at UTC-5.
    expect(inspectUuid("C232AB00-9414-11EC-B3C8-9F6BDECED846")?.date?.toISOString()).toBe("2022-02-22T19:22:22.000Z");
  });
  it("ULID encodes time; nanoid has its size", () => {
    const at = 1469918176385;
    const id = ulid(at);
    expect(id).toHaveLength(26);
    expect(id.slice(0, 10)).toBe("01ARYZ6S41");
    expect(ulidTime(id)?.getTime()).toBe(at);
    expect(nanoid()).toMatch(/^[\w-]{21}$/);
  });
  it("passwords include every chosen set", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword({ length: 8, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: true });
      expect(p).toHaveLength(8);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/\d/);
      expect(p).not.toMatch(/[0O1lI]/);
    }
    expect(Math.round(entropyBits(62, 20))).toBe(119);
  });
});

describe("RUT and fixtures", () => {
  it("computes the check digit", () => {
    expect(rutCheckDigit("12345678")).toBe("5");
    expect(rutCheckDigit(11111111)).toBe("1");
    expect(rutCheckDigit("10000013")).toBe("K");
    expect(rutCheckDigit("1000013")).toBe("0");
    expect(formatRut("12345678")).toBe("12.345.678-5");
  });
  it("validates in any common spelling", () => {
    expect(validateRut("12.345.678-5").valid).toBe(true);
    expect(validateRut("123456785").valid).toBe(true);
    expect(validateRut("10.000.013-k").valid).toBe(true);
    expect(validateRut("12.345.678-9")).toMatchObject({ valid: false, expected: "5" });
    expect(validateRut("hola").valid).toBe(false);
  });
  it("generates valid RUTs and IBANs, reproducibly with a seed", () => {
    const r = seededRandom(42);
    for (let i = 0; i < 100; i++) expect(validateRut(randomRut(r)).valid).toBe(true);
    for (let i = 0; i < 20; i++) expect(validateIban(randomIban(r))).toBe(true);
    expect(validateIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(validateIban("GB82 WEST 1234 5698 7654 33")).toBe(false);
    expect(fakeRecords(["name", "email", "rut"], 3, 7)).toEqual(fakeRecords(["name", "email", "rut"], 3, 7));
    const [rec] = fakeRecords(["email"], 1, 3);
    expect(String(rec.email)).toMatch(/^[a-z]+\.[a-z]+\d*@example\.(com|org|net|cl)$/);
  });
});

describe("catalog", () => {
  it("has unique ids and finds tools by keyword", () => {
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length);
    const label = (t: { id: string }) => t.id;
    expect(searchTools("jwt", label).map((t) => t.id)).toContain("jwt");
    expect(searchTools("b64", label).map((t) => t.id)).toContain("base64");
    expect(searchTools("epoch", label).map((t) => t.id)).toContain("timestamp");
    expect(searchTools("dígito verificador", label).map((t) => t.id)).toContain("rut");
  });
});
