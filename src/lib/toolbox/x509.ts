/**
 * X.509 certificates, decoded: who it is for, who signed it, when it is valid, the names it covers,
 * the key inside it and its fingerprints. Read with the DER reader in `asn1.ts`.
 */

import {
  decodeOid,
  decodeString,
  decodeTime,
  integerBits,
  integerHex,
  nodeBytes,
  parseDer,
  parseDerOne,
  parsePem,
  type Asn1Node,
} from "./asn1";
import { bytesToHex } from "./encoding";

const NAME_OIDS: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.5": "serialNumber",
  "2.5.4.9": "street",
  "2.5.4.17": "postalCode",
  "2.5.4.42": "givenName",
  "2.5.4.4": "SN",
  "1.2.840.113549.1.9.1": "emailAddress",
  "0.9.2342.19200300.100.1.25": "DC",
  "2.5.4.97": "organizationIdentifier",
};

export const ALGORITHM_OIDS: Record<string, string> = {
  "1.2.840.113549.1.1.1": "RSA",
  "1.2.840.113549.1.1.5": "SHA-1 with RSA",
  "1.2.840.113549.1.1.11": "SHA-256 with RSA",
  "1.2.840.113549.1.1.12": "SHA-384 with RSA",
  "1.2.840.113549.1.1.13": "SHA-512 with RSA",
  "1.2.840.113549.1.1.10": "RSA-PSS",
  "1.2.840.10045.2.1": "EC",
  "1.2.840.10045.4.3.2": "ECDSA with SHA-256",
  "1.2.840.10045.4.3.3": "ECDSA with SHA-384",
  "1.2.840.10045.4.3.4": "ECDSA with SHA-512",
  "1.3.101.112": "Ed25519",
  "1.3.101.113": "Ed448",
};

export const CURVE_OIDS: Record<string, string> = {
  "1.2.840.10045.3.1.7": "P-256",
  "1.3.132.0.34": "P-384",
  "1.3.132.0.35": "P-521",
  "1.3.132.0.10": "secp256k1",
};

const EKU_OIDS: Record<string, string> = {
  "1.3.6.1.5.5.7.3.1": "serverAuth",
  "1.3.6.1.5.5.7.3.2": "clientAuth",
  "1.3.6.1.5.5.7.3.3": "codeSigning",
  "1.3.6.1.5.5.7.3.4": "emailProtection",
  "1.3.6.1.5.5.7.3.8": "timeStamping",
  "1.3.6.1.5.5.7.3.9": "OCSPSigning",
};

const KEY_USAGES = [
  "digitalSignature",
  "nonRepudiation",
  "keyEncipherment",
  "dataEncipherment",
  "keyAgreement",
  "keyCertSign",
  "cRLSign",
  "encipherOnly",
  "decipherOnly",
];

export interface NamePart {
  key: string;
  value: string;
}

export interface CertificateInfo {
  version: number;
  serial: string;
  signatureAlgorithm: string;
  issuer: NamePart[];
  subject: NamePart[];
  notBefore: Date;
  notAfter: Date;
  publicKey: { algorithm: string; detail: string };
  /** The SubjectPublicKeyInfo, DER — what WebCrypto imports as `spki`. */
  spki: Uint8Array;
  subjectAltNames: string[];
  isCa: boolean | null;
  keyUsage: string[];
  extendedKeyUsage: string[];
  selfSigned: boolean;
  der: Uint8Array;
}

export function formatName(parts: NamePart[]): string {
  return parts.map((p) => `${p.key}=${p.value}`).join(", ");
}

function readName(node: Asn1Node): NamePart[] {
  const out: NamePart[] = [];
  for (const set of node.children) {
    for (const atv of set.children) {
      const [oid, value] = atv.children;
      if (!oid || !value) continue;
      const id = decodeOid(oid.content);
      out.push({ key: NAME_OIDS[id] ?? id, value: decodeString(value) });
    }
  }
  return out;
}

function readSans(octets: Uint8Array): string[] {
  const seq = parseDerOne(octets);
  return seq.children.map((gn) => {
    const text = new TextDecoder("latin1").decode(gn.content);
    switch (gn.tag) {
      case 1:
        return `email:${text}`;
      case 2:
        return `DNS:${text}`;
      case 6:
        return `URI:${text}`;
      case 7:
        return `IP:${
          gn.content.length === 4
            ? Array.from(gn.content).join(".")
            : Array.from({ length: gn.content.length / 2 }, (_, i) =>
                ((gn.content[i * 2] << 8) | gn.content[i * 2 + 1]).toString(16),
              ).join(":")
        }`;
      default:
        return `[${gn.tag}]`;
    }
  });
}

/** A SubjectPublicKeyInfo's algorithm and size, e.g. `RSA` / `2048 bits`, `EC` / `P-256`. */
export function describeSpki(spki: Asn1Node): { algorithm: string; detail: string } {
  const [algId, bits] = spki.children;
  const oid = decodeOid(algId.children[0].content);
  const algorithm = ALGORITHM_OIDS[oid] ?? oid;
  if (algorithm === "RSA") {
    // BIT STRING: first content byte is the unused-bit count; then RSAPublicKey SEQUENCE.
    const key = parseDerOne(bits.content.subarray(1));
    const modulus = key.children[0];
    const exponent = key.children[1];
    return { algorithm, detail: `${integerBits(modulus.content)} bits, e=${parseInt(integerHex(exponent.content).replace(/:/g, ""), 16)}` };
  }
  if (algorithm === "EC") {
    const param = algId.children[1];
    const curve = param ? decodeOid(param.content) : "";
    return { algorithm, detail: CURVE_OIDS[curve] ?? curve };
  }
  return { algorithm, detail: "" };
}

export function parseCertificateDer(der: Uint8Array): CertificateInfo {
  const cert = parseDerOne(der);
  const tbs = cert.children[0];
  if (!tbs || tbs.tag !== 16) throw new Error("Not an X.509 certificate");
  const fields = [...tbs.children];
  let version = 1;
  if (fields[0].cls === 2 && fields[0].tag === 0) {
    version = (fields[0].children[0]?.content[0] ?? 0) + 1;
    fields.shift();
  }
  const [serial, , issuer, validity, subject, spki, ...rest] = fields;
  const sigAlg = decodeOid(cert.children[1].children[0].content);
  const info: CertificateInfo = {
    version,
    serial: integerHex(serial.content),
    signatureAlgorithm: ALGORITHM_OIDS[sigAlg] ?? sigAlg,
    issuer: readName(issuer),
    subject: readName(subject),
    notBefore: decodeTime(validity.children[0]),
    notAfter: decodeTime(validity.children[1]),
    publicKey: describeSpki(spki),
    spki: nodeBytes(der, spki),
    subjectAltNames: [],
    isCa: null,
    keyUsage: [],
    extendedKeyUsage: [],
    selfSigned: false,
    der,
  };
  info.selfSigned = formatName(info.issuer) === formatName(info.subject);
  const extWrapper = rest.find((n) => n.cls === 2 && n.tag === 3);
  for (const ext of extWrapper?.children[0]?.children ?? []) {
    const oid = decodeOid(ext.children[0].content);
    const value = ext.children[ext.children.length - 1].content;
    try {
      if (oid === "2.5.29.17") info.subjectAltNames = readSans(value);
      else if (oid === "2.5.29.19") {
        const seq = parseDerOne(value);
        info.isCa = seq.children[0]?.tag === 1 ? seq.children[0].content[0] !== 0 : false;
      } else if (oid === "2.5.29.15") {
        const bits = parseDerOne(value).content;
        for (let i = 0; i < KEY_USAGES.length; i++) {
          const byte = bits[1 + (i >> 3)];
          if (byte !== undefined && byte & (0x80 >> (i & 7))) info.keyUsage.push(KEY_USAGES[i]);
        }
      } else if (oid === "2.5.29.37") {
        info.extendedKeyUsage = parseDerOne(value).children.map((n) => {
          const id = decodeOid(n.content);
          return EKU_OIDS[id] ?? id;
        });
      }
    } catch {
      // A malformed extension is skipped rather than failing the whole certificate.
    }
  }
  return info;
}

/** Every certificate in a PEM bundle, or the one DER certificate given as Base64. */
export function parseCertificates(text: string): CertificateInfo[] {
  const blocks = parsePem(text).filter((b) => b.label.includes("CERTIFICATE"));
  if (blocks.length) return blocks.map((b) => parseCertificateDer(b.der));
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Bare Base64 of a DER certificate (what some consoles show).
  const bytes = Uint8Array.from(atob(trimmed.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return [parseCertificateDer(bytes)];
}

export async function fingerprint(der: Uint8Array, algorithm: "SHA-1" | "SHA-256"): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(algorithm, der as BufferSource));
  return bytesToHex(digest, ":").toUpperCase();
}

/** Re-exported for callers that only need to sanity-check a DER blob. */
export { parseDer };
