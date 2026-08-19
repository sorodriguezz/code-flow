import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { inlineEditWithAi } from "../../lib/tauri/commands";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { RunEngineChip } from "../ai/AiRunLog";
import { pushErrorToast } from "../../state/toastStore";
import { notify } from "../../state/notificationStore";
import { useT } from "../../state/languageStore";

/** Ctrl+I: describe the change in words, and the selected code is rewritten in place.
 *
 * The replacement lands in the editor's own buffer as a normal edit — one Ctrl+Z away from being
 * undone, and unsaved until the user decides otherwise. That's the deliberate difference from
 * "fix with AI", which lets an agent write to disk: this one never leaves the editor, so it can
 * be routed to any provider (a local model included) and carries no risk to the working tree.
 */
export function InlineEditWidget({
  editNonce,
  filePath,
  fileContent,
  selection,
  workspaceId,
  onApply,
  onClose,
}: {
  /**
   * Which Ctrl+I this widget is showing, handed straight back to `onApply`.
   *
   * The editor cannot tell two requests in the same file apart by anything else, and it has to:
   * pressing Ctrl+I again while a rewrite is still running is an ordinary thing to do — the input
   * here is disabled for the duration, so carrying on in the code is the only thing left — and the
   * first reply would otherwise be applied to the second selection.
   */
  editNonce: number;
  filePath: string;
  fileContent: string;
  selection: string;
  /**
   * The workspace the file being rewritten lives in — the pane's own `project.workspace_id`.
   *
   * A prop rather than a read of whichever workspace is active when the reply lands, which is the
   * difference between a run the status bar can attribute and one it files wherever the user
   * happens to be standing. A rewrite over a large selection outlives a workspace switch easily,
   * and that run is precisely the one whose home nobody can reconstruct afterwards.
   */
  workspaceId: string;
  /** Applies the rewrite, and answers whether it actually landed: the editor refuses a reply whose
   *  file — or whose request — has moved on since Ctrl+I, and a refusal must not be reported as a
   *  success. */
  onApply: (replacement: string, editNonce: number) => boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [instruction, setInstruction] = useState("");
  const [running, setRunning] = useState(false);
  const runIdRef = useRef<string | null>(null);
  // The same id as the ref, kept in state so the "working" line can name the engine and model the
  // run reported. This edit is the one most likely to be routed somewhere unexpected — it's the
  // task that can run on a fast local model — so which one answered is worth saying.
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    const text = instruction.trim();
    if (!text || running) return;
    const runId = newRunId("inline");
    runIdRef.current = runId;
    setRunId(runId);
    // No target: the notification centre's `select.kind` has no vocabulary for a file in an editor
    // group, so there is nothing more specific to navigate to than the workspace itself — which is
    // stamped here, before the request goes out, and is the same value both notifications below
    // carry however long the answer takes.
    useAiRunStore.getState().start(runId, { kindKey: "agents.liveKindInline", detail: filePath, workspaceId });
    setRunning(true);
    try {
      const replacement = await inlineEditWithAi(filePath, fileContent, selection, text, runId);
      // The editor refuses a rewrite whose file is no longer the one on screen, or whose request
      // has been superseded by a later Ctrl+I — see `applyInlineEdit`; `editNonce` is what names
      // this request to it, read out of the closure this call started in rather than off a later
      // render. Reporting a refusal as finished would put a success in the panel for an edit that
      // no buffer ever received, and send the user looking for a change that is not there.
      const applied = onApply(replacement, editNonce);
      onClose();
      // The shortest-lived run of the lot, and the one most likely to land while the user is still
      // watching — but an edit over a large selection can take a while, and closing the widget on
      // apply means there is nothing left on screen to say it worked.
      notify({
        source: "editor",
        workspaceId,
        titleKey: applied ? "notifications.inlineEditDone" : "notifications.inlineEditDiscarded",
        status: applied ? "success" : "info",
        detail: filePath,
      });
    } catch (e) {
      if (!isCancellation(e)) {
        pushErrorToast(String(e));
        notify({
          source: "editor",
          workspaceId,
          titleKey: "notifications.inlineEditFailed",
          status: "error",
          detail: filePath,
        });
      }
    } finally {
      useAiRunStore.getState().finish(runId);
      setRunning(false);
      runIdRef.current = null;
    }
  };

  const stop = () => {
    const runId = runIdRef.current;
    if (runId) void useAiRunStore.getState().cancel(runId);
  };

  const selectionLines = selection.split("\n").length;

  return (
    <div className="absolute inset-x-3 top-3 z-20 rounded-lg border border-[var(--cf-accent)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Sparkles size={13} className="shrink-0 text-[var(--cf-accent)]" />
        <input
          autoFocus
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          disabled={running}
          placeholder={t("editor.inlineEditPlaceholder", { n: selectionLines })}
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none disabled:opacity-60"
        />
        {running ? (
          <button
            onClick={stop}
            className="shrink-0 rounded-md border border-[var(--cf-border)] px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
          >
            {t("ai.stop")}
          </button>
        ) : (
          <button
            onClick={() => void submit()}
            disabled={!instruction.trim()}
            className="shrink-0 rounded-md bg-[var(--cf-accent)] px-2 py-0.5 text-[11px] text-white disabled:opacity-40"
          >
            {t("editor.inlineEditApply")}
          </button>
        )}
        <button onClick={onClose} className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
          <X size={13} />
        </button>
      </div>
      {running && (
        <div className="flex items-center gap-1.5 border-t border-[var(--cf-border)] px-2.5 py-1 text-[11px] text-[var(--cf-text-muted)]">
          <Loader2 size={11} className="shrink-0 animate-spin" />
          <span className="shrink-0">{t("ai.working")}</span>
          <RunEngineChip runId={runId ?? undefined} />
        </div>
      )}
    </div>
  );
}
