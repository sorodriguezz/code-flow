import { useEffect, useState } from "react";
import { Frame, RefreshCw } from "lucide-react";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { fieldClass, rowClass } from "../common/recipes";
import { listeningPorts } from "../../lib/tauri/services";
import { useDesignStore } from "../../state/designStore";
import { useT } from "../../state/languageStore";
import type { ListeningPort } from "../../types/services";

/**
 * Where design mode should open: one of the servers actually listening on this machine, or an
 * address typed by hand.
 *
 * # Why a list and not a text field
 *
 * The port is the one thing the app cannot know and the user should not have to remember. The
 * machine does know — `services_listening_ports` is the same read the Ports panel draws — so the
 * dialog offers what is up, named by the process behind it, and keeps the field for everything else
 * (a remote staging URL, a port that is about to exist).
 *
 * Read once, when the dialog opens, and again only if asked: a port list is a process-table scan,
 * and nothing here is worth repeating on a timer.
 */
export function DesignOpenModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const lastUrl = useDesignStore((s) => s.lastUrl);
  const [url, setUrl] = useState(lastUrl || "http://localhost:1420");
  const [ports, setPorts] = useState<ListeningPort[] | null>(null);

  const read = () => {
    setPorts(null);
    void listeningPorts()
      .then((rows) => {
        // Loopback only: design mode opens a page *this machine* is serving, and a port bound to a
        // LAN address belongs to something else. Lowest first, so the dev server a person started
        // sits above whatever the OS is holding high in the range.
        const local = rows
          .filter((row) => row.address === "127.0.0.1" || row.address === "0.0.0.0" || row.address === "::1" || row.address === "::")
          .sort((a, b) => a.port - b.port);
        setPorts(local);
      })
      .catch(() => setPorts([]));
  };

  useEffect(read, []);

  const open = (target: string) => {
    const trimmed = target.trim();
    if (!/^https?:\/\/\S+$/.test(trimmed)) return;
    void useDesignStore.getState().show(trimmed);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[70vh] w-full max-w-[460px] flex-col rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2">
          <Frame size={15} className="shrink-0 text-[var(--cf-accent)]" />
          <p className="min-w-0 flex-1 text-[13px] font-semibold text-[var(--cf-text)]">{t("design.urlPrompt")}</p>
          <Tooltip label={t("design.portsRefresh")}>
            <button type="button" aria-label={t("design.portsRefresh")} onClick={read} className={iconButtonClass({ size: "sm" })}>
              <RefreshCw size={13} className={ports === null ? "animate-spin" : ""} />
            </button>
          </Tooltip>
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {ports !== null && ports.length === 0 && (
            <p className="px-1 py-2 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{t("design.portsNone")}</p>
          )}
          {(ports ?? []).map((row) => (
            <button
              key={`${row.address}:${row.port}`}
              type="button"
              onClick={() => open(`http://localhost:${row.port}`)}
              className={rowClass(false, "py-1.5")}
            >
              <span className="shrink-0 font-mono text-[12.5px] tabular-nums text-[var(--cf-text)]">{row.port}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text-muted)]">
                {row.serviceName || row.process}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2 border-t border-[var(--cf-border)] pt-3">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) open(url);
              if (event.key === "Escape") onClose();
            }}
            placeholder="http://localhost:1420"
            aria-label={t("design.urlPrompt")}
            className={fieldClass({ className: "min-w-0 flex-1" })}
          />
          <button type="button" onClick={() => open(url)} className={buttonClass({ variant: "primary" })}>
            {t("design.openAction")}
          </button>
        </div>
      </div>
    </div>
  );
}
