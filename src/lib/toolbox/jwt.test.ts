import { describe, expect, it } from "vitest";
import { claimTimes, decodeJwt, signHmacJwt, tokenStatus, verifyJwt } from "./jwt";
import { toPem } from "./asn1";
import { CERT_PEM } from "./__fixtures__/cert";

const HS =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkV4YW1wbGUgVXNlciIsImlhdCI6MTUxNjIzOTAyMn0.Zh4pKkZUuXapehqIXNCw9sfhHkndE8mbRVx3CkAhh68";

/** Signed with the private key of the fixture certificate (ES256). */
const ES =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlcy11c2VyIiwiaWF0IjoxNzYxMjM1MjAwfQ.IKQ5YH2RdErTQnNKJU0w4Dssk9De4zPJI_SU4k5hXau9QRMbGTeoS7F-yCgKHaVmFx6WhfFVr5klbboJzWowcg";

const ES_PUBLIC = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqDENxCvFXgQ9uYKXzerU6fwY7/4A
t/MjpLOuT6iMC5FXz7l7kaZno3hhoiQ5TmceAO/Ebmly46Nd1zc2DzDk7g==
-----END PUBLIC KEY-----`;

describe("decodeJwt", () => {
  it("reads header and payload, strips Bearer", () => {
    const d = decodeJwt(`Bearer ${HS}`);
    expect(d.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(d.payload).toMatchObject({ sub: "1234567890", name: "Example User" });
  });
  it("explains what is wrong", () => {
    expect(() => decodeJwt("abc")).toThrow(/three parts/);
    expect(() => decodeJwt("a.b.c.d.e")).toThrow(/JWE/);
    expect(() => decodeJwt("e30.e30")).toThrow();
  });
});

describe("claims", () => {
  it("dates and status", () => {
    const now = Date.UTC(2026, 0, 1);
    const payload = { iat: now / 1000 - 60, exp: now / 1000 + 3600 };
    const times = claimTimes(payload, now);
    expect(times.map((t) => t.claim)).toEqual(["iat", "exp"]);
    expect(times[1].delta).toBe(3600);
    expect(tokenStatus(payload, now)).toBe("valid");
    expect(tokenStatus({ exp: now / 1000 - 1 }, now)).toBe("expired");
    expect(tokenStatus({ nbf: now / 1000 + 10 }, now)).toBe("notYet");
  });
});

describe("verifyJwt", () => {
  it("HS256 with the right and the wrong secret", async () => {
    expect(await verifyJwt(HS, "secreto-de-ejemplo")).toBe(true);
    expect(await verifyJwt(HS, "otro")).toBe(false);
  });
  it("ES256 with a PEM public key and with the certificate", async () => {
    expect(await verifyJwt(ES, ES_PUBLIC)).toBe(true);
    expect(await verifyJwt(ES, CERT_PEM)).toBe(true);
    const tampered = ES.replace(/\.[^.]+\./, `.${Buffer.from('{"sub":"x"}').toString("base64url")}.`);
    expect(await verifyJwt(tampered, ES_PUBLIC)).toBe(false);
  });
  it("RS256 with a JWK", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const b64u = (s: string) => Buffer.from(s).toString("base64url");
    const input = `${b64u('{"alg":"RS256"}')}.${b64u('{"a":1}')}`;
    const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input))).toString("base64url");
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    expect(await verifyJwt(`${input}.${sig}`, JSON.stringify(jwk))).toBe(true);
    const spki = toPem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey));
    expect(await verifyJwt(`${input}.${sig}`, spki)).toBe(true);
  });
  it("refuses alg none and unknown algorithms", async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.e30.`;
    await expect(verifyJwt(none, "x")).rejects.toThrow(/unsigned/);
  });
});

describe("signHmacJwt", () => {
  it("signs what verify accepts, and alg cannot be overridden by the header", async () => {
    const token = await signHmacJwt({ sub: "1" }, "s3cret", "HS384", { alg: "none", kid: "k1" });
    const d = decodeJwt(token);
    expect(d.header).toMatchObject({ alg: "HS384", kid: "k1", typ: "JWT" });
    expect(await verifyJwt(token, "s3cret")).toBe(true);
  });
});
