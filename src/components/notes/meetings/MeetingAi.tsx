import { useEffect, useState } from "react";
import { BookmarkPlus, Copy, CornerDownLeft, Lock, Trash2, X } from "lucide-react";
import { AiGlyph } from "../../common/AiGlyph";
import { ThinkingOrb } from "../../common/ThinkingOrb";
import { buttonClass } from "../../common/Button";
import { ChatModelPicker } from "../../ai/ChatModelPicker";
import { NotePreview } from "../NotePreview";
import { BUILTIN_RECIPES, factsOf, namesOf } from "./meetingLabels";
import {
  LOCAL_UNAVAILABLE,
  meetingsAi,
  meetingsDeleteRecipe,
  meetingsRecipes,
  meetingsSaveRecipe,
  type Meeting,
  type MeetingDetail,
  type MeetingRecipe,
} from "../../../lib/tauri/meetingsCommands";
import { isCancellation, newRunId, useAiRunStore } from "../../../state/aiRunStore";
import { useMeetingsStore } from "../../../state/meetingsStore";
import { useLanguageStore, useT } from "../../../state/languageStore";
import { notify } from "../../../state/notificationStore";
import { pushErrorToast, useToastStore } from "../../../state/toastStore";
import { useUiStore } from "../../../state/uiStore";

/** The routing row: `AiTask::Meetings`, which follows the Notes row until set. */
const TASK = "meetings";

/**
 * The AI over a meeting: recipes that write into the note (minutes, decisions, tasks, a plan…), a
 * question answered from the transcript, or an instruction of one's own — kept as a recipe of the
 * workspace when it is worth keeping.
 *
 * **A recipe writes into the note**, at its end, as one edit — ⌘Z takes it back — the way «Escribir
 * con IA» does. A question's answer is shown here instead, with the minutes it cites made into links
 * that play that moment; it goes into the note only when asked.
 *
 * **The run lives in the store**, by meeting, so collapsing the panel or opening another note does
 * not lose it: an answer that lands while the note is not open waits here to be inserted.
 */
export function MeetingAi({
  meeting,
  detail,
  noteTitle,
  workspaceId,
  onInsert,
  onSeek,
}: {
  meeting: Meeting;
  detail: MeetingDetail;
  noteTitle: string;
  workspaceId: string;
  onInsert: (markdown: string) => boolean;
  onSeek: (ms: number) => void;
}) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const run = useMeetingsStore((s) => s.ai[meeting.id]);
  const [recipes, setRecipes] = useState<MeetingRecipe[]>([]);
  const [question, setQuestion] = useState("");
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    void meetingsRecipes(workspaceId).then(setRecipes).catch(() => setRecipes([]));
  }, [workspaceId]);

  const running = run?.status === "running";

  const ask = async (request: { recipe?: string; instruction?: string; question: boolean; label: string }) => {
    if (running) return;
    const runId = newRunId("meeting-ai");
    const store = useMeetingsStore.getState();
    store.setAi(meeting.id, { runId, label: request.label, question: request.question, status: "running" });
    useAiRunStore.getState().start(runId, {
      kindKey: "meetings.ai.runKind",
      detail: `${noteTitle} · ${request.label}`,
      target: { view: "notes", select: { kind: "note", id: meeting.noteId } },
      workspaceId,
    });
    try {
      const facts = factsOf(meeting, noteTitle, detail.speakers, detail.lines, language);
      const answer = await meetingsAi({
        meetingId: meeting.id,
        recipe: request.recipe,
        instruction: request.instruction,
        question: request.question,
        facts,
        names: namesOf(detail.speakers, detail.lines, meeting.kind),
        runId,
        workspaceId,
      });
      const markdown = answer.markdown.trim();
      if (!markdown) {
        store.setAi(meeting.id, null);
        return;
      }
      if (!request.question && onInsert(`${markdown}\n`)) {
        store.setAi(meeting.id, null);
        useToastStore.getState().pushToast(t("meetings.ai.inserted", { what: request.label }), "success");
      } else {
        store.setAi(meeting.id, { runId, label: request.label, question: request.question, status: "ready", markdown });
      }
      notify({
        source: "notes",
        titleKey: "meetings.ai.done",
        target: { view: "notes", select: { kind: "note", id: meeting.noteId } },
        status: "success",
        detail: `${noteTitle} · ${request.label}`,
        workspaceId,
      });
    } catch (error) {
      if (isCancellation(error)) {
        store.setAi(meeting.id, null);
        return;
      }
      const text = String(error);
      store.setAi(meeting.id, { runId, label: request.label, question: request.question, status: "failed", error: text });
      if (text.includes(LOCAL_UNAVAILABLE)) {
        pushErrorToast(t("meetings.ai.localUnavailable"));
      } else {
        pushErrorToast(text);
      }
    } finally {
      useAiRunStore.getState().finish(runId);
    }
  };

  const recipeLabel = (id: (typeof BUILTIN_RECIPES)[number]) => t(`meetings.recipe.${id}` as Parameters<typeof t>[0]);

  const saveInstruction = async () => {
    const text = instruction.trim();
    if (!text) return;
    const name = text.length > 32 ? `${text.slice(0, 30)}…` : text;
    try {
      const saved = await meetingsSaveRecipe(workspaceId, null, name, text);
      setRecipes((current) => [...current, saved]);
      useToastStore.getState().pushToast(t("meetings.ai.recipeSaved"), "success");
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  // `[12:34]` in an answer plays that moment: made into links the preview keeps.
  const linked = (markdown: string) =>
    markdown.replace(/\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\](?!\()/g, (whole, h, m, s) => {
      const ms = ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000;
      return `[${whole.slice(1, -1)}](#t=${ms})`;
    });

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {BUILTIN_RECIPES.map((id) => (
          <button
            key={id}
            type="button"
            disabled={running}
            onClick={() => void ask({ recipe: id, question: false, label: recipeLabel(id) })}
            className="rounded-full border border-[var(--cf-border)] px-2.5 py-[2px] text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent-line)] hover:bg-[var(--cf-accent-soft)] disabled:opacity-50"
          >
            {recipeLabel(id)}
          </button>
        ))}
        {recipes.map((recipe) => (
          <span key={recipe.id} className="group flex items-center rounded-full border border-[var(--cf-border)] text-[12px] hover:border-[var(--cf-accent-line)]">
            <button type="button" disabled={running} onClick={() => void ask({ recipe: recipe.id, question: false, label: recipe.name })} className="py-[2px] pl-2.5 pr-1 disabled:opacity-50" title={recipe.prompt}>
              {recipe.name}
            </button>
            <button
              type="button"
              aria-label={t("meetings.ai.deleteRecipe")}
              className="mr-1 hidden rounded-full p-0.5 text-[var(--cf-text-faint)] hover:text-[var(--cf-danger)] group-hover:block"
              onClick={() => void meetingsDeleteRecipe(recipe.id).then(() => setRecipes((c) => c.filter((r) => r.id !== recipe.id)))}
            >
              <Trash2 size={10} />
            </button>
          </span>
        ))}
        <span className="flex-1" />
        {detail.localOnly ? (
          <span className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)]" title={t("meetings.localOnlyHint")}>
            <Lock size={10} />
            {t("meetings.ai.localModel")}
            <button type="button" className="text-[var(--cf-accent)] hover:underline" onClick={() => useUiStore.getState().openSettingsAt("claude", "localModel")}>
              {t("meetings.ai.change")}
            </button>
          </span>
        ) : (
          <ChatModelPicker task={TASK} liveModel={null} chatActive={false} />
        )}
      </div>

      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const text = question.trim();
          if (!text) return;
          void ask({ instruction: text, question: true, label: text });
          setQuestion("");
        }}
      >
        <AiGlyph size={13} still={!running} />
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={running}
          data-ai-input
          placeholder={t("meetings.ai.askPlaceholder")}
          className="h-7 min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 text-[12.5px] outline-none focus:border-[var(--cf-accent)]"
        />
        <button type="submit" disabled={running || !question.trim()} className={buttonClass({ variant: "secondary", size: "sm" })}>
          {t("meetings.ai.ask")}
        </button>
      </form>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const text = instruction.trim();
          if (!text) return;
          void ask({ instruction: text, question: false, label: text.length > 40 ? `${text.slice(0, 38)}…` : text });
        }}
      >
        <span className="w-[13px]" />
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={running}
          data-ai-input
          placeholder={t("meetings.ai.instructionPlaceholder")}
          className="h-7 min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 text-[12.5px] outline-none focus:border-[var(--cf-accent)]"
        />
        <button type="button" disabled={!instruction.trim()} className={buttonClass({ variant: "ghost", size: "sm" })} title={t("meetings.ai.saveRecipe")} onClick={() => void saveInstruction()}>
          <BookmarkPlus size={12} />
        </button>
        <button type="submit" disabled={running || !instruction.trim()} className={buttonClass({ variant: "secondary", size: "sm" })}>
          {t("meetings.ai.write")}
        </button>
      </form>

      {run && (
        <div className="rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-2)] p-2">
          <div className="mb-1 flex items-center gap-2 text-[11.5px] text-[var(--cf-text-muted)]">
            {run.status === "running" && <ThinkingOrb size="sm" />}
            <span className="min-w-0 flex-1 truncate">
              {run.status === "running" ? t("meetings.ai.writing", { what: run.label }) : run.status === "failed" ? t("meetings.ai.failed", { what: run.label }) : run.label}
            </span>
            {run.status === "running" ? (
              <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => void useAiRunStore.getState().cancel(run.runId)}>
                {t("common.cancel")}
              </button>
            ) : (
              <>
                {run.markdown && (
                  <>
                    <button
                      type="button"
                      className={buttonClass({ variant: "secondary", size: "sm" })}
                      onClick={() => {
                        if (onInsert(`${run.markdown}\n`)) useMeetingsStore.getState().setAi(meeting.id, null);
                      }}
                    >
                      <CornerDownLeft size={11} />
                      {t("meetings.ai.insert")}
                    </button>
                    <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => void navigator.clipboard.writeText(run.markdown ?? "").catch(() => {})}>
                      <Copy size={11} />
                    </button>
                  </>
                )}
                <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} aria-label={t("common.close")} onClick={() => useMeetingsStore.getState().setAi(meeting.id, null)}>
                  <X size={12} />
                </button>
              </>
            )}
          </div>
          {run.status === "failed" && <p className="text-[12px] text-[var(--cf-danger)]">{run.error}</p>}
          {run.markdown && (
            <div
              className="max-h-[30vh] overflow-y-auto"
              onClick={(e) => {
                const anchor = (e.target as HTMLElement).closest("a");
                const href = anchor?.getAttribute("href") ?? "";
                if (href.startsWith("#t=")) {
                  e.preventDefault();
                  onSeek(Number(href.slice(3)));
                }
              }}
            >
              <NotePreview source={linked(run.markdown)} className="cf-markdown-preview text-[12.5px]" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
