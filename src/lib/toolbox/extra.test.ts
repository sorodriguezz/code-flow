import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, base58Decode, base58Encode } from "./baseN";
import { hotp, parseOtpInput, totp } from "./totp";
import { parseEnv, toEnv } from "./env";
import { decodeId, SNOWFLAKE_EPOCHS } from "./idDecode";
import { minifyCss, minifyHtml } from "./webFormat";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("base32 / base58", () => {
  it("matches RFC 4648's vectors", () => {
    expect(base32Encode(utf8("foobar"))).toBe("MZXW6YTBOI======");
    expect(new TextDecoder().decode(base32Decode("mzxw6ytboi"))).toBe("foobar");
  });
  it("round-trips Base58 and keeps leading zeros", () => {
    expect(base58Encode(utf8("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(Array.from(base58Decode(base58Encode(Uint8Array.from([0, 0, 1, 2]))))).toEqual([0, 0, 1, 2]);
  });
});

describe("totp", () => {
  // RFC 4226 appendix D: the ASCII secret "12345678901234567890".
  it("matches RFC 4226's HOTP values", async () => {
    const key = utf8("12345678901234567890");
    expect(await hotp(key, 0, 6, "SHA-1")).toBe("755224");
    expect(await hotp(key, 9, 6, "SHA-1")).toBe("520489");
  });
  it("matches RFC 6238 at 59 seconds", async () => {
    const secret = base32Encode(utf8("12345678901234567890"));
    const { code } = await totp({ secret, digits: 8, period: 30, algorithm: "SHA-1" }, 59_000);
    expect(code).toBe("94287082");
  });
  it("reads an otpauth link", () => {
    const parsed = parseOtpInput("otpauth://totp/Acme:ana@acme.cl?secret=JBSWY3DPEHPK3PXP&digits=8&algorithm=SHA256", { digits: 6, period: 30, algorithm: "SHA-1" });
    expect(parsed).toMatchObject({ secret: "JBSWY3DPEHPK3PXP", digits: 8, algorithm: "SHA-256", issuer: "Acme", account: "ana@acme.cl" });
  });
});

describe("env", () => {
  it("reads what dotenv reads", () => {
    expect(parseEnv('# c\nexport A=1\nB="two words"\nC=\'lit\\n\'\nD=x # note\nE="line\\nbreak"')).toEqual({ A: "1", B: "two words", C: "lit\\n", D: "x", E: "line\nbreak" });
  });
  it("writes back what it reads", () => {
    const env = toEnv('{"A":"1","B":"two words","C":true}');
    expect(env).toBe('A=1\nB="two words"\nC=true');
    expect(parseEnv(env)).toEqual({ A: "1", B: "two words", C: "true" });
  });
});

describe("decodeId", () => {
  it("reads an ObjectId's date", () => {
    const id = decodeId("507f1f77bcf86cd799439011", SNOWFLAKE_EPOCHS[0]);
    expect(id.date.toISOString()).toBe("2012-10-17T21:13:27.000Z");
  });
  it("reads a Discord snowflake", () => {
    const id = decodeId("175928847299117063", SNOWFLAKE_EPOCHS[1]);
    expect(id.date.toISOString()).toBe("2016-04-30T11:18:25.796Z");
  });
});

describe("web minify", () => {
  it("keeps strings and drops comments in CSS", () => {
    expect(minifyCss('a  >  b { color : red ; /* x */ content: "a  b"; }\n.c{margin:0 auto;}')).toBe('a>b{color:red;content:"a  b"}.c{margin:0 auto}');
  });
  it("keeps pre blocks in HTML", () => {
    expect(minifyHtml("<div>\n  <!-- c -->\n  <p>  hola   mundo </p>\n  <pre>  a\n b</pre>\n</div>")).toBe("<div><p> hola mundo </p><pre>  a\n b</pre></div>");
  });
});
