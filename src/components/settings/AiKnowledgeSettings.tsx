import { useEffect, useState } from "react";
import { FolderPlus, Loader2, RefreshCw, Search, Trash2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { chipClass, fieldClass } from "../common/recipes";
import { ModelDownloadRow } from "./localModelRow";
import { VectorizingLine } from "../layout/EnginesActivity";
import { useBackgroundStore } from "../../state/backgroundStore";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useKnowledgeStore } from "../../state/knowledgeStore";
import { useChatContextModeStore, type ChatContextMode } from "../../state/chatContextModeStore";
import { useUiStore } from "../../state/uiStore";
import { useConfirmStore } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { knowledgeSearch, type KnowledgeFound, type KnowledgeOverview, type KnowledgeStatus } from "../../lib/tauri/knowledgeCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

/** The sources beside repositories and folders, as `knowledge_overview` sums them (`SourceKnowledge`). */
type SourceKind = "note" | "meeting" | "doc" | "story" | "review" | "commit";
interface KnowledgeSource {
  kind: SourceKind;
  status: KnowledgeStatus;
}

/** What a result's or a source's chip says, by its `source`. */
const KIND_LABEL: Record<string, TranslationKey> = {
  repo: "knowledge.repo",
  folder: "knowledge.folder",
  symbol: "knowledge.kind.symbol",
  note: "knowledge.kind.note",
  meeting: "knowledge.kind.meeting",
  doc: "knowledge.kind.doc",
  story: "knowledge.kind.story",
  review: "knowledge.kind.review",
  commit: "knowledge.kind.commit",
};

function ago(ms: number | null, t: ReturnType<typeof useT>): string {
  if (!ms) return t("knowledge.never");
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return minutes < 1 ? t("knowledge.justNow") : minutes < 60 ? t("knowledge.minutesAgo", { n: String(minutes) }) : new Date(ms).toLocaleString();
}

function StatusLine({ status, documents = false }: { status: KnowledgeStatus; documents?: boolean }) {
  const t = useT();
  return (
    <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">
      {t(documents ? "knowledge.countsDocs" : "knowledge.counts", { files: String(status.files), chunks: String(status.chunks) })}
      {status.vectors > 0 && ` · ${t("knowledge.vectors", { n: String(status.vectors) })}`}
      {` · ${ago(status.refreshedAt, t)}`}
    </span>
  );
}

/**
 * Settings › Conocimiento: what CodeFlow can look up for a model (`crate::knowledge`). The
 * workspace's repositories are always in; folders of documents can be added, and marked "local
 * only" so cloud engines never see them. The semantic model is optional — without one, search is
 * exact words plus the code map.
 */
const CONTEXT_MODE_HINT: Record<ChatContextMode, TranslationKey> = {
  auto: "knowledge.autoContextAutoHint",
  always: "knowledge.autoContextAlwaysHint",
  tools: "knowledge.autoContextToolsHint",
};

/**
 * What the chats attach to a question besides the question (`context::need`) — global, like the
 * answer length, so it is shown with or without a workspace open.
 */
function ChatContextModePicker() {
  const t = useT();
  const { mode, pick } = useChatContextModeStore();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] text-[var(--cf-text-muted)]">{t("knowledge.autoContext")}</span>
      <Segmented
        size="sm"
        layoutId="knowledge-chat-context-mode"
        value={mode}
        onChange={(next) => void pick(next)}
        className="self-start"
        options={[
          { value: "auto", label: t("knowledge.autoContextAuto") },
          { value: "always", label: t("knowledge.autoContextAlways") },
          { value: "tools", label: t("knowledge.autoContextTools") },
        ]}
      />
      <span className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{t(CONTEXT_MODE_HINT[mode])}</span>
    </div>
  );
}

export function AiKnowledgeSettings() {
  const t = useT();
  const ask = useConfirmStore((s) => s.ask);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const { overview, reindexing, progress, load, reindex, clear, setCloud, addFolder, updateFolder, removeFolder, useModel, download, cancelDownload, removeModel } =
    useKnowledgeStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeFound[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (workspaceId) void load(workspaceId);
  }, [workspaceId, load]);

  if (!workspaceId || !overview) {
    return (
      <div className="flex flex-col gap-4">
        <ChatContextModePicker />
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("knowledge.noWorkspace")}</span>
      </div>
    );
  }

  const activeModel = overview.embedSetting ?? overview.embedModels.find((m) => m.installed)?.id ?? null;
  // Notes, meetings, generated docs, stories, review findings and commits — only the ones that hold
  // something: an empty kind is a row that says nothing.
  const sources = ((overview as KnowledgeOverview & { sources?: KnowledgeSource[] }).sources ?? []).filter((s) => s.status.files > 0);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      setResults(await knowledgeSearch(workspaceId, query.trim(), 8));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSearching(false);
    }
  };

  const pickFolder = async (localOnly: boolean) => {
    const chosen = await openDialog({ directory: true, multiple: false });
    if (typeof chosen === "string") await addFolder(chosen, localOnly);
  };

  return (
    <div className="flex flex-col gap-4">
      <ChatContextModePicker />
      <label className="flex items-start gap-2 text-[12px] text-[var(--cf-text)]">
        <Checkbox checked={overview.cloudAllowed} onChange={(value) => void setCloud(value)} className="mt-[1px]" />
        <span>
          {t("knowledge.cloudAllowed")}
          <span className="block text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("knowledge.cloudAllowedHint")}</span>
        </span>
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("knowledge.semantic")}</span>
        <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {overview.embedModels.map((model) => (
            <ModelDownloadRow
              key={model.id}
              model={{
                id: model.id,
                label: model.label,
                tier: "light",
                params: model.params,
                licence: model.licence,
                size_bytes: model.sizeBytes,
                min_ram_gb: model.minRamGb,
                installed: model.installed,
                partial_bytes: model.partialBytes,
              }}
              active={model.installed && model.id === activeModel}
              progress={progress[model.id]}
              note={<span>{t("knowledge.dims", { n: String(model.dims) })}</span>}
              onDownload={() => void download(model.id)}
              onCancel={() => void cancelDownload(model.id)}
              onUse={() => void useModel(model.id)}
              onDelete={() => void removeModel(model.id)}
            />
          ))}
        </div>
        <span className="text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {overview.space ? t("knowledge.semanticOn") : t("knowledge.semanticOff")}
        </span>
        <VectorizingNow onDone={() => void load(workspaceId)} />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("knowledge.sources")}</span>
          <button type="button" disabled={reindexing} onClick={() => void reindex()} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {reindexing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {t("knowledge.reindex")}
          </button>
          <button
            type="button"
            disabled={reindexing}
            title={t("knowledge.clearHint")}
            onClick={() =>
              void ask({ message: t("knowledge.clearConfirm"), confirmLabel: t("knowledge.clear"), danger: true }).then((ok) => {
                if (ok) void clear();
              })
            }
            className={buttonClass({ variant: "ghost", size: "sm" })}
          >
            <Trash2 size={13} />
            {t("knowledge.clear")}
          </button>
        </div>
        <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {overview.repos.map((repo) => (
            <div key={repo.projectId} className="flex flex-col border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0">
              <span className="flex min-w-0 items-center gap-2">
                {/* A reference repository (`ref:<id>`, Settings › Repositorios de referencia) is
                    searched beside the workspace's own and named for what it is. */}
                <span className={chipClass(repo.projectId.startsWith("ref:") ? "info" : "neutral")}>
                  {repo.projectId.startsWith("ref:") ? t("knowledge.reference") : t("knowledge.repo")}
                </span>
                <span className="min-w-0 truncate text-[12px] text-[var(--cf-text)]">{repo.name}</span>
              </span>
              <StatusLine status={repo.status} />
            </div>
          ))}
          {overview.folders.map(({ collection, status }) => (
            <div key={collection.id} className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={chipClass(collection.localOnly ? "warn" : "neutral")}>
                    {collection.localOnly ? t("knowledge.localOnly") : t("knowledge.folder")}
                  </span>
                  <span className="min-w-0 truncate text-[12px] text-[var(--cf-text)]" title={collection.path}>
                    {collection.name}
                  </span>
                </span>
                <StatusLine status={status} />
              </div>
              <label className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
                <Checkbox checked={collection.localOnly} onChange={(value) => void updateFolder(collection.id, { localOnly: value })} />
                {t("knowledge.localOnlyShort")}
              </label>
              <label className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
                <Checkbox checked={collection.enabled} onChange={(value) => void updateFolder(collection.id, { enabled: value })} />
                {t("knowledge.enabled")}
              </label>
              <button
                type="button"
                title={t("knowledge.remove")}
                onClick={() =>
                  void ask({ message: t("knowledge.removeConfirm", { name: collection.name }), confirmLabel: t("knowledge.remove"), danger: true }).then(
                    (ok) => {
                      if (ok) void removeFolder(collection.id);
                    },
                  )
                }
                className={buttonClass({ variant: "ghost", size: "sm" })}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {sources.map(({ kind, status }) => (
            <div key={kind} className="flex flex-col border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0">
              <span className="flex min-w-0 items-center gap-2">
                <span className={chipClass("neutral")}>{t(KIND_LABEL[kind])}</span>
              </span>
              <StatusLine status={status} documents />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void pickFolder(false)} className={buttonClass({ variant: "secondary", size: "sm" })}>
            <FolderPlus size={13} /> {t("knowledge.addFolder")}
          </button>
          <button type="button" onClick={() => void pickFolder(true)} className={buttonClass({ variant: "ghost", size: "sm" })}>
            <FolderPlus size={13} /> {t("knowledge.addLocalFolder")}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("knowledge.try")}</span>
        <div className="flex max-w-[520px] items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
            placeholder={t("knowledge.tryPlaceholder")}
            aria-label={t("knowledge.try")}
            className={fieldClass({ size: "sm", className: "flex-1" })}
          />
          <button type="button" disabled={!query.trim() || searching} onClick={() => void search()} className={buttonClass({ variant: "secondary", size: "sm" })}>
            {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            {t("knowledge.search")}
          </button>
        </div>
        {results && results.length === 0 && <span className="text-[12px] text-[var(--cf-text-muted)]">{t("knowledge.noResults")}</span>}
        {results && results.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
            {results.map((found, index) => (
              <div key={`${found.path}-${index}`} className="border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0">
                <div className="flex items-center gap-2">
                  <span className={chipClass("neutral")}>{KIND_LABEL[found.source] ? t(KIND_LABEL[found.source]) : found.source}</span>
                  {found.source === "repo" || found.source === "symbol" ? (
                    <button
                      type="button"
                      onClick={() => useUiStore.getState().openInEditor(found.path, found.startLine || undefined)}
                      className="min-w-0 truncate font-mono text-[11px] text-[var(--cf-text)] hover:underline"
                    >
                      {found.path}
                      {found.startLine > 0 && `:${found.startLine}-${found.endLine}`}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate font-mono text-[11px] text-[var(--cf-text)]">{found.label || found.path}</span>
                  )}
                  {found.heading && <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{found.heading}</span>}
                </div>
                <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[11px] leading-snug text-[var(--cf-text-muted)]">{found.snippet}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The vectorizing pass under way, under the models — what used to go on unseen for minutes after
 * Reindexar had already answered (2026-10-22). When it ends, `onDone` re-reads the counts.
 */
function VectorizingNow({ onDone }: { onDone: () => void }) {
  const t = useT();
  const watch = useBackgroundStore((s) => s.watch);
  const vectorizing = useBackgroundStore((s) => s.status?.vectorizing ?? null);
  const [was, setWas] = useState(false);
  useEffect(() => watch(), [watch]);
  useEffect(() => {
    if (vectorizing) setWas(true);
    else if (was) {
      setWas(false);
      onDone();
    }
  }, [vectorizing, was, onDone]);
  if (!vectorizing) return null;
  return (
    <div className="rounded-md border border-[var(--cf-border)] px-2.5 py-2">
      <span className="text-[11.5px] font-medium text-[var(--cf-text)]">{t("knowledge.vectorizing")}</span>
      <VectorizingLine done={vectorizing.done} total={vectorizing.total} etaSecs={vectorizing.etaSecs} />
    </div>
  );
}
