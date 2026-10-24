/**
 * «Herramientas»: which tools exist, how they are grouped, and the words they are found by.
 *
 * Pure data, apart from the icons, so the command palette and Codi can list the tools without
 * loading a single one of them — the components live in `components/toolbox` and load with the
 * app. The keywords are search terms, not copy: they are what people type ("jwt", "b64",
 * "epoch"), in both languages, and they never reach the screen.
 */

import {
  ArrowLeftRight,
  Binary,
  Braces,
  Calculator,
  CalendarClock,
  CaseSensitive,
  Clock,
  Code2,
  Database,
  FileCode2,
  FileDiff,
  FileJson,
  FileKey2,
  FileText,
  Fingerprint,
  Globe,
  Hash,
  IdCard,
  KeyRound,
  Link,
  ListOrdered,
  Lock,
  type LucideIcon,
  Network,
  Palette,
  QrCode,
  Regex,
  Search,
  ShieldCheck,
  Sigma,
  Table,
  Terminal,
  Timer,
  Type,
  Archive,
  Cable,
  BookOpen,
  Monitor,
  FileType,
  Ruler,
  Users,
  Hourglass,
  Eye,
  Scissors,
  Quote,
  Languages,
  Shield,
} from "lucide-react";
import type { TranslationKey } from "../i18n/translations";

export type ToolCategory = "encode" | "jwt" | "format" | "text" | "generate" | "time" | "web" | "numbers" | "crypto";

export const TOOL_CATEGORIES: ToolCategory[] = ["encode", "jwt", "format", "text", "generate", "time", "web", "numbers", "crypto"];

export interface ToolEntry {
  id: string;
  category: ToolCategory;
  icon: LucideIcon;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  /** Extra search terms, both languages, lower case. */
  keywords: string;
}

const tool = (id: string, category: ToolCategory, icon: LucideIcon, keywords: string): ToolEntry => ({
  id,
  category,
  icon,
  titleKey: `toolbox.tool.${id}` as TranslationKey,
  descriptionKey: `toolbox.tool.${id}.desc` as TranslationKey,
  keywords,
});

export const TOOLS: ToolEntry[] = [
  tool("base64", "encode", Binary, "base64 b64 base64url data uri imagen image file archivo atob btoa"),
  tool("url", "encode", Link, "url encode decode percent porcentaje uri component querystring escape"),
  tool("html", "encode", Code2, "html entities entidades escape amp lt gt"),
  tool("unicode", "encode", Languages, "unicode escape \\u utf16 surrogate code point emoji"),
  tool("hex", "encode", Hash, "hex hexadecimal bytes utf8 text texto"),
  tool("binary", "encode", Binary, "binary binario bits bytes 0101"),
  tool("punycode", "encode", Globe, "punycode idn idna xn-- dominio domain ñ"),
  tool("qp", "encode", Quote, "quoted printable qp email correo mime"),
  tool("gzip", "encode", Archive, "gzip deflate zlib compress comprimir inflate descomprimir"),

  tool("jwt", "jwt", KeyRound, "jwt token bearer decode decodificar verify verificar firma signature hs256 rs256 es256 jwk jws oauth oidc claims exp"),
  tool("jwt-sign", "jwt", FileKey2, "jwt sign firmar crear build token hs256 hmac secret secreto"),

  tool("json", "format", Braces, "json format formatear pretty beautify minify minificar validate validar sort"),
  tool("convert", "format", ArrowLeftRight, "json yaml yml toml xml convert convertir"),
  tool("xml", "format", FileCode2, "xml format formatear pretty minify validar"),
  tool("csv", "format", Table, "csv json excel tabla table tsv delimiter"),
  tool("jsonpath", "format", Search, "jsonpath json path query jq filter filtrar consulta"),
  tool("sql", "format", Database, "sql format formatear query consulta postgres mysql tsql oracle"),
  tool("json-code", "format", FileJson, "json typescript types tipos interface class clase csharp c# rust go python java kotlin swift dart quicktype"),
  tool("markdown", "format", FileText, "markdown md html preview vista previa"),
  tool("query", "format", ListOrdered, "query string querystring params parametros url json"),
  tool("curl", "format", Terminal, "curl fetch axios httpclient c# python requests code snippet codigo"),

  tool("diff", "text", FileDiff, "diff compare comparar texto text changes diferencias"),
  tool("case", "text", CaseSensitive, "case camel snake kebab pascal constant title mayusculas minusculas"),
  tool("count", "text", Sigma, "count contar caracteres characters words palabras lines lineas bytes"),
  tool("lines", "text", ListOrdered, "lines lineas sort ordenar dedupe duplicados unique reverse shuffle trim"),
  tool("escape", "text", Quote, "escape json string regex sql quote shell comillas"),
  tool("lorem", "text", Type, "lorem ipsum placeholder texto relleno dummy"),
  tool("slug", "text", Scissors, "slug slugify url friendly permalink"),
  tool("inspect", "text", Eye, "invisible characters caracteres zero width bom unicode code points inspector"),
  tool("regex", "text", Regex, "regex regexp expresion regular regular expression match replace grupos groups"),

  tool("uuid", "generate", Fingerprint, "uuid guid v4 v7 ulid nanoid id identificador"),
  tool("password", "generate", Lock, "password contraseña clave passphrase frase random aleatorio string secret"),
  tool("hash", "generate", Hash, "hash md5 sha1 sha256 sha512 crc32 checksum digest file archivo"),
  tool("hmac", "generate", ShieldCheck, "hmac sha256 signature firma webhook secret"),
  tool("qr", "generate", QrCode, "qr code codigo wifi"),
  tool("fake", "generate", Users, "fake falso datos data fixture faker nombres names email rut iban test"),
  tool("rut", "generate", IdCard, "rut run chile chileno validar validate digito verificador dv"),

  tool("timestamp", "time", Clock, "timestamp unix epoch date fecha time zone zona horaria utc iso"),
  tool("date-calc", "time", CalendarClock, "date difference diferencia fechas add sumar dias days business habiles"),
  tool("cron", "time", Timer, "cron crontab schedule programacion expression expresion next"),
  tool("duration", "time", Hourglass, "iso 8601 duration duracion p1d pt1h period"),

  tool("url-parse", "web", Link, "url parse parser analizar query host path protocol"),
  tool("cidr", "web", Network, "cidr ip ipv4 ipv6 subnet subred mask mascara netmask broadcast"),
  tool("http-status", "web", BookOpen, "http status code codigo estado 404 500 response"),
  tool("mime", "web", FileType, "mime type tipo content-type extension"),
  tool("user-agent", "web", Monitor, "user agent ua browser navegador parser"),
  tool("ports", "web", Cable, "ports puertos tcp udp services servicios"),
  tool("chmod", "web", Shield, "chmod permissions permisos unix rwx octal 755 644"),
  tool("color", "web", Palette, "color colour hex rgb hsl oklch contrast contraste wcag"),

  tool("base", "numbers", Calculator, "base convert binary octal decimal hex hexadecimal bigint numero number"),
  tool("bytes", "numbers", Ruler, "bytes size tamaño kb mb gb kib mib gib storage"),

  tool("cert", "crypto", ShieldCheck, "certificate certificado x509 pem der tls ssl san fingerprint huella"),
  tool("keypair", "crypto", KeyRound, "key pair par de claves rsa ec ecdsa ed25519 pem jwk public private publica privada generate"),
  tool("aes", "crypto", Lock, "aes gcm encrypt decrypt cifrar descifrar encriptar passphrase pbkdf2"),
];

export function toolById(id: string): ToolEntry | undefined {
  return TOOLS.find((t) => t.id === id);
}

export const CATEGORY_LABEL_KEY: Record<ToolCategory, TranslationKey> = {
  encode: "toolbox.cat.encode",
  jwt: "toolbox.cat.jwt",
  format: "toolbox.cat.format",
  text: "toolbox.cat.text",
  generate: "toolbox.cat.generate",
  time: "toolbox.cat.time",
  web: "toolbox.cat.web",
  numbers: "toolbox.cat.numbers",
  crypto: "toolbox.cat.crypto",
};

/** Folded for matching — case and accents ignored. */
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The tools matching every word of `query` in their title, description or keywords. */
export function searchTools(query: string, label: (tool: ToolEntry) => string): ToolEntry[] {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return TOOLS;
  return TOOLS.filter((t) => {
    const hay = fold(`${label(t)} ${t.id} ${t.keywords}`);
    return words.every((w) => hay.includes(w));
  });
}
