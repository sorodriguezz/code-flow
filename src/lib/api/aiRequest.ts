/**
 * «Crear con IA»: the model's JSON answer turned into a request spec — or refused. Everything is
 * checked; nothing it says becomes a script or an auth block, only what a request line, headers and
 * a body can hold.
 */

import { defaultRequestSpec, emptyKeyValue, HTTP_METHODS, type ApiRequestSpec, type KeyValue } from "../../types/api";
import { stripFence } from "./aiPayload";

export interface DraftedRequest {
  name: string;
  spec: ApiRequestSpec;
}

const METHODS: readonly string[] = HTTP_METHODS;

function rowId(): string {
  return `kv-${Math.random().toString(36).slice(2, 10)}`;
}

function row(key: string, value: string): KeyValue {
  return { ...emptyKeyValue(rowId()), key, value };
}

/** The first `{…}` in `text` that parses — a model asked for bare JSON still sometimes says hello. */
function firstObject(text: string): Record<string, unknown> | null {
  const clean = stripFence(text);
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Look for one inside.
  }
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(clean.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export function parseDraftedRequest(answer: string): DraftedRequest | null {
  const json = firstObject(answer);
  if (!json) return null;
  const url = str(json.url).trim();
  if (url === "" || /\s/.test(url)) return null;
  const method = str(json.method).trim().toUpperCase();
  const spec = defaultRequestSpec("http");
  spec.method = METHODS.includes(method) ? method : "GET";
  // The builder's convention: the URL as typed, its query mirrored in the params table (on send the
  // table is what the query becomes).
  const queryAt = url.indexOf("?");
  spec.url = url;
  if (queryAt >= 0) {
    spec.params = url
      .slice(queryAt + 1)
      .split("&")
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        return eq < 0 ? row(pair, "") : row(pair.slice(0, eq), pair.slice(eq + 1));
      });
  }
  const headers = Array.isArray(json.headers) ? json.headers : [];
  spec.headers = headers
    .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
    .map((h) => row(str(h.key).trim(), str(h.value)))
    .filter((h) => h.key !== "" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.key));
  const body = json.body && typeof json.body === "object" ? (json.body as Record<string, unknown>) : {};
  const mode = str(body.mode);
  const content = typeof body.content === "string" ? body.content : body.content !== undefined ? JSON.stringify(body.content, null, 2) : "";
  if (content.trim() !== "" && mode !== "none") {
    if (mode === "urlencoded") {
      spec.body = {
        ...spec.body,
        mode: "urlencoded",
        urlencoded: content.split("&").filter(Boolean).map((pair) => {
          const eq = pair.indexOf("=");
          return eq < 0 ? row(pair, "") : row(pair.slice(0, eq), pair.slice(eq + 1));
        }),
      };
    } else {
      let raw = content;
      if (mode === "json") {
        try {
          raw = JSON.stringify(JSON.parse(content), null, 2);
        } catch {
          // Kept as written; the editor will show what is wrong with it.
        }
      }
      spec.body = { ...spec.body, mode: "raw", raw, rawLanguage: mode === "json" ? "json" : "text" };
    }
  }
  const name = str(json.name).trim().slice(0, 120) || `${spec.method} ${spec.url}`;
  return { name, spec };
}
