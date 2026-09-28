import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { AiSparkles } from "../../common/AiGlyph";
import { ThinkingOrb } from "../../common/ThinkingOrb";
import { ChatModelPicker } from "../../ai/ChatModelPicker";
import { RunEngineChip } from "../../ai/AiRunLog";
import { AiErrorBanner } from "../../ai/AiErrorBanner";
import { parseClaudeError } from "../../../lib/claudeError";
import { useTaskProvider } from "../../../state/aiProviderStore";
import { notebookActions, type NotebookAiRun } from "../../../state/notebookStore";
import { useT } from "../../../state/languageStore";
import { buttonClass } from "../../common/Button";
import { proposalDiff } from "../../../lib/notebook/aiDiff";
import { MarkdownBlock } from "./CellOutputs";

/** The routing row notebook AI runs under — `AiTask::Notebook`. */
export const NOTEBOOK_TASK = "notebook";

const ACTION_LABEL = {
  generate: "notebook.ai.generate",
  explain: "notebook.ai.explain",
  fix: "notebook.ai.fix",
  document: "notebook.ai.document",
} as const;

/**
 * What an AI action on a cell is doing, and what it came back with — under the cell it is about.
 *
 * While it runs: the orb (a model is running, and nothing else in the notebook wears it), the
 * engine that answers, and Stop. An explanation is shown as Markdown. **Code is never applied as it
 * arrives**: a fix or documentation is shown as a diff against the cell, a generated cell as the
 * lines it would add, each with Aceptar / Descartar — accepting is one edit of the cell, so the
 * cell editor's own undo takes it back.
 */
export function CellAiPanel({
  sessionKey,
  slot,
  run,
  currentSource,
  onOpenLink,
}: {
  sessionKey: string;
  /** The cell's key, or `""` for a generation at the end of the notebook. */
  slot: string;
  run: NotebookAiRun;
  currentSource: string;
  onOpenLink: (href: string) => void;
}) {
  const t = useT();
  const provider = useTaskProvider(NOTEBOOK_TASK);
  const code = run.action !== "explain";
  const diff = useMemo(
    () =>
      run.status === "ready" && code && run.answer !== null
        ? proposalDiff(run.action === "generate" ? "" : currentSource, run.answer)
        : null,
    [run.status, run.answer, run.action, code, currentSource],
  );
  const stale = code && run.action !== "generate" && run.status === "ready" && currentSource !== run.before;

  return (
    <div className="mx-2 mb-2 overflow-hidden rounded-lg border border-[color-mix(in_oklab,var(--cf-accent)_40%,transparent)] bg-[var(--cf-surface-raised)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1 text-[11px]">
        <AiSparkles size={12} className="shrink-0" />
        <span className="font-medium text-[var(--cf-text)]">{t(ACTION_LABEL[run.action])}</span>
        <RunEngineChip runId={run.runId} />
        <span className="flex-1" />
        {run.status === "running" ? (
          <>
            <span className="flex items-center gap-1.5 text-[var(--cf-text-muted)]">
              <ThinkingOrb size="sm" />
              {t("notebook.ai.thinking")}
            </span>
            <button
              onClick={() => notebookActions.cancelAi(sessionKey, slot)}
              className="rounded-md px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
            >
              {t("ai.stop")}
            </button>
          </>
        ) : (
          <button
            onClick={() => notebookActions.discardAi(sessionKey, slot)}
            aria-label={t("notebook.ai.discard")}
            className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {run.status === "failed" && run.error && (
        <div className="p-2">
          <AiErrorBanner error={parseClaudeError(run.error)} compact provider={provider} />
        </div>
      )}

      {run.status === "ready" && run.answer !== null && !code && (
        <div className="max-h-[420px] select-text overflow-auto px-3 py-2 text-[12.5px]">
          <MarkdownBlock source={run.answer} onOpenLink={onOpenLink} />
        </div>
      )}

      {diff && (
        <>
          <div className="max-h-[360px] select-text overflow-auto py-1 font-mono text-[12px] leading-[1.45]">
            {diff.map((line, index) =>
              line === null ? (
                <div key={index} className="px-3 text-[var(--cf-text-muted)]">
                  ⋯
                </div>
              ) : (
                <div
                  key={index}
                  className={`whitespace-pre-wrap break-words px-3 ${
                    line.kind === "added"
                      ? "bg-[color-mix(in_oklab,var(--cf-success)_14%,transparent)]"
                      : line.kind === "removed"
                        ? "bg-[color-mix(in_oklab,var(--cf-danger)_14%,transparent)] line-through decoration-[color-mix(in_oklab,var(--cf-danger)_50%,transparent)]"
                        : "text-[var(--cf-text-muted)]"
                  }`}
                >
                  <span className="mr-2 select-none opacity-60">
                    {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                  </span>
                  {line.text || " "}
                </div>
              ),
            )}
          </div>
          <div className="flex items-center justify-end gap-1.5 border-t border-[var(--cf-border)] px-2 py-1">
            {stale && (
              <span className="mr-auto text-[10.5px] text-[var(--cf-warning)]" title={t("notebook.ai.staleHint")}>
                {t("notebook.ai.stale")}
              </span>
            )}
            <button
              onClick={() => notebookActions.discardAi(sessionKey, slot)}
              className={buttonClass({ variant: "ghost", size: "sm" })}
            >
              {t("notebook.ai.discard")}
            </button>
            <button
              onClick={() => notebookActions.acceptAi(sessionKey, slot)}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              <Check size={12} />
              {t("notebook.ai.accept")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** "Generar celda": a one-line description, the engine that will write it, and go. */
export function GeneratePrompt({ sessionKey, cellKey }: { sessionKey: string; cellKey: string | null }) {
  const t = useT();
  const [text, setText] = useState("");
  const submit = () => {
    const instruction = text.trim();
    if (!instruction) return;
    void notebookActions.askAi(sessionKey, cellKey, "generate", instruction);
  };
  return (
    <div className="mx-2 my-1.5 flex items-center gap-2 rounded-lg border border-[var(--cf-accent)] bg-[var(--cf-surface-raised)] px-2 py-1.5">
      <ChatModelPicker
        task={NOTEBOOK_TASK}
        variant="icon"
        liveModel={null}
        chatActive={false}
        title={t("notebook.ai.modelHint")}
      >
        <AiSparkles size={13} />
      </ChatModelPicker>
      <input
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape" && !document.querySelector('[role="menu"]')) {
            event.preventDefault();
            notebookActions.closeGenerate(sessionKey);
          }
        }}
        placeholder={t("notebook.ai.generatePlaceholder")}
        className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
      />
      <button onClick={submit} disabled={!text.trim()} className={buttonClass({ variant: "primary", size: "sm" })}>
        {t("notebook.ai.generateGo")}
      </button>
      <button
        onClick={() => notebookActions.closeGenerate(sessionKey)}
        aria-label={t("common.close")}
        className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      >
        <X size={13} />
      </button>
    </div>
  );
}
