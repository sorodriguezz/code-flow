import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileJson,
  FileText,
  Folder,
  Globe,
  Link2,
  Loader2,
  Upload,
} from "lucide-react";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { ApiModal, GhostButton, PrimaryButton } from "./ApiModal";
import { badgeColor, badgeLabel, statusColor } from "./methodStyle";
import { useApiStore } from "../../state/apiStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { detectFormat, importAny } from "../../lib/api/importers";
import { SpecFetchError, fetchSpec } from "../../lib/api/specFetch";
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

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * A node's identity is its position: `"0.3.1"` is the second item of the fourth item of the first
 * collection. Positions rather than names because names repeat — two tags can both hold a
 * `GET /` — and because the tree is derived deterministically from the document, so re-parsing
 * the same text yields the same positions and a selection survives it.
 *
 * Only requests are ever in the set. A folder's checkbox is computed from the requests under it,
 * which is one source of truth instead of two that can disagree.
 */
type Key = string;

function collectRequestKeys(items: ImportedItem[], prefix: Key, out: Key[]): void {
  items.forEach((item, index) => {
    const key = `${prefix}.${index}`;
    if (item.kind === "request") out.push(key);
    else collectRequestKeys(item.items, key, out);
  });
}

function allRequestKeys(result: ImportResult): Key[] {
  const out: Key[] = [];
  result.collections.forEach((collection, index) => collectRequestKeys(collection.items, String(index), out));
  return out;
}

function descendantKeys(items: ImportedItem[], prefix: Key): Key[] {
  const out: Key[] = [];
  collectRequestKeys(items, prefix, out);
  return out;
}

type CheckState = "all" | "some" | "none";

function checkStateOf(keys: Key[], selected: Set<Key>): CheckState {
  if (keys.length === 0) return "none";
  let hits = 0;
  for (const key of keys) if (selected.has(key)) hits += 1;
  if (hits === 0) return "none";
  return hits === keys.length ? "all" : "some";
}

/** Drops everything unselected, and any folder left holding nothing. */
function pruneItems(items: ImportedItem[], prefix: Key, selected: Set<Key>): ImportedItem[] {
  const out: ImportedItem[] = [];
  items.forEach((item, index) => {
    const key = `${prefix}.${index}`;
    if (item.kind === "request") {
      if (selected.has(key)) out.push(item);
      return;
    }
    const kept = pruneItems(item.items, key, selected);
    if (kept.length > 0) out.push({ ...item, items: kept });
  });
  return out;
}

function countTree(items: ImportedItem[]): { folders: number; requests: number; examples: number } {
  let folders = 0;
  let requests = 0;
  let examples = 0;
  for (const item of items) {
    if (item.kind === "request") {
      requests += 1;
      examples += item.spec.examples.length;
      continue;
    }
    folders += 1;
    const nested = countTree(item.items);
    folders += nested.folders;
    requests += nested.requests;
    examples += nested.examples;
  }
  return { folders, requests, examples };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function markAll(items: ImportedItem[], prefix: Key, out: Set<Key>): void {
  items.forEach((item, index) => {
    const key = `${prefix}.${index}`;
    out.add(key);
    if (item.kind === "folder") markAll(item.items, key, out);
  });
}

/**
 * The keys a query leaves on screen: matching requests, every folder above them, and — when a
 * folder matches by its own name — everything inside it.
 *
 * A filter marks nodes rather than rebuilding the tree, because rebuilding renumbers it and the
 * selection is keyed by number.
 */
function markVisible(items: ImportedItem[], prefix: Key, query: string, out: Set<Key>): boolean {
  let any = false;
  items.forEach((item, index) => {
    const key = `${prefix}.${index}`;
    if (item.kind === "request") {
      if (item.name.toLowerCase().includes(query) || item.spec.url.toLowerCase().includes(query)) {
        out.add(key);
        any = true;
      }
      return;
    }
    const childMatched = markVisible(item.items, key, query, out);
    const selfMatched = item.name.toLowerCase().includes(query);
    if (childMatched || selfMatched) {
      out.add(key);
      any = true;
      if (!childMatched) markAll(item.items, key, out);
    }
  });
  return any;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function TriCheckbox({
  state,
  onChange,
  label,
  disabled,
}: {
  state: CheckState;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      disabled={disabled}
      checked={state === "all"}
      // `indeterminate` is a DOM property with no HTML attribute, so React can't set it for us.
      ref={(el) => {
        if (el) el.indeterminate = state === "some";
      }}
      onChange={onChange}
      className="h-3 w-3 shrink-0 accent-[var(--cf-accent)]"
    />
  );
}

function Twisty({ open, onClick }: { open: boolean; onClick: () => void }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      tabIndex={-1}
      aria-hidden
    >
      <Icon size={12} />
    </button>
  );
}

function TreeRows({
  items,
  prefix,
  depth,
  selected,
  visible,
  toggled,
  onToggleSelect,
  onToggleOpen,
}: {
  items: ImportedItem[];
  prefix: Key;
  depth: number;
  selected: Set<Key>;
  /** `null` while no filter is active — everything shows. */
  visible: Set<Key> | null;
  toggled: Set<Key>;
  onToggleSelect: (keys: Key[], next: boolean) => void;
  onToggleOpen: (key: Key) => void;
}) {
  return (
    <>
      {items.map((item, index) => {
        const key = `${prefix}.${index}`;
        if (visible && !visible.has(key)) return null;
        const pad = { paddingLeft: `${depth * 14}px` };

        if (item.kind === "folder") {
          const keys = descendantKeys(item.items, key);
          const state = checkStateOf(keys, selected);
          // A filtered tree is open: hiding a match behind a collapsed folder defeats the filter.
          const open = visible !== null || !toggled.has(key);
          return (
            <div key={key}>
              <div className="flex items-center gap-1.5 py-[3px] text-[12px]" style={pad}>
                <TriCheckbox
                  state={state}
                  label={item.name}
                  onChange={() => onToggleSelect(keys, state !== "all")}
                />
                <Twisty open={open} onClick={() => onToggleOpen(key)} />
                <Folder size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="truncate text-[var(--cf-text)]">{item.name}</span>
                <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{keys.length}</span>
              </div>
              {open && (
                <TreeRows
                  items={item.items}
                  prefix={key}
                  depth={depth + 1}
                  selected={selected}
                  visible={visible}
                  toggled={toggled}
                  onToggleSelect={onToggleSelect}
                  onToggleOpen={onToggleOpen}
                />
              )}
            </div>
          );
        }

        const examples = item.spec.examples;
        const checked = selected.has(key);
        const open = toggled.has(key);
        return (
          <div key={key}>
            <div
              className={`flex items-center gap-1.5 py-[3px] text-[12px] ${checked ? "" : "opacity-50"}`}
              style={pad}
            >
              <TriCheckbox
                state={checked ? "all" : "none"}
                label={item.name}
                onChange={() => onToggleSelect([key], !checked)}
              />
              {examples.length > 0 ? (
                <Twisty open={open} onClick={() => onToggleOpen(key)} />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span
                className="w-[46px] shrink-0 font-mono text-[10px] font-semibold uppercase"
                style={{ color: badgeColor(item.spec.protocol, item.spec.method) }}
              >
                {badgeLabel(item.spec.protocol, item.spec.method)}
              </span>
              <span className="truncate text-[var(--cf-text)]">{item.name}</span>
              <span className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                {item.spec.url}
              </span>
            </div>
            {open &&
              examples.map((example) => (
                <div
                  key={example.id}
                  className="flex items-center gap-1.5 py-[2px] text-[11px]"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 32}px` }}
                >
                  <FileText size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
                  <span
                    className="shrink-0 font-mono text-[10px] font-semibold"
                    style={{ color: statusColor(example.status) }}
                  >
                    {example.status}
                  </span>
                  <span className="truncate text-[var(--cf-text-muted)]">{example.name}</span>
                </div>
              ))}
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function ImportModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const pushToast = useToastStore((s) => s.pushToast);
  const settings = useApiStore((s) => s.settings);

  const [text, setText] = useState("");
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<{ ok: boolean; message: string } | null>(null);

  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [includeExamples, setIncludeExamples] = useState(true);

  const [selected, setSelected] = useState<Set<Key>>(new Set());
  const [toggled, setToggled] = useState<Set<Key>>(new Set());
  const [filter, setFilter] = useState("");
  /** The document the current selection was built for, so a re-parse doesn't clear it. */
  const selectionSource = useRef<string | null>(null);

  const busy = importing || fetching;

  // Detection is cheap (structure sniffing, no full parse) so the badge can follow every keystroke.
  const format = useMemo(() => (text.trim() ? detectFormat(text) : null), [text]);

  useEffect(() => {
    if (!text.trim()) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => setResult(importAny(text, { includeExamples })), PARSE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, includeExamples]);

  // A fresh document starts fully selected; a re-parse of the same one (toggling examples) keeps
  // whatever the user had unticked, because the keys are positional and the positions didn't move.
  useEffect(() => {
    if (!result) {
      selectionSource.current = null;
      return;
    }
    if (selectionSource.current === text) return;
    selectionSource.current = text;
    setSelected(new Set(allRequestKeys(result)));
    setToggled(new Set());
    setFilter("");
    if (!nameDirty) setName(result.collections[0]?.name ?? "");
  }, [result, text, nameDirty]);

  const loadFile = useCallback(
    async (path: string) => {
      try {
        setText(await apiReadTextFile(path));
        setSourcePath(path);
        setFetchNote(null);
        // A new document brings its own title; a name typed for the previous one is stale.
        setNameDirty(false);
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

  const load = async () => {
    if (!url.trim()) return;
    setFetching(true);
    setFetchNote(null);
    try {
      const spec = await fetchSpec(url, settings);
      setText(spec.text);
      setSourcePath(null);
      setNameDirty(false);
      setFetchNote({
        ok: true,
        message: spec.resolvedFrom
          ? t("api.import.urlResolved", { url: spec.url })
          : t("api.import.urlLoaded"),
      });
    } catch (e) {
      setFetchNote({ ok: false, message: describeFetchError(e, t) });
    } finally {
      setFetching(false);
    }
  };

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query || !result) return null;
    const out = new Set<Key>();
    result.collections.forEach((collection, index) =>
      markVisible(collection.items, String(index), query, out),
    );
    return out;
  }, [filter, result]);

  /** What `Import` will actually create: the tree with everything unticked removed. */
  const pruned = useMemo(() => {
    if (!result) return [];
    return result.collections
      .map((collection, index) => ({
        ...collection,
        items: pruneItems(collection.items, String(index), selected),
      }))
      .filter((collection) => collection.items.length > 0);
  }, [result, selected]);

  const totals = useMemo(() => {
    let requests = 0;
    let examples = 0;
    for (const collection of pruned) {
      const counted = countTree(collection.items);
      requests += counted.requests;
      examples += counted.examples;
    }
    return {
      collections: pruned.length,
      requests,
      examples,
      environments: result?.environments.length ?? 0,
    };
  }, [pruned, result]);

  const hasSomething = totals.collections > 0 || totals.environments > 0;
  const hasAnyRequest = (result?.collections.length ?? 0) > 0;

  const toggleSelect = useCallback((keys: Key[], next: boolean) => {
    setSelected((previous) => {
      const out = new Set(previous);
      for (const key of keys) {
        if (next) out.add(key);
        else out.delete(key);
      }
      return out;
    });
  }, []);

  const toggleOpen = useCallback((key: Key) => {
    setToggled((previous) => {
      const out = new Set(previous);
      if (out.has(key)) out.delete(key);
      else out.add(key);
      return out;
    });
  }, []);

  /** Bulk actions act on what the filter leaves on screen, which is what "all" reads as there. */
  const setAll = (next: boolean) => {
    if (!result) return;
    const keys = allRequestKeys(result).filter((key) => !visible || visible.has(key));
    toggleSelect(keys, next);
  };

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
      for (const imported of pruned) {
        // The name field only stands in for a single collection — with several there is nothing
        // sensible for one typed name to mean.
        const label = pruned.length === 1 && name.trim() ? name.trim() : imported.name;
        const collection = await store.createCollection(label);
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

  const fieldClass =
    "w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[12px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50";

  return (
    <ApiModal
      icon={Download}
      title={t("api.import.title")}
      subtitle={t("api.import.formats")}
      width="max-w-3xl"
      height="h-[80vh]"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11px] text-[var(--cf-text-muted)]">
            {hasSomething
              ? t("api.import.willCreate", {
                  requests: totals.requests,
                  examples: totals.examples,
                })
              : format
                ? t("api.import.detected", { format: FORMAT_LABELS[format] })
                : text.trim()
                  ? t("api.import.unknownFormat")
                  : ""}
          </span>
          <GhostButton onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </GhostButton>
          <PrimaryButton onClick={() => void runImport()} disabled={busy || !hasSomething}>
            {importing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {t("api.import.run")}
          </PrimaryButton>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="mb-3">
          <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
            {t("api.import.urlLabel")}
          </label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Link2
                size={13}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
              />
              <input
                autoFocus
                type="url"
                spellCheck={false}
                disabled={busy}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void load();
                }}
                placeholder={t("api.import.urlPlaceholder")}
                className={`${fieldClass} pl-7 font-mono`}
              />
            </div>
            <GhostButton onClick={() => void load()} disabled={busy || !url.trim()}>
              {fetching ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {t("api.import.load")}
            </GhostButton>
          </div>
          {fetchNote && (
            <p
              className={`mt-1 text-[11px] leading-snug ${
                fetchNote.ok ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-danger)]"
              }`}
            >
              {fetchNote.message}
            </p>
          )}
        </div>

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
            <GhostButton onClick={() => void pick()} disabled={busy}>
              {t("api.import.pickFile")}
            </GhostButton>
            {text !== "" && (
              <GhostButton
                onClick={() => {
                  setText("");
                  setSourcePath(null);
                  setFetchNote(null);
                  setName("");
                  setNameDirty(false);
                }}
                disabled={busy}
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
          spellCheck={false}
          disabled={busy}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSourcePath(null);
            setFetchNote(null);
          }}
          placeholder={t("api.import.curlPlaceholder")}
          className="mb-3 h-24 w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent p-2 font-mono text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
        />

        {result && result.collections.length === 1 && (
          <>
            <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("api.import.name")}
            </label>
            <input
              type="text"
              disabled={busy}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameDirty(true);
              }}
              placeholder={result.collections[0]?.name}
              className={`${fieldClass} mb-3`}
            />
          </>
        )}

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
          {hasAnyRequest && (
            <>
              <input
                type="text"
                disabled={busy}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t("api.import.filter")}
                className="ml-auto w-40 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-[2px] text-[11px] outline-none focus:border-[var(--cf-accent)]"
              />
              <GhostButton onClick={() => setAll(true)} disabled={busy}>
                {t("api.import.selectAll")}
              </GhostButton>
              <GhostButton onClick={() => setAll(false)} disabled={busy}>
                {t("api.import.selectNone")}
              </GhostButton>
            </>
          )}
        </div>

        <div className="rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2">
          {!hasAnyRequest && totals.environments === 0 ? (
            <p className="p-2 text-[12px] text-[var(--cf-text-muted)]">
              {t("api.import.previewEmpty")}
            </p>
          ) : (
            <>
              {result?.collections.map((collection, index) => {
                const keys = descendantKeys(collection.items, String(index));
                const state = checkStateOf(keys, selected);
                return (
                  <div key={`${index}-${collection.name}`} className="mb-1">
                    <div className="flex items-center gap-1.5 py-[3px] text-[12px] font-medium text-[var(--cf-text)]">
                      <TriCheckbox
                        state={state}
                        label={collection.name}
                        onChange={() => toggleSelect(keys, state !== "all")}
                      />
                      <FileJson size={12} className="shrink-0 text-[var(--cf-accent)]" />
                      <span className="truncate">
                        {index === 0 && name.trim() && result.collections.length === 1
                          ? name.trim()
                          : collection.name}
                      </span>
                    </div>
                    <TreeRows
                      items={collection.items}
                      prefix={String(index)}
                      depth={1}
                      selected={selected}
                      visible={visible}
                      toggled={toggled}
                      onToggleSelect={toggleSelect}
                      onToggleOpen={toggleOpen}
                    />
                  </div>
                );
              })}
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

        <label className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
          <input
            type="checkbox"
            disabled={busy}
            checked={includeExamples}
            onChange={(e) => setIncludeExamples(e.target.checked)}
            className="h-3 w-3 accent-[var(--cf-accent)]"
          />
          {t("api.import.includeExamples")}
        </label>
      </div>
    </ApiModal>
  );
}

function describeFetchError(e: unknown, t: ReturnType<typeof useT>): string {
  if (e instanceof SpecFetchError) {
    switch (e.failure.code) {
      case "badUrl":
        return t("api.import.urlBad");
      case "http":
        return t("api.import.urlHttp", { status: e.failure.status });
      case "network":
        return t("api.import.urlNetwork", { error: e.failure.detail });
      case "notASpec":
        return t("api.import.urlNotASpec");
    }
  }
  return t("api.import.failed", { error: String(e) });
}
