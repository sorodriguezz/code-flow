import { useEffect, useState } from "react";
import { Check, Download, Loader2, Trash2, X } from "lucide-react";
import { reviewerDiskUsed, type ReviewerComponent, type ReviewerInstallProgress } from "../../lib/tauri/reviewerCommands";
import { chooseAction } from "../../state/confirmStore";
import { useT, type Translate } from "../../state/languageStore";
import { useReviewerStore } from "../../state/reviewerStore";
import { pushErrorToast } from "../../state/toastStore";
import { Actions, Note, Status } from "../api/settingsChrome";
import { Button, buttonClass } from "../common/Button";
import { formatBytes } from "./localModelRow";

const COMPONENT_LABEL: Record<ReviewerComponent["id"], "reviewer.componentJdk" | "reviewer.componentSonarqube" | "reviewer.componentScanner"> = {
  jdk: "reviewer.componentJdk",
  sonarqube: "reviewer.componentSonarqube",
  scanner: "reviewer.componentScanner",
};

function progressLabel(t: Translate, progress: ReviewerInstallProgress | undefined): string | null {
  if (!progress) return null;
  if (progress.phase === "extracting") return t("reviewer.extracting");
  if (progress.phase === "downloading") {
    return progress.total > 0
      ? `${formatBytes(progress.done)} / ${formatBytes(progress.total)}`
      : formatBytes(progress.done);
  }
  return null;
}

export function SonarInstallation({ highlighted }: { highlighted: boolean }) {
  const t = useT();
  const status = useReviewerStore((s) => s.status);
  const serverState = useReviewerStore((s) => s.server.state);
  const refresh = useReviewerStore((s) => s.refresh);
  const installing = useReviewerStore((s) => s.installing);
  const progress = useReviewerStore((s) => s.installProgress);
  const installError = useReviewerStore((s) => s.installError);
  const install = useReviewerStore((s) => s.install);
  const cancelInstall = useReviewerStore((s) => s.cancelInstall);
  const uninstall = useReviewerStore((s) => s.uninstall);
  const [disk, setDisk] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  const ready = status?.install.ready ?? false;

  const check = () => {
    setLoadError(false);
    void refresh().catch(() => setLoadError(true));
  };

  useEffect(() => {
    void refresh().catch(() => setLoadError(true));
  }, [refresh]);

  useEffect(() => {
    if (ready) void reviewerDiskUsed().then(setDisk).catch(() => setDisk(null));
  }, [ready, serverState]);

  const remove = async () => {
    const choice = await chooseAction({
      message: t("reviewer.removeConfirm"),
      danger: true,
      choices: [
        { id: "keep", label: t("reviewer.removeKeepData"), variant: "secondary" },
        { id: "all", label: t("reviewer.removeAll"), variant: "danger" },
      ],
    });
    if (!choice) return;
    await uninstall(choice === "all").catch((e: unknown) => pushErrorToast(String(e)));
  };

  return (
    <div
      id="cf-installation-sonarqube"
      className={`scroll-m-3 space-y-2 rounded-lg border bg-[var(--cf-surface)] px-3 py-2.5 ${highlighted ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)]"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="text-[13px] font-medium text-[var(--cf-text)]">SonarQube</h5>
        {status && !installing && <Status tone={ready ? "success" : "warning"}>{t(ready ? "toolSetup.installed" : "toolSetup.missing")}</Status>}
      </div>
      {!status ? (
        loadError ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-[12px] text-[var(--cf-danger)]">{t("installations.loadError")}</p>
            <Button size="sm" onClick={check}>{t("installations.refresh")}</Button>
          </div>
        ) : (
          <p role="status" className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
            <Loader2 size={13} className="animate-spin" />
            {t("toolSetup.checking")}
          </p>
        )
      ) : (
        <>
          <ul className="mb-2.5 flex flex-col gap-1.5">
            {status.install.components.map((component) => {
              const current = progress[component.id];
              const label = progressLabel(t, installing ? current : undefined);
              const fraction = current && current.total > 0 ? Math.min(1, current.done / current.total) : 0;
              return (
                <li key={component.id} className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] items-center gap-2.5 text-[13px]">
                  <span className="break-words text-[var(--cf-text)]">
                    {t(COMPONENT_LABEL[component.id], { n: status.javaRelease })}
                  </span>
                  <span className="break-words text-[11px] tabular-nums text-[var(--cf-text-muted)]">{component.version}</span>
                  {component.installed || current?.phase === "done" ? (
                    <span className="flex items-center gap-1 text-[11px] text-[var(--cf-success)]">
                      <Check size={11} />
                      {t("reviewer.installed")}
                    </span>
                  ) : installing && current ? (
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-[var(--cf-hover)]">
                        <span
                          className="block h-full rounded-full bg-[var(--cf-accent-fill)] transition-[width] duration-200"
                          style={{ width: `${current.phase === "extracting" ? 100 : Math.round(fraction * 100)}%` }}
                        />
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">{label}</span>
                    </span>
                  ) : (
                    <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">{formatBytes(component.size)}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <Actions>
            {!ready && !installing && (
              <button type="button" onClick={() => void install()} className={buttonClass({ variant: "primary", size: "sm" })}>
                <Download size={12} />
                {t("reviewer.download", { size: formatBytes(status.install.pendingBytes) })}
              </button>
            )}
            {installing && (
              <button type="button" onClick={() => void cancelInstall()} className={buttonClass({ variant: "secondary", size: "sm" })}>
                <X size={12} />
                {t("common.cancel")}
              </button>
            )}
            {ready && !installing && (
              <button type="button" onClick={() => void remove()} className={buttonClass({ variant: "danger-ghost", size: "sm" })}>
                <Trash2 size={12} />
                {t("reviewer.remove")}
              </button>
            )}
          </Actions>
          {installError && <Note tone="warning">{installError}</Note>}
          <p className="mt-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("reviewer.license")}</p>
          {ready && disk !== null && (
            <p className="break-all text-[11px] text-[var(--cf-text-muted)]">
              {t("reviewer.diskUsed", { size: formatBytes(disk), path: status.install.root })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
