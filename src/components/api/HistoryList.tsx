import { useMemo } from "react";
import { History, Trash2, X } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { MethodBadge } from "./CollectionTree";
import { apiGetHistorySnapshot } from "../../lib/tauri/apiCommands";
import { useApiStore } from "../../state/apiStore";
import { useApiRuntimeStore } from "../../state/apiRuntimeStore";
import { confirmAction } from "../../state/confirmStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";
import type { ApiHistoryEntry, ApiRequestSpec, ApiResponse } from "../../types/api";

/** What `api_history.snapshot` holds — enough to put the request *and* what came back on screen. */
interface HistorySnapshot {
  request: ApiRequestSpec;
  response: ApiResponse | null;
}

function parseSnapshot(raw: string): HistorySnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<HistorySnapshot>;
    return parsed.request ? { request: parsed.request, response: parsed.response ?? null } : null;
  } catch {
    return null;
  }
}

function statusColor(status: number | null): string {
  if (status === null) return "var(--cf-danger)";
  if (status < 300) return "var(--cf-success)";
  if (status < 400) return "var(--cf-warning)";
  return "var(--cf-danger)";
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Newest first, split into runs of one calendar day. An unparseable timestamp keeps its entry
 * rather than dropping it — it just lands in a group of its own, labelled with the raw value. */
function groupByDay(entries: ApiHistoryEntry[]): { key: string; when: Date | null; items: ApiHistoryEntry[] }[] {
  const groups: { key: string; when: Date | null; items: ApiHistoryEntry[] }[] = [];
  for (const entry of entries) {
    const parsed = new Date(entry.created_at);
    const valid = !Number.isNaN(parsed.getTime());
    const key = valid ? parsed.toDateString() : entry.created_at;
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(entry);
    else groups.push({ key, when: valid ? parsed : null, items: [entry] });
  }
  return groups;
}

export function HistoryList() {
  const t = useT();
  const locale = useLanguageStore((s) => (s.language === "es" ? "es-ES" : "en-US"));
  const history = useApiStore((s) => s.history);
  const deleteHistory = useApiStore((s) => s.deleteHistory);
  const clearHistory = useApiStore((s) => s.clearHistory);

  const groups = useMemo(() => groupByDay(history), [history]);

  const dayLabel = (key: string, when: Date | null): string => {
    if (!when) return key;
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (when.toDateString() === today.toDateString()) return t("api.history.today");
    if (when.toDateString() === yesterday.toDateString()) return t("api.history.yesterday");
    return when.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
  };

  /**
   * Re-opens an entry as a scratch tab. It deliberately does *not* re-point at the saved request
   * the send came from: the history row is a record of what was sent then, and reopening it must
   * not become a way to overwrite what that request says now.
   */
  const restore = async (entry: ApiHistoryEntry) => {
    // The list is loaded without snapshots — `apiListHistoryMeta` leaves them empty so that opening
    // the workspace doesn't parse every past send's request and response at once — so the blob for
    // *this* row is fetched on the click that needs it. A row that already carries one is a send
    // made this session, which `addHistory` puts on the front of the list with its snapshot intact;
    // reopening that costs no round-trip. A fetch that fails leaves `raw` empty, and the tab opens
    // as a blank scratch request rather than not opening at all.
    const raw = entry.snapshot || (await apiGetHistorySnapshot(entry.id).catch(() => null)) || "";
    const snapshot = parseSnapshot(raw);
    const state = useApiStore.getState();
    const tabId = state.openScratchTab(entry.protocol);
    if (snapshot) state.updateDraft(tabId, snapshot.request);
    state.renameTab(tabId, entry.name || entry.url);
    if (snapshot?.response) useApiRuntimeStore.getState().setResponse(tabId, snapshot.response);
  };

  const clearAll = async () => {
    if (!(await confirmAction(t("api.history.clearConfirm"), true, t("api.settings.clearHistory")))) return;
    await clearHistory();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1">
        <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("api.history")}
        </span>
        <button
          onClick={() => void clearAll()}
          disabled={history.length === 0}
          title={t("api.settings.clearHistory")}
          aria-label={t("api.settings.clearHistory")}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--cf-text-muted)] dark:hover:bg-white/[0.08]"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {history.length === 0 ? (
        <EmptyState icon={History} title={t("api.noHistory")} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto pb-1">
          {groups.map((group) => (
            <div key={group.key}>
              <div className="sticky top-0 z-10 bg-[var(--cf-surface)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {dayLabel(group.key, group.when)}
              </div>
              {group.items.map((entry, at) => (
                <div
                  key={entry.id}
                  onClick={() => void restore(entry)}
                  title={entry.name ? `${entry.name}\n${entry.url}` : entry.url}
                  style={riseDelay(at)}
                  className="cf-rise group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                >
                  <MethodBadge protocol={entry.protocol} method={entry.method} />
                  <span className="min-w-0 flex-1 truncate text-[var(--cf-text)]">{entry.url}</span>
                  <span
                    className="shrink-0 font-mono text-[10px] font-bold"
                    style={{ color: statusColor(entry.status) }}
                  >
                    {entry.status ?? "ERR"}
                  </span>
                  <span className="w-12 shrink-0 truncate text-right font-mono text-[10px] text-[var(--cf-text-muted)]">
                    {formatDuration(entry.duration_ms)}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteHistory(entry.id);
                    }}
                    title={t("api.delete")}
                    aria-label={t("api.delete")}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-danger)] group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
