import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Monitor,
  RefreshCw,
  Terminal,
  Trash2,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { useRemoteStore } from "../../state/remoteStore";
import { remoteClearLogs, remoteListLogs } from "../../lib/tauri/remoteCommands";
import { pushErrorToast } from "../../state/toastStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { RemoteLogEntry } from "../../types/remote";

/** How many rows to load. Well under the backend's hard cap — this is a list to scan for what just
 *  failed, not an archive to browse. */
const LIMIT = 300;

/**
 * What was opened against which host, and whether it worked.
 *
 * **Why this is worth a tab.** Everything else in this workspace shows the present: which sessions
 * are live, which ports are listening. The question this answers is the other one — *"it worked an
 * hour ago, what changed"* — and it is the only place a failure survives being dismissed. A toast
 * that has faded is gone; the row that produced it is here.
 *
 * Failures are what the list is for, so they carry their message inline rather than behind a hover.
 * A successful row is one line, because the interesting thing about it is only that it happened.
 */
export function LogPanel() {
  const workspaceId = useRemoteStore((s) => s.workspaceId);
  const t = useT();

  const [entries, setEntries] = useState<RemoteLogEntry[] | null>(null);
  const [failuresOnly, setFailuresOnly] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setEntries(await remoteListLogs(workspaceId, LIMIT));
    } catch (error) {
      pushErrorToast(String(error));
      setEntries([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = (entries ?? []).filter((entry) => !failuresOnly || entry.error);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
        <span className="text-[12px] font-medium text-[var(--cf-text)]">{t("remote.log")}</span>
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
          <input
            type="checkbox"
            checked={failuresOnly}
            onChange={(e) => setFailuresOnly(e.target.checked)}
            className="h-3 w-3 accent-[var(--cf-accent)]"
          />
          {t("remote.logFailuresOnly")}
        </label>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void load()}
            title={t("remote.refresh")}
            aria-label={t("remote.refresh")}
            className="rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <RefreshCw size={12} />
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!workspaceId || !(await confirmAction(t("remote.logClearConfirm")))) return;
              await remoteClearLogs(workspaceId).catch((error) => pushErrorToast(String(error)));
              void load();
            }}
            title={t("remote.logClear")}
            aria-label={t("remote.logClear")}
            className="rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title={failuresOnly ? t("remote.logNoFailures") : t("remote.logEmpty")}
            subtitle={failuresOnly ? undefined : t("remote.logEmptyHint")}
          />
        ) : (
          visible.map((entry) => {
            const Icon = KIND_ICON[entry.kind] ?? Terminal;
            return (
              <div
                key={entry.id}
                className="flex items-start gap-2 border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0"
              >
                <span
                  className={`mt-[3px] shrink-0 ${
                    entry.error ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"
                  }`}
                >
                  {entry.error ? <AlertTriangle size={12} /> : <Icon size={12} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 text-[12px] text-[var(--cf-text)]">
                      {entry.host_name}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                      {entry.detail}
                    </span>
                    <span className="shrink-0 tabular-nums text-[10px] text-[var(--cf-text-muted)]">
                      {formatWhen(entry.at)}
                    </span>
                  </span>
                  {entry.error && (
                    <span className="mt-0.5 block whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--cf-danger)]">
                      {entry.error}
                    </span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const KIND_ICON: Record<string, LucideIcon> = {
  session: Terminal,
  forward: Waypoints,
  screen: Monitor,
  files: FolderOpen,
};

/**
 * A timestamp, as something readable at a glance.
 *
 * Time alone for today, date and time for anything older: "what failed twenty minutes ago" is the
 * question this list answers most often, and a full date on every row buries the part that varies.
 */
function formatWhen(at: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return at;
  const today = new Date().toDateString() === when.toDateString();
  return today
    ? when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
