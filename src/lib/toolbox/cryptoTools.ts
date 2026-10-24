/**
 * Key pairs and passphrase encryption, with WebCrypto — the keys are generated in the webview and
 * never written anywhere but the screen.
 */

import { toPem } from "./asn1";
import { base64ToBytes, bytesToBase64, fromUtf8, utf8 } from "./encoding";

export type KeyPairKind = "RSA-2048" | "RSA-3072" | "RSA-4096" | "P-256" | "P-384" | "P-521" | "Ed25519";

export const KEY_PAIR_KINDS: KeyPairKind[] = ["RSA-2048", "RSA-3072", "RSA-4096", "P-256", "P-384", "P-521", "Ed25519"];

export interface GeneratedKeyPair {
  publicPem: string;
  privatePem: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

function algorithmFor(kind: KeyPairKind): RsaHashedKeyGenParams | EcKeyGenParams | Algorithm {
  if (kind.startsWith("RSA-")) {
    return {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: Number(kind.slice(4)),
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    };
  }
  if (kind === "Ed25519") return { name: "Ed25519" };
  return { name: "ECDSA", namedCurve: kind };
}

export async function generateKeyPair(kind: KeyPairKind): Promise<GeneratedKeyPair> {
  const pair = (await crypto.subtle.generateKey(algorithmFor(kind), true, ["sign", "verify"])) as CryptoKeyPair;
  const [spki, pkcs8, publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey("spki", pair.publicKey),
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  return { publicPem: toPem("PUBLIC KEY", spki), privatePem: toPem("PRIVATE KEY", pkcs8), publicJwk, privateJwk };
}

// ---------------------------------------------------------------------------------------------
// AES-GCM with a passphrase
// ---------------------------------------------------------------------------------------------

/** OWASP's 2023 figure for PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", utf8(passphrase) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Base64 of `salt (16) ‖ iv (12) ‖ ciphertext+tag`. The layout is shown under the tool so the text
 * can be decrypted elsewhere with the same parameters.
 */
export async function encryptText(plain: string, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, iterations);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(plain) as BufferSource));
  const out = new Uint8Array(SALT_BYTES + IV_BYTES + cipher.length);
  out.set(salt, 0);
  out.set(iv, SALT_BYTES);
  out.set(cipher, SALT_BYTES + IV_BYTES);
  return bytesToBase64(out);
}

export async function decryptText(payload: string, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const bytes = base64ToBytes(payload);
  if (bytes.length < SALT_BYTES + IV_BYTES + 16) throw new Error("Too short to be an encrypted payload");
  const key = await deriveKey(passphrase, bytes.subarray(0, SALT_BYTES), iterations);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES) as BufferSource },
      key,
      bytes.subarray(SALT_BYTES + IV_BYTES) as BufferSource,
    );
    return fromUtf8(new Uint8Array(plain));
  } catch {
    throw new Error("Wrong passphrase or corrupted data");
  }
}
