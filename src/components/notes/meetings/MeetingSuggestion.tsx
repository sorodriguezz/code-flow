import { useEffect } from "react";
import { Mic, X } from "lucide-react";
import { buttonClass } from "../../common/Button";
import { useMeetingsStore } from "../../../state/meetingsStore";
import { useNotesStore } from "../../../state/notesStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useUiStore } from "../../../state/uiStore";
import { useLanguageStore, useT, translate } from "../../../state/languageStore";

/** How long the card waits for an answer before it goes away by itself. */
const SHOWN_MS = 60_000;

/**
 * «¿Tomar notas de esta reunión?» — the card the call detector raises when Teams, Zoom or a browser
 * starts using the microphone (`meetings::detect`). It only ever asks: «Tomar notas» makes a note in
 * the workspace's «Reuniones» book, opens it and starts recording; anything else lets it go. The main
 * window only, bottom right, out of the way of whatever is being worked on.
 */
export function MeetingSuggestion() {
  const t = useT();
  const suggestion = useMeetingsStore((s) => s.suggestion);

  useEffect(() => {
    if (!suggestion) return;
    const timer = window.setTimeout(() => useMeetingsStore.getState().dismissSuggestion(), SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [suggestion]);

  if (!suggestion) return null;
  return (
    <div className="fixed bottom-10 right-4 z-[60] flex w-[320px] flex-col gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 text-[12.5px] shadow-lg" role="dialog" aria-label={t("meetings.suggest.title")}>
      <div className="flex items-start gap-2">
        <Mic size={14} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />
        <p className="min-w-0 flex-1">{t("meetings.suggest.body", { app: suggestion.name })}</p>
        <button type="button" aria-label={t("common.close")} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]" onClick={() => useMeetingsStore.getState().dismissSuggestion()}>
          <X size={13} />
        </button>
      </div>
      <div className="flex justify-end gap-1.5">
        <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => useMeetingsStore.getState().dismissSuggestion()}>
          {t("meetings.suggest.no")}
        </button>
        <button type="button" className={buttonClass({ variant: "primary", size: "sm" })} onClick={() => void takeNotes(suggestion.name)}>
          {t("meetings.suggest.yes")}
        </button>
      </div>
    </div>
  );
}

/** A note in the «Reuniones» book (made when missing), opened, and recording the call. */
async function takeNotes(app: string) {
  useMeetingsStore.getState().dismissSuggestion();
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!workspaceId) return;
  useUiStore.getState().setActiveView("notes");
  const notes = useNotesStore.getState();
  if (notes.workspaceId !== workspaceId) await notes.setWorkspace(workspaceId);
  const bookName = translate("meetings.bookName");
  const existing = useNotesStore.getState().books.find((b) => !b.parent_id && b.name === bookName);
  const book = existing?.id ?? (await useNotesStore.getState().createBook(null, bookName));
  if (!book) return;
  const noteId = await useNotesStore.getState().createNote(book);
  if (!noteId) return;
  const when = new Date().toLocaleString(useLanguageStore.getState().language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  useNotesStore.getState().editDraft({ title: translate("meetings.suggest.noteTitle", { app, when }) });
  void useNotesStore.getState().flush();
  const language = useLanguageStore.getState().language === "en" ? "en" : "es";
  await useMeetingsStore.getState().start({ noteId, workspaceId, kind: "virtual", language });
}
