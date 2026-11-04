/**
 * Artifacts in a chat answer: a named deliverable — a page, a document, a diagram, a component —
 * written as a fenced `artefacto` block and drawn as a card instead of as code.
 *
 * ````artefacto {"name": "informe-api", "type": "markdown", "title": "Informe"}
 * …content, which may hold its own ``` fences…
 * ````
 *
 * The backend tells every engine this format (`chat_refs::artifacts::ARTIFACT_RULES`) and files each
 * block by name when the answer lands, versioned per workspace. This is the same parser, so what the
 * bubble draws is what was filed — keep the two in step (`src-tauri/src/chat_refs/artifacts.rs`).
 */

export type ArtifactKind = "html" | "markdown" | "mermaid" | "svg" | "code";

export interface ChatArtifactBlock {
  name: string;
  title: string;
  kind: ArtifactKind;
  language: string;
  content: string;
}

/** `informe API v2` → `informe-api-v2`; never empty. */
export function artifactSlug(raw: string): string {
  const folded = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  let out = "";
  for (const c of folded) {
    if (/[a-z0-9_.]/.test(c)) out += c;
    else if (out && !out.endsWith("-")) out += "-";
  }
  out = out.replace(/^[-.]+|[-.]+$/g, "").slice(0, 60).replace(/-+$/, "");
  return out || "artefacto";
}

function kindOf(raw: string): [ArtifactKind, string] {
  const value = raw.trim().toLowerCase();
  if (["html", "htm", "page", "pagina", "página"].includes(value)) return ["html", ""];
  if (["markdown", "md", "document", "documento", "doc", "text", "texto"].includes(value)) return ["markdown", ""];
  if (["mermaid", "diagram", "diagrama"].includes(value)) return ["mermaid", ""];
  if (value === "svg") return ["svg", ""];
  if (["", "code", "codigo", "código", "script", "component", "componente"].includes(value)) return ["code", ""];
  return ["code", value];
}

function fence(line: string): { char: string; n: number; rest: string } | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  return { char: match[2][0], n: match[2].length, rest: match[3] };
}

function header(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* key="value" pairs below */
  }
  const out: Record<string, unknown> = {};
  for (const m of text.matchAll(/([A-Za-z_]+)\s*=\s*(?:"([^"]*)"?|(\S+))/g)) out[m[1]] = m[2] ?? m[3] ?? "";
  return Object.keys(out).length > 0 ? out : null;
}

function field(map: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = map[key];
    if (typeof value === "string") return value.trim();
  }
  return "";
}

/**
 * `text` without its artifact blocks, and the artifacts they held, in order. A bare fence of the
 * opening character at least as long closes the block; one with an info string opens a nested block
 * (so a three-backtick artifact keeps its own code blocks). A block left open runs to the end.
 */
export function splitArtifacts(text: string): { text: string; artifacts: ChatArtifactBlock[] } {
  const lines = text.split("\n");
  const kept: string[] = [];
  const artifacts: ChatArtifactBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = fence(lines[i]);
    if (!open) {
      kept.push(lines[i]);
      i += 1;
      continue;
    }
    const info = open.rest.trimStart();
    const lower = info.toLowerCase();
    const word = ["artefacto", "artifact"].find((w) => lower.startsWith(w) && (lower.length === w.length || /[\s{]/.test(lower[w.length])));
    if (!word) {
      // An ordinary fence, kept whole — an artifact block quoted inside one stays a quote.
      let j = i + 1;
      while (j < lines.length) {
        const f = fence(lines[j]);
        if (f && f.char === open.char && f.n >= open.n && !f.rest.trim()) break;
        j += 1;
      }
      kept.push(...lines.slice(i, Math.min(j + 1, lines.length)));
      i = j + 1;
      continue;
    }
    let start = i + 1;
    let meta = header(info.slice(word.length));
    if (!meta && lines[start]?.trimStart().startsWith("{")) {
      const next = header(lines[start]);
      if (next) {
        meta = next;
        start += 1;
      }
    }
    const map = meta ?? {};
    let depth = 0;
    let end = lines.length;
    for (let j = start; j < lines.length; j += 1) {
      const f = fence(lines[j]);
      if (!f || f.char !== open.char || f.n < open.n) continue;
      if (!f.rest.trim()) {
        if (depth === 0) {
          end = j;
          break;
        }
        depth -= 1;
      } else depth += 1;
    }
    const content = lines.slice(start, end).join("\n");
    const title = field(map, ["title", "titulo", "título"]);
    const named = field(map, ["name", "nombre", "id"]);
    const [kind, implied] = kindOf(field(map, ["type", "tipo", "kind"]));
    const given = field(map, ["language", "lenguaje", "lang"]).toLowerCase();
    if (content.trim()) {
      artifacts.push({ name: artifactSlug(named || title || ""), title, kind, language: given || implied, content });
    } else {
      kept.push(...lines.slice(i, Math.min(end + 1, lines.length)));
    }
    i = end + 1;
  }
  if (artifacts.length === 0) return { text, artifacts };
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(), artifacts };
}

/** A file name for saving an artifact. */
export function artifactFileName(artifact: Pick<ChatArtifactBlock, "name" | "kind" | "language">): string {
  if (/\.[a-z0-9]{1,6}$/.test(artifact.name)) return artifact.name;
  const ext =
    artifact.kind === "html"
      ? "html"
      : artifact.kind === "markdown"
        ? "md"
        : artifact.kind === "mermaid"
          ? "mmd"
          : artifact.kind === "svg"
            ? "svg"
            : (LANGUAGE_EXT[artifact.language] ?? (artifact.language || "txt"));
  return `${artifact.name}.${ext}`;
}

const LANGUAGE_EXT: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  bash: "sh",
  shell: "sh",
  csharp: "cs",
  "c#": "cs",
  kotlin: "kt",
  ruby: "rb",
  golang: "go",
  yaml: "yml",
};
