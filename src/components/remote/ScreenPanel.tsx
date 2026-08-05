import { AlertTriangle, ExternalLink, Loader2, Monitor, RefreshCw, ShieldCheck } from "lucide-react";
import { Pill } from "./remoteChrome";
import { useRemoteStore, type RemoteScreenTab } from "../../state/remoteStore";
import { useT } from "../../state/languageStore";

/**
 * A launched screen.
 *
 * **What this tab is, precisely.** The pixels are in the platform's own viewer — a separate window
 * this app does not draw into (see `remotes::screen` for why that is a decision and not a
 * shortcut). What the tab owns is the SSH tunnel underneath it, which is why closing the tab closes
 * that tunnel and why the panel spells out both addresses: the user asked for `10.0.0.7:5900` and
 * the viewer opened on `127.0.0.1:49213`, and a panel that showed only the second would read as
 * having connected to the wrong machine.
 *
 * It is also where an embedded canvas would go when there is one. Nothing above this component
 * would change: the tab, the tunnel and the host all already exist.
 */
export function ScreenPanel({ tab }: { tab: RemoteScreenTab }) {
  const openScreen = useRemoteStore((s) => s.openScreen);
  const t = useT();

  if (tab.opening) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--cf-text-muted)]">
        <Loader2 size={20} className="animate-spin" />
        <p className="text-[12px]">{t("remote.screenOpening")}</p>
      </div>
    );
  }

  if (tab.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle size={24} className="text-[var(--cf-danger)]" />
        <p className="text-sm font-medium text-[var(--cf-text)]">{t("remote.screenFailed")}</p>
        <p className="max-w-md whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
          {tab.error}
        </p>
        <button
          type="button"
          onClick={() => void openScreen(tab.hostId)}
          className="mt-1 flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        >
          <RefreshCw size={13} />
          {t("remote.retry")}
        </button>
      </div>
    );
  }

  const launch = tab.launch;
  if (!launch) return null;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <Monitor size={28} className="text-[var(--cf-text-muted)]" />
      <div className="space-y-1">
        <p className="flex items-center justify-center gap-2 text-sm font-medium text-[var(--cf-text)]">
          {t("remote.screenOpen", { name: tab.name })}
          <Pill tone="accent">{launch.protocol.toUpperCase()}</Pill>
        </p>
        <p className="text-[12px] text-[var(--cf-text-muted)]">{t("remote.screenInViewer")}</p>
      </div>

      <div className="w-full max-w-md space-y-1.5 rounded-md border border-[var(--cf-border)] p-3 text-left">
        <Detail label={t("remote.screenTarget")} value={`${launch.target_host}:${launch.target_port}`} />
        {launch.tunnelled && (
          <>
            <Detail label={t("remote.screenViaTunnel")} value={`${launch.host}:${launch.port}`} />
            <p className="flex items-start gap-1.5 pt-1 text-[11px] leading-relaxed text-[var(--cf-success)]">
              <ShieldCheck size={12} className="mt-0.5 shrink-0" />
              {t("remote.screenTunnelledNote")}
            </p>
          </>
        )}
        <Detail label={t("remote.screenViewerCommand")} value={launch.viewer} />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void openScreen(tab.hostId)}
          className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
        >
          <ExternalLink size={13} />
          {t("remote.screenReopen")}
        </button>
      </div>

      <p className="max-w-md text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
        {t("remote.screenCloseHint")}
      </p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-2">
      <span className="text-[11px] text-[var(--cf-text-muted)]">{label}</span>
      <span className="break-all font-mono text-[11px] text-[var(--cf-text)]">{value}</span>
    </div>
  );
}
