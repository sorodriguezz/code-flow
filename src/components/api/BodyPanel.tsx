import { useMemo } from "react";
import Editor from "@monaco-editor/react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { AlertTriangle, CheckCircle2, FolderOpen, Info, WandSparkles, X } from "lucide-react";
import { Select } from "../common/Select";
import { KeyValueTable } from "./KeyValueTable";
import { GraphqlPanel } from "./GraphqlPanel";
import { useApiStore } from "../../state/apiStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { apiPickFile } from "../../lib/tauri/apiCommands";
import { RAW_CONTENT_TYPES } from "../../lib/api/send";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ApiRequestSpec, BodyMode, RawLanguage, RequestBody } from "../../types/api";

const MODES: { mode: BodyMode; labelKey: TranslationKey }[] = [
  { mode: "none", labelKey: "api.body.none" },
  { mode: "formdata", labelKey: "api.body.formData" },
  { mode: "urlencoded", labelKey: "api.body.urlencoded" },
  { mode: "raw", labelKey: "api.body.raw" },
  { mode: "binary", labelKey: "api.body.binary" },
  { mode: "graphql", labelKey: "api.body.graphql" },
];

/**
 * Mirrors `guess_mime` in `src-tauri/src/commands/api_cmd.rs`. Duplicated rather than fetched
 * because asking the backend costs a whole file read (`api_read_file_base64` is the only command
 * that reports a MIME, and it returns the bytes with it) for a label under a file picker.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  csv: "text/csv",
  txt: "text/plain",
  log: "text/plain",
  md: "text/plain",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  zip: "application/zip",
};

const EDITOR_OPTIONS: MonacoEditorNS.IStandaloneEditorConstructionOptions = {
  ...OVERFLOW_SAFE_OPTIONS,
  minimap: { enabled: false },
  fontSize: 12,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  wordWrap: "on",
  tabSize: 2,
  renderLineHighlight: "none",
  overviewRulerLanes: 0,
  padding: { top: 8, bottom: 8 },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
};

function guessMime(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `Content-Type` the send path will supply on its own for this body — see `impliedContentType`
 * in `lib/api/send.ts`. `formdata` has none because only the transport knows the multipart
 * boundary, and `none` sends no body to describe.
 */
function impliedContentType(body: RequestBody): string | null {
  switch (body.mode) {
    case "raw":
      return RAW_CONTENT_TYPES[body.rawLanguage];
    case "graphql":
      return "application/json";
    case "urlencoded":
      return "application/x-www-form-urlencoded";
    case "binary":
      return "application/octet-stream";
    default:
      return null;
  }
}

/**
 * Puts every tag on its own line and indents by nesting depth. Text content stays with the tag
 * that opens it, so `<name>Ada</name>` survives as one line.
 *
 * Not a parser: an attribute value containing `>` will confuse it, and a document that already
 * mixes significant whitespace into its markup gets that whitespace collapsed. Both are fine for
 * a button labelled "Beautify" that the user can undo, and neither is worth a DOM parser here.
 */
function indentXml(source: string, indent = "  "): string {
  const compact = source.replace(/\r?\n\s*/g, "").replace(/>\s+</g, "><").trim();
  if (compact === "") return source;

  let depth = 0;
  return compact
    .replace(/></g, ">\n<")
    .split("\n")
    .map((line) => {
      if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
      const rendered = indent.repeat(depth) + line;
      // An opening tag and nothing else: not a closing tag, not a declaration or a comment
      // (`[^!?/]`), not self-closing, and with no content of its own trailing the `>`.
      if (/^<[^!?/][^>]*>$/.test(line) && !line.endsWith("/>")) depth++;
      return rendered;
    })
    .join("\n");
}

export function BodyPanel({ tabId }: { tabId: string }) {
  const draft = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft ?? null);
  const collectionId = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.collectionId ?? null);

  // A panel addressed by a tab that no longer exists is a render racing a close, not an error.
  if (!draft) return null;
  return <Body tabId={tabId} spec={draft} collectionId={collectionId} />;
}

function Body({
  tabId,
  spec,
  collectionId,
}: {
  tabId: string;
  spec: ApiRequestSpec;
  collectionId: string | null;
}) {
  const t = useT();
  const updateDraft = useApiStore((s) => s.updateDraft);
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const collections = useApiStore((s) => s.collections);
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);

  const body = spec.body;

  // Rebuilt from the store rather than selected out of it: `variableContext` assembles a fresh
  // object on every call, and a selector that never returns the same reference twice makes
  // `useSyncExternalStore` re-render forever.
  const variableContext = useMemo(
    () => useApiStore.getState().variableContext(collectionId),
    [collectionId, collections, environments, activeEnvironmentId],
  );

  const patchBody = (patch: Partial<RequestBody>) =>
    updateDraft(tabId, { body: { ...body, ...patch } });

  const jsonError = useMemo(() => {
    if (body.mode !== "raw" || body.rawLanguage !== "json" || body.raw.trim() === "") return null;
    try {
      JSON.parse(body.raw);
      return null;
    } catch (e) {
      return messageOf(e);
    }
  }, [body.mode, body.rawLanguage, body.raw]);

  const explicitContentType = useMemo(
    () => spec.headers.find((row) => row.enabled && row.key.trim().toLowerCase() === "content-type") ?? null,
    [spec.headers],
  );
  const overridden =
    body.mode !== "none" &&
    explicitContentType !== null &&
    explicitContentType.value.trim() !== impliedContentType(body);

  /**
   * Switching languages moves the `Content-Type` header only when it still carries the *previous*
   * language's type — that is a header this control wrote, and following the body is what it is
   * for. Anything else was typed deliberately (`application/vnd.api+json` is a real answer), and
   * rewriting it would change what goes on the wire without saying so.
   */
  const setRawLanguage = (next: RawLanguage) => {
    const outgoing = RAW_CONTENT_TYPES[body.rawLanguage];
    const row = spec.headers.find((header) => header.key.trim().toLowerCase() === "content-type");
    const headers =
      row && row.value.trim() === outgoing
        ? spec.headers.map((header) =>
            header === row ? { ...header, value: RAW_CONTENT_TYPES[next] } : header,
          )
        : null;
    updateDraft(tabId, {
      body: { ...body, rawLanguage: next },
      ...(headers ? { headers } : {}),
    });
  };

  const beautify = () => {
    if (body.rawLanguage === "json") {
      try {
        patchBody({ raw: JSON.stringify(JSON.parse(body.raw), null, 2) });
      } catch (e) {
        pushErrorToast(t("api.body.invalidJson", { error: messageOf(e) }));
      }
      return;
    }
    patchBody({ raw: indentXml(body.raw) });
  };

  const pickBinary = async () => {
    try {
      const path = await apiPickFile([]);
      if (path) patchBody({ binaryPath: path });
    } catch (e) {
      pushErrorToast(messageOf(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--cf-border)] px-3 py-2">
        {MODES.map(({ mode, labelKey }) => (
          <ModeRadio
            key={mode}
            group={`cf-body-mode-${tabId}`}
            checked={body.mode === mode}
            label={t(labelKey)}
            onSelect={() => patchBody({ mode })}
          />
        ))}

        {body.mode === "raw" && (
          <div className="ml-auto flex items-center gap-2">
            <Select
              size="sm"
              className="w-32"
              ariaLabel={t("api.body.language")}
              value={body.rawLanguage}
              onChange={(value) => setRawLanguage(value as RawLanguage)}
              // Values are Monaco's own language ids — `RawLanguage` is named after them, so the
              // same string drives the picker, the editor and the implied `Content-Type`.
              options={[
                { value: "json", label: "JSON" },
                { value: "xml", label: "XML" },
                { value: "html", label: "HTML" },
                { value: "javascript", label: "JavaScript" },
                { value: "text", label: t("api.body.text") },
              ]}
            />
            {(body.rawLanguage === "json" || body.rawLanguage === "xml") && (
              <button
                onClick={beautify}
                className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-0.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
              >
                <WandSparkles size={12} />
                {t("api.body.beautify")}
              </button>
            )}
          </div>
        )}
      </div>

      {overridden && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-3 py-1 text-[11px] text-[var(--cf-text-muted)]">
          <Info size={11} className="shrink-0" />
          {t("api.body.contentTypeOverride")}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {body.mode === "none" && (
          <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-[var(--cf-text-muted)]">
            {t("api.body.noBody")}
          </div>
        )}

        {body.mode === "formdata" && (
          <div className="h-full overflow-auto">
            <KeyValueTable
              key={`${tabId}:formdata`}
              rows={body.formdata}
              onChange={(rows) => patchBody({ formdata: rows })}
              fileRows
              allowBulkEdit
              variableContext={variableContext}
            />
          </div>
        )}

        {body.mode === "urlencoded" && (
          <div className="h-full overflow-auto">
            <KeyValueTable
              key={`${tabId}:urlencoded`}
              rows={body.urlencoded}
              onChange={(rows) => patchBody({ urlencoded: rows })}
              allowBulkEdit
              variableContext={variableContext}
            />
          </div>
        )}

        {body.mode === "raw" && (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <Editor
                height="100%"
                // One model per tab, so two tabs editing raw bodies keep their own undo history
                // and cursor. The scheme is this panel's own — `cf-editor` URIs are file models
                // and would be offered to "go to definition".
                path={`cf-api:/body/${tabId}`}
                language={body.rawLanguage}
                value={body.raw}
                theme={monacoTheme}
                onChange={(value) => patchBody({ raw: value ?? "" })}
                options={EDITOR_OPTIONS}
              />
            </div>
            {body.rawLanguage === "json" && body.raw.trim() !== "" && (
              <div
                className={`flex shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] px-3 py-1 text-[11px] ${
                  jsonError ? "text-[var(--cf-danger)]" : "text-[var(--cf-success)]"
                }`}
              >
                {jsonError ? (
                  <AlertTriangle size={11} className="shrink-0" />
                ) : (
                  <CheckCircle2 size={11} className="shrink-0" />
                )}
                <span className="truncate">
                  {jsonError ? t("api.body.invalidJson", { error: jsonError }) : t("api.body.validJson")}
                </span>
              </div>
            )}
          </div>
        )}

        {body.mode === "binary" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
            <button
              onClick={() => void pickBinary()}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            >
              <FolderOpen size={13} />
              {t("api.body.chooseFile")}
            </button>
            {body.binaryPath ? (
              <div className="flex max-w-full items-center gap-2 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-[12px] text-[var(--cf-text)]">{baseName(body.binaryPath)}</div>
                  <div className="truncate text-[11px] text-[var(--cf-text-muted)]" title={body.binaryPath}>
                    {body.binaryPath}
                  </div>
                  <div className="text-[11px] text-[var(--cf-text-muted)]">{guessMime(body.binaryPath)}</div>
                </div>
                <button
                  onClick={() => patchBody({ binaryPath: "" })}
                  title={t("api.body.clearFile")}
                  aria-label={t("api.body.clearFile")}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.06] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <p className="text-[12px] text-[var(--cf-text-muted)]">{t("api.body.noFile")}</p>
            )}
          </div>
        )}

        {body.mode === "graphql" && <GraphqlPanel tabId={tabId} />}
      </div>
    </div>
  );
}

/** A real radio input under a styled dot, for the same reason `Checkbox` does it: keyboard focus,
 * screen readers and "click the label" all keep working without being re-implemented. */
function ModeRadio({
  group,
  checked,
  label,
  onSelect,
}: {
  group: string;
  checked: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <span className="relative inline-flex h-3.5 w-3.5 shrink-0">
        <input
          type="radio"
          name={group}
          checked={checked}
          onChange={onSelect}
          className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
        <span
          aria-hidden
          className="pointer-events-none flex h-3.5 w-3.5 items-center justify-center rounded-full border transition-colors duration-100 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--cf-accent)] peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-[var(--cf-surface)]"
          style={{ borderColor: checked ? "var(--cf-accent)" : "var(--cf-border)" }}
        >
          {checked && <span className="h-1.5 w-1.5 rounded-full bg-[var(--cf-accent)]" />}
        </span>
      </span>
      <span className={`text-[12px] ${checked ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>
        {label}
      </span>
    </label>
  );
}
