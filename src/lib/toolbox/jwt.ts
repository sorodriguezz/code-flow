/**
 * JSON Web Tokens: decode, verify and sign — locally, with WebCrypto.
 *
 * Decoding never needs the key. Verifying takes an HMAC secret (HS*) or a public key (RS*, PS*,
 * ES*, EdDSA) as PEM (`PUBLIC KEY` or a `CERTIFICATE`) or as a JWK. Signing is HMAC only: the
 * tool is for building test tokens against a local service, and those are almost always HS256.
 */

import { parsePem } from "./asn1";
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
  kind: "hmac" | "rsa" | "pss" | "ecdsa" | "eddsa";
  hash: Hash;
  curve?: "P-256" | "P-384" | "P-521";
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
  EdDSA: { kind: "eddsa", hash: "SHA-512" },
};

export const HMAC_ALGS = ["HS256", "HS384", "HS512"] as const;
export type HmacAlg = (typeof HMAC_ALGS)[number];

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
  const k = await publicKeyFor(key, spec);
  return crypto.subtle.verify(verifyParams(spec), k, signature as BufferSource, data as BufferSource);
}

/** Signs `payload` with an HMAC secret. `header` is merged over `{ alg, typ: "JWT" }`. */
export async function signHmacJwt(
  payload: unknown,
  secret: string,
  alg: HmacAlg = "HS256",
  header: Record<string, unknown> = {},
  secretIsBase64 = false,
): Promise<string> {
  // `alg` last, so a header field cannot claim an algorithm the signature was not made with.
  const head = { typ: "JWT", ...header, alg };
  const encode = (value: unknown) => toBase64Url(bytesToBase64(utf8(JSON.stringify(value))));
  const signingInput = `${encode(head)}.${encode(payload)}`;
  const k = await hmacKey(secret, secretIsBase64, ALGS[alg].hash, "sign");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8(signingInput) as BufferSource));
  return `${signingInput}.${toBase64Url(bytesToBase64(sig))}`;
}
