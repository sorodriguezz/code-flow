/**
 * Digests of text and files: MD5 and CRC32 written here (WebCrypto has neither — MD5 is broken
 * for security, but every package registry and download page still prints one), SHA-1/2 and HMAC
 * through WebCrypto.
 */

import { bytesToBase64, bytesToHex } from "./encoding";

export type ShaAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
export type HashAlgorithm = "MD5" | ShaAlgorithm | "CRC32";

export const HASH_ALGORITHMS: HashAlgorithm[] = ["MD5", "SHA-1", "SHA-256", "SHA-384", "SHA-512", "CRC32"];

// ---------------------------------------------------------------------------------------------
// MD5 (RFC 1321)
// ---------------------------------------------------------------------------------------------

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((w, i) => ov.setUint32(i * 4, w, true));
  return out;
}

// ---------------------------------------------------------------------------------------------
// CRC32 (IEEE 802.3, the zip/PNG one)
// ---------------------------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------------------------

export async function digest(algorithm: HashAlgorithm, bytes: Uint8Array): Promise<Uint8Array> {
  if (algorithm === "MD5") return md5(bytes);
  if (algorithm === "CRC32") {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, crc32(bytes));
    return out;
  }
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes as BufferSource));
}

export function formatDigest(bytes: Uint8Array, format: "hex" | "HEX" | "base64"): string {
  if (format === "base64") return bytesToBase64(bytes);
  const hex = bytesToHex(bytes);
  return format === "HEX" ? hex.toUpperCase() : hex;
}

export async function hmac(algorithm: ShaAlgorithm, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: algorithm }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource));
}
