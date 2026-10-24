/**
 * JSON Web Tokens: decode, verify and sign — locally, with WebCrypto.
 *
 * Decoding never needs the key. Verifying takes an HMAC secret (HS*) or a public key (RS*, PS*,
 * ES*, Ed25519, ML-DSA-*) as PEM (`PUBLIC KEY` or a `CERTIFICATE`) or as a JWK; signing takes the
 * secret or a PKCS#8 / JWK private key — the same list jwt.io offers.
 *
 * ML-DSA goes through @noble/post-quantum: WebKit's WebCrypto has no post-quantum signatures.
 */

import { ml_dsa44, ml_dsa65, ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { decodeOid, parseDerOne, parsePem, toPem } from "./asn1";
import { base64ToBytes, bytesToBase64, fromUtf8, toBase64Url, utf8 } from "./encoding";
import { parseCertificateDer } from "./x509";

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: unknown;
  /** The signature as it was in the token (Base64URL). */
  signature: string;
  /** `header.payload`, the bytes the signature is over. */
  signingInput: string;
}

function decodeJsonPart(part: string, which: string): unknown {
  let text: string;
  try {
    text = fromUtf8(base64ToBytes(part));
  } catch {
    throw new Error(`The ${which} is not Base64URL`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The ${which} is not JSON`);
  }
}

export function decodeJwt(token: string): DecodedJwt {
  const clean = token.trim().replace(/^Bearer\s+/i, "");
  const parts = clean.split(".");
  if (parts.length === 5) throw new Error("This is an encrypted token (JWE); it cannot be read without the key");
  if (parts.length !== 3) throw new Error("A JWT has three parts separated by dots");
  const header = decodeJsonPart(parts[0], "header");
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error("The header is not a JSON object");
  // Payloads are usually JSON; a JWS may carry anything, so fall back to the text.
  let payload: unknown;
  try {
    payload = decodeJsonPart(parts[1], "payload");
  } catch {
    payload = fromUtf8(base64ToBytes(parts[1]));
  }
  return { header: header as Record<string, unknown>, payload, signature: parts[2], signingInput: `${parts[0]}.${parts[1]}` };
}

export interface ClaimTime {
  claim: "exp" | "iat" | "nbf" | "auth_time";
  date: Date;
  /** Seconds from `now` (negative = in the past). */
  delta: number;
}

export function claimTimes(payload: unknown, now = Date.now()): ClaimTime[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const out: ClaimTime[] = [];
  for (const claim of ["iat", "nbf", "exp", "auth_time"] as const) {
    const value = record[claim];
    if (typeof value === "number" && Number.isFinite(value)) {
      out.push({ claim, date: new Date(value * 1000), delta: Math.round(value - now / 1000) });
    }
  }
  return out;
}

export type JwtStatus = "valid" | "expired" | "notYet";

export function tokenStatus(payload: unknown, now = Date.now()): JwtStatus {
  const times = claimTimes(payload, now);
  const exp = times.find((t) => t.claim === "exp");
  const nbf = times.find((t) => t.claim === "nbf");
  if (exp && exp.delta <= 0) return "expired";
  if (nbf && nbf.delta > 0) return "notYet";
  return "valid";
}

// ---------------------------------------------------------------------------------------------
// Algorithms
// ---------------------------------------------------------------------------------------------

type Hash = "SHA-256" | "SHA-384" | "SHA-512";

interface AlgSpec {
  kind: "hmac" | "rsa" | "pss" | "ecdsa" | "eddsa" | "mldsa";
  hash: Hash;
  curve?: "P-256" | "P-384" | "P-521";
  /** ML-DSA parameter set. */
  level?: 44 | 65 | 87;
}

const ALGS: Record<string, AlgSpec> = {
  HS256: { kind: "hmac", hash: "SHA-256" },
  HS384: { kind: "hmac", hash: "SHA-384" },
  HS512: { kind: "hmac", hash: "SHA-512" },
  RS256: { kind: "rsa", hash: "SHA-256" },
  RS384: { kind: "rsa", hash: "SHA-384" },
  RS512: { kind: "rsa", hash: "SHA-512" },
  PS256: { kind: "pss", hash: "SHA-256" },
  PS384: { kind: "pss", hash: "SHA-384" },
  PS512: { kind: "pss", hash: "SHA-512" },
  ES256: { kind: "ecdsa", hash: "SHA-256", curve: "P-256" },
  ES384: { kind: "ecdsa", hash: "SHA-384", curve: "P-384" },
  ES512: { kind: "ecdsa", hash: "SHA-512", curve: "P-521" },
  // RFC 9864 names the curve; `EdDSA` is the older, deprecated spelling of the same signature.
  Ed25519: { kind: "eddsa", hash: "SHA-512" },
  EdDSA: { kind: "eddsa", hash: "SHA-512" },
  "ML-DSA-44": { kind: "mldsa", hash: "SHA-256", level: 44 },
  "ML-DSA-65": { kind: "mldsa", hash: "SHA-256", level: 65 },
  "ML-DSA-87": { kind: "mldsa", hash: "SHA-256", level: 87 },
};

/** What the pickers offer, in jwt.io's order. `EdDSA` still verifies but is not offered. */
export const JWT_ALGS = [
  "none",
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
  "Ed25519",
  "ML-DSA-44",
  "ML-DSA-65",
  "ML-DSA-87",
] as const;
export type JwtAlg = (typeof JWT_ALGS)[number];

export const HMAC_ALGS = ["HS256", "HS384", "HS512"] as const;
export type HmacAlg = (typeof HMAC_ALGS)[number];

/** Which kind of key `alg` signs with: none, a shared secret, or a key pair. */
export function keyKind(alg: string): "none" | "secret" | "pair" {
  if (alg === "none") return "none";
  return ALGS[alg]?.kind === "hmac" ? "secret" : "pair";
}

export function isSupportedAlg(alg: unknown): alg is string {
  return typeof alg === "string" && alg in ALGS;
}

export function needsSecret(alg: unknown): boolean {
  return typeof alg === "string" && ALGS[alg]?.kind === "hmac";
}

function importParams(spec: AlgSpec): RsaHashedImportParams | EcKeyImportParams | Algorithm {
  switch (spec.kind) {
    case "rsa":
      return { name: "RSASSA-PKCS1-v1_5", hash: spec.hash };
    case "pss":
      return { name: "RSA-PSS", hash: spec.hash };
    case "ecdsa":
      return { name: "ECDSA", namedCurve: spec.curve! };
    default:
      return { name: "Ed25519" };
  }
}

function verifyParams(spec: AlgSpec): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
  switch (spec.kind) {
    case "pss":
      return { name: "RSA-PSS", saltLength: Number(spec.hash.slice(4)) / 8 };
    case "ecdsa":
      return { name: "ECDSA", hash: spec.hash };
    case "rsa":
      return { name: "RSASSA-PKCS1-v1_5" };
    default:
      return { name: "Ed25519" };
  }
}

async function publicKeyFor(keyText: string, spec: AlgSpec): Promise<CryptoKey> {
  const text = keyText.trim();
  if (text.startsWith("{")) {
    let jwk: JsonWebKey & { keys?: JsonWebKey[] };
    try {
      jwk = JSON.parse(text);
    } catch {
      throw new Error("The key is not valid JSON");
    }
    // A JWKS: the first key is tried — the UI says to paste the one the `kid` names.
    const key = jwk.keys ? jwk.keys[0] : jwk;
    return crypto.subtle.importKey("jwk", key, importParams(spec), false, ["verify"]);
  }
  const blocks = parsePem(text);
  if (!blocks.length) throw new Error("Paste a PEM public key, a certificate or a JWK");
  const block = blocks[0];
  let spki: Uint8Array;
  if (block.label === "PUBLIC KEY") spki = block.der;
  else if (block.label.includes("CERTIFICATE")) spki = parseCertificateDer(block.der).spki;
  else if (block.label === "RSA PUBLIC KEY") throw new Error("PKCS#1 keys are not supported — convert it to a «PUBLIC KEY»");
  else throw new Error(`A «${block.label}» is not a public key`);
  return crypto.subtle.importKey("spki", spki as BufferSource, importParams(spec), false, ["verify"]);
}

// ML-DSA keys (RFC 9881 for PEM, the JOSE "AKP" key type for JWK) ------------------------------

const ML_DSA = { 44: ml_dsa44, 65: ml_dsa65, 87: ml_dsa87 } as const;
const ML_DSA_OID = { 44: "2.16.840.1.101.3.4.3.17", 65: "2.16.840.1.101.3.4.3.18", 87: "2.16.840.1.101.3.4.3.19" } as const;
const ML_DSA_OID_DER = { 44: 0x11, 65: 0x12, 87: 0x13 } as const;

function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const head = len < 0x80 ? [tag, len] : len < 0x100 ? [tag, 0x81, len] : [tag, 0x82, len >> 8, len & 0xff];
  const out = new Uint8Array(head.length + len);
  out.set(head);
  let at = head.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function mlDsaAlgId(level: 44 | 65 | 87): Uint8Array {
  return der(0x30, new Uint8Array([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x03, ML_DSA_OID_DER[level]]));
}

function mlDsaPublicPem(level: 44 | 65 | 87, pub: Uint8Array): string {
  return toPem("PUBLIC KEY", der(0x30, mlDsaAlgId(level), der(0x03, new Uint8Array([0]), pub)));
}

/** PKCS#8 in the seed-only form RFC 9881 recommends. */
function mlDsaPrivatePem(level: 44 | 65 | 87, seed: Uint8Array): string {
  return toPem("PRIVATE KEY", der(0x30, new Uint8Array([0x02, 0x01, 0x00]), mlDsaAlgId(level), der(0x04, der(0x80, seed))));
}

function checkMlDsaOid(algId: { children: { content: Uint8Array }[] }, level: 44 | 65 | 87) {
  const oid = algId.children[0] ? decodeOid(algId.children[0].content) : "";
  if (oid !== ML_DSA_OID[level]) throw new Error(`The key is not an ML-DSA-${level} key`);
}

function readJwk(text: string): JsonWebKey & { keys?: JsonWebKey[]; pub?: string; priv?: string } {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The key is not valid JSON");
  }
}

function mlDsaPublicKey(keyText: string, level: 44 | 65 | 87): Uint8Array {
  const text = keyText.trim();
  if (text.startsWith("{")) {
    const jwk = readJwk(text);
    const key = (jwk.keys ? jwk.keys[0] : jwk) as { pub?: string };
    if (!key.pub) throw new Error("An ML-DSA JWK carries the key in «pub»");
    return base64ToBytes(key.pub);
  }
  const block = parsePem(text)[0];
  if (!block) throw new Error("Paste a PEM public key, a certificate or a JWK");
  const spki = block.label.includes("CERTIFICATE") ? parseCertificateDer(block.der).spki : block.der;
  const root = parseDerOne(spki);
  checkMlDsaOid(root.children[0], level);
  return root.children[1].content.subarray(1);
}

/** The FIPS 204 secret key, from a seed or an expanded key. */
function mlDsaSecretKey(keyText: string, level: 44 | 65 | 87): Uint8Array {
  const dsa = ML_DSA[level];
  const text = keyText.trim();
  if (text.startsWith("{")) {
    const jwk = readJwk(text) as { priv?: string };
    if (!jwk.priv) throw new Error("An ML-DSA private JWK carries the seed in «priv»");
    return dsa.keygen(base64ToBytes(jwk.priv)).secretKey;
  }
  const block = parsePem(text)[0];
  if (!block || block.label !== "PRIVATE KEY") throw new Error("Paste a PKCS#8 «PRIVATE KEY» or a JWK");
  const root = parseDerOne(block.der);
  checkMlDsaOid(root.children[1], level);
  // ML-DSA-PrivateKey ::= CHOICE { seed [0], expandedKey OCTET STRING, both SEQUENCE { seed, expandedKey } }
  const inner = parseDerOne(root.children[2].content);
  if (inner.cls === 2 && inner.tag === 0) return dsa.keygen(inner.content).secretKey;
  if (inner.tag === 0x10) return dsa.keygen(inner.children[0].content).secretKey;
  return inner.content;
}

function hmacKey(secret: string, secretIsBase64: boolean, hash: Hash, usage: KeyUsage): Promise<CryptoKey> {
  const raw = secretIsBase64 ? base64ToBytes(secret) : utf8(secret);
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash }, false, [usage]);
}

/**
 * Whether the token's signature checks out with `key`. Throws when the algorithm is unknown or
 * the key cannot be read — a different answer from "the signature is wrong".
 */
export async function verifyJwt(token: string, key: string, secretIsBase64 = false): Promise<boolean> {
  const decoded = decodeJwt(token);
  const alg = decoded.header.alg;
  if (alg === "none") throw new Error("The token is unsigned (alg: none)");
  if (!isSupportedAlg(alg)) throw new Error(`Unsupported algorithm: ${String(alg)}`);
  const spec = ALGS[alg];
  const signature = base64ToBytes(decoded.signature);
  const data = utf8(decoded.signingInput);
  if (spec.kind === "hmac") {
    const k = await hmacKey(key, secretIsBase64, spec.hash, "verify");
    return crypto.subtle.verify("HMAC", k, signature as BufferSource, data as BufferSource);
  }
  if (spec.kind === "mldsa") return ML_DSA[spec.level!].verify(signature, data, mlDsaPublicKey(key, spec.level!));
  const k = await publicKeyFor(key, spec).catch(keyError(alg));
  return crypto.subtle.verify(verifyParams(spec), k, signature as BufferSource, data as BufferSource);
}

/** WebCrypto's "DataError" says nothing; say which algorithm the key did not fit. */
function keyError(alg: string) {
  return (err: unknown): never => {
    if (err instanceof Error && !(err instanceof DOMException)) throw err;
    throw new Error(`The key does not fit ${alg}`);
  };
}

async function privateKeyFor(keyText: string, spec: AlgSpec, extractable = false): Promise<CryptoKey> {
  const text = keyText.trim();
  if (text.startsWith("{")) {
    return crypto.subtle.importKey("jwk", readJwk(text), importParams(spec), extractable, ["sign"]);
  }
  const block = parsePem(text)[0];
  if (!block) throw new Error("Paste a PEM private key or a JWK");
  if (block.label === "RSA PRIVATE KEY" || block.label === "EC PRIVATE KEY") {
    throw new Error(`«${block.label}» is not PKCS#8 — convert it to a «PRIVATE KEY» (openssl pkcs8 -topk8 -nocrypt)`);
  }
  if (block.label !== "PRIVATE KEY") throw new Error(`A «${block.label}» is not a private key`);
  return crypto.subtle.importKey("pkcs8", block.der as BufferSource, importParams(spec), extractable, ["sign"]);
}

/**
 * Signs `payload`. `key` is the secret for HS*, a PKCS#8 PEM or JWK private key otherwise, and is
 * ignored for `none`. `header` is merged over `{ alg, typ: "JWT" }`, with `alg` set again last so
 * a header field cannot claim an algorithm the signature was not made with.
 */
export async function signJwt(
  payload: unknown,
  alg: string,
  key: string,
  header: Record<string, unknown> = {},
  secretIsBase64 = false,
): Promise<string> {
  if (alg !== "none" && !isSupportedAlg(alg)) throw new Error(`Unsupported algorithm: ${alg}`);
  const head: Record<string, unknown> = { alg, typ: "JWT", ...header };
  head.alg = alg;
  const encode = (value: unknown) => toBase64Url(bytesToBase64(utf8(JSON.stringify(value))));
  const signingInput = `${encode(head)}.${encode(payload)}`;
  if (alg === "none") return `${signingInput}.`;
  const spec = ALGS[alg];
  const data = utf8(signingInput);
  let sig: Uint8Array;
  if (spec.kind === "hmac") {
    const k = await hmacKey(key, secretIsBase64, spec.hash, "sign");
    sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource));
  } else if (spec.kind === "mldsa") {
    sig = ML_DSA[spec.level!].sign(data, mlDsaSecretKey(key, spec.level!));
  } else {
    const k = await privateKeyFor(key, spec).catch(keyError(alg));
    sig = new Uint8Array(await crypto.subtle.sign(verifyParams(spec), k, data as BufferSource));
  }
  return `${signingInput}.${toBase64Url(bytesToBase64(sig))}`;
}

/** Signs `payload` with an HMAC secret. */
export function signHmacJwt(
  payload: unknown,
  secret: string,
  alg: HmacAlg = "HS256",
  header: Record<string, unknown> = {},
  secretIsBase64 = false,
): Promise<string> {
  return signJwt(payload, alg, secret, header, secretIsBase64);
}

export interface PemPair {
  privateKey: string;
  publicKey: string;
}

/** A fresh key pair for `alg`, both halves as PEM (PKCS#8 and SPKI). */
export async function generateKeyPair(alg: string): Promise<PemPair> {
  const spec = ALGS[alg];
  if (!spec || spec.kind === "hmac") throw new Error(`${alg} does not use a key pair`);
  if (spec.kind === "mldsa") {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { publicKey } = ML_DSA[spec.level!].keygen(seed);
    return { privateKey: mlDsaPrivatePem(spec.level!, seed), publicKey: mlDsaPublicPem(spec.level!, publicKey) };
  }
  const params =
    spec.kind === "rsa" || spec.kind === "pss"
      ? { ...(importParams(spec) as RsaHashedImportParams), modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
      : importParams(spec);
  const pair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    privateKey: toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: toPem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

/** The public half of a private key, as SPKI PEM — what the decoder needs to verify. */
export async function publicKeyFromPrivate(alg: string, privateText: string): Promise<string> {
  const spec = ALGS[alg];
  if (!spec || spec.kind === "hmac") throw new Error(`${alg} does not use a key pair`);
  if (spec.kind === "mldsa") {
    const dsa = ML_DSA[spec.level!];
    return mlDsaPublicPem(spec.level!, dsa.getPublicKey(mlDsaSecretKey(privateText, spec.level!)));
  }
  const priv = await privateKeyFor(privateText, spec, true).catch(keyError(alg));
  // A private JWK carries the public members too; drop the private ones and import it back.
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, key_ops: _ops, ...pub } = await crypto.subtle.exportKey("jwk", priv);
  const k = await crypto.subtle.importKey("jwk", pub, importParams(spec), true, ["verify"]);
  return toPem("PUBLIC KEY", await crypto.subtle.exportKey("spki", k));
}

/** The secret behind every HS* example, so the verification line shows a match. */
export const EXAMPLE_SECRET = "a-string-secret-at-least-256-bits-long";

/** An example token for `alg` and the key that verifies it (secret, public key PEM, or "" for none). */
export async function generateExample(alg: string, now = Date.now()): Promise<{ token: string; key: string }> {
  const payload = { sub: "1234567890", name: "Example User", admin: true, iat: Math.floor(now / 1000) };
  const kind = keyKind(alg);
  if (kind === "none") return { token: await signJwt(payload, "none", ""), key: "" };
  if (kind === "secret") return { token: await signJwt(payload, alg, EXAMPLE_SECRET), key: EXAMPLE_SECRET };
  const pair = await generateKeyPair(alg);
  return { token: await signJwt(payload, alg, pair.privateKey), key: pair.publicKey };
}
