import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Download, ExternalLink, Loader2 } from "lucide-react";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { useToolSetupStore } from "../../state/toolSetupStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ToolInstallOutcome, ToolStatus } from "../../types/domain";
import { buttonClass } from "./Button";
import { Checkbox } from "./Checkbox";
import { chipClass } from "./recipes";

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

/**
 * One tool — `git` or an AI CLI — with the command that installs it and a one-click «Instalar».
 *
 * The same row in the first-launch setup (with a checkbox: pick, then install the lot) and in
 * Settings (a button of its own). Shows the command before it runs, because "install" is a promise
 * and the line is what keeps it: the person can see it is the vendor's own installer.
 */
export function ToolInstallRow({
  tool,
  selected,
  onSelect,
  compact = false,
}: {
  tool: ToolStatus;
  /** With these two, a checkbox replaces the button — the setup's "pick, then install". */
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  /** Settings: no name and no installed-state chip — the row it sits in already says both. */
  compact?: boolean;
}) {
  const t = useT();
  const installing = useToolSetupStore((s) => s.installing);
  const lastLine = useToolSetupStore((s) => s.lastLine[tool.id]);
  const result = useToolSetupStore((s) => s.results[tool.id]);
  const install = useToolSetupStore((s) => s.install);
  const [details, setDetails] = useState(false);
  const running = installing === tool.id;
  const selectable = onSelect !== undefined;
  const canInstall = !tool.installed && !!tool.command && !tool.missingPrerequisite;

  useEffect(() => {
    if (running) setDetails(false);
  }, [running]);

  return (
    <div className={compact ? "space-y-1.5" : "space-y-1.5 rounded-lg border border-[var(--cf-border)] p-3"}>
      {!compact && (
        <div className="flex items-center gap-2">
          {selectable && (
            <Checkbox checked={!!selected && canInstall} disabled={!canInstall || !!installing} onChange={(value) => onSelect(value)} />
          )}
          <span className="min-w-0 flex-1 text-[13px] font-medium text-[var(--cf-text)]">{tool.label}</span>
          {running ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-[var(--cf-text-muted)]" />
          ) : tool.installed ? (
            <span className={chipClass("ok")}>
              <CircleCheck size={11} />
              {t("toolSetup.installed")}
            </span>
          ) : (
            <span className={chipClass("warn")}>
              <CircleAlert size={11} />
              {t("toolSetup.missing")}
            </span>
          )}
        </div>
      )}

      {tool.installed && !compact && tool.detail && (
        <p className="select-text truncate font-mono text-[11px] text-[var(--cf-text-muted)]">{tool.detail}</p>
      )}

      {!tool.installed && (
        <>
          {tool.command ? (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 select-text break-all rounded-md bg-[var(--cf-hover)] px-2 py-1.5 font-mono text-[11px] text-[var(--cf-text-muted)]">
                {tool.command}
              </code>
              {!selectable && (
                <button
                  type="button"
                  disabled={!canInstall || !!installing}
                  onClick={() => void install(tool.id)}
                  className={buttonClass({ variant: "primary", size: "sm" })}
                >
                  {running ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  {t(running ? "toolSetup.installing" : "toolSetup.install")}
                </button>
              )}
            </div>
          ) : (
            <p className="text-[12px] text-[var(--cf-text-muted)]">{t("toolSetup.noCommand")}</p>
          )}
          {tool.missingPrerequisite && (
            <p className="text-[11px] text-[var(--cf-warning)]">{t("toolSetup.needs", { program: tool.missingPrerequisite })}</p>
          )}
          {running && lastLine && <p className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">{lastLine}</p>}
          {!running && result && (
            <div className="space-y-1">
              <p className={`text-[12px] ${result.outcome === "done" ? "text-[var(--cf-success)]" : result.outcome === "failed" ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}`}>
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
          {/* Settings' provider row already links its docs. */}
          {tool.url && !compact && (
            <button
              type="button"
              onClick={() => void openExternalUrl(tool.url)}
              className="flex items-center gap-1 text-[12px] text-[var(--cf-accent)] hover:underline"
            >
              <ExternalLink size={12} />
              {t("toolSetup.page")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The row for one tool id, loading the list the first time it is needed. */
export function ToolInstallFor({ id, compact = false }: { id: string; compact?: boolean }) {
  const tools = useToolSetupStore((s) => s.tools);
  const loading = useToolSetupStore((s) => s.loading);
  const load = useToolSetupStore((s) => s.load);
  useEffect(() => {
    if (!tools && !loading) void load();
  }, [tools, loading, load]);
  const tool = tools?.find((entry) => entry.id === id);
  if (!tool) return loading ? <Loader2 size={13} className="animate-spin text-[var(--cf-text-muted)]" /> : null;
  return <ToolInstallRow tool={tool} compact={compact} />;
}
