/**
 * Base32 (RFC 4648 — the alphabet TOTP secrets are written in) and Base58 (Bitcoin's alphabet, also
 * IPFS and Solana addresses), between text or bytes and their encoded form.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base32Encode(bytes: Uint8Array, padding = true): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  if (padding) while (out.length % 8) out += "=";
  return out;
}

/** Lenient about what people paste: case, spaces and the padding are all optional. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error(`«${char}» is not a Base32 character`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(text: string): Uint8Array {
  const clean = text.trim();
  let zeros = 0;
  while (zeros < clean.length && clean[zeros] === "1") zeros++;
  let value = 0n;
  for (const char of clean) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error(`«${char}» is not a Base58 character`);
    value = value * 58n + BigInt(digit);
  }
  const out: number[] = [];
  while (value > 0n) {
    out.unshift(Number(value & 255n));
    value >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...out]);
}

/** Bytes as text when they are UTF-8, as hex when they are not — a decoded key is rarely text. */
export function bytesForDisplay(bytes: Uint8Array): { text: string; binary: boolean } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), binary: false };
  } catch {
    return { text: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" "), binary: true };
  }
}
