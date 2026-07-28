import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  ChevronRight,
  Download,
  FileJson,
  Folder,
  Globe,
  Loader2,
  Upload,
} from "lucide-react";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { ApiModal, GhostButton, PrimaryButton } from "./ApiModal";
import { useApiStore } from "../../state/apiStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { detectFormat, importAny } from "../../lib/api/importers";
import { apiPickFile, apiReadTextFile } from "../../lib/tauri/apiCommands";
import type { ImportFormat, ImportResult, ImportedItem } from "../../types/api";

/** Parsing a 5 MB OpenAPI document on every keystroke would make the textarea unusable. */
const PARSE_DEBOUNCE_MS = 250;

const FILE_EXTENSIONS = ["json", "yaml", "yml", "har", "txt", "sh", "curl"];

/** Format names are product names, not UI copy — they read the same in every language. */
const FORMAT_LABELS: Record<ImportFormat, string> = {
  postman: "Postman Collection",
  openapi: "OpenAPI / Swagger",
  curl: "cURL",
  har: "HAR",
  insomnia: "Insomnia",
  codeflow: "CodeFlow",
};

function countItems(items: ImportedItem[]): { folders: number; requests: number } {
  let folders = 0;
  let requests = 0;
  for (const item of items) {
    if (item.kind === "request") {
      requests += 1;
    } else {
      folders += 1;
      const nested = countItems(item.items);
      folders += nested.folders;
      requests += nested.requests;
    }
  }
  return { folders, requests };
}

function PreviewItems({ items, depth }: { items: ImportedItem[]; depth: number }) {
  return (
    <>
      {items.map((item, index) => (
        <div key={`${depth}-${index}-${item.name}`}>
          <div
            className="flex items-center gap-1.5 py-[3px] text-[12px]"
            style={{ paddingLeft: `${depth * 14}px` }}
          >
            {item.kind === "folder" ? (
              <>
                <Folder size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="truncate text-[var(--cf-text)]">{item.name}</span>
              </>
            ) : (
              <>
                <span className="w-[46px] shrink-0 font-mono text-[10px] font-semibold uppercase text-[var(--cf-accent)]">
                  {item.spec.protocol === "http" ? item.spec.method : item.spec.protocol}
                </span>
                <span className="truncate text-[var(--cf-text)]">{item.name}</span>
                <span className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                  {item.spec.url}
                </span>
              </>
            )}
          </div>
          {item.kind === "folder" && <PreviewItems items={item.items} depth={depth + 1} />}
        </div>
      ))}
    </>
  );
}

export function ImportModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const pushToast = useToastStore((s) => s.pushToast);

  const [text, setText] = useState("");
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  // Detection is cheap (structure sniffing, no full parse) so the badge can follow every keystroke.
  const format = useMemo(() => (text.trim() ? detectFormat(text) : null), [text]);

  useEffect(() => {
    if (!text.trim()) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => setResult(importAny(text)), PARSE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const loadFile = useCallback(
    async (path: string) => {
      try {
        setText(await apiReadTextFile(path));
        setSourcePath(path);
      } catch (e) {
        pushErrorToast(t("api.import.failed", { error: String(e) }));
      }
    },
    [t],
  );

  const loadFileRef = useRef(loadFile);
  loadFileRef.current = loadFile;

  /**
   * File drops arrive on Tauri's native webview channel, not as DOM `drop` events — the native
   * drag handler consumes those before the page sees them. The event is window-wide with a
   * physical-pixel position, so rather than hit-test the zone we accept a drop anywhere while this
   * modal is up: it's modal, nothing else can be the intended target.
   */
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") setDropActive(true);
        else if (payload.type === "leave") setDropActive(false);
        else if (payload.type === "drop") {
          setDropActive(false);
          const path = payload.paths[0];
          if (path) void loadFileRef.current(path);
        }
      })
      .then((fn) => {
        if (disposed) void fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      if (unlisten) void unlisten();
    };
  }, []);

  const pick = async () => {
    const path = await apiPickFile(FILE_EXTENSIONS).catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (path) await loadFile(path);
  };

  const totals = useMemo(() => {
    if (!result) return { collections: 0, folders: 0, requests: 0, environments: 0 };
    let folders = 0;
    let requests = 0;
    for (const collection of result.collections) {
      const counted = countItems(collection.items);
      folders += counted.folders;
      requests += counted.requests;
    }
    return {
      collections: result.collections.length,
      folders,
      requests,
      environments: result.environments.length,
    };
  }, [result]);

  const hasSomething = totals.collections > 0 || totals.environments > 0;

  const runImport = async () => {
    if (!result || !hasSomething) return;
    setImporting(true);
    const store = useApiStore.getState();

    const createItems = async (
      collectionId: string,
      folderId: string | null,
      items: ImportedItem[],
    ): Promise<void> => {
      for (const item of items) {
        if (item.kind === "request") {
          await store.createRequest(collectionId, folderId, item.name, item.spec);
          continue;
        }
        const folder = await store.createFolder(collectionId, folderId, item.name);
        if (!folder) continue;
        await store.updateFolder({
          ...folder,
          description: item.description,
          auth: item.auth ? JSON.stringify(item.auth) : "",
          pre_script: item.preScript,
          post_script: item.postScript,
        });
        await createItems(collectionId, folder.id, item.items);
      }
    };

    try {
      for (const imported of result.collections) {
        const collection = await store.createCollection(imported.name);
        if (!collection) continue;
        await store.updateCollection({
          ...collection,
          description: imported.description,
          auth: imported.auth ? JSON.stringify(imported.auth) : "",
          pre_script: imported.preScript,
          post_script: imported.postScript,
          variables: JSON.stringify(imported.variables),
        });
        await createItems(collection.id, null, imported.items);
      }

      for (const environment of result.environments) {
        const created = await store.createEnvironment(environment.name);
        if (!created) continue;
        await store.updateEnvironment({
          ...created,
          variables: JSON.stringify(environment.variables),
        });
      }

      pushToast(
        t("api.import.done", { collections: totals.collections, requests: totals.requests }),
        "success",
      );
      onClose();
    } catch (e) {
      pushErrorToast(t("api.import.failed", { error: String(e) }));
    } finally {
      setImporting(false);
    }
  };

  return (
    <ApiModal
      icon={Download}
      title={t("api.import.title")}
      subtitle={t("api.import.formats")}
      width="max-w-3xl"
      height="h-[80vh]"
      busy={importing}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11px] text-[var(--cf-text-muted)]">
            {format
              ? t("api.import.detected", { format: FORMAT_LABELS[format] })
              : text.trim()
                ? t("api.import.unknownFormat")
                : ""}
          </span>
          <GhostButton onClick={onClose} disabled={importing}>
            {t("common.cancel")}
          </GhostButton>
          <PrimaryButton onClick={() => void runImport()} disabled={importing || !hasSomething}>
            {importing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {t("api.import.run")}
          </PrimaryButton>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div
          className={`mb-3 rounded-lg border border-dashed p-3 transition-colors ${
            dropActive
              ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
              : "border-[var(--cf-border)]"
          }`}
        >
          <div className="flex items-center gap-2">
            <Upload size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text-muted)]">
              {dropActive
                ? t("api.import.dropActive")
                : sourcePath
                  ? t("api.import.fileRead", { path: sourcePath })
                  : t("api.import.dropHint")}
            </span>
            <GhostButton onClick={() => void pick()} disabled={importing}>
              {t("api.import.pickFile")}
            </GhostButton>
            {text !== "" && (
              <GhostButton
                onClick={() => {
                  setText("");
                  setSourcePath(null);
                }}
                disabled={importing}
              >
                {t("api.import.clear")}
              </GhostButton>
            )}
          </div>
        </div>

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("api.import.pasteText")}
        </label>
        <textarea
          autoFocus
          spellCheck={false}
          disabled={importing}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSourcePath(null);
          }}
          placeholder={t("api.import.curlPlaceholder")}
          className="mb-3 h-32 w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent p-2 font-mono text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
        />

        {result && result.warnings.length > 0 && (
          <div className="mb-3">
            <CollapsibleSection
              icon={AlertTriangle}
              title={t("api.import.warnings", { n: result.warnings.length })}
            >
              <ul className="space-y-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2">
                {result.warnings.map((warning, index) => (
                  <li
                    key={index}
                    className="flex gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]"
                  >
                    <ChevronRight size={11} className="mt-[2px] shrink-0" />
                    <span className="min-w-0 break-words">{warning}</span>
                  </li>
                ))}
              </ul>
            </CollapsibleSection>
          </div>
        )}

        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("api.import.preview")}
          </span>
          {hasSomething && (
            <span className="text-[11px] text-[var(--cf-text-muted)]">
              {t("api.import.done", {
                collections: totals.collections,
                requests: totals.requests,
              })}
            </span>
          )}
        </div>

        <div className="rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2">
          {!hasSomething ? (
            <p className="p-2 text-[12px] text-[var(--cf-text-muted)]">
              {t("api.import.previewEmpty")}
            </p>
          ) : (
            <>
              {result?.collections.map((collection, index) => (
                <div key={`${index}-${collection.name}`} className="mb-1">
                  <div className="flex items-center gap-1.5 py-[3px] text-[12px] font-medium text-[var(--cf-text)]">
                    <FileJson size={12} className="shrink-0 text-[var(--cf-accent)]" />
                    <span className="truncate">{collection.name}</span>
                  </div>
                  <PreviewItems items={collection.items} depth={1} />
                </div>
              ))}
              {result?.environments.map((environment, index) => (
                <div
                  key={`env-${index}-${environment.name}`}
                  className="flex items-center gap-1.5 py-[3px] text-[12px] text-[var(--cf-text)]"
                >
                  <Globe size={12} className="shrink-0 text-[var(--cf-accent)]" />
                  <span className="truncate">{environment.name}</span>
                  <span className="text-[11px] text-[var(--cf-text-muted)]">
                    {environment.variables.length}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </ApiModal>
  );
}
