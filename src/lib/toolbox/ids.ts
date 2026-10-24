/**
 * Identifiers and secrets: UUID v4/v7, ULID, nanoid, passwords, passphrases and random strings.
 * Every random byte comes from `crypto.getRandomValues`, and picking from an alphabet uses
 * rejection sampling so no character is likelier than another.
 */

import { bytesToHex } from "./encoding";

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** A uniform integer in [0, max). */
export function randomInt(max: number): number {
  if (max <= 0 || max > 2 ** 32) throw new Error("randomInt: bad range");
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

export function pick(alphabet: string, length: number): string {
  const chars = Array.from(alphabet);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[randomInt(chars.length)];
  return out;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidV4(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return formatUuid(b);
}

/** RFC 9562 v7: 48 bits of Unix milliseconds, then random — sorts by creation time. */
export function uuidV7(now = Date.now()): string {
  const b = randomBytes(16);
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  return formatUuid(b);
}

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface UuidInfo {
  version: number;
  variant: "NCS" | "RFC 9562" | "Microsoft" | "Future";
  /** For v1, v6 and v7, when it was made. */
  date: Date | null;
}

export function inspectUuid(text: string): UuidInfo | null {
  const m = /^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/i.exec(text.trim());
  if (!m) return null;
  const hex = m.slice(1).join("").toLowerCase();
  const version = parseInt(hex[12], 16);
  const v = parseInt(hex[16], 16);
  const variant = v < 8 ? "NCS" : v < 12 ? "RFC 9562" : v < 14 ? "Microsoft" : "Future";
  let date: Date | null = null;
  if (version === 7) date = new Date(parseInt(hex.slice(0, 12), 16));
  else if (version === 1 || version === 6) {
    // 60-bit count of 100 ns intervals since 1582-10-15.
    const ticks =
      version === 1
        ? BigInt(`0x${hex.slice(13, 16)}${hex.slice(8, 12)}${hex.slice(0, 8)}`)
        : BigInt(`0x${hex.slice(0, 12)}${hex.slice(13, 16)}`);
    date = new Date(Number((ticks - 122192928000000000n) / 10000n));
  }
  return { version, variant, date };
}

// ---------------------------------------------------------------------------------------------
// ULID and nanoid
// ---------------------------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let time = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  return time + pick(CROCKFORD, 16);
}

export function ulidTime(id: string): Date | null {
  const text = id.trim().toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(text)) return null;
  let ms = 0;
  for (const ch of text.slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(ch);
  return new Date(ms);
}

export const NANOID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyrzict";

export function nanoid(size = 21, alphabet = NANOID_ALPHABET): string {
  return pick(alphabet, size);
}

// ---------------------------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------------------------

export interface PasswordOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  /** Leaves out 0/O, 1/l/I — for a password someone has to type from a screen. */
  avoidAmbiguous: boolean;
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?/~";
const AMBIGUOUS = /[0O1lI|]/g;

export function passwordAlphabet(o: PasswordOptions): string[] {
  const sets = [o.lower && LOWER, o.upper && UPPER, o.digits && DIGITS, o.symbols && SYMBOLS].filter(Boolean) as string[];
  return sets.map((s) => (o.avoidAmbiguous ? s.replace(AMBIGUOUS, "") : s));
}

/** At least one character of every chosen set, the rest from all of them, then shuffled. */
export function generatePassword(o: PasswordOptions): string {
  const sets = passwordAlphabet(o);
  if (!sets.length) return "";
  const all = sets.join("");
  const chars = sets.slice(0, o.length).map((s) => pick(s, 1));
  while (chars.length < o.length) chars.push(pick(all, 1));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Bits of entropy of `length` picks from an alphabet of `size`. */
export function entropyBits(size: number, length: number): number {
  return size > 1 ? length * Math.log2(size) : 0;
}

/**
 * A short wordlist for passphrases: 391 common four-letter English words, about 8.6 bits each.
 * Short beside EFF's 7776 — five words here are 43 bits — so the tool defaults to six and always
 * shows the number, computed from this list's real length.
 */
export const WORDS = (
  "able acid aged also area army away baby back ball band bank base bath bear beat bell belt best bird blow blue boat body bone book boot born boss both bowl bulk burn bush busy cake calm came camp card care cart case cash cast cell chat chef chip city clay club coal coat code cold cook cool cope copy core corn cost crew crop dark data date dawn deal dear deck deep deer desk dial diet dish dock door dose down draw drop drum duck dust duty each earn east easy edge else even ever exam face fact fair fall farm fast fear feed feel file film fine fire firm fish five flag flat flow folk food foot form fort four free frog fuel full fund gain game gate gear gift girl give glad glow goal gold golf good grab gray grew grid grow hair half hall hand hard harm hawk head heat herb hero high hill hint hold hole home hope horn host hour huge hunt idea inch iron item jazz join joke jump just keen keep kind king kite knee knot lady lake lamp land lane last late lawn lead leaf lean left lens life lift like lime line lion list live load loan lock loft long look loop lord love luck lung made mail main make mall many mark mask mate meal meat menu mild milk mind mint miss mode mood moon more moss most move much nail name navy near neat neck nest news next nice nine node none noon nose note oven pace pack page pain pair palm park part pass path peak pear pink pipe plan play plot plug poem pole pond pool port pull pump pure push quiz race rain ramp rate read real rest rice rich ride ring rise road rock roof room root rope rose ruby rule safe sail salt sand save seal seat seed ship shoe shop show side sign silk sing site size skin slow snow soap sock soft soil song sort soup spot star stay step stop suit sure swan tail take talk tall tank tape task team tent test text tide tile time tone tool tour town tree trip tube tune twin type unit vast verb view vote wage walk wall warm wave wide wild wind wing wire wise wolf wood wool word work yard year zone"
).split(" ");

export function generatePassphrase(words: number, separator = "-", capitalize = false, withNumber = false): string {
  const list = Array.from({ length: words }, () => {
    const w = WORDS[randomInt(WORDS.length)];
    return capitalize ? w[0].toUpperCase() + w.slice(1) : w;
  });
  if (withNumber) list.push(String(randomInt(100)));
  return list.join(separator);
}

export const RANDOM_ALPHABETS = {
  alnum: LOWER + UPPER + DIGITS,
  hex: "0123456789abcdef",
  base64url: LOWER + UPPER + DIGITS + "-_",
  digits: DIGITS,
  letters: LOWER + UPPER,
} as const;
