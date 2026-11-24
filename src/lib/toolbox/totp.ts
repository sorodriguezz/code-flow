/**
 * One-time passwords (RFC 6238 TOTP over RFC 4226 HOTP), through WebCrypto's HMAC — for testing a
 * login's second factor without reaching for a phone.
 */
import { base32Decode } from "./baseN";

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface TotpConfig {
  secret: string;
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
  /** From an `otpauth://` URI, when the secret came in one. */
  issuer?: string;
  account?: string;
}

/** The code for counter `counter`. */
export async function hotp(key: Uint8Array, counter: number, digits: number, algorithm: TotpAlgorithm): Promise<string> {
  const message = new Uint8Array(8);
  let rest = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    message[i] = Number(rest & 255n);
    rest >>= 8n;
  }
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: algorithm }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, message as BufferSource));
  const offset = mac[mac.length - 1] & 15;
  const binary = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The code valid at `at` (ms), and how many seconds it has left. */
export async function totp(config: TotpConfig, at = Date.now()): Promise<{ code: string; next: string; remaining: number }> {
  const key = base32Decode(config.secret);
  if (key.length === 0) throw new Error("The secret is empty");
  const step = Math.floor(at / 1000 / config.period);
  const [code, next] = await Promise.all([
    hotp(key, step, config.digits, config.algorithm),
    hotp(key, step + 1, config.digits, config.algorithm),
  ]);
  return { code, next, remaining: config.period - (Math.floor(at / 1000) % config.period) };
}

/** Reads an `otpauth://totp/Issuer:account?secret=…` URI; a bare secret is returned as one. */
export function parseOtpInput(input: string, defaults: Omit<TotpConfig, "secret">): TotpConfig {
  const text = input.trim();
  if (!/^otpauth:\/\//i.test(text)) return { ...defaults, secret: text };
  const url = new URL(text);
  if (url.host.toLowerCase() !== "totp") throw new Error("Only TOTP links are supported (otpauth://totp/…)");
  const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const [labelIssuer, account] = label.includes(":") ? label.split(/:(.*)/s) : [undefined, label];
  const algorithm = (url.searchParams.get("algorithm") ?? "").toUpperCase().replace(/^SHA(\d)/, "SHA-$1");
  return {
    secret: url.searchParams.get("secret") ?? "",
    digits: Number(url.searchParams.get("digits")) || defaults.digits,
    period: Number(url.searchParams.get("period")) || defaults.period,
    algorithm: (["SHA-1", "SHA-256", "SHA-512"] as const).find((a) => a === algorithm) ?? defaults.algorithm,
    issuer: url.searchParams.get("issuer") ?? labelIssuer,
    account,
  };
}
