/**
 * Code-snippet generation for the API client — the "Code" panel that renders the request at hand
 * as runnable code in ~34 language/client flavours.
 *
 * Every generator is a pure formatter over `ResolvedRequest`: the URL already carries its query
 * string, the headers already carry the auth header, the body is already interpolated. Nothing
 * here re-reads the original `ApiRequestSpec`, and that is the whole trick — the snippet cannot
 * drift from what Send does, because both consume the same resolved value.
 *
 * The one thing a snippet genuinely cannot reproduce is a signature computed on the wire (Digest's
 * challenge/response, AWS SigV4 over the final headers). Those arrive in `backendAuth`, and every
 * target prepends a comment saying so out loud rather than emitting a request that looks complete
 * and quietly isn't.
 */

import type {
  BackendAuth,
  FormPart,
  ResolvedBody,
  ResolvedRequest,
  SnippetOptions,
  SnippetTarget,
} from "../../types/api";
import { translate } from "../../state/languageStore";

type Generator = (req: ResolvedRequest, opts: SnippetOptions) => string;

interface TargetDef {
  target: SnippetTarget;
  /** Wraps one line of prose in this target's comment syntax. */
  comment: (text: string) => string;
  generate: Generator;
}

// ---------------------------------------------------------------------------
// Escaping — one helper per language family, deliberately not shared
// ---------------------------------------------------------------------------

/** POSIX single-quoted word: nothing is special inside one, so the only job is closing the quote,
 * emitting a literal `'`, and reopening. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The escapes every C-descended double-quoted literal agrees on. Callers layer their own
 * interpolation escapes on top of this. */
function cEsc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** C, C#, Java, Go, Rust, Swift, Objective-C (after `@`), Python, R and OCaml all read this. */
function dq(s: string): string {
  return `"${cEsc(s)}"`;
}

/** Kotlin and Dart expand `$name` inside double quotes. */
function dollarq(s: string): string {
  return `"${cEsc(s).replace(/\$/g, "\\$")}"`;
}

/** Ruby expands `#{…}`, `#$global` and `#@ivar` inside double quotes — but only those three. */
function rbq(s: string): string {
  return `"${cEsc(s).replace(/#(?=[{$@])/g, "\\#")}"`;
}

/** JS single-quoted literal. */
function jsq(s: string): string {
  return `'${s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}'`;
}

/** PHP single quotes give meaning to `\` and `'` and nothing else; newlines stay literal, which
 * keeps a JSON body readable instead of collapsing it into one `\n`-riddled line. */
function phpq(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** PowerShell single quotes are fully literal and escape themselves by doubling. */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** A literal here-string keeps a multi-line body readable and interpolates nothing. It only works
 * when no line of the body starts with the terminator, so the caller gets `null` to fall back on. */
function psHereString(s: string): string | null {
  if (/^'@/m.test(s)) return null;
  return `@'\n${s}\n'@`;
}

// ---------------------------------------------------------------------------
// Shared shaping helpers
// ---------------------------------------------------------------------------

const KNOWN_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"];

const BOUNDARY = "----CodeFlowFormBoundary";

interface Wire {
  method: string;
  url: string;
  /** Headers as a snippet should print them: the body's `Content-Type` folded in, the matched
   * cookie jar folded into `Cookie`, and multipart's `Content-Type` dropped so the client can pick
   * its own boundary. */
  headers: [string, string][];
  body: ResolvedBody;
  /** `""` when the body carries no content type of its own (no body, or multipart). */
  contentType: string;
}

function isContentType(name: string): boolean {
  return name.toLowerCase() === "content-type";
}

function impliedContentType(body: ResolvedBody): string {
  switch (body.kind) {
    case "text":
      return body.contentType;
    case "urlencoded":
      return "application/x-www-form-urlencoded";
    case "file":
      return body.contentType || "application/octet-stream";
    default:
      return "";
  }
}

function wire(req: ResolvedRequest): Wire {
  const headers: [string, string][] = req.headers.filter(
    ([name]) => !(req.body.kind === "formdata" && isContentType(name)),
  );
  const declared = headers.find(([name]) => isContentType(name))?.[1] ?? "";
  const contentType = declared || impliedContentType(req.body);
  if (!declared && contentType) headers.push(["Content-Type", contentType]);
  // The cookie jar is applied by the transport, so a snippet that omitted it would send a
  // different request than Send does.
  if (req.options.cookies.length > 0 && !headers.some(([name]) => name.toLowerCase() === "cookie")) {
    headers.push(["Cookie", req.options.cookies.map(([k, v]) => `${k}=${v}`).join("; ")]);
  }
  return { method: req.method, url: req.url, headers, body: req.body, contentType };
}

/** For clients that own the `Content-Type` themselves (a typed body object, a `-ContentType`
 * switch) — passing it twice is either a duplicate header or a runtime error. */
function headersWithoutContentType(w: Wire): [string, string][] {
  return w.headers.filter(([name]) => !isContentType(name));
}

/** Hand-assembled multipart has to announce its own boundary, which `wire` stripped. */
function headersWithBoundary(w: Wire): [string, string][] {
  if (w.body.kind !== "formdata") return w.headers;
  return [...w.headers, ["Content-Type", `multipart/form-data; boundary=${BOUNDARY}`]];
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** `application/x-www-form-urlencoded` serialisation: everything but ASCII alphanumerics and
 * `*-._` percent-encoded, space as `+` — matching what the transport does with the same pairs. */
function formEncodeOne(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

function formEncode(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${formEncodeOne(k)}=${formEncodeOne(v)}`).join("&");
}

type MultipartChunk = { kind: "text"; text: string } | { kind: "file"; path: string };

/** Splits a multipart body into its literal text runs and the file blobs between them, so targets
 * whose client has no multipart builder (raw HTTP, Foundation, `http.client`, Cohttp) can still
 * assemble the exact bytes in their own idiom instead of guessing. */
function multipartChunks(parts: FormPart[]): MultipartChunk[] {
  const chunks: MultipartChunk[] = [];
  let buf = "";
  for (const part of parts) {
    const name = part.name.replace(/"/g, "%22");
    buf += `--${BOUNDARY}\r\n`;
    buf += part.file_path
      ? `Content-Disposition: form-data; name="${name}"; filename="${baseName(part.file_path).replace(/"/g, "%22")}"\r\n`
      : `Content-Disposition: form-data; name="${name}"\r\n`;
    if (part.content_type) buf += `Content-Type: ${part.content_type}\r\n`;
    buf += "\r\n";
    if (part.file_path) {
      chunks.push({ kind: "text", text: buf }, { kind: "file", path: part.file_path });
      buf = "";
    } else {
      buf += part.value ?? "";
    }
    buf += "\r\n";
  }
  chunks.push({ kind: "text", text: `${buf}--${BOUNDARY}--\r\n` });
  return chunks;
}

interface UrlParts {
  secure: boolean;
  hostname: string;
  /** `""` when the URL relies on the scheme's default. */
  port: string;
  /** Host plus port, as the `Host` header wants it. */
  host: string;
  /** Path and query, always starting with `/`. */
  path: string;
}

/** Never throws: an interpolated URL can still be something `URL` rejects, and a roughly-split
 * snippet beats no snippet. */
function splitUrl(raw: string): UrlParts {
  try {
    const u = new URL(raw);
    return {
      secure: u.protocol === "https:" || u.protocol === "wss:",
      hostname: u.hostname,
      port: u.port,
      host: u.host,
      path: `${u.pathname}${u.search}` || "/",
    };
  } catch {
    const m = /^([a-zA-Z][\w+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(raw);
    const authority = m ? m[2] : "";
    const colon = authority.lastIndexOf(":");
    const hasPort = colon > -1 && /^\d+$/.test(authority.slice(colon + 1));
    return {
      secure: (m?.[1] ?? "https").toLowerCase().endsWith("s"),
      hostname: hasPort ? authority.slice(0, colon) : authority,
      port: hasPort ? authority.slice(colon + 1) : "",
      host: authority,
      path: (m ? m[3] : raw) || "/",
    };
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** `null` entries drop out; `""` stays as a deliberate blank line. */
function lines(...parts: (string | null)[]): string {
  return parts.filter((p): p is string => p !== null).join("\n");
}

function indentBy(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => (l.length > 0 ? prefix + l : l))
    .join("\n");
}

function joinCommand(parts: string[], opts: SnippetOptions): string {
  return opts.multiline ? parts.join(` \\\n${opts.indentWith}`) : parts.join(" ");
}

function pascalMethod(method: string): string {
  return method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
}

function isKnownMethod(method: string): boolean {
  return KNOWN_METHODS.includes(method.toUpperCase());
}

function hasFileParts(body: ResolvedBody): boolean {
  return body.kind === "formdata" && body.parts.some((p) => p.file_path);
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/** `--data-urlencode name=content` only encodes `content`, so a name needing encoding has to go
 * through a pre-encoded `--data-raw` instead of quietly travelling raw. */
const SAFE_FORM_NAME = /^[A-Za-z0-9_.*-]+$/;

function curlFormArg(part: FormPart): string {
  if (part.file_path) {
    const type = part.content_type ? `;type=${part.content_type}` : "";
    return `${part.name}=@${part.file_path}${type}`;
  }
  return `${part.name}=${part.value ?? ""}`;
}

const genCurl: Generator = (req, opts) => {
  const w = wire(req);
  const parts = [`curl --request ${w.method}`, `--url ${shq(w.url)}`];
  if (req.options.follow_redirects) parts.push("--location");
  if (!req.options.verify_ssl) parts.push("--insecure");
  if (req.options.proxy_url) parts.push(`--proxy ${shq(req.options.proxy_url)}`);
  for (const [name, value] of w.headers) parts.push(`--header ${shq(`${name}: ${value}`)}`);
  switch (w.body.kind) {
    case "text":
      parts.push(`--data-raw ${shq(w.body.text)}`);
      break;
    case "urlencoded":
      if (w.body.pairs.every(([k]) => SAFE_FORM_NAME.test(k))) {
        for (const [k, v] of w.body.pairs) parts.push(`--data-urlencode ${shq(`${k}=${v}`)}`);
      } else {
        parts.push(`--data-raw ${shq(formEncode(w.body.pairs))}`);
      }
      break;
    case "formdata":
      for (const part of w.body.parts) parts.push(`--form ${shq(curlFormArg(part))}`);
      break;
    case "file":
      parts.push(`--data-binary ${shq(`@${w.body.path}`)}`);
      break;
    case "none":
      break;
  }
  return joinCommand(parts, opts);
};

const genWget: Generator = (req, opts) => {
  const w = wire(req);
  const parts = ["wget --quiet", `--method ${w.method}`];
  if (!req.options.verify_ssl) parts.push("--no-check-certificate");
  for (const [name, value] of w.headers) parts.push(`--header ${shq(`${name}: ${value}`)}`);
  switch (w.body.kind) {
    case "text":
      parts.push(`--body-data ${shq(w.body.text)}`);
      break;
    case "urlencoded":
      parts.push(`--body-data ${shq(formEncode(w.body.pairs))}`);
      break;
    case "file":
      parts.push(`--body-file ${shq(w.body.path)}`);
      break;
    case "formdata":
    case "none":
      break;
  }
  if (opts.includeBoilerplate) parts.push("--output-document", "-");
  parts.push(shq(w.url));
  const command = joinCommand(parts, opts);
  return w.body.kind === "formdata"
    ? `# wget cannot build a multipart/form-data body — this snippet omits it.\n${command}`
    : command;
};

const genHttpie: Generator = (req, opts) => {
  const w = wire(req);
  const flags: string[] = [];
  if (w.body.kind === "formdata") flags.push("--multipart");
  else if (w.body.kind === "urlencoded") flags.push("--form");
  if (!req.options.verify_ssl) flags.push("--verify=no");
  if (req.options.follow_redirects) flags.push("--follow");

  const parts = [`http${flags.length > 0 ? ` ${flags.join(" ")}` : ""} ${w.method} ${shq(w.url)}`];
  for (const [name, value] of w.headers) parts.push(shq(`${name}:${value}`));
  if (w.body.kind === "urlencoded") {
    for (const [k, v] of w.body.pairs) parts.push(shq(`${k}=${v}`));
  }
  if (w.body.kind === "formdata") {
    for (const part of w.body.parts) {
      parts.push(shq(part.file_path ? `${part.name}@${part.file_path}` : `${part.name}=${part.value ?? ""}`));
    }
  }
  const command = joinCommand(parts, opts);
  if (w.body.kind === "text") return `printf '%s' ${shq(w.body.text)} | ${command}`;
  if (w.body.kind === "file") return `${command} < ${shq(w.body.path)}`;
  return command;
};

// ---------------------------------------------------------------------------
// HTTP — the raw request text
// ---------------------------------------------------------------------------

const genHttpRaw: Generator = (req) => {
  const w = wire(req);
  const url = splitUrl(w.url);
  const headers = headersWithBoundary(w);

  let body = "";
  let known = true;
  switch (w.body.kind) {
    case "text":
      body = w.body.text;
      break;
    case "urlencoded":
      body = formEncode(w.body.pairs);
      break;
    case "file":
      body = `<contents of ${w.body.path}>`;
      known = false;
      break;
    case "formdata":
      body = multipartChunks(w.body.parts)
        .map((c) => (c.kind === "text" ? c.text : `<contents of ${c.path}>`))
        .join("");
      known = !hasFileParts(w.body);
      break;
    case "none":
      break;
  }

  const head = [`${w.method} ${url.path} HTTP/1.1`, `Host: ${url.host}`];
  for (const [name, value] of headers) head.push(`${name}: ${value}`);
  if (body && known && !headers.some(([n]) => n.toLowerCase() === "content-length")) {
    head.push(`Content-Length: ${byteLength(body)}`);
  }
  return body ? `${head.join("\n")}\n\n${body}` : `${head.join("\n")}\n`;
};

// ---------------------------------------------------------------------------
// C
// ---------------------------------------------------------------------------

const genCLibcurl: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const out: (string | null)[] = ["CURL *hnd = curl_easy_init();", ""];
  out.push(`curl_easy_setopt(hnd, CURLOPT_CUSTOMREQUEST, ${dq(w.method)});`);
  out.push(`curl_easy_setopt(hnd, CURLOPT_URL, ${dq(w.url)});`);

  if (w.body.kind !== "formdata" && w.headers.length > 0) {
    out.push("", "struct curl_slist *headers = NULL;");
    for (const [name, value] of w.headers) {
      out.push(`headers = curl_slist_append(headers, ${dq(`${name}: ${value}`)});`);
    }
    out.push("curl_easy_setopt(hnd, CURLOPT_HTTPHEADER, headers);");
  }

  switch (w.body.kind) {
    case "text":
      out.push("", `curl_easy_setopt(hnd, CURLOPT_POSTFIELDS, ${dq(w.body.text)});`);
      break;
    case "urlencoded":
      out.push("", `curl_easy_setopt(hnd, CURLOPT_POSTFIELDS, ${dq(formEncode(w.body.pairs))});`);
      break;
    case "file":
      out.push(
        "",
        `FILE *fd = fopen(${dq(w.body.path)}, "rb");`,
        "curl_easy_setopt(hnd, CURLOPT_UPLOAD, 1L);",
        "curl_easy_setopt(hnd, CURLOPT_READDATA, fd);",
      );
      break;
    case "formdata": {
      out.push("", "curl_mime *mime = curl_mime_init(hnd);", "curl_mimepart *part;");
      for (const part of w.body.parts) {
        out.push("", "part = curl_mime_addpart(mime);", `curl_mime_name(part, ${dq(part.name)});`);
        if (part.file_path) out.push(`curl_mime_filedata(part, ${dq(part.file_path)});`);
        else out.push(`curl_mime_data(part, ${dq(part.value ?? "")}, CURL_ZERO_TERMINATED);`);
        if (part.content_type) out.push(`curl_mime_type(part, ${dq(part.content_type)});`);
      }
      out.push("", "curl_easy_setopt(hnd, CURLOPT_MIMEPOST, mime);");
      if (w.headers.length > 0) {
        out.push("", "struct curl_slist *headers = NULL;");
        for (const [name, value] of w.headers) {
          out.push(`headers = curl_slist_append(headers, ${dq(`${name}: ${value}`)});`);
        }
        out.push("curl_easy_setopt(hnd, CURLOPT_HTTPHEADER, headers);");
      }
      break;
    }
    case "none":
      break;
  }

  out.push("", "CURLcode ret = curl_easy_perform(hnd);");
  if (opts.includeBoilerplate) {
    out.push(
      "",
      "if (ret != CURLE_OK) {",
      `${i}fprintf(stderr, "request failed: %s\\n", curl_easy_strerror(ret));`,
      "}",
      "curl_easy_cleanup(hnd);",
    );
  }
  return lines(...out);
};

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

function csharpMethod(method: string): string {
  return isKnownMethod(method) ? `HttpMethod.${pascalMethod(method)}` : `new HttpMethod(${dq(method)})`;
}

const genCsharpHttpClient: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const usings = new Set(["System.Net.Http"]);
  if (opts.includeBoilerplate) usings.add("System");

  const out: (string | null)[] = [
    "var client = new HttpClient();",
    `var request = new HttpRequestMessage(${csharpMethod(w.method)}, ${dq(w.url)});`,
  ];
  // `HttpRequestMessage.Headers` rejects content headers at runtime, so `Content-Type` has to ride
  // on the content object instead.
  for (const [name, value] of headersWithoutContentType(w)) {
    out.push(`request.Headers.Add(${dq(name)}, ${dq(value)});`);
  }

  switch (w.body.kind) {
    case "text":
      usings.add("System.Text");
      out.push(
        `var content = new StringContent(${dq(w.body.text)}, Encoding.UTF8, ${dq(w.contentType || "text/plain")});`,
        "request.Content = content;",
      );
      break;
    case "urlencoded":
      usings.add("System.Collections.Generic");
      out.push("var content = new FormUrlEncodedContent(new List<KeyValuePair<string, string>>");
      out.push("{");
      for (const [k, v] of w.body.pairs) {
        out.push(`${i}new KeyValuePair<string, string>(${dq(k)}, ${dq(v)}),`);
      }
      out.push("});", "request.Content = content;");
      break;
    case "formdata": {
      out.push("var content = new MultipartFormDataContent();");
      w.body.parts.forEach((part, index) => {
        if (part.file_path) {
          usings.add("System.IO");
          const variable = `part${index}`;
          out.push(`var ${variable} = new StreamContent(File.OpenRead(${dq(part.file_path)}));`);
          if (part.content_type) {
            usings.add("System.Net.Http.Headers");
            out.push(`${variable}.Headers.ContentType = new MediaTypeHeaderValue(${dq(part.content_type)});`);
          }
          out.push(`content.Add(${variable}, ${dq(part.name)}, ${dq(baseName(part.file_path))});`);
        } else {
          out.push(`content.Add(new StringContent(${dq(part.value ?? "")}), ${dq(part.name)});`);
        }
      });
      out.push("request.Content = content;");
      break;
    }
    case "file":
      usings.add("System.IO");
      usings.add("System.Net.Http.Headers");
      out.push(
        `var content = new StreamContent(File.OpenRead(${dq(w.body.path)}));`,
        `content.Headers.ContentType = new MediaTypeHeaderValue(${dq(w.contentType)});`,
        "request.Content = content;",
      );
      break;
    case "none":
      break;
  }

  out.push("var response = await client.SendAsync(request);");
  if (opts.includeBoilerplate) {
    out.push("response.EnsureSuccessStatusCode();", "Console.WriteLine(await response.Content.ReadAsStringAsync());");
  }
  return lines(...[...usings].sort().map((u) => `using ${u};`), "", ...out);
};

const genCsharpRestSharp: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const method = isKnownMethod(w.method) ? `Method.${pascalMethod(w.method)}` : `Method.Get /* ${w.method} */`;
  const out: (string | null)[] = [
    `var options = new RestClientOptions(${dq(w.url)});`,
    "var client = new RestClient(options);",
    `var request = new RestRequest("", ${method});`,
  ];
  for (const [name, value] of headersWithoutContentType(w)) {
    out.push(`request.AddHeader(${dq(name)}, ${dq(value)});`);
  }

  switch (w.body.kind) {
    case "text":
      out.push(`request.AddStringBody(${dq(w.body.text)}, ${dq(w.contentType || "text/plain")});`);
      break;
    case "urlencoded":
      for (const [k, v] of w.body.pairs) out.push(`request.AddParameter(${dq(k)}, ${dq(v)});`);
      break;
    case "formdata":
      out.push("request.AlwaysMultipartFormData = true;");
      for (const part of w.body.parts) {
        if (part.file_path) out.push(`request.AddFile(${dq(part.name)}, ${dq(part.file_path)});`);
        else out.push(`request.AddParameter(${dq(part.name)}, ${dq(part.value ?? "")});`);
      }
      break;
    case "file":
      out.push(`request.AddFile("file", ${dq(w.body.path)});`);
      break;
    case "none":
      break;
  }

  out.push("var response = await client.ExecuteAsync(request);");
  if (opts.includeBoilerplate) out.push("Console.WriteLine(response.Content);");
  return lines(
    "using RestSharp;",
    opts.includeBoilerplate ? "using System;" : null,
    "",
    ...out.map((l) => (l === null ? null : l.startsWith(i) ? l : l)),
  );
};

// ---------------------------------------------------------------------------
// Dart
// ---------------------------------------------------------------------------

const genDartDio: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const out: (string | null)[] = ["import 'package:dio/dio.dart';", "", "var dio = Dio();"];

  const headers = w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;
  if (headers.length > 0) {
    out.push("var headers = {");
    for (const [name, value] of headers) out.push(`${i}${dollarq(name)}: ${dollarq(value)},`);
    out.push("};");
  }

  let data: string | null = null;
  switch (w.body.kind) {
    case "text":
      out.push(`var data = ${dollarq(w.body.text)};`);
      data = "data";
      break;
    case "urlencoded":
      out.push("var data = {");
      for (const [k, v] of w.body.pairs) out.push(`${i}${dollarq(k)}: ${dollarq(v)},`);
      out.push("};");
      data = "data";
      break;
    case "formdata":
      out.push("var data = FormData.fromMap({");
      for (const part of w.body.parts) {
        out.push(
          part.file_path
            ? `${i}${dollarq(part.name)}: await MultipartFile.fromFile(${dollarq(part.file_path)}, filename: ${dollarq(baseName(part.file_path))}),`
            : `${i}${dollarq(part.name)}: ${dollarq(part.value ?? "")},`,
        );
      }
      out.push("});");
      data = "data";
      break;
    case "file":
      out.push(`var data = await MultipartFile.fromFile(${dollarq(w.body.path)});`);
      data = "data.finalize()";
      break;
    case "none":
      break;
  }

  out.push(
    "var response = await dio.request(",
    `${i}${dollarq(w.url)},`,
    `${i}options: Options(`,
    `${i}${i}method: ${dollarq(w.method)},`,
    headers.length > 0 ? `${i}${i}headers: headers,` : null,
    w.body.kind === "urlencoded" ? `${i}${i}contentType: Headers.formUrlEncodedContentType,` : null,
    `${i}),`,
    data ? `${i}data: ${data},` : null,
    ");",
  );
  if (opts.includeBoilerplate) {
    out.push("", "print(response.statusCode);", "print(json.encode(response.data));");
  }
  return lines(...out);
};

const genDartHttp: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const multipart = w.body.kind === "formdata";
  const out: (string | null)[] = ["import 'package:http/http.dart' as http;", ""];

  const headers = multipart ? headersWithoutContentType(w) : w.headers;
  if (headers.length > 0) {
    out.push("var headers = {");
    for (const [name, value] of headers) out.push(`${i}${dollarq(name)}: ${dollarq(value)},`);
    out.push("};");
  }

  if (multipart && w.body.kind === "formdata") {
    out.push(`var request = http.MultipartRequest(${dollarq(w.method)}, Uri.parse(${dollarq(w.url)}));`);
    const fields = w.body.parts.filter((p) => !p.file_path);
    if (fields.length > 0) {
      out.push("request.fields.addAll({");
      for (const part of fields) out.push(`${i}${dollarq(part.name)}: ${dollarq(part.value ?? "")},`);
      out.push("});");
    }
    for (const part of w.body.parts) {
      if (!part.file_path) continue;
      out.push(
        `request.files.add(await http.MultipartFile.fromPath(${dollarq(part.name)}, ${dollarq(part.file_path)}));`,
      );
    }
  } else {
    out.push(`var request = http.Request(${dollarq(w.method)}, Uri.parse(${dollarq(w.url)}));`);
    switch (w.body.kind) {
      case "text":
        out.push(`request.body = ${dollarq(w.body.text)};`);
        break;
      case "urlencoded":
        out.push("request.bodyFields = {");
        for (const [k, v] of w.body.pairs) out.push(`${i}${dollarq(k)}: ${dollarq(v)},`);
        out.push("};");
        break;
      case "file":
        out.push("import 'dart:io';".length > 0 ? `request.bodyBytes = await File(${dollarq(w.body.path)}).readAsBytes();` : null);
        break;
      default:
        break;
    }
  }

  if (headers.length > 0) out.push("request.headers.addAll(headers);");
  out.push("", "http.StreamedResponse response = await request.send();");
  if (opts.includeBoilerplate) {
    out.push(
      "",
      "if (response.statusCode == 200) {",
      `${i}print(await response.stream.bytesToString());`,
      "} else {",
      `${i}print(response.reasonPhrase);`,
      "}",
    );
  }
  const code = lines(...out);
  return w.body.kind === "file" ? `import 'dart:io';\n${code}` : code;
};

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const genGoNative: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const imports = new Set(["net/http"]);
  const body: string[] = [];
  let payload = "nil";

  switch (w.body.kind) {
    case "text":
      imports.add("strings");
      body.push(`payload := strings.NewReader(${dq(w.body.text)})`, "");
      payload = "payload";
      break;
    case "urlencoded":
      imports.add("strings");
      body.push(`payload := strings.NewReader(${dq(formEncode(w.body.pairs))})`, "");
      payload = "payload";
      break;
    case "file":
      imports.add("os");
      body.push(`payload, _ := os.Open(${dq(w.body.path)})`, "defer payload.Close()", "");
      payload = "payload";
      break;
    case "formdata": {
      imports.add("bytes");
      imports.add("mime/multipart");
      body.push("payload := &bytes.Buffer{}", "writer := multipart.NewWriter(payload)");
      for (const part of w.body.parts) {
        if (part.file_path) {
          imports.add("io");
          imports.add("os");
          body.push(
            `file, _ := os.Open(${dq(part.file_path)})`,
            `filePart, _ := writer.CreateFormFile(${dq(part.name)}, ${dq(baseName(part.file_path))})`,
            "_, _ = io.Copy(filePart, file)",
            "file.Close()",
          );
        } else {
          body.push(`_ = writer.WriteField(${dq(part.name)}, ${dq(part.value ?? "")})`);
        }
      }
      body.push("writer.Close()", "");
      payload = "payload";
      break;
    }
    case "none":
      break;
  }

  const out: string[] = [];
  out.push(`url := ${dq(w.url)}`, "");
  out.push(...body);
  out.push(`req, _ := http.NewRequest(${dq(w.method)}, url, ${payload})`, "");
  for (const [name, value] of w.headers) out.push(`req.Header.Add(${dq(name)}, ${dq(value)})`);
  if (w.body.kind === "formdata") out.push('req.Header.Set("Content-Type", writer.FormDataContentType())');
  out.push("", "res, _ := http.DefaultClient.Do(req)", "defer res.Body.Close()");
  if (opts.includeBoilerplate) {
    imports.add("io");
    imports.add("fmt");
    out.push("", "body, _ := io.ReadAll(res.Body)", "fmt.Println(res.Status)", "fmt.Println(string(body))");
  }

  return lines(
    "package main",
    "",
    "import (",
    ...[...imports].sort().map((im) => `${i}${dq(im)}`),
    ")",
    "",
    "func main() {",
    indentBy(out.join("\n"), i),
    "}",
  );
};

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const genJavaOkHttp: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const out: (string | null)[] = ["OkHttpClient client = new OkHttpClient();", ""];
  let bodyExpr: string | null = null;

  switch (w.body.kind) {
    case "text":
      out.push(
        `MediaType mediaType = MediaType.parse(${dq(w.contentType || "text/plain")});`,
        `RequestBody body = RequestBody.create(mediaType, ${dq(w.body.text)});`,
      );
      bodyExpr = "body";
      break;
    case "urlencoded":
      out.push("RequestBody body = new FormBody.Builder()");
      for (const [k, v] of w.body.pairs) out.push(`${i}.add(${dq(k)}, ${dq(v)})`);
      out.push(`${i}.build();`);
      bodyExpr = "body";
      break;
    case "formdata":
      out.push("RequestBody body = new MultipartBody.Builder().setType(MultipartBody.FORM)");
      for (const part of w.body.parts) {
        out.push(
          part.file_path
            ? `${i}.addFormDataPart(${dq(part.name)}, ${dq(baseName(part.file_path))}, RequestBody.create(MediaType.parse(${dq(part.content_type || "application/octet-stream")}), new File(${dq(part.file_path)})))`
            : `${i}.addFormDataPart(${dq(part.name)}, ${dq(part.value ?? "")})`,
        );
      }
      out.push(`${i}.build();`);
      bodyExpr = "body";
      break;
    case "file":
      out.push(
        `MediaType mediaType = MediaType.parse(${dq(w.contentType)});`,
        `RequestBody body = RequestBody.create(mediaType, new File(${dq(w.body.path)}));`,
      );
      bodyExpr = "body";
      break;
    case "none":
      break;
  }
  if (bodyExpr) out.push("");

  out.push("Request request = new Request.Builder()", `${i}.url(${dq(w.url)})`);
  out.push(`${i}.method(${dq(w.method)}, ${bodyExpr ?? "null"})`);
  for (const [name, value] of w.headers) out.push(`${i}.addHeader(${dq(name)}, ${dq(value)})`);
  out.push(`${i}.build();`, "", "Response response = client.newCall(request).execute();");
  if (opts.includeBoilerplate) out.push("System.out.println(response.body().string());");
  return lines(...out);
};

function unirestEntry(method: string, url: string): string {
  const lower = method.toLowerCase();
  return ["get", "post", "put", "patch", "delete", "head", "options"].includes(lower)
    ? `Unirest.${lower}(${dq(url)})`
    : `Unirest.request(${dq(method)}, ${dq(url)})`;
}

const genJavaUnirest: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const chain: string[] = [];
  for (const [name, value] of w.headers) chain.push(`${i}.header(${dq(name)}, ${dq(value)})`);
  switch (w.body.kind) {
    case "text":
      chain.push(`${i}.body(${dq(w.body.text)})`);
      break;
    case "urlencoded":
      for (const [k, v] of w.body.pairs) chain.push(`${i}.field(${dq(k)}, ${dq(v)})`);
      break;
    case "formdata":
      for (const part of w.body.parts) {
        chain.push(
          part.file_path
            ? `${i}.field(${dq(part.name)}, new File(${dq(part.file_path)}))`
            : `${i}.field(${dq(part.name)}, ${dq(part.value ?? "")})`,
        );
      }
      break;
    case "file":
      chain.push(`${i}.body(Files.readAllBytes(Paths.get(${dq(w.body.path)})))`);
      break;
    case "none":
      break;
  }
  return lines(
    `HttpResponse<String> response = ${unirestEntry(w.method, w.url)}`,
    ...chain,
    `${i}.asString();`,
    opts.includeBoilerplate ? "" : null,
    opts.includeBoilerplate ? "System.out.println(response.getBody());" : null,
  );
};

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

const genKotlinOkHttp: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const out: (string | null)[] = ["val client = OkHttpClient()", ""];
  let bodyExpr: string | null = null;

  switch (w.body.kind) {
    case "text":
      out.push(
        `val mediaType = ${dollarq(w.contentType || "text/plain")}.toMediaType()`,
        `val body = ${dollarq(w.body.text)}.toRequestBody(mediaType)`,
      );
      bodyExpr = "body";
      break;
    case "urlencoded":
      out.push("val body = FormBody.Builder()");
      for (const [k, v] of w.body.pairs) out.push(`${i}.add(${dollarq(k)}, ${dollarq(v)})`);
      out.push(`${i}.build()`);
      bodyExpr = "body";
      break;
    case "formdata":
      out.push("val body = MultipartBody.Builder().setType(MultipartBody.FORM)");
      for (const part of w.body.parts) {
        out.push(
          part.file_path
            ? `${i}.addFormDataPart(${dollarq(part.name)}, ${dollarq(baseName(part.file_path))}, File(${dollarq(part.file_path)}).asRequestBody(${dollarq(part.content_type || "application/octet-stream")}.toMediaType()))`
            : `${i}.addFormDataPart(${dollarq(part.name)}, ${dollarq(part.value ?? "")})`,
        );
      }
      out.push(`${i}.build()`);
      bodyExpr = "body";
      break;
    case "file":
      out.push(`val body = File(${dollarq(w.body.path)}).asRequestBody(${dollarq(w.contentType)}.toMediaType())`);
      bodyExpr = "body";
      break;
    case "none":
      break;
  }
  if (bodyExpr) out.push("");

  out.push("val request = Request.Builder()", `${i}.url(${dollarq(w.url)})`);
  out.push(`${i}.method(${dollarq(w.method)}, ${bodyExpr ?? "null"})`);
  for (const [name, value] of w.headers) out.push(`${i}.addHeader(${dollarq(name)}, ${dollarq(value)})`);
  out.push(`${i}.build()`, "", "val response = client.newCall(request).execute()");
  if (opts.includeBoilerplate) out.push("println(response.body?.string())");
  return lines(...out);
};

// ---------------------------------------------------------------------------
// JavaScript (browser)
// ---------------------------------------------------------------------------

/** Browser `FormData`/`fetch` bodies take a `File`, which no snippet can conjure from a path —
 * saying so beats emitting a line that silently uploads nothing. */
const BROWSER_FILE_NOTE = "// Browsers cannot read a path: supply a File/Blob, e.g. from an <input type=\"file\">.";

function jsFormDataLines(parts: FormPart[], variable: string): string[] {
  const out = [`const ${variable} = new FormData();`];
  for (const part of parts) {
    if (part.file_path) {
      out.push(`${BROWSER_FILE_NOTE} (${part.file_path})`);
      out.push(`${variable}.append(${jsq(part.name)}, fileInput.files[0], ${jsq(baseName(part.file_path))});`);
    } else {
      out.push(`${variable}.append(${jsq(part.name)}, ${jsq(part.value ?? "")});`);
    }
  }
  return out;
}

function jsUrlEncodedLines(pairs: [string, string][], variable: string): string[] {
  return [
    `const ${variable} = new URLSearchParams();`,
    ...pairs.map(([k, v]) => `${variable}.append(${jsq(k)}, ${jsq(v)});`),
  ];
}

const genJsFetch: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const pre: string[] = [];
  let bodyExpr: string | null = null;

  switch (w.body.kind) {
    case "text":
      bodyExpr = jsq(w.body.text);
      break;
    case "urlencoded":
      pre.push(...jsUrlEncodedLines(w.body.pairs, "form"), "");
      bodyExpr = "form";
      break;
    case "formdata":
      pre.push(...jsFormDataLines(w.body.parts, "form"), "");
      bodyExpr = "form";
      break;
    case "file":
      pre.push(BROWSER_FILE_NOTE, `// ${w.body.path}`, "");
      bodyExpr = "fileInput.files[0]";
      break;
    case "none":
      break;
  }

  const options: string[] = [`method: ${jsq(w.method)}`];
  if (w.headers.length > 0) {
    options.push(
      `headers: {\n${w.headers.map(([n, v]) => `${i}${i}${jsq(n)}: ${jsq(v)}`).join(",\n")}\n${i}}`,
    );
  }
  if (bodyExpr) options.push(`body: ${bodyExpr}`);

  return lines(
    ...pre,
    `const response = await fetch(${jsq(w.url)}, {`,
    ...options.map((o, idx) => `${i}${o}${idx === options.length - 1 ? "" : ","}`),
    "});",
    opts.includeBoilerplate ? "" : null,
    opts.includeBoilerplate ? "console.log(await response.text());" : null,
  );
};

function axiosSnippet(req: ResolvedRequest, opts: SnippetOptions, runtime: "browser" | "node"): string {
  const w = wire(req);
  const i = opts.indentWith;
  const pre: string[] = [];
  const post: string[] = [];
  let dataExpr: string | null = null;
  let headers = w.headers;

  switch (w.body.kind) {
    case "text":
      dataExpr = jsq(w.body.text);
      break;
    case "urlencoded":
      dataExpr = jsq(formEncode(w.body.pairs));
      break;
    case "formdata":
      if (runtime === "node") {
        pre.push("const form = new FormData();");
        for (const part of w.body.parts) {
          pre.push(
            part.file_path
              ? `form.append(${jsq(part.name)}, await fs.openAsBlob(${jsq(part.file_path)}), ${jsq(baseName(part.file_path))});`
              : `form.append(${jsq(part.name)}, ${jsq(part.value ?? "")});`,
          );
        }
      } else {
        pre.push(...jsFormDataLines(w.body.parts, "form"));
      }
      pre.push("");
      dataExpr = "form";
      break;
    case "file":
      if (runtime === "node") {
        pre.push(`const data = await fs.openAsBlob(${jsq(w.body.path)});`, "");
        dataExpr = "data";
      } else {
        pre.push(BROWSER_FILE_NOTE, `// ${w.body.path}`, "");
        dataExpr = "fileInput.files[0]";
      }
      break;
    case "none":
      break;
  }
  if (w.body.kind === "formdata") headers = headersWithoutContentType(w);

  const options: string[] = [`method: ${jsq(w.method)}`, `url: ${jsq(w.url)}`];
  if (headers.length > 0) {
    options.push(`headers: {\n${headers.map(([n, v]) => `${i}${i}${jsq(n)}: ${jsq(v)}`).join(",\n")}\n${i}}`);
  }
  if (dataExpr) options.push(`data: ${dataExpr}`);

  if (opts.includeBoilerplate) {
    post.push(
      "",
      "try {",
      `${i}const { data } = await axios.request(options);`,
      `${i}console.log(data);`,
      "} catch (error) {",
      `${i}console.error(error);`,
      "}",
    );
  } else {
    post.push("", "const { data } = await axios.request(options);");
  }

  return lines(
    runtime === "node" ? "const axios = require('axios');" : "import axios from 'axios';",
    runtime === "node" && (w.body.kind === "file" || hasFileParts(w.body)) ? "const fs = require('node:fs');" : null,
    "",
    ...pre,
    "const options = {",
    ...options.map((o, idx) => `${i}${o}${idx === options.length - 1 ? "" : ","}`),
    "};",
    ...post,
  );
}

const genJsAxios: Generator = (req, opts) => axiosSnippet(req, opts, "browser");

const genJsJquery: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const pre: string[] = [];
  const settings: string[] = ["async: true", "crossDomain: true", `url: ${jsq(w.url)}`, `method: ${jsq(w.method)}`];
  const headers = w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;
  if (headers.length > 0) {
    settings.push(`headers: {\n${headers.map(([n, v]) => `${i}${i}${jsq(n)}: ${jsq(v)}`).join(",\n")}\n${i}}`);
  }

  switch (w.body.kind) {
    case "text":
      settings.push(`data: ${jsq(w.body.text)}`);
      break;
    case "urlencoded":
      settings.push(`data: ${jsq(formEncode(w.body.pairs))}`);
      break;
    case "formdata":
      pre.push(...jsFormDataLines(w.body.parts, "form"), "");
      settings.push("processData: false", "contentType: false", "data: form");
      break;
    case "file":
      pre.push(BROWSER_FILE_NOTE, `// ${w.body.path}`, "");
      settings.push("processData: false", "data: fileInput.files[0]");
      break;
    case "none":
      break;
  }

  return lines(
    ...pre,
    "const settings = {",
    ...settings.map((s, idx) => `${i}${s}${idx === settings.length - 1 ? "" : ","}`),
    "};",
    "",
    opts.includeBoilerplate ? "$.ajax(settings).done(function (response) {" : "$.ajax(settings);",
    opts.includeBoilerplate ? `${i}console.log(response);` : null,
    opts.includeBoilerplate ? "});" : null,
  );
};

const genJsXhr: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const pre: string[] = [];
  let sendExpr = "";

  switch (w.body.kind) {
    case "text":
      pre.push(`const data = ${jsq(w.body.text)};`, "");
      sendExpr = "data";
      break;
    case "urlencoded":
      pre.push(...jsUrlEncodedLines(w.body.pairs, "data"), "");
      sendExpr = "data";
      break;
    case "formdata":
      pre.push(...jsFormDataLines(w.body.parts, "data"), "");
      sendExpr = "data";
      break;
    case "file":
      pre.push(BROWSER_FILE_NOTE, `// ${w.body.path}`, "");
      sendExpr = "fileInput.files[0]";
      break;
    case "none":
      break;
  }

  return lines(
    ...pre,
    "const xhr = new XMLHttpRequest();",
    "xhr.withCredentials = true;",
    opts.includeBoilerplate ? "" : null,
    opts.includeBoilerplate ? "xhr.addEventListener('readystatechange', function () {" : null,
    opts.includeBoilerplate ? `${i}if (this.readyState === this.DONE) {` : null,
    opts.includeBoilerplate ? `${i}${i}console.log(this.responseText);` : null,
    opts.includeBoilerplate ? `${i}}` : null,
    opts.includeBoilerplate ? "});" : null,
    "",
    `xhr.open(${jsq(w.method)}, ${jsq(w.url)});`,
    ...(w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers).map(
      ([name, value]) => `xhr.setRequestHeader(${jsq(name)}, ${jsq(value)});`,
    ),
    "",
    `xhr.send(${sendExpr});`,
  );
};

// ---------------------------------------------------------------------------
// NodeJs
// ---------------------------------------------------------------------------

const genNodeAxios: Generator = (req, opts) => axiosSnippet(req, opts, "node");

const genNodeFetch: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const pre: string[] = [];
  let bodyExpr: string | null = null;
  let needsFs = false;

  switch (w.body.kind) {
    case "text":
      bodyExpr = jsq(w.body.text);
      break;
    case "urlencoded":
      pre.push(...jsUrlEncodedLines(w.body.pairs, "form"), "");
      bodyExpr = "form";
      break;
    case "formdata":
      pre.push("const form = new FormData();");
      for (const part of w.body.parts) {
        if (part.file_path) {
          needsFs = true;
          pre.push(
            `form.append(${jsq(part.name)}, await fs.openAsBlob(${jsq(part.file_path)}), ${jsq(baseName(part.file_path))});`,
          );
        } else {
          pre.push(`form.append(${jsq(part.name)}, ${jsq(part.value ?? "")});`);
        }
      }
      pre.push("");
      bodyExpr = "form";
      break;
    case "file":
      needsFs = true;
      pre.push(`const data = await fs.openAsBlob(${jsq(w.body.path)});`, "");
      bodyExpr = "data";
      break;
    case "none":
      break;
  }

  const headers = w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;
  const options: string[] = [`method: ${jsq(w.method)}`];
  if (headers.length > 0) {
    options.push(`headers: {\n${headers.map(([n, v]) => `${i}${i}${jsq(n)}: ${jsq(v)}`).join(",\n")}\n${i}}`);
  }
  if (bodyExpr) options.push(`body: ${bodyExpr}`);

  return lines(
    needsFs ? "const fs = require('node:fs');" : null,
    needsFs ? "" : null,
    ...pre,
    `const response = await fetch(${jsq(w.url)}, {`,
    ...options.map((o, idx) => `${i}${o}${idx === options.length - 1 ? "" : ","}`),
    "});",
    opts.includeBoilerplate ? "" : null,
    opts.includeBoilerplate ? "console.log(await response.text());" : null,
  );
};

const genNodeNative: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const url = splitUrl(w.url);
  const module = url.secure ? "https" : "http";
  const headers = w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;

  const pre: string[] = [];
  const tail: string[] = [];
  const requires = [`const ${module} = require('node:${module}');`];

  switch (w.body.kind) {
    case "text":
      tail.push(`req.write(${jsq(w.body.text)});`, "req.end();");
      break;
    case "urlencoded":
      tail.push(`req.write(${jsq(formEncode(w.body.pairs))});`, "req.end();");
      break;
    case "file":
      requires.push("const fs = require('node:fs');");
      tail.push(`fs.createReadStream(${jsq(w.body.path)}).pipe(req);`);
      break;
    case "formdata":
      // `node:http` has no multipart builder; `form-data` is the package everyone reaches for,
      // and it owns the boundary so the Content-Type comes from `getHeaders()`.
      requires.push("const FormData = require('form-data');");
      if (hasFileParts(w.body)) requires.push("const fs = require('node:fs');");
      pre.push("const form = new FormData();");
      for (const part of w.body.parts) {
        pre.push(
          part.file_path
            ? `form.append(${jsq(part.name)}, fs.createReadStream(${jsq(part.file_path)}));`
            : `form.append(${jsq(part.name)}, ${jsq(part.value ?? "")});`,
        );
      }
      pre.push("");
      tail.push("form.pipe(req);");
      break;
    case "none":
      tail.push("req.end();");
      break;
  }

  const headerLines = headers.map(([n, v]) => `${i}${i}${jsq(n)}: ${jsq(v)}`).join(",\n");
  const headerValue =
    w.body.kind === "formdata"
      ? headers.length > 0
        ? `{\n${headerLines},\n${i}${i}...form.getHeaders()\n${i}}`
        : "form.getHeaders()"
      : `{\n${headerLines}\n${i}}`;

  return lines(
    ...requires,
    "",
    ...pre,
    "const options = {",
    `${i}method: ${jsq(w.method)},`,
    `${i}hostname: ${jsq(url.hostname)},`,
    `${i}port: ${url.port ? url.port : "null"},`,
    `${i}path: ${jsq(url.path)}${headers.length > 0 || w.body.kind === "formdata" ? "," : ""}`,
    headers.length > 0 || w.body.kind === "formdata" ? `${i}headers: ${headerValue}` : null,
    "};",
    "",
    opts.includeBoilerplate ? `const req = ${module}.request(options, function (res) {` : null,
    opts.includeBoilerplate ? `${i}const chunks = [];` : null,
    opts.includeBoilerplate ? "" : null,
    opts.includeBoilerplate ? `${i}res.on('data', function (chunk) {` : null,
    opts.includeBoilerplate ? `${i}${i}chunks.push(chunk);` : null,
    opts.includeBoilerplate ? `${i}});` : null,
    opts.includeBoilerplate ? "" : null,
    opts.includeBoilerplate ? `${i}res.on('end', function () {` : null,
    opts.includeBoilerplate ? `${i}${i}console.log(Buffer.concat(chunks).toString());` : null,
    opts.includeBoilerplate ? `${i}});` : null,
    opts.includeBoilerplate ? "});" : `const req = ${module}.request(options);`,
    "",
    ...tail,
  );
};

const genNodeRequest: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const headers = w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;
  const options: string[] = [`method: ${jsq(w.method)}`, `url: ${jsq(w.url)}`];
  if (headers.length > 0) {
    options.push(`headers: {\n${headers.map(([n, v]) => `${i}${i}${jsq(n)}: ${jsq(v)}`).join(",\n")}\n${i}}`);
  }
  let needsFs = false;

  switch (w.body.kind) {
    case "text":
      options.push(`body: ${jsq(w.body.text)}`);
      break;
    case "urlencoded":
      options.push(`form: ${jsq(formEncode(w.body.pairs))}`);
      break;
    case "formdata": {
      const parts = w.body.parts.map((part) => {
        if (part.file_path) {
          needsFs = true;
          return `${i}${i}${jsq(part.name)}: fs.createReadStream(${jsq(part.file_path)})`;
        }
        return `${i}${i}${jsq(part.name)}: ${jsq(part.value ?? "")}`;
      });
      options.push(`formData: {\n${parts.join(",\n")}\n${i}}`);
      break;
    }
    case "file":
      needsFs = true;
      options.push(`body: fs.createReadStream(${jsq(w.body.path)})`);
      break;
    case "none":
      break;
  }

  return lines(
    "const request = require('request');",
    needsFs ? "const fs = require('node:fs');" : null,
    "",
    "const options = {",
    ...options.map((o, idx) => `${i}${o}${idx === options.length - 1 ? "" : ","}`),
    "};",
    "",
    "request(options, function (error, response, body) {",
    `${i}if (error) throw new Error(error);`,
    opts.includeBoilerplate ? `${i}console.log(body);` : null,
    "});",
  );
};

// ---------------------------------------------------------------------------
// Objective-C
// ---------------------------------------------------------------------------

const genObjcNsUrlSession: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const headers = headersWithBoundary(w);
  const out: (string | null)[] = ["#import <Foundation/Foundation.h>", ""];

  if (headers.length > 0) {
    out.push("NSDictionary *headers = @{");
    headers.forEach(([name, value], idx) => {
      out.push(`${i}@${dq(name)}: @${dq(value)}${idx === headers.length - 1 ? "" : ","}`);
    });
    out.push("};", "");
  }

  switch (w.body.kind) {
    case "text":
      out.push(`NSData *postData = [@${dq(w.body.text)} dataUsingEncoding:NSUTF8StringEncoding];`, "");
      break;
    case "urlencoded":
      out.push(`NSData *postData = [@${dq(formEncode(w.body.pairs))} dataUsingEncoding:NSUTF8StringEncoding];`, "");
      break;
    case "file":
      out.push(`NSData *postData = [NSData dataWithContentsOfFile:@${dq(w.body.path)}];`, "");
      break;
    case "formdata":
      // Foundation ships no multipart builder, so the body is assembled by hand — the boundary in
      // the Content-Type header above is the same one.
      out.push("NSMutableData *postData = [NSMutableData data];");
      for (const chunk of multipartChunks(w.body.parts)) {
        out.push(
          chunk.kind === "text"
            ? `[postData appendData:[@${dq(chunk.text)} dataUsingEncoding:NSUTF8StringEncoding]];`
            : `[postData appendData:[NSData dataWithContentsOfFile:@${dq(chunk.path)}]];`,
        );
      }
      out.push("");
      break;
    case "none":
      break;
  }

  out.push(
    `NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@${dq(w.url)}]`,
    `${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}cachePolicy:NSURLRequestUseProtocolCachePolicy`,
    `${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}timeoutInterval:${(req.options.timeout_ms / 1000).toFixed(1)}];`,
    `[request setHTTPMethod:@${dq(w.method)}];`,
  );
  if (headers.length > 0) out.push("[request setAllHTTPHeaderFields:headers];");
  if (w.body.kind !== "none") out.push("[request setHTTPBody:postData];");

  out.push(
    "",
    "NSURLSession *session = [NSURLSession sharedSession];",
    "NSURLSessionDataTask *dataTask = [session dataTaskWithRequest:request",
    `${i}completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {`,
    `${i}${i}if (error) {`,
    `${i}${i}${i}NSLog(@"%@", error);`,
    `${i}${i}} else {`,
    opts.includeBoilerplate
      ? `${i}${i}${i}NSLog(@"%@", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);`
      : `${i}${i}${i}NSLog(@"%@", (NSHTTPURLResponse *) response);`,
    `${i}${i}}`,
    `${i}}];`,
    "[dataTask resume];",
  );
  return lines(...out);
};

// ---------------------------------------------------------------------------
// OCaml
// ---------------------------------------------------------------------------

function ocamlMethod(method: string): string {
  return isKnownMethod(method) ? `\`${method.toUpperCase()}` : `\`Other ${dq(method)}`;
}

const genOcamlCohttp: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const headers = headersWithBoundary(w);
  const out: (string | null)[] = ["open Lwt", "open Cohttp", "open Cohttp_lwt_unix", ""];

  out.push(`let uri = Uri.of_string ${dq(w.url)} in`);
  if (headers.length > 0) {
    out.push("let headers = Header.add_list (Header.init ()) [");
    for (const [name, value] of headers) out.push(`${i}(${dq(name)}, ${dq(value)});`);
    out.push("] in");
  }

  switch (w.body.kind) {
    case "text":
      out.push(`let body = Cohttp_lwt.Body.of_string ${dq(w.body.text)} in`);
      break;
    case "urlencoded":
      out.push(`let body = Cohttp_lwt.Body.of_string ${dq(formEncode(w.body.pairs))} in`);
      break;
    case "file":
      out.push(
        `let body = Cohttp_lwt.Body.of_string (In_channel.with_open_bin ${dq(w.body.path)} In_channel.input_all) in`,
      );
      break;
    case "formdata":
      out.push("let body = Cohttp_lwt.Body.of_string (String.concat \"\" [");
      for (const chunk of multipartChunks(w.body.parts)) {
        out.push(
          chunk.kind === "text"
            ? `${i}${dq(chunk.text)};`
            : `${i}In_channel.with_open_bin ${dq(chunk.path)} In_channel.input_all;`,
        );
      }
      out.push("]) in");
      break;
    case "none":
      break;
  }

  const args = [
    headers.length > 0 ? "~headers" : null,
    w.body.kind === "none" ? null : "~body",
    ocamlMethod(w.method),
    "uri",
  ].filter((a): a is string => a !== null);

  out.push("", `Client.call ${args.join(" ")}`, ">>= fun (res, body) ->");
  if (opts.includeBoilerplate) {
    out.push(
      `${i}Printf.printf "Status: %d\\n" (Code.code_of_status (Response.status res));`,
      `${i}Cohttp_lwt.Body.to_string body`,
      `${i}>|= fun body -> print_endline body`,
    );
  } else {
    out.push(`${i}Lwt.return (res, body)`);
  }
  return lines(...out);
};

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

const genPhpCurl: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const out: (string | null)[] = ["<?php", "", "$curl = curl_init();", "", "curl_setopt_array($curl, ["];
  out.push(`${i}CURLOPT_URL => ${phpq(w.url)},`);
  out.push(`${i}CURLOPT_RETURNTRANSFER => true,`);
  out.push(`${i}CURLOPT_CUSTOMREQUEST => ${phpq(w.method)},`);
  if (req.options.follow_redirects) out.push(`${i}CURLOPT_FOLLOWLOCATION => true,`);
  if (!req.options.verify_ssl) out.push(`${i}CURLOPT_SSL_VERIFYPEER => false,`);

  switch (w.body.kind) {
    case "text":
      out.push(`${i}CURLOPT_POSTFIELDS => ${phpq(w.body.text)},`);
      break;
    case "urlencoded":
      out.push(`${i}CURLOPT_POSTFIELDS => ${phpq(formEncode(w.body.pairs))},`);
      break;
    case "file":
      out.push(`${i}CURLOPT_POSTFIELDS => file_get_contents(${phpq(w.body.path)}),`);
      break;
    case "formdata":
      out.push(`${i}CURLOPT_POSTFIELDS => [`);
      for (const part of w.body.parts) {
        out.push(
          part.file_path
            ? `${i}${i}${phpq(part.name)} => new CURLFile(${phpq(part.file_path)}, ${part.content_type ? phpq(part.content_type) : "null"}, ${phpq(baseName(part.file_path))}),`
            : `${i}${i}${phpq(part.name)} => ${phpq(part.value ?? "")},`,
        );
      }
      out.push(`${i}],`);
      break;
    case "none":
      break;
  }

  if (w.headers.length > 0) {
    out.push(`${i}CURLOPT_HTTPHEADER => [`);
    for (const [name, value] of w.headers) out.push(`${i}${i}${phpq(`${name}: ${value}`)},`);
    out.push(`${i}],`);
  }
  out.push("]);", "", "$response = curl_exec($curl);", "$err = curl_error($curl);", "", "curl_close($curl);");
  if (opts.includeBoilerplate) {
    out.push("", "if ($err) {", `${i}echo "cURL Error #:" . $err;`, "} else {", `${i}echo $response;`, "}");
  }
  return lines(...out);
};

const genPhpGuzzle: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const headers = w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;
  const out: (string | null)[] = [
    "<?php",
    "",
    "$client = new \\GuzzleHttp\\Client();",
    "",
    `$response = $client->request(${phpq(w.method)}, ${phpq(w.url)}, [`,
  ];

  switch (w.body.kind) {
    case "text":
      out.push(`${i}'body' => ${phpq(w.body.text)},`);
      break;
    case "urlencoded":
      out.push(`${i}'form_params' => [`);
      for (const [k, v] of w.body.pairs) out.push(`${i}${i}${phpq(k)} => ${phpq(v)},`);
      out.push(`${i}],`);
      break;
    case "formdata":
      out.push(`${i}'multipart' => [`);
      for (const part of w.body.parts) {
        out.push(`${i}${i}[`);
        out.push(`${i}${i}${i}'name' => ${phpq(part.name)},`);
        out.push(
          part.file_path
            ? `${i}${i}${i}'contents' => fopen(${phpq(part.file_path)}, 'r'),`
            : `${i}${i}${i}'contents' => ${phpq(part.value ?? "")},`,
        );
        if (part.file_path) out.push(`${i}${i}${i}'filename' => ${phpq(baseName(part.file_path))},`);
        if (part.content_type) {
          out.push(`${i}${i}${i}'headers' => ['Content-Type' => ${phpq(part.content_type)}],`);
        }
        out.push(`${i}${i}],`);
      }
      out.push(`${i}],`);
      break;
    case "file":
      out.push(`${i}'body' => fopen(${phpq(w.body.path)}, 'r'),`);
      break;
    case "none":
      break;
  }

  if (headers.length > 0) {
    out.push(`${i}'headers' => [`);
    for (const [name, value] of headers) out.push(`${i}${i}${phpq(name)} => ${phpq(value)},`);
    out.push(`${i}],`);
  }
  out.push("]);");
  if (opts.includeBoilerplate) out.push("", "echo $response->getBody();");
  return lines(...out);
};

const genPhpHttpRequest2: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const method = isKnownMethod(w.method)
    ? `HTTP_Request2::METHOD_${w.method.toUpperCase()}`
    : phpq(w.method);
  const headers = w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;
  const out: (string | null)[] = [
    "<?php",
    "",
    "require_once 'HTTP/Request2.php';",
    "",
    "$request = new HTTP_Request2();",
    `$request->setUrl(${phpq(w.url)});`,
    `$request->setMethod(${method});`,
    "$request->setConfig([",
    `${i}'follow_redirects' => ${req.options.follow_redirects ? "TRUE" : "FALSE"},`,
    `${i}'ssl_verify_peer' => ${req.options.verify_ssl ? "TRUE" : "FALSE"},`,
    "]);",
  ];

  if (headers.length > 0) {
    out.push("$request->setHeader([");
    for (const [name, value] of headers) out.push(`${i}${phpq(name)} => ${phpq(value)},`);
    out.push("]);");
  }

  switch (w.body.kind) {
    case "text":
      out.push(`$request->setBody(${phpq(w.body.text)});`);
      break;
    case "urlencoded":
      for (const [k, v] of w.body.pairs) out.push(`$request->addPostParameter(${phpq(k)}, ${phpq(v)});`);
      break;
    case "formdata":
      for (const part of w.body.parts) {
        out.push(
          part.file_path
            ? `$request->addUpload(${phpq(part.name)}, ${phpq(part.file_path)});`
            : `$request->addPostParameter(${phpq(part.name)}, ${phpq(part.value ?? "")});`,
        );
      }
      break;
    case "file":
      out.push(`$request->setBody(file_get_contents(${phpq(w.body.path)}));`);
      break;
    case "none":
      break;
  }

  out.push("", "try {", `${i}$response = $request->send();`);
  if (opts.includeBoilerplate) {
    out.push(
      `${i}if ($response->getStatus() == 200) {`,
      `${i}${i}echo $response->getBody();`,
      `${i}} else {`,
      `${i}${i}echo 'Unexpected HTTP status: ' . $response->getStatus() . ' ' . $response->getReasonPhrase();`,
      `${i}}`,
    );
  }
  out.push("} catch (HTTP_Request2_Exception $e) {", `${i}echo 'Error: ' . $e->getMessage();`, "}");
  return lines(...out);
};

const genPhpPeclHttp: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const headers = w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;
  const out: (string | null)[] = [
    "<?php",
    "",
    "$client = new http\\Client;",
    "$request = new http\\Client\\Request;",
    "",
    `$request->setRequestUrl(${phpq(w.url)});`,
    `$request->setRequestMethod(${phpq(w.method)});`,
  ];

  switch (w.body.kind) {
    case "text":
      out.push("$body = new http\\Message\\Body;", `$body->append(${phpq(w.body.text)});`, "$request->setBody($body);");
      break;
    case "urlencoded":
      out.push(
        "$body = new http\\Message\\Body;",
        `$body->append(${phpq(formEncode(w.body.pairs))});`,
        "$request->setBody($body);",
      );
      break;
    case "file":
      out.push(
        "$body = new http\\Message\\Body;",
        `$body->append(file_get_contents(${phpq(w.body.path)}));`,
        "$request->setBody($body);",
      );
      break;
    case "formdata": {
      const fields = w.body.parts.filter((p) => !p.file_path);
      const files = w.body.parts.filter((p) => p.file_path);
      out.push("$body = new http\\Message\\Body;", "$body->addForm([");
      for (const part of fields) out.push(`${i}${phpq(part.name)} => ${phpq(part.value ?? "")},`);
      out.push("], [");
      for (const part of files) {
        out.push(
          `${i}['name' => ${phpq(part.name)}, 'type' => ${part.content_type ? phpq(part.content_type) : "null"}, 'file' => ${phpq(part.file_path ?? "")}],`,
        );
      }
      out.push("]);", "$request->setBody($body);");
      break;
    }
    case "none":
      break;
  }

  if (headers.length > 0) {
    out.push("", "$request->setHeaders([");
    for (const [name, value] of headers) out.push(`${i}${phpq(name)} => ${phpq(value)},`);
    out.push("]);");
  }
  out.push("", "$client->enqueue($request)->send();", "$response = $client->getResponse();");
  if (opts.includeBoilerplate) out.push("", "echo $response->getBody();");
  return lines(...out);
};

// ---------------------------------------------------------------------------
// PowerShell
// ---------------------------------------------------------------------------

const genPowerShell: Generator = (req, opts) => {
  const w = wire(req);
  // Invoke-RestMethod rejects Content-Type inside -Headers, so it travels on its own switch.
  const headers = headersWithoutContentType(w);
  const out: (string | null)[] = [];

  if (headers.length > 0) {
    out.push('$headers = New-Object "System.Collections.Generic.Dictionary[[String],[String]]"');
    for (const [name, value] of headers) out.push(`$headers.Add(${psq(name)}, ${psq(value)})`);
    out.push("");
  }

  const args = [`-Uri ${psq(w.url)}`, `-Method ${isKnownMethod(w.method) ? pascalMethod(w.method) : w.method}`];
  if (headers.length > 0) args.push("-Headers $headers");

  switch (w.body.kind) {
    case "text": {
      const here = psHereString(w.body.text);
      out.push(here ? `$body = ${here}` : `$body = ${psq(w.body.text)}`, "");
      if (w.contentType) args.push(`-ContentType ${psq(w.contentType)}`);
      args.push("-Body $body");
      break;
    }
    case "urlencoded":
      out.push(`$body = ${psq(formEncode(w.body.pairs))}`, "");
      args.push(`-ContentType ${psq(w.contentType)}`, "-Body $body");
      break;
    case "formdata":
      out.push("$form = @{");
      for (const part of w.body.parts) {
        out.push(
          part.file_path
            ? `${opts.indentWith}${psq(part.name)} = Get-Item ${psq(part.file_path)}`
            : `${opts.indentWith}${psq(part.name)} = ${psq(part.value ?? "")}`,
        );
      }
      out.push("}", "");
      args.push("-Form $form");
      break;
    case "file":
      if (w.contentType) args.push(`-ContentType ${psq(w.contentType)}`);
      args.push(`-InFile ${psq(w.body.path)}`);
      break;
    case "none":
      break;
  }
  if (!req.options.verify_ssl) args.push("-SkipCertificateCheck");
  if (req.options.proxy_url) args.push(`-Proxy ${psq(req.options.proxy_url)}`);

  out.push(`$response = Invoke-RestMethod ${joinCommand(args, opts)}`);
  if (opts.includeBoilerplate) out.push("$response | ConvertTo-Json -Depth 10");
  return lines(...out);
};

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const genPythonRequests: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const headers = w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;
  const out: (string | null)[] = ["import requests", "", `url = ${dq(w.url)}`, ""];
  const args = [dq(w.method), "url"];

  switch (w.body.kind) {
    case "text":
      out.push(`payload = ${dq(w.body.text)}`, "");
      args.push("data=payload");
      break;
    case "urlencoded":
      // A list of pairs rather than a dict: duplicate keys are legal in a form body.
      out.push("payload = [");
      for (const [k, v] of w.body.pairs) out.push(`${i}(${dq(k)}, ${dq(v)}),`);
      out.push("]", "");
      args.push("data=payload");
      break;
    case "formdata": {
      const fields = w.body.parts.filter((p) => !p.file_path);
      const files = w.body.parts.filter((p) => p.file_path);
      if (fields.length > 0) {
        out.push("payload = [");
        for (const part of fields) out.push(`${i}(${dq(part.name)}, ${dq(part.value ?? "")}),`);
        out.push("]");
        args.push("data=payload");
      }
      if (files.length > 0) {
        out.push("files = [");
        for (const part of files) {
          const path = part.file_path ?? "";
          out.push(
            `${i}(${dq(part.name)}, (${dq(baseName(path))}, open(${dq(path)}, "rb"), ${dq(part.content_type || "application/octet-stream")})),`,
          );
        }
        out.push("]");
        args.push("files=files");
      }
      out.push("");
      break;
    }
    case "file":
      out.push(`payload = open(${dq(w.body.path)}, "rb")`, "");
      args.push("data=payload");
      break;
    case "none":
      break;
  }

  if (headers.length > 0) {
    out.push("headers = {");
    for (const [name, value] of headers) out.push(`${i}${dq(name)}: ${dq(value)},`);
    out.push("}", "");
    args.push("headers=headers");
  }
  if (!req.options.verify_ssl) args.push("verify=False");
  if (!req.options.follow_redirects) args.push("allow_redirects=False");

  out.push(`response = requests.request(${args.join(", ")})`);
  if (opts.includeBoilerplate) out.push("", "print(response.text)");
  return lines(...out);
};

const genPythonHttpClient: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const url = splitUrl(w.url);
  const headers = headersWithBoundary(w);
  const connection = url.secure ? "HTTPSConnection" : "HTTPConnection";
  const host = url.port ? `${dq(url.hostname)}, ${url.port}` : dq(url.hostname);
  const out: (string | null)[] = ["import http.client", "", `conn = http.client.${connection}(${host})`, ""];
  let payload: string | null = null;

  switch (w.body.kind) {
    case "text":
      out.push(`payload = ${dq(w.body.text)}`, "");
      payload = "payload";
      break;
    case "urlencoded":
      out.push(`payload = ${dq(formEncode(w.body.pairs))}`, "");
      payload = "payload";
      break;
    case "file":
      out.push(`payload = open(${dq(w.body.path)}, "rb").read()`, "");
      payload = "payload";
      break;
    case "formdata": {
      // http.client has no multipart builder, so the body is concatenated by hand against the same
      // boundary the Content-Type header announces.
      const chunks = multipartChunks(w.body.parts);
      out.push("payload = (");
      chunks.forEach((chunk, idx) => {
        const expr =
          chunk.kind === "text"
            ? `b${dq(chunk.text)}`
            : `open(${dq(chunk.path)}, "rb").read()`;
        out.push(`${i}${idx === 0 ? "" : "+ "}${expr}`);
      });
      out.push(")", "");
      payload = "payload";
      break;
    }
    case "none":
      break;
  }

  if (headers.length > 0) {
    out.push("headers = {");
    for (const [name, value] of headers) out.push(`${i}${dq(name)}: ${dq(value)},`);
    out.push("}", "");
  }

  const args = [dq(w.method), dq(url.path)];
  if (payload) args.push(payload);
  else if (headers.length > 0) args.push('""');
  if (headers.length > 0) args.push("headers");

  out.push(`conn.request(${args.join(", ")})`, "", "res = conn.getresponse()", "data = res.read()");
  if (opts.includeBoilerplate) out.push("", 'print(data.decode("utf-8"))');
  return lines(...out);
};

// ---------------------------------------------------------------------------
// R
// ---------------------------------------------------------------------------

/** Header names carry `-`, which R only accepts inside backticks. */
function rName(name: string): string {
  return /^[A-Za-z.][A-Za-z0-9._]*$/.test(name) ? name : `\`${name.replace(/`/g, "")}\``;
}

const genRHttr: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const headers = w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;
  const out: (string | null)[] = ["library(httr)", "", `url <- ${dq(w.url)}`, ""];
  const args = [dq(w.method), "url"];

  switch (w.body.kind) {
    case "text":
      out.push(`payload <- ${dq(w.body.text)}`, "");
      args.push("body = payload");
      break;
    case "urlencoded": {
      const { pairs } = w.body;
      out.push("payload <- list(");
      pairs.forEach(([k, v], idx) => {
        out.push(`${i}${rName(k)} = ${dq(v)}${idx === pairs.length - 1 ? "" : ","}`);
      });
      out.push(")", "");
      args.push("body = payload", 'encode = "form"');
      break;
    }
    case "formdata": {
      const { parts } = w.body;
      out.push("payload <- list(");
      parts.forEach((part, idx) => {
        const value = part.file_path ? `upload_file(${dq(part.file_path)})` : dq(part.value ?? "");
        out.push(`${i}${rName(part.name)} = ${value}${idx === parts.length - 1 ? "" : ","}`);
      });
      out.push(")", "");
      args.push("body = payload", 'encode = "multipart"');
      break;
    }
    case "file":
      out.push(`payload <- upload_file(${dq(w.body.path)})`, "");
      args.push("body = payload");
      break;
    case "none":
      break;
  }

  if (headers.length > 0) {
    const pairs = headers.map(([name, value]) => `${rName(name)} = ${dq(value)}`).join(", ");
    args.push(`add_headers(${pairs})`);
  }
  if (w.contentType && w.body.kind !== "formdata") args.push(`content_type(${dq(w.contentType)})`);

  out.push(`response <- VERB(${args.join(", ")})`);
  if (opts.includeBoilerplate) out.push("", 'cat(content(response, "text", encoding = "UTF-8"))');
  return lines(...out);
};

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

const genRubyNetHttp: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const url = splitUrl(w.url);
  const requestClass = isKnownMethod(w.method) ? `Net::HTTP::${pascalMethod(w.method)}` : "Net::HTTPGenericRequest";
  const headers = w.body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;
  const out: (string | null)[] = [
    "require 'uri'",
    "require 'net/http'",
    url.secure ? "require 'openssl'" : null,
    "",
    `url = URI(${rbq(w.url)})`,
    "",
    "http = Net::HTTP.new(url.host, url.port)",
  ];
  if (url.secure) {
    out.push("http.use_ssl = true");
    if (!req.options.verify_ssl) out.push("http.verify_mode = OpenSSL::SSL::VERIFY_NONE");
  }

  out.push(
    "",
    isKnownMethod(w.method)
      ? `request = ${requestClass}.new(url)`
      : `request = Net::HTTPGenericRequest.new(${rbq(w.method)}, true, true, url)`,
  );
  for (const [name, value] of headers) out.push(`request[${rbq(name)}] = ${rbq(value)}`);

  switch (w.body.kind) {
    case "text":
      out.push(`request.body = ${rbq(w.body.text)}`);
      break;
    case "urlencoded":
      out.push(`request.body = ${rbq(formEncode(w.body.pairs))}`);
      break;
    case "file":
      out.push(`request.body = File.binread(${rbq(w.body.path)})`);
      break;
    case "formdata":
      out.push("request.set_form([");
      for (const part of w.body.parts) {
        out.push(
          part.file_path
            ? `${i}[${rbq(part.name)}, File.open(${rbq(part.file_path)})],`
            : `${i}[${rbq(part.name)}, ${rbq(part.value ?? "")}],`,
        );
      }
      out.push("], 'multipart/form-data')");
      break;
    case "none":
      break;
  }

  out.push("", "response = http.request(request)");
  if (opts.includeBoilerplate) out.push("puts response.read_body");
  return lines(...out);
};

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const genRustReqwest: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const body = w.body;
  const verb = isKnownMethod(w.method) && w.method.toUpperCase() !== "TRACE" ? w.method.toLowerCase() : null;
  const pre: string[] = [];
  const chain: string[] = [];
  const headers = body.kind === "formdata" ? headersWithoutContentType(w) : w.headers;

  for (const [name, value] of headers) chain.push(`.header(${dq(name)}, ${dq(value)})`);

  switch (body.kind) {
    case "text":
      chain.push(`.body(${dq(body.text)})`);
      break;
    case "urlencoded":
      pre.push("let form = [");
      for (const [k, v] of body.pairs) pre.push(`${i}${i}(${dq(k)}, ${dq(v)}),`);
      pre.push("];");
      chain.push(".form(&form)");
      break;
    case "file":
      pre.push(`let file = std::fs::read(${dq(body.path)})?;`);
      chain.push(".body(file)");
      break;
    case "formdata": {
      pre.push("let mut form = reqwest::multipart::Form::new();");
      body.parts.forEach((part, index) => {
        if (part.file_path) {
          const variable = `part${index}`;
          pre.push(
            `let ${variable} = reqwest::multipart::Part::bytes(std::fs::read(${dq(part.file_path)})?)`,
            `${i}${i}.file_name(${dq(baseName(part.file_path))})`,
            part.content_type ? `${i}${i}.mime_str(${dq(part.content_type)})?;` : `${i}${i};`,
          );
          pre.push(`form = form.part(${dq(part.name)}, ${variable});`);
        } else {
          pre.push(`form = form.text(${dq(part.name)}, ${dq(part.value ?? "")});`);
        }
      });
      chain.push(".multipart(form)");
      break;
    }
    case "none":
      break;
  }

  const entry = verb
    ? `client.${verb}(${dq(w.url)})`
    : `client.request(reqwest::Method::from_bytes(${dq(w.method)}.as_bytes())?, ${dq(w.url)})`;

  const inner = lines(
    body.kind === "formdata" || body.kind === "file" || body.kind === "urlencoded" ? "" : null,
    ...pre.map((l) => (l.startsWith(`${i}${i}`) ? l.slice(i.length) : l)),
    pre.length > 0 ? "" : null,
    "let client = reqwest::Client::new();",
    "",
    `let response = ${entry}`,
    ...chain.map((c) => `${i}${c}`),
    `${i}.send()`,
    `${i}.await?;`,
    opts.includeBoilerplate ? "" : null,
    opts.includeBoilerplate ? 'println!("{}", response.status());' : null,
    opts.includeBoilerplate ? 'println!("{}", response.text().await?);' : null,
    "",
    "Ok(())",
  );

  return lines(
    body.kind === "formdata"
      ? '// Cargo.toml: reqwest = { version = "0.12", features = ["multipart"] }'
      : null,
    "#[tokio::main]",
    "async fn main() -> Result<(), Box<dyn std::error::Error>> {",
    indentBy(inner, i),
    "}",
  );
};

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

const genSwiftUrlSession: Generator = (req, opts) => {
  const w = wire(req);
  const i = opts.indentWith;
  const headers = headersWithBoundary(w);
  const out: (string | null)[] = ["import Foundation", ""];

  if (headers.length > 0) {
    out.push("let headers = [");
    headers.forEach(([name, value], idx) => {
      out.push(`${i}${dq(name)}: ${dq(value)}${idx === headers.length - 1 ? "" : ","}`);
    });
    out.push("]", "");
  }

  switch (w.body.kind) {
    case "text":
      out.push(`let postData = ${dq(w.body.text)}.data(using: .utf8)`, "");
      break;
    case "urlencoded":
      out.push(`let postData = ${dq(formEncode(w.body.pairs))}.data(using: .utf8)`, "");
      break;
    case "file":
      out.push(`let postData = FileManager.default.contents(atPath: ${dq(w.body.path)})`, "");
      break;
    case "formdata":
      // Foundation has no multipart builder; the parts are appended against the boundary declared
      // in the Content-Type header above.
      out.push("var postData = Data()");
      for (const chunk of multipartChunks(w.body.parts)) {
        out.push(
          chunk.kind === "text"
            ? `postData.append(${dq(chunk.text)}.data(using: .utf8)!)`
            : `postData.append(FileManager.default.contents(atPath: ${dq(chunk.path)})!)`,
        );
      }
      out.push("");
      break;
    case "none":
      break;
  }

  out.push(
    `var request = URLRequest(url: URL(string: ${dq(w.url)})!, timeoutInterval: ${(req.options.timeout_ms / 1000).toFixed(1)})`,
    `request.httpMethod = ${dq(w.method)}`,
  );
  if (headers.length > 0) out.push("request.allHTTPHeaderFields = headers");
  if (w.body.kind !== "none") out.push("request.httpBody = postData");

  out.push(
    "",
    "let task = URLSession.shared.dataTask(with: request) { data, response, error in",
    `${i}guard let data = data else {`,
    `${i}${i}print(String(describing: error))`,
    `${i}${i}return`,
    `${i}}`,
    opts.includeBoilerplate ? `${i}print(String(data: data, encoding: .utf8)!)` : `${i}_ = data`,
    "}",
    "",
    "task.resume()",
  );
  return lines(...out);
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const slashComment = (text: string) => `// ${text}`;
const hashComment = (text: string) => `# ${text}`;
const ocamlComment = (text: string) => `(* ${text} *)`;

function def(
  id: string,
  label: string,
  language: string,
  group: string,
  comment: (text: string) => string,
  generate: Generator,
): TargetDef {
  return { target: { id, label, language, group }, comment, generate };
}

/** Ordered exactly as the picker lists them. */
const TARGET_DEFS: TargetDef[] = [
  def("shell-curl", "cURL", "shell", "Shell", hashComment, genCurl),
  def("shell-wget", "wget", "shell", "Shell", hashComment, genWget),
  def("shell-httpie", "HTTPie", "shell", "Shell", hashComment, genHttpie),
  def("c-libcurl", "C - libcurl", "c", "C", slashComment, genCLibcurl),
  def("csharp-httpclient", "C# - HttpClient", "csharp", "C#", slashComment, genCsharpHttpClient),
  def("csharp-restsharp", "C# - RestSharp", "csharp", "C#", slashComment, genCsharpRestSharp),
  def("dart-dio", "Dart - dio", "dart", "Dart", slashComment, genDartDio),
  def("dart-http", "Dart - http", "dart", "Dart", slashComment, genDartHttp),
  def("go-native", "Go - Native", "go", "Go", slashComment, genGoNative),
  // Monaco has no `http` grammar, and plaintext beats mis-highlighting a raw request.
  def("http-raw", "HTTP", "plaintext", "HTTP", hashComment, genHttpRaw),
  def("java-okhttp", "Java - OkHttp", "java", "Java", slashComment, genJavaOkHttp),
  def("java-unirest", "Java - Unirest", "java", "Java", slashComment, genJavaUnirest),
  def("javascript-fetch", "JavaScript - Fetch", "javascript", "JavaScript", slashComment, genJsFetch),
  def("javascript-axios", "JavaScript - Axios", "javascript", "JavaScript", slashComment, genJsAxios),
  def("javascript-jquery", "JavaScript - jQuery", "javascript", "JavaScript", slashComment, genJsJquery),
  def("javascript-xhr", "JavaScript - XHR", "javascript", "JavaScript", slashComment, genJsXhr),
  def("kotlin-okhttp", "Kotlin - OkHttp", "kotlin", "Kotlin", slashComment, genKotlinOkHttp),
  def("nodejs-axios", "NodeJs - Axios", "javascript", "NodeJs", slashComment, genNodeAxios),
  def("nodejs-fetch", "NodeJs - Fetch", "javascript", "NodeJs", slashComment, genNodeFetch),
  def("nodejs-native", "NodeJs - Native", "javascript", "NodeJs", slashComment, genNodeNative),
  def("nodejs-request", "NodeJs - Request", "javascript", "NodeJs", slashComment, genNodeRequest),
  def("objc-nsurlsession", "Objective-C - NSURLSession", "objective-c", "Objective-C", slashComment, genObjcNsUrlSession),
  def("ocaml-cohttp", "OCaml - Cohttp", "plaintext", "OCaml", ocamlComment, genOcamlCohttp),
  def("php-curl", "PHP - cURL", "php", "PHP", slashComment, genPhpCurl),
  def("php-guzzle", "PHP - Guzzle", "php", "PHP", slashComment, genPhpGuzzle),
  def("php-httprequest2", "PHP - HTTP_Request2", "php", "PHP", slashComment, genPhpHttpRequest2),
  def("php-pecl-http", "PHP - pecl_http", "php", "PHP", slashComment, genPhpPeclHttp),
  def("powershell-restmethod", "PowerShell - RestMethod", "powershell", "PowerShell", hashComment, genPowerShell),
  def("python-requests", "Python - Requests", "python", "Python", hashComment, genPythonRequests),
  def("python-http-client", "Python - http.client", "python", "Python", hashComment, genPythonHttpClient),
  def("r-httr", "R - httr", "r", "R", hashComment, genRHttr),
  def("ruby-nethttp", "Ruby - Net::HTTP", "ruby", "Ruby", hashComment, genRubyNetHttp),
  def("rust-reqwest", "Rust - Reqwest", "rust", "Rust", slashComment, genRustReqwest),
  def("swift-urlsession", "Swift - URLSession", "swift", "Swift", slashComment, genSwiftUrlSession),
];

const BY_ID = new Map(TARGET_DEFS.map((d) => [d.target.id, d]));

function backendAuthNote(auth: BackendAuth): string {
  return translate(auth.kind === "digest" ? "api.snippet.digestNote" : "api.snippet.awsNote");
}

/** PHP snippets open with `<?php`; a comment above that tag would be echoed as page text. */
function prependNote(code: string, note: string): string {
  if (!code.startsWith("<?php")) return `${note}\n${code}`;
  const cut = code.indexOf("\n");
  return cut === -1 ? `${code}\n${note}` : `${code.slice(0, cut + 1)}${note}\n${code.slice(cut + 1)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const SNIPPET_TARGETS: SnippetTarget[] = TARGET_DEFS.map((d) => d.target);

export function defaultSnippetOptions(): SnippetOptions {
  return { multiline: true, indentWith: "  ", includeBoilerplate: true };
}

/**
 * Renders `req` as code for `targetId`, or `""` when there is nothing honest to render — an
 * unknown target, or a protocol whose transport no HTTP client in this list speaks (WebSocket,
 * Socket.IO, MQTT, gRPC). Callers show `api.snippet.unsupported` on `""`.
 */
export function generateSnippet(targetId: string, req: ResolvedRequest, options: SnippetOptions): string {
  const target = BY_ID.get(targetId);
  if (!target) return "";
  if (req.protocol !== "http" && req.protocol !== "graphql") return "";
  const code = target.generate(req, options);
  if (!code) return "";
  return req.backendAuth ? prependNote(code, target.comment(backendAuthNote(req.backendAuth))) : code;
}
