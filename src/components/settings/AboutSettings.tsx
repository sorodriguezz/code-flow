import { useEffect, useState } from "react";
import { Bug, ClipboardCopy, FolderOpen, ScrollText } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ApiModal } from "../api/ApiModal";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Markdown } from "../common/Markdown";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { revealInFileManager } from "../../lib/tauri/commands";
import {
  appDiagnostics,
  diagnosticsReport,
  newIssueUrl,
  thirdPartyNotices,
  type AppDiagnostics,
} from "../../lib/diagnostics";

/**
 * Settings › General › About and diagnostics: what this build is, where its log lives, and the way to
 * report a problem.
 *
 * All three were in the macOS Help menu and nowhere else, so on Windows and Linux there was no way to
 * find the log folder, copy what a bug report needs, or even see the version without opening the
 * update notes. The explanations live in tooltips; the pane is its facts and its three buttons.
 */
export function AboutPane() {
  const t = useT();
  const [info, setInfo] = useState<AppDiagnostics | null>(null);
  const [copying, setCopying] = useState(false);
  // Read on demand, not with the pane: it is ~80 KB of text nobody needs until they ask for it.
  const [notices, setNotices] = useState<string | null>(null);

  useEffect(() => {
    void appDiagnostics()
      .then(setInfo)
      .catch(() => {});
  }, []);

  const system = info ? `${info.os} ${info.osVersion} (${info.arch})` : "…";

  const copy = async () => {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(await diagnosticsReport());
      pushSuccessToast(t("about.copied"));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setCopying(false);
    }
  };

  const report = () => {
    const body = t("about.issueBody", { version: info?.version ?? "?", system });
    void openUrl(newIssueUrl(body)).catch((e: unknown) => pushErrorToast(String(e)));
  };

  const rows: [string, string, string | null][] = [
    [t("about.version"), info?.version ?? "…", null],
    [t("about.system"), system, null],
    [t("about.data"), info?.stateDir ?? "…", info?.stateDir ?? null],
  ];

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
        {rows.map(([label, value, reveal]) => (
          <div
            key={label}
            className="flex min-h-10 items-center gap-2 border-b border-[var(--cf-border)] py-1.5 pl-3 pr-2 last:border-b-0"
          >
            <span className="w-[150px] shrink-0 text-[13px] text-[var(--cf-text-muted)]">{label}</span>
            <span className="min-w-0 flex-1 select-text truncate font-mono text-[12px]" title={value}>
              {value}
            </span>
            {reveal && (
              <Tooltip label={t("settings.dataReveal")}>
                <button
                  type="button"
                  onClick={() => void revealInFileManager(reveal).catch((e: unknown) => pushErrorToast(String(e)))}
                  aria-label={t("settings.dataReveal")}
                  className={iconButtonClass({ size: "sm" })}
                >
                  <FolderOpen size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!info}
          onClick={() => info && void revealInFileManager(info.logsDir).catch((e: unknown) => pushErrorToast(String(e)))}
          className={buttonClass({ variant: "secondary", size: "md" })}
        >
          <FolderOpen size={14} />
          {t("about.revealLogs")}
        </button>
        <Tooltip label={t("about.copyDiagnostics")} description={t("about.copyDiagnosticsHint")}>
          <button
            type="button"
            disabled={copying}
            onClick={() => void copy()}
            className={buttonClass({ variant: "secondary", size: "md" })}
          >
            <ClipboardCopy size={14} />
            {t("about.copyDiagnostics")}
          </button>
        </Tooltip>
        <Tooltip label={t("about.reportIssue")} description={t("about.reportIssueHint")}>
          <button type="button" onClick={report} className={buttonClass({ variant: "secondary", size: "md" })}>
            <Bug size={14} />
            {t("about.reportIssue")}
          </button>
        </Tooltip>
        <Tooltip label={t("about.thirdParty")} description={t("about.thirdPartyHint")}>
          <button
            type="button"
            onClick={() => void thirdPartyNotices().then(setNotices).catch((e: unknown) => pushErrorToast(String(e)))}
            className={buttonClass({ variant: "secondary", size: "md" })}
          >
            <ScrollText size={14} />
            {t("about.thirdParty")}
          </button>
        </Tooltip>
      </div>

      {notices !== null && (
        <ApiModal
          icon={ScrollText}
          title={t("about.thirdParty")}
          width="max-w-3xl"
          height="h-[80vh]"
          // Opened from inside Settings, itself a `z-50` overlay — without this the dialog lands
          // underneath it and all the user sees is the screen going darker.
          raised
          onClose={() => setNotices(null)}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <Markdown source={notices} className="cf-markdown-preview select-text text-[13px]" />
          </div>
        </ApiModal>
      )}
    </>
  );
}
