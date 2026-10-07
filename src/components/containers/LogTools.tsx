import { useState } from "react";
import { Copy, Download, X } from "lucide-react";
import { AiSparkles } from "../common/AiGlyph";
import { ContextMenu } from "../common/ContextMenu";
import { Markdown } from "../common/Markdown";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { AiRunLog } from "../ai/AiRunLog";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { RowAction } from "./containerBits";
import { lineCount, logFileName } from "./pageModel";
import { apiSaveFile } from "../../lib/tauri/apiCommands";
import { analysisRunning, useContainersLogAiStore } from "../../state/containersLogAiStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";

/**
 * A log tab's own tools, in the tab row beside its options: copy all of it, save it as a `.log` or a
 * `.txt`, and «Analizar con IA» fused with the menu that picks its engine — account, provider and
 * model, the `logs` task's route, the same row Settings shows.
 *
 * All three take what the pane shows (`read`, from the terminal's buffer): the lines the user is
 * looking at are the ones copied, saved and explained — not a second read of a log that has moved on.
 */
export function LogTools({ read, subject, about, analysisKey }: { read: () => string; subject: string; about: string; analysisKey: string }) {
  const t = useT();
  const analysis = useContainersLogAiStore((s) => s.byKey[analysisKey]);
  const analyze = useContainersLogAiStore((s) => s.analyze);
  const [saveMenu, setSaveMenu] = useState<{ x: number; y: number } | null>(null);
  const running = analysisRunning(analysis);

  const take = (): string | null => {
    const text = read();
    if (text.trim()) return text;
    pushErrorToast(t("containers.logs.empty"));
    return null;
  };
  const copy = () => {
    const text = take();
    if (text === null) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => pushSuccessToast(t("containers.logs.copied", { count: lineCount(text) })))
      .catch((e: unknown) => pushErrorToast(String(e)));
  };
  const save = async (extension: "log" | "txt") => {
    const text = take();
    if (text === null) return;
    try {
      const path = await apiSaveFile(logFileName(subject, extension), text);
      if (path) pushSuccessToast(t("containers.logs.saved", { path }));
    } catch (e) {
      pushErrorToast(String(e));
    }
  };
  const ask = () => {
    const text = take();
    if (text !== null) void analyze(analysisKey, { subject, about, log: text });
  };

  return (
    <span className="flex items-center gap-1">
      <RowAction label={t("containers.logs.copy")} onClick={copy}>
        <Copy size={12} />
      </RowAction>
      <RowAction
        label={t("containers.logs.save")}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setSaveMenu({ x: rect.left, y: rect.bottom + 2 });
        }}
      >
        <Download size={12} />
      </RowAction>
      <ChatModelPicker
        task="logs"
        variant="split"
        liveModel={null}
        chatActive={false}
        title={t("containers.logs.aiModelHint")}
        action={{
          // The orb, not a spinner: a model is reading the log.
          icon: running ? <ThinkingOrb size="sm" /> : <AiSparkles size={13} />,
          label: t("containers.logs.analyze"),
          onClick: ask,
          disabled: running,
        }}
      />
      {saveMenu && (
        <ContextMenu
          x={saveMenu.x}
          y={saveMenu.y}
          items={[
            { label: t("containers.logs.saveAs", { ext: ".log" }), onClick: () => void save("log") },
            { label: t("containers.logs.saveAs", { ext: ".txt" }), onClick: () => void save("txt") },
          ]}
          onClose={() => setSaveMenu(null)}
        />
      )}
    </span>
  );
}

/**
 * The answer, beside the log it is about — a column on the right rather than a drawer under it: the
 * dock is wide and short, and the lines the answer quotes stay on screen while it is read. While it
 * runs it shows the engine's own trace, with its stop; closing it stops a run still going.
 */
export function LogAnalysisPanel({ analysisKey }: { analysisKey: string }) {
  const t = useT();
  const analysis = useContainersLogAiStore((s) => s.byKey[analysisKey]);
  const clear = useContainersLogAiStore((s) => s.clear);
  const [traceOpen, setTraceOpen] = useState(true);
  if (!analysis) return null;
  const running = analysisRunning(analysis);
  return (
    <aside className="flex w-[min(460px,45%)] min-w-[260px] shrink-0 flex-col border-l border-[var(--cf-border)] bg-[var(--cf-surface)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] pl-3 pr-1.5">
        {running ? <ThinkingOrb size="sm" /> : <AiSparkles size={12} />}
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--cf-text)]">{t("containers.logs.analysisTitle")}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">{t("containers.logs.analysisLines", { count: analysis.lines })}</span>
        {analysis.text && (
          <RowAction
            label={t("containers.logs.copyAnswer")}
            onClick={() =>
              void navigator.clipboard
                .writeText(analysis.text ?? "")
                .then(() => pushSuccessToast(t("containers.logs.answerCopied")))
                .catch((e: unknown) => pushErrorToast(String(e)))
            }
          >
            <Copy size={12} />
          </RowAction>
        )}
        <RowAction label={running ? t("containers.logs.stop") : t("common.close")} onClick={() => clear(analysisKey)}>
          <X size={13} />
        </RowAction>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {running && (
          <div className="p-2">
            <AiRunLog runId={analysis.runId} running startedAt={analysis.startedAt} expanded={traceOpen} onToggle={() => setTraceOpen((open) => !open)} />
          </div>
        )}
        {analysis.error && <p className="whitespace-pre-wrap break-words px-3 py-3 text-[12.5px] text-[var(--cf-danger)]">{analysis.error}</p>}
        {analysis.text && <Markdown source={analysis.text} className="cf-markdown-preview px-3 py-3 text-[12.5px] leading-[1.6]" />}
      </div>
    </aside>
  );
}
