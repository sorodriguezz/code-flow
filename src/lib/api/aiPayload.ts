/**
 * What the API client hands its assistant (`api_ai`): an exchange written out as plain text, with
 * every credential masked first.
 *
 * Masked by name — `Authorization`, `Cookie`, `X-Api-Key`, a `token=` in the query — and by value:
 * every variable marked secret, wherever its value ended up (a header, the URL, a JSON body). The
 * model is somebody else's computer; a token it never sees is a token it cannot repeat.
 */

import type { ApiResponse, ApiVariable, HttpResponse, SentRequestSummary } from "../../types/api";

export const MASK = "•••";

/** Header and parameter names whose value is a credential. */
const SENSITIVE_NAME = /(^|[-_])(authorization|auth|cookie|token|secret|password|passwd|pwd|api[-_]?key|apikey|session|signature|credential|private[-_]?key|access[-_]?key|client[-_]?secret)([-_]|$)/i;

/** How much of a body the assistant is shown. */
const BODY_LIMIT = 24_000;

function isSensitiveName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower === "authorization" || lower === "proxy-authorization" || lower === "cookie" || lower === "set-cookie" || SENSITIVE_NAME.test(lower);
}

/** Every secret variable's values, longest first so a value inside another is not left half-masked. */
export function secretValues(scopes: ApiVariable[][]): string[] {
  const values = new Set<string>();
  for (const list of scopes) {
    for (const variable of list) {
      if (!variable.secret) continue;
      for (const value of [variable.currentValue, variable.initialValue]) {
        // Short values ("1", "yes") would mask half the payload and protect nothing.
        if (value && value.trim().length >= 4) values.add(value);
      }
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function maskText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(MASK);
  return out;
}

function maskHeaders(headers: [string, string][], secrets: string[]): string {
  return headers.map(([name, value]) => `${name}: ${isSensitiveName(name) ? MASK : maskText(value, secrets)}`).join("\n");
}

/** A URL with its sensitive query values (and any secret anywhere in it) masked. */
export function maskUrl(url: string, secrets: string[]): string {
  const masked = url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (whole, lead: string, name: string) =>
    isSensitiveName(decodeSafe(name)) ? `${lead}${name}=${MASK}` : whole,
  );
  // `user:password@host`.
  return maskText(masked.replace(/(\/\/[^/:@]+:)[^@/]+@/, `$1${MASK}@`), secrets);
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A JSON body with every sensitive key's value masked; anything else is masked by value only. */
function maskBody(text: string, secrets: string[]): string {
  const clipped = text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}\n… (${text.length - BODY_LIMIT} more characters)` : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return maskText(clipped, secrets);
  }
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, isSensitiveName(key) && typeof inner !== "object" ? MASK : scrub(inner)]),
      );
    }
    return value;
  };
  const pretty = JSON.stringify(scrub(parsed), null, 2);
  const shown = pretty.length > BODY_LIMIT ? `${pretty.slice(0, BODY_LIMIT)}\n… (${pretty.length - BODY_LIMIT} more characters)` : pretty;
  return maskText(shown, secrets);
}

function requestSection(sent: SentRequestSummary, secrets: string[]): string {
  const lines = [`${sent.method} ${maskUrl(sent.url, secrets)}`];
  if (sent.headers.length > 0) lines.push(maskHeaders(sent.headers, secrets));
  if (sent.body_preview.trim() !== "") lines.push("", maskBody(sent.body_preview, secrets));
  return lines.join("\n");
}

function timingLine(response: HttpResponse): string {
  const t = response.timings;
  const parts = [`total ${t.total_ms} ms`];
  if (t.dns_ms >= 0) parts.push(`DNS ${t.dns_ms} ms`);
  if (t.connect_ms >= 0) parts.push(`conexión ${t.connect_ms} ms`);
  if (t.first_byte_ms >= 0) parts.push(`espera ${t.first_byte_ms} ms`);
  if (t.download_ms >= 0) parts.push(`descarga ${t.download_ms} ms`);
  return parts.join(", ");
}

/** The whole exchange, for «Explicar con IA» and «Generar tests». */
export function exchangeForAi(response: ApiResponse, secrets: string[], extra: { name?: string; description?: string } = {}): string {
  const out: string[] = [];
  if (extra.name) out.push(`=== PETICIÓN: ${extra.name} ===`);
  else out.push("=== PETICIÓN ===");
  if (extra.description?.trim()) out.push(`Descripción: ${extra.description.trim()}`);
  out.push(requestSection(response.sent, secrets), "");
  if (response.error) {
    out.push("=== ERROR (no hubo respuesta) ===", maskText(response.error, secrets));
    return out.join("\n");
  }
  out.push(`=== RESPUESTA: ${response.status} ${response.status_text} (${response.http_version}) ===`);
  out.push(`Tiempos: ${timingLine(response)}; tamaño ${response.size_bytes} bytes`);
  if (response.redirects.length > 0) out.push(`Redirecciones: ${response.redirects.map((url) => maskUrl(url, secrets)).join(" → ")}`);
  out.push(maskHeaders(response.headers, secrets), "");
  if (response.body_base64) out.push("(cuerpo binario, no se muestra)");
  else if (response.body_text.trim() === "") out.push("(cuerpo vacío)");
  else out.push(maskBody(response.body_text, secrets));
  if (response.interrupted) out.push("", `Cortada: ${response.interrupted}`);
  const failed = response.tests.filter((test) => !test.passed);
  if (failed.length > 0) {
    out.push("", "=== TESTS QUE FALLARON ===", ...failed.map((test) => `- ${test.name}: ${test.error ?? ""}`));
  }
  return out.join("\n");
}

/** «Crear con IA»: the description and the variables a request may use (names only, never values
 *  of secret ones). */
export function requestAskForAi(description: string, variables: ApiVariable[][]): string {
  const names = new Map<string, string>();
  for (const list of variables) {
    for (const variable of list) {
      if (!variable.enabled || variable.key.trim() === "" || names.has(variable.key)) continue;
      const value = variable.currentValue || variable.initialValue;
      names.set(variable.key, variable.secret || isSensitiveName(variable.key) ? MASK : value.slice(0, 120));
    }
  }
  const listed = [...names.entries()].map(([key, value]) => `{{${key}}} = ${value}`);
  return [`=== DESCRIPCIÓN ===`, description.trim(), "", "=== VARIABLES DISPONIBLES ===", ...(listed.length ? listed : ["(ninguna)"])].join("\n");
}

/** A model's answer without the Markdown fence it was told not to write. */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}
