/**
 * The editor's state for an AI turn — the open file, the selection, unsaved buffers and the
 * language server's markers — and what a turn reports back as «Contexto usado». Mirrors
 * `src-tauri/src/context/mod.rs`.
 *
 * The chat must not import Monaco to ask about it (it would pull the editor into the chat's
 * bundle), so the editor *publishes* a provider per project here when it mounts
 * (`setEditorContextProvider`), and the chat asks through {@link collectEditorContext}. No editor
 * open for the project: no provider, no context.
 */

export interface EditorContextPayload {
  activePath?: string | null;
  cursorLine?: number | null;
  selection?: { path: string; startLine: number; endLine: number; text: string } | null;
  /** The active buffer and any the question mentions. The backend keeps only those that differ
   *  from the disk. */
  unsaved: { path: string; content: string }[];
  diagnostics: { path: string; line: number; severity: string; message: string }[];
}

export type ContextSourceKind =
  | "active_file"
  | "selection"
  | "unsaved"
  | "diagnostics"
  | "mention"
  | "diff"
  | "memory"
  | "knowledge";

export interface ContextSource {
  kind: ContextSourceKind;
  label: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
}

type Provider = (message: string) => EditorContextPayload | null;

const providers = new Map<string, Provider>();

export function setEditorContextProvider(projectId: string, provider: Provider | null) {
  if (provider) providers.set(projectId, provider);
  else providers.delete(projectId);
}

/** The editor's state for a question about `projectId`, or `null` when no editor is open for it.
 *  Never throws: a turn is not worth failing over the context it could have carried. */
export function collectEditorContext(projectId: string, message: string): EditorContextPayload | null {
  const provider = providers.get(projectId);
  if (!provider) return null;
  try {
    const payload = provider(message);
    if (!payload) return null;
    const empty =
      !payload.activePath && !payload.selection && payload.unsaved.length === 0 && payload.diagnostics.length === 0;
    return empty ? null : payload;
  } catch {
    return null;
  }
}

/** The repository paths a question mentions as `@path` or `@path:12-20`. */
export function mentionedPaths(message: string): string[] {
  const out: string[] = [];
  for (const token of message.split(/\s+/)) {
    if (!token.startsWith("@") || token.startsWith("@commit:")) continue;
    const raw = token.slice(1).replace(/[,.;)(`"'?!]+$/, "");
    const path = raw.replace(/:\d+(-\d+)?$/, "");
    if (path && path.includes("/") && !out.includes(path)) out.push(path);
  }
  return out;
}

/** `ChatReply.context` / `ActivityLogEntry.context` (JSON) as sources; `[]` for anything else. */
export function parseContextSources(value: string | ContextSource[] | null | undefined): ContextSource[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ContextSource[]) : [];
  } catch {
    return [];
  }
}
