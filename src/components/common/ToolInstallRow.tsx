import { useState } from "react";
import { CircleAlert, CircleCheck, Download, ExternalLink, Loader2 } from "lucide-react";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { useToolSetupStore } from "../../state/toolSetupStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ToolInstallOutcome, ToolStatus } from "../../types/domain";
import { Button } from "./Button";
import { chipClass } from "./recipes";
import { openToolInstallations } from "./ToolInstallationLink";

const OUTCOME_TEXT: Record<ToolInstallOutcome, TranslationKey> = {
  done: "toolSetup.outcome.done",
  busy: "toolSetup.outcome.busy",
  failed: "toolSetup.outcome.failed",
  not_detected: "toolSetup.outcome.notDetected",
  handed_off: "toolSetup.outcome.handedOff",
};

const FAILURE_TEXT: Record<string, TranslationKey> = {
  permission: "cliUpdates.failure.permission",
  network: "cliUpdates.failure.network",
  timeout: "cliUpdates.failure.timeout",
  storage: "cliUpdates.failure.storage",
};

export function ToolInstallRow({ tool, highlighted }: { tool: ToolStatus; highlighted: boolean }) {
  const t = useT();
  const installing = useToolSetupStore((s) => s.installing);
  const lastLine = useToolSetupStore((s) => s.lastLine[tool.id]);
  const result = useToolSetupStore((s) => s.results[tool.id]);
  const install = useToolSetupStore((s) => s.install);
  const prerequisite = tool.missingPrerequisite;
  const prerequisiteId = prerequisite === "npm" ? "node" : prerequisite;
  const canOpenPrerequisite = useToolSetupStore((s) => s.tools?.some((entry) => entry.id === prerequisiteId));
  const [details, setDetails] = useState(false);
  const running = installing === tool.id;

  return (
    <div
      id={`cf-installation-${tool.id}`}
      className={`scroll-m-3 space-y-2 rounded-lg border bg-[var(--cf-surface)] px-3 py-2.5 ${highlighted ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)]"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h5 className="text-[13px] font-medium text-[var(--cf-text)]">{tool.label}</h5>
          {running ? (
            <span className={chipClass("neutral")}><Loader2 size={11} className="animate-spin" />{t("toolSetup.installing")}</span>
          ) : tool.installed ? (
            <span className={chipClass("ok")}><CircleCheck size={11} />{t("toolSetup.installed")}</span>
          ) : (
            <span className={chipClass("warn")}><CircleAlert size={11} />{t("toolSetup.missing")}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {tool.url && (
            <Button size="sm" variant="ghost" onClick={() => void openExternalUrl(tool.url)}>
              <ExternalLink size={12} />{t("toolSetup.page")}
            </Button>
          )}
          {!tool.installed && tool.command && (
            <Button
              size="sm"
              variant="primary"
              disabled={!!prerequisite || !!installing}
              onClick={() => {
                setDetails(false);
                void install(tool.id);
              }}
            >
              <Download size={12} />{t("toolSetup.install")}
            </Button>
          )}
        </div>
      </div>
      {tool.installed && tool.detail && (
        <p className="select-text break-all font-mono text-[11px] text-[var(--cf-text-muted)]">{tool.detail}</p>
      )}
      {!tool.installed && (tool.command ? (
        <code className="block select-text break-all rounded-md bg-[var(--cf-sunken)] px-2 py-1.5 font-mono text-[11px] text-[var(--cf-text-muted)]">
          {tool.command}
        </code>
      ) : (
        <p className="text-[12px] text-[var(--cf-text-muted)]">{t("toolSetup.noCommand")}</p>
      ))}
      {!tool.installed && prerequisite && (
        <p className="flex flex-wrap gap-x-2 text-[11px] text-[var(--cf-warning)]">
          {t("toolSetup.needs", { program: prerequisite })}
          {prerequisiteId && canOpenPrerequisite && (
            <button type="button" onClick={() => openToolInstallations(prerequisiteId)} className="text-[var(--cf-accent)] hover:underline">
              {t("installations.prerequisite")}
            </button>
          )}
        </p>
      )}
      {running && lastLine && <p className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">{lastLine}</p>}
      {!running && tool.installed && result?.outcome === "done" && (
        <p role="status" className="text-[11px] text-[var(--cf-text-muted)]">{t("installations.afterInstall")}</p>
      )}
      {!running && !tool.installed && result && (
        <div className="space-y-1">
          <p role="status" className={`text-[12px] ${result.outcome === "failed" ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}`}>
            {t(OUTCOME_TEXT[result.outcome])}
            {result.outcome === "failed" && ` ${t(FAILURE_TEXT[result.errorKind ?? ""] ?? "cliUpdates.failure.unknown")}`}
          </p>
          {result.details && (
            <button type="button" onClick={() => setDetails((open) => !open)} className="text-[11px] text-[var(--cf-accent)] hover:underline">
              {t(details ? "toolSetup.hideDetails" : "toolSetup.showDetails")}
            </button>
          )}
          {details && (
            <pre className="max-h-40 select-text overflow-auto whitespace-pre-wrap rounded-md bg-[var(--cf-hover)] p-2 font-mono text-[10.5px] text-[var(--cf-text-muted)]">
              {result.details}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
