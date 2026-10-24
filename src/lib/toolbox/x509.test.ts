import { describe, expect, it } from "vitest";
import { fingerprint, formatName, parseCertificates } from "./x509";
import { decodeOid } from "./asn1";
import { decryptText, encryptText, generateKeyPair } from "./cryptoTools";
import { CERT_PEM } from "./__fixtures__/cert";

describe("X.509", () => {
  it("reads what openssl wrote", async () => {
    const [c] = parseCertificates(CERT_PEM);
    expect(c.version).toBe(3);
    expect(formatName(c.subject)).toBe("C=CL, O=Example Org, CN=test.example.com");
    expect(c.selfSigned).toBe(true);
    expect(c.isCa).toBe(true);
    expect(c.serial.replace(/:/g, "")).toBe("14D9242D7F986A5DB21051E027E1665EC9C4ABB0");
    expect(c.notBefore.toISOString()).toBe("2026-10-23T21:53:32.000Z");
    expect(c.notAfter.toISOString()).toBe("2036-10-20T21:53:32.000Z");
    expect(c.subjectAltNames).toEqual(["DNS:test.example.com", "DNS:*.example.com", "IP:127.0.0.1"]);
    expect(c.publicKey).toEqual({ algorithm: "EC", detail: "P-256" });
    expect(c.signatureAlgorithm).toBe("ECDSA with SHA-256");
    expect(await fingerprint(c.der, "SHA-256")).toBe("01:AE:16:15:8D:62:C5:4F:A7:FC:72:1C:29:30:B9:D9:7B:75:95:E8:0C:FF:4B:59:F8:3B:05:2A:5C:50:A1:37");
  });
  it("reads a chain and refuses what is not a certificate", () => {
    expect(parseCertificates(`${CERT_PEM}\n${CERT_PEM}`)).toHaveLength(2);
    expect(() => parseCertificates("hola")).toThrow();
  });
  it("decodes OIDs", () => {
    expect(decodeOid(new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]))).toBe("1.2.840.113549.1.1.11");
  });
});

describe("crypto tools", () => {
  it("AES-GCM round-trips and rejects the wrong passphrase", async () => {
    const box = await encryptText("datos secretos ñ", "frase", 1000);
    expect(await decryptText(box, "frase", 1000)).toBe("datos secretos ñ");
    await expect(decryptText(box, "otra", 1000)).rejects.toThrow(/passphrase/);
  });
  it("generates PEM key pairs", async () => {
    const pair = await generateKeyPair("P-256");
    expect(pair.publicPem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
    expect(pair.privatePem).toMatch(/BEGIN PRIVATE KEY/);
    expect(pair.publicJwk.crv).toBe("P-256");
  });
});
