/**
 * A cell that holds bytes, read back from the text it arrives as.
 *
 * Every value crosses as text (the workspace's first invariant), and each engine writes bytes its
 * own way: Postgres `bytea` as `\x…`, SQL Server and MySQL as `0x…`, SQLite as `X'…'`. All three
 * are hex. Decoding them is what lets the cell viewer show an image as an image, the rest as a hex
 * dump, and save either as the file it is.
 */
export function decodeBinary(value: string): Uint8Array | null {
  const text = value.trim();
  const hex = /^\\x([0-9a-fA-F]*)$/.exec(text)?.[1] ?? /^0x([0-9a-fA-F]*)$/.exec(text)?.[1] ?? /^[xX]'([0-9a-fA-F]*)'$/.exec(text)?.[1];
  if (hex === undefined || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** The image type the bytes start like, by their magic number — `null` for anything else. */
export function imageType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x42, 0x4d)) return "image/bmp";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return "image/webp";
  return null;
}

/** A file extension for saving the bytes, from what they look like. */
export function extensionFor(bytes: Uint8Array): string {
  const image = imageType(bytes);
  if (image) return image.split("/")[1] === "jpeg" ? "jpg" : image.split("/")[1];
  const starts = (...sig: number[]) => sig.every((byte, index) => bytes[index] === byte);
  if (starts(0x25, 0x50, 0x44, 0x46)) return "pdf";
  if (starts(0x50, 0x4b, 0x03, 0x04)) return "zip";
  if (starts(0x1f, 0x8b)) return "gz";
  return "bin";
}

/** `offset  hex bytes  ascii`, sixteen to a line — the first `limit` bytes. */
export function hexDump(bytes: Uint8Array, limit = 64 * 1024): string {
  const lines: string[] = [];
  const end = Math.min(bytes.length, limit);
  for (let at = 0; at < end; at += 16) {
    const chunk = bytes.subarray(at, Math.min(at + 16, end));
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk, (byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("");
    lines.push(`${at.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`);
  }
  return lines.join("\n");
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}
