import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Sparkles, X } from "lucide-react";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { notesWriteWithAi } from "../../lib/tauri/notesCommands";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { useAiModelsStore } from "../../state/aiModelsStore";
import { useNotesStore } from "../../state/notesStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/**
 * Asks an engine for Markdown to put in the note.
 *
 * **The engine is picked here, not routed by task.** Every other AI call in the app goes through
 * the task router, which is right when the *app* decides to run something — a commit message, a
 * review. This is a person asking for prose in a document they are writing, and which engine
 * writes it is part of the asking: a local model for a rough outline, a large one for something
 * that has to be right. So the picker is in the dialog, and the choice is remembered per workspace.
 *
 * What comes back is inserted, never auto-saved over anything: with a selection it replaces it,
 * without one it lands at the caret. Either way it is one Monaco edit, so **Ctrl+Z takes it back
 * out** — which is the only thing that makes a generate button safe to press on a document you
 * care about.
 */
export function NoteAiModal({
  selection,
  onInsert,
  onClose,
}: {
  /** The editor's current selection, or `""`. Shown so the user knows what will be replaced. */
  selection: string;
  onInsert: (markdown: string) => void;
  onClose: () => void;
}) {
  const draft = useNotesStore((s) => s.draft);
  const provider = useNotesStore((s) => s.aiProvider);
  const model = useNotesStore((s) => s.aiModel);
  const setEngine = useNotesStore((s) => s.setAiEngine);
  const modelsByProvider = useAiModelsStore((s) => s.byProvider);
  const ensureModels = useAiModelsStore((s) => s.ensure);
  const t = useT();

  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);

  const providers = useMemo(() => AI_PROVIDERS.filter((entry) => entry.available), []);
  const models = provider ? (modelsByProvider[provider] ?? []) : [];

  // The version list is fetched per provider and cached in `aiModelsStore`; asking for it when the
  // dialog opens means the dropdown is populated before anyone reaches it.
  useEffect(() => {
    if (provider) void ensureModels([provider]);
  }, [provider, ensureModels]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, busy]);

  const submit = async () => {
    if (!instruction.trim() || busy || !draft) return;
    const id = newRunId("note-ai");
    setRunId(id);
    setBusy(true);
    // No `target`: the user is already looking at the note this is writing into, so there is
      // nowhere for the notification centre to send them.
      useAiRunStore.getState().start(id, { kindKey: "notes.ai.runKind", detail: draft.title });
    try {
      const markdown = await notesWriteWithAi({
        title: draft.title,
        content: draft.content,
        selection,
        instruction: instruction.trim(),
        provider: provider || undefined,
        model: model || undefined,
        runId: id,
      });
      if (markdown.trim()) onInsert(markdown);
      onClose();
    } catch (error) {
      // Stopping it yourself is not a failure worth a red toast.
      if (!isCancellation(error)) pushErrorToast(String(error));
    } finally {
      useAiRunStore.getState().finish(id);
      setBusy(false);
      setRunId(null);
    }
  };

  const field =
    "w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="cf-fade-in w-[520px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
          <Sparkles size={14} className="text-[var(--cf-accent)]" />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--cf-text)]">
            {selection.trim() ? t("notes.ai.titleReplace") : t("notes.ai.titleWrite")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t("notes.close")}
            className="text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] disabled:opacity-40"
          >
            <X size={15} />
          </button>
        </div>

        <div className="space-y-3 p-4">
          {selection.trim() && (
            <div>
              <span className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
                {t("notes.ai.willReplace")}
              </span>
              {/* Three lines of it, so "replace this" names something the user can recognise
                  without the dialog turning into a second editor. */}
              <pre className="max-h-16 overflow-hidden rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                {selection.slice(0, 240)}
                {selection.length > 240 ? "…" : ""}
              </pre>
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("notes.ai.instruction")}
            </span>
            <textarea
              autoFocus
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                // Enter alone is a newline: the instruction is prose and often two sentences.
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={3}
              placeholder={t("notes.ai.instructionPlaceholder")}
              className={`${field} resize-none leading-relaxed`}
            />
          </label>

          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("notes.ai.engine")}
            </span>
            <div className="relative">
              <select
                value={provider}
                onChange={(event) => setEngine(event.target.value, "")}
                aria-label={t("notes.ai.provider")}
                className={`${field} appearance-none pr-6`}
              >
                <option value="">{t("notes.ai.defaultEngine")}</option>
                {providers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={11}
                className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
              />
            </div>

            {provider && (
              <div className="relative min-w-0 flex-1">
                <select
                  value={model}
                  onChange={(event) => setEngine(provider, event.target.value)}
                  aria-label={t("notes.ai.model")}
                  className={`${field} appearance-none pr-6`}
                >
                  <option value="">{t("notes.ai.defaultModel")}</option>
                  {models.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={11}
                  className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
                />
              </div>
            )}
          </div>

          <p className="text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("notes.ai.undoHint")}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--cf-border)] px-4 py-2.5">
          {busy && runId && (
            <button
              type="button"
              onClick={() => void useAiRunStore.getState().cancel(runId)}
              className="mr-auto rounded-md px-2 py-1 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
            >
              {t("notes.ai.stop")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] disabled:opacity-40"
          >
            {t("notes.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!instruction.trim() || busy}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {busy ? t("notes.ai.writing") : t("notes.ai.write")}
          </button>
        </div>
      </div>
    </div>
  );
}
