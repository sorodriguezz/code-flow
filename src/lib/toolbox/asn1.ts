/**
 * A minimal DER reader and the PEM armour around it — enough to take an X.509 certificate apart
 * and to find the public key inside one, for the certificate decoder and the JWT verifier.
 *
 * Written here rather than pulled in: the tool needs a reader, not a full ASN.1 toolkit, and every
 * library that does this well (pkijs, node-forge) is several hundred kilobytes for a screen that
 * reads a dozen fields.
 */

import { base64ToBytes, bytesToBase64 } from "./encoding";

export interface Asn1Node {
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  constructed: boolean;
  /** The tag number within its class. */
  tag: number;
  /** Offset of the first header byte in the outermost buffer. */
  start: number;
  /** Header plus content, in bytes. */
  length: number;
  /** The content bytes (a view into the buffer). */
  content: Uint8Array;
  children: Asn1Node[];
}

export function parseDer(bytes: Uint8Array, offset = 0, end = bytes.length): Asn1Node[] {
  const nodes: Asn1Node[] = [];
  let pos = offset;
  while (pos < end) {
    const start = pos;
    const first = bytes[pos++];
    const cls = first >> 6;
    const constructed = (first & 0x20) !== 0;
    let tag = first & 0x1f;
    if (tag === 0x1f) {
      tag = 0;
      let b: number;
      do {
        if (pos >= end) throw new Error("Truncated DER tag");
        b = bytes[pos++];
        tag = tag * 128 + (b & 0x7f);
      } while (b & 0x80);
    }
    if (pos >= end) throw new Error("Truncated DER length");
    let len = bytes[pos++];
    if (len & 0x80) {
      const count = len & 0x7f;
      if (count === 0 || count > 4) throw new Error("Unsupported DER length");
      len = 0;
      for (let i = 0; i < count; i++) len = len * 256 + bytes[pos++];
    }
    if (pos + len > end) throw new Error("DER content runs past its container");
    const content = bytes.subarray(pos, pos + len);
    const node: Asn1Node = { cls, constructed, tag, start, length: pos + len - start, content, children: [] };
    if (constructed) node.children = parseDer(bytes, pos, pos + len);
    nodes.push(node);
    pos += len;
  }
  return nodes;
}

export function parseDerOne(bytes: Uint8Array): Asn1Node {
  const nodes = parseDer(bytes);
  if (nodes.length === 0) throw new Error("Empty DER");
  return nodes[0];
}

/** The whole encoding of `node` (header included), out of the buffer it was parsed from. */
export function nodeBytes(buffer: Uint8Array, node: Asn1Node): Uint8Array {
  return buffer.subarray(node.start, node.start + node.length);
}

export function decodeOid(content: Uint8Array): string {
  const ids: number[] = [];
  let value = 0;
  for (const byte of content) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      ids.push(value);
      value = 0;
    }
  }
  if (ids.length === 0) return "";
  // The first subidentifier packs the first two arcs: 40·x + y, with x capped at 2.
  const x = Math.min(2, Math.floor(ids[0] / 40));
  return [x, ids[0] - 40 * x, ...ids.slice(1)].join(".");
}

/** An INTEGER as hex (colon-separated bytes, leading sign byte dropped). */
export function integerHex(content: Uint8Array): string {
  let start = 0;
  while (start < content.length - 1 && content[start] === 0) start++;
  return Array.from(content.subarray(start), (b) => b.toString(16).padStart(2, "0")).join(":").toUpperCase();
}

/** The number of significant bits of an unsigned INTEGER — an RSA modulus's key size. */
export function integerBits(content: Uint8Array): number {
  let start = 0;
  while (start < content.length && content[start] === 0) start++;
  if (start === content.length) return 0;
  return (content.length - start - 1) * 8 + (32 - Math.clz32(content[start]));
}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

/** The text of a string type: UTF8String, PrintableString, IA5String, BMPString and friends. */
export function decodeString(node: Asn1Node): string {
  if (node.tag === 30) {
    // BMPString: UTF-16BE.
    let s = "";
    for (let i = 0; i + 1 < node.content.length; i += 2) s += String.fromCharCode((node.content[i] << 8) | node.content[i + 1]);
    return s;
  }
  return node.tag === 12 ? utf8.decode(node.content) : latin1.decode(node.content);
}

/** UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ) as a Date. */
export function decodeTime(node: Asn1Node): Date {
  const text = latin1.decode(node.content);
  const m =
    node.tag === 23
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(text)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(text);
  if (!m) throw new Error(`Unsupported time: ${text}`);
  let year = Number(m[1]);
  if (node.tag === 23) year += year >= 50 ? 1900 : 2000;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
}

// ---------------------------------------------------------------------------------------------
// PEM
// ---------------------------------------------------------------------------------------------

export interface PemBlock {
  label: string;
  der: Uint8Array;
}

/** Every `-----BEGIN X-----` block in `text`, in order. */
export function parsePem(text: string): PemBlock[] {
  const out: PemBlock[] = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Headers such as `Proc-Type:` (encrypted legacy keys) sit before a blank line.
    const body = m[2].includes(":") ? m[2].split(/\r?\n\r?\n/).pop()! : m[2];
    out.push({ label: m[1], der: base64ToBytes(body) });
  }
  return out;
}

export function toPem(label: string, der: Uint8Array | ArrayBuffer): string {
  const b64 = bytesToBase64(der instanceof Uint8Array ? der : new Uint8Array(der));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
