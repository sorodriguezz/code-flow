import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, LoaderCircle, Network, RefreshCw, Search, Square, X } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Tooltip } from "../common/Tooltip";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { useServicesStore } from "../../state/servicesStore";
import { pushErrorToast } from "../../state/toastStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import { freePort, listeningPorts } from "../../lib/tauri/services";
import type { ListeningPort } from "../../types/services";
import { fieldClass } from "../common/recipes";

/** How often the table re-reads the machine while it is on screen. */
const REFRESH_MS = 3000;

/**
 * Every TCP port something on this machine is listening on, and who.
 *
 * The other half of "which ports do my services use": the half where a port is taken and nobody
 * remembers by what. A row that belongs to a service says so and stops it the way its own button
 * would — the whole tree, gracefully. Any other row can be freed by ending the process holding it,
 * which is the answer to "address already in use" when the culprit is an orphan from a crash.
 */
export function PortsPanel({ onOpenService }: { onOpenService: (id: string) => void }) {
  const t = useT();
  const stopService = useServicesStore((s) => s.stop);
  const [rows, setRows] = useState<ListeningPort[] | null>(null);
  const [query, setQuery] = useState("");
  const [onlyServices, setOnlyServices] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setRows(await listeningPorts());
    } catch (err) {
      pushErrorToast(String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (rows ?? []).filter((row) => {
      if (onlyServices && !row.serviceId) return false;
      if (!needle) return true;
      return (
        String(row.port).includes(needle) ||
        row.process.toLowerCase().includes(needle) ||
        (row.serviceName ?? "").toLowerCase().includes(needle) ||
        String(row.pid) === needle
      );
    });
  }, [rows, query, onlyServices]);

  const free = async (row: ListeningPort) => {
    if (row.serviceId) {
      setBusy(row.pid);
      await stopService(row.serviceId);
      setBusy(null);
      void refresh();
      return;
    }
    const ok = await confirmAction(
      t("services.ports.freeConfirm", { port: row.port, process: row.process || `pid ${row.pid}` }),
      true,
      t("services.ports.free"),
    );
    if (!ok) return;
    setBusy(row.pid);
    try {
      await freePort(row.pid);
    } catch (err) {
      pushErrorToast(String(err));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        <Network size={13} className="shrink-0 text-[var(--cf-accent)]" />
        <span className="text-[13px] font-semibold text-[var(--cf-text)]">{t("services.ports.title")}</span>
        {rows && <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">{shown.length}</span>}
        <div className="flex-1" />
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
          <Checkbox checked={onlyServices} onChange={setOnlyServices} />
          {t("services.ports.onlyServices")}
        </label>
        <div className="relative w-48">
          <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("services.ports.filter")}
            className={fieldClass({ size: "sm", className: "w-full pl-6 pr-6" })}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label={t("common.clear")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <Tooltip label={t("services.ports.refresh")}>
          <button
            onClick={() => void refresh()}
            aria-label={t("services.ports.refresh")}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          >
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
          </button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows === null ? (
          <div className="flex h-full items-center justify-center text-[var(--cf-text-muted)]">
            <LoaderCircle size={16} className="animate-spin" />
          </div>
        ) : shown.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-[12px] text-[var(--cf-text-muted)]">
            {rows.length === 0 ? t("services.ports.none") : t("services.ports.noMatch")}
          </div>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-[var(--cf-surface)]">
              <tr className="text-left text-[10.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">
                <th className="border-b border-[var(--cf-border)] px-3 py-1.5 font-medium">{t("services.ports.port")}</th>
                <th className="border-b border-[var(--cf-border)] px-3 py-1.5 font-medium">{t("services.ports.address")}</th>
                <th className="border-b border-[var(--cf-border)] px-3 py-1.5 font-medium">{t("services.ports.process")}</th>
                <th className="border-b border-[var(--cf-border)] px-3 py-1.5 font-medium">PID</th>
                <th className="border-b border-[var(--cf-border)] px-3 py-1.5 font-medium">{t("services.ports.service")}</th>
                <th className="w-px border-b border-[var(--cf-border)] px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr
                  key={`${row.port}:${row.pid}`}
                  className="group/port hover:bg-[var(--cf-hover)]"
                >
                  <td className="border-b border-[var(--cf-border)] px-3 py-1 font-mono tabular-nums">
                    <button
                      onClick={() => void openExternalUrl(`http://localhost:${row.port}`)}
                      className="text-[var(--cf-accent)] hover:underline"
                      title={`http://localhost:${row.port}`}
                    >
                      :{row.port}
                    </button>
                  </td>
                  <td className="border-b border-[var(--cf-border)] px-3 py-1 font-mono text-[11px] text-[var(--cf-text-muted)]">
                    {row.address === "*" ? t("services.ports.allInterfaces") : row.address}
                  </td>
                  <td className="max-w-[180px] truncate border-b border-[var(--cf-border)] px-3 py-1 text-[var(--cf-text)]" title={row.process}>
                    {row.process || "—"}
                  </td>
                  <td className="border-b border-[var(--cf-border)] px-3 py-1 font-mono text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                    {row.pid}
                  </td>
                  <td className="border-b border-[var(--cf-border)] px-3 py-1">
                    {row.serviceId ? (
                      <button
                        onClick={() => onOpenService(row.serviceId!)}
                        className="rounded-full bg-[var(--cf-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--cf-accent)] hover:underline"
                      >
                        {row.serviceName}
                      </button>
                    ) : (
                      <span className="text-[var(--cf-text-muted)]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap border-b border-[var(--cf-border)] px-2 py-1 text-right">
                    <div className="flex items-center justify-end gap-0.5 opacity-60 group-hover/port:opacity-100">
                      <Tooltip label={t("services.ports.open")}>
                        <button
                          onClick={() => void openExternalUrl(`http://localhost:${row.port}`)}
                          aria-label={t("services.ports.open")}
                          className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                        >
                          <ExternalLink size={11} />
                        </button>
                      </Tooltip>
                      <Tooltip label={row.serviceId ? t("services.ports.stopService") : t("services.ports.free")}>
                        <button
                          onClick={() => void free(row)}
                          disabled={busy === row.pid}
                          aria-label={row.serviceId ? t("services.ports.stopService") : t("services.ports.free")}
                          className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] disabled:opacity-40"
                        >
                          {busy === row.pid ? <LoaderCircle size={11} className="animate-spin" /> : <Square size={10} />}
                        </button>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
