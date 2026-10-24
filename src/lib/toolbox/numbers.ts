/**
 * Numbers: integers between bases (BigInt, so a 128-bit id converts exactly), two's complement,
 * and byte sizes in both SI (kB = 1000) and IEC (KiB = 1024) units.
 */

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Reads an integer in `base`, or with a `0x`/`0o`/`0b` prefix that overrides it. */
export function parseBigInt(text: string, base: number): bigint {
  let t = text.trim().replace(/[_\s,]/g, "").toLowerCase();
  let negative = false;
  if (t.startsWith("-")) {
    negative = true;
    t = t.slice(1);
  }
  const prefix = /^0([xob])/.exec(t);
  if (prefix) {
    base = { x: 16, o: 8, b: 2 }[prefix[1] as "x" | "o" | "b"];
    t = t.slice(2);
  }
  if (!t) throw new Error("Empty number");
  let n = 0n;
  const b = BigInt(base);
  for (const ch of t) {
    const d = DIGITS.indexOf(ch);
    if (d < 0 || d >= base) throw new Error(`"${ch}" is not a base-${base} digit`);
    n = n * b + BigInt(d);
  }
  return negative ? -n : n;
}

export function formatBigInt(n: bigint, base: number, group = 0): string {
  const negative = n < 0n;
  let text = (negative ? -n : n).toString(base);
  if (group > 0) text = text.replace(new RegExp(`\\B(?=(.{${group}})+$)`, "g"), base === 10 ? "," : " ");
  return (negative ? "-" : "") + text;
}

/** The bit pattern of `n` as a `bits`-wide two's-complement integer, or `null` if it does not fit. */
export function twosComplement(n: bigint, bits: number): string | null {
  const min = -(1n << BigInt(bits - 1));
  const maxUnsigned = (1n << BigInt(bits)) - 1n;
  if (n < min || n > maxUnsigned) return null;
  const pattern = n < 0n ? (1n << BigInt(bits)) + n : n;
  return pattern.toString(2).padStart(bits, "0").replace(/(.{4})(?=.)/g, "$1 ");
}

// ---------------------------------------------------------------------------------------------
// Byte sizes
// ---------------------------------------------------------------------------------------------

export const SI_UNITS = ["B", "kB", "MB", "GB", "TB", "PB", "EB"] as const;
export const IEC_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] as const;

/** `1.5 GiB`, `200MB`, `10 kb` (read as kB), `1024` (bytes), `8 Mbit`. */
export function parseByteSize(text: string): number {
  const m = /^\s*([\d.,_]+)\s*([a-zA-Z]*)\s*$/.exec(text);
  if (!m) throw new Error("Write a number and an optional unit, like 1.5 GiB");
  const value = Number(m[1].replace(/[_,]/g, (c) => (c === "," && !m[1].includes(".") ? "." : "")));
  if (!Number.isFinite(value)) throw new Error("Not a number");
  const unit = m[2];
  if (!unit || /^b(ytes?)?$/i.test(unit) || unit === "B") return value;
  const bits = /bits?$/i.test(unit);
  const u = unit.replace(/(bits?|bytes?|b)$/i, "").toLowerCase();
  const iec = u.endsWith("i");
  const letter = u.replace(/i$/, "");
  const power = ["", "k", "m", "g", "t", "p", "e"].indexOf(letter);
  if (power < 0) throw new Error(`Unknown unit ${unit}`);
  const bytes = value * (iec ? 1024 : 1000) ** power;
  return bits ? bytes / 8 : bytes;
}

export function formatBytes(bytes: number, system: "si" | "iec", decimals = 2): string {
  const base = system === "si" ? 1000 : 1024;
  const units = system === "si" ? SI_UNITS : IEC_UNITS;
  let i = 0;
  let v = Math.abs(bytes);
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  return `${bytes < 0 ? "-" : ""}${i === 0 ? v : Number(v.toFixed(decimals))} ${units[i]}`;
}

/** The size in every unit of `system`. */
export function byteTable(bytes: number, system: "si" | "iec"): { unit: string; value: number }[] {
  const base = system === "si" ? 1000 : 1024;
  const units = system === "si" ? SI_UNITS : IEC_UNITS;
  return units.map((unit, i) => ({ unit, value: bytes / base ** i }));
}
