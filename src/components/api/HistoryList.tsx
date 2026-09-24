import { useMemo } from "react";
import { History, Trash2, X } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { Tooltip } from "../common/Tooltip";
import { rowClass, sectionLabelClass } from "../common/recipes";
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
    // *this* row is fetched on the click that needs it. A row that already carries one is one of the
    // last three sends of this session: `addHistory` keeps the snapshot on those and strips it from
    // everything behind them, so reopening what you just sent costs no round-trip while a session's
    // worth of history does not accumulate megabytes of response text nothing draws. A fetch that
    // fails leaves `raw` empty, and the tab opens as a blank scratch request rather than not opening
    // at all.
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
      <div className={`${sectionLabelClass} shrink-0 pl-3.5 pr-2 pt-1`}>
        <span className="min-w-0 flex-1 truncate">{t("api.history")}</span>
        <Tooltip label={t("api.settings.clearHistory")}>
          <button
            type="button"
            onClick={() => void clearAll()}
            disabled={history.length === 0}
            aria-label={t("api.settings.clearHistory")}
            // `iconButtonClass` with a danger hover, spelled out: its own hover ink would win a tie.
            className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] hover:text-[var(--cf-danger)] disabled:pointer-events-none disabled:opacity-40"
          >
            <Trash2 size={15} />
          </button>
        </Tooltip>
      </div>

      {history.length === 0 ? (
        <EmptyState icon={History} title={t("api.noHistory")} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2.5">
          {groups.map((group) => (
            <div key={group.key}>
              {/* Sticky, so it has to be opaque — in the explorer's own tone, not the sheet's. */}
              <div className={`${sectionLabelClass} sticky top-0 z-10 bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))]`}>
                {dayLabel(group.key, group.when)}
              </div>
              {group.items.map((entry, at) => (
                <div
                  key={entry.id}
                  onClick={() => void restore(entry)}
                  title={entry.name ? `${entry.name}\n${entry.url}` : entry.url}
                  style={riseDelay(at)}
                  className={rowClass(false, "cf-rise group h-[30px] cursor-pointer pr-1")}
                >
                  <MethodBadge protocol={entry.protocol} method={entry.method} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--cf-text)]">
                    {entry.url}
                  </span>
                  {/* The code is the word; the tint only helps it be found down the column. */}
                  <span
                    className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 font-mono text-[11px] font-semibold tabular-nums"
                    style={{
                      color: statusColor(entry.status),
                      backgroundColor: `color-mix(in oklab, ${statusColor(entry.status)} 14%, transparent)`,
                    }}
                  >
                    {entry.status ?? "ERR"}
                  </span>
                  <span className="w-12 shrink-0 truncate text-right font-mono text-[11px] tabular-nums text-[var(--cf-text-faint)]">
                    {formatDuration(entry.duration_ms)}
                  </span>
                  <Tooltip label={t("api.delete")}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteHistory(entry.id);
                      }}
                      aria-label={t("api.delete")}
                      className="hidden h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] group-hover:inline-flex"
                    >
                      <X size={13} />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
