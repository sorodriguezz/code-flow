import type { ReactNode } from "react";
import { Check, CircleX, Loader2, TriangleAlert } from "lucide-react";
import { useT } from "../../state/languageStore";
import { TerminalPane } from "../terminal/TerminalPane";
import { chipClass } from "../common/recipes";

export type RunStatus = "preparing" | "running" | "ok" | "failed";

/**
 * A command running, in the dialog's own terminal — an install or the project being generated.
 *
 * The pane is a real pty: a generator that asks something no flag anticipated asks it here, and the
 * answer is typed here. `stage` is what is happening before there is a terminal at all (start.spring.io
 * being downloaded, boilerplate written).
 */
export function RunView({
  icon,
  title,
  sessionId,
  status,
  code,
  stage,
  error,
  commitProblem,
  footer,
}: {
  icon: ReactNode;
  title: string;
  sessionId: string | null;
  status: RunStatus;
  code: number | null;
  stage: string | null;
  error: string | null;
  commitProblem?: string | null;
  footer: ReactNode;
}) {
  const t = useT();
  const chip =
    status === "ok" && commitProblem ? (
      <span className={chipClass("warn")} role="status">
        <TriangleAlert size={11} />
        {t("scaffold.run.commitPending")}
      </span>
    ) : status === "ok" ? (
      <span className={chipClass("ok")}>
        <Check size={11} />
        {t("scaffold.run.ok")}
      </span>
    ) : status === "failed" ? (
      <span className={chipClass("bad")}>
        <CircleX size={11} />
        {code !== null ? t("scaffold.run.failedCode", { code }) : t("scaffold.run.failed")}
      </span>
    ) : (
      <span className={chipClass("neutral")}>
        <Loader2 size={11} className="animate-spin" />
        {stage ?? t("scaffold.run.running")}
      </span>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-[var(--cf-border)] px-4">
        {icon}
        <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--cf-text)]">{title}</h3>
        {chip}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-sunken)]">
          {sessionId ? (
            <TerminalPane sessionId={sessionId} visible quietExit autoFocus />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
              {error ? (
                <span className="max-w-[80%] whitespace-pre-wrap text-center text-[var(--cf-danger)]">{error}</span>
              ) : (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  {stage ?? t("scaffold.run.running")}
                </>
              )}
            </div>
          )}
        </div>
        {error && sessionId && <p className="max-h-32 shrink-0 overflow-auto text-[12px] text-[var(--cf-danger)]">{error}</p>}
        {commitProblem && (
          <p className="max-h-32 shrink-0 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--cf-hover)] p-2 text-[12px] text-[var(--cf-warning)]">
            {commitProblem}
          </p>
        )}
      </div>
      <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-[var(--cf-border)] px-4">{footer}</div>
    </div>
  );
}
