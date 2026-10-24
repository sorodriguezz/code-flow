/**
 * Tool id → component. Each category file is its own chunk, loaded the first time one of its tools
 * is opened, so the toolbox itself opens with nothing but the list.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type Loader = () => Promise<Record<string, ComponentType>>;

const encode: Loader = () => import("./EncodeTools") as never;
const jwt: Loader = () => import("./JwtTools") as never;
const format: Loader = () => import("./FormatTools") as never;
const text: Loader = () => import("./TextTools") as never;
const generate: Loader = () => import("./GenerateTools") as never;
const time: Loader = () => import("./TimeTools") as never;
const web: Loader = () => import("./WebTools") as never;
const numbers: Loader = () => import("./NumberCryptoTools") as never;

const from = (load: Loader, name: string) => lazy(() => load().then((m) => ({ default: m[name] })));

export const TOOL_COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = {
  base64: from(encode, "Base64Tool"),
  url: from(encode, "UrlTool"),
  html: from(encode, "HtmlTool"),
  unicode: from(encode, "UnicodeTool"),
  hex: from(encode, "HexTool"),
  binary: from(encode, "BinaryTool"),
  punycode: from(encode, "PunycodeTool"),
  qp: from(encode, "QuotedPrintableTool"),
  gzip: from(encode, "GzipTool"),
  jwt: from(jwt, "JwtTool"),
  "jwt-sign": from(jwt, "JwtSignTool"),
  json: from(format, "JsonTool"),
  convert: from(format, "ConvertTool"),
  xml: from(format, "XmlTool"),
  csv: from(format, "CsvTool"),
  jsonpath: from(format, "JsonPathTool"),
  sql: from(format, "SqlTool"),
  "json-code": from(format, "JsonCodeTool"),
  markdown: from(format, "MarkdownTool"),
  query: from(format, "QueryTool"),
  curl: from(format, "CurlTool"),
  diff: lazy(() => import("./DiffTool")),
  case: from(text, "CaseTool"),
  count: from(text, "CountTool"),
  lines: from(text, "LinesTool"),
  escape: from(text, "EscapeTool"),
  lorem: from(text, "LoremTool"),
  slug: from(text, "SlugTool"),
  inspect: from(text, "InspectTool"),
  regex: from(text, "RegexTool"),
  uuid: from(generate, "UuidTool"),
  password: from(generate, "PasswordTool"),
  hash: from(generate, "HashTool"),
  hmac: from(generate, "HmacTool"),
  qr: from(generate, "QrTool"),
  fake: from(generate, "FakeTool"),
  rut: from(generate, "RutTool"),
  timestamp: from(time, "TimestampTool"),
  "date-calc": from(time, "DateCalcTool"),
  cron: from(time, "CronTool"),
  duration: from(time, "DurationTool"),
  "url-parse": from(web, "UrlParseTool"),
  cidr: from(web, "CidrTool"),
  "http-status": from(web, "HttpStatusTool"),
  mime: from(web, "MimeTool"),
  "user-agent": from(web, "UserAgentTool"),
  ports: from(web, "PortsTool"),
  chmod: from(web, "ChmodTool"),
  color: from(web, "ColorTool"),
  base: from(numbers, "BaseTool"),
  bytes: from(numbers, "BytesTool"),
  cert: from(numbers, "CertTool"),
  keypair: from(numbers, "KeyPairTool"),
  aes: from(numbers, "AesTool"),
};
