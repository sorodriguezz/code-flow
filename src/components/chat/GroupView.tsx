import { FileText, Paperclip, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { COLUMN_GUTTER, READING_COLUMN, useLocale } from "./chatChrome";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { relativeTime } from "../notes/notesChrome";
import { useConversationStore } from "../../state/conversationStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { ChatGroup } from "../../lib/tauri/chatCommands";
import { buttonClass } from "../common/Button";

/**
 * A project's own page: ask something new here, or pick up one of its conversations.
 *
 * # What makes this a project rather than a folder
 *
 * A folder is only a place to put things. What is on this page is the two things that make the
 * grouping mean something to the *model* as well as to the user:
 *
 * - **Instructions** — standing text prepended to every conversation in the project. Resolved from
 *   the project row on every turn, never copied onto a conversation, so editing them here changes
 *   what the existing chats are told the next time they run.
 * - **Context** — reference documents the whole project shares. They are named to the engine once
 *   per session rather than on every turn, because a project's documents are established facts
 *   about the conversation and not something handed over with a particular question.
 *
 * Both are read on the send path in `chat_cmd`, so a chat started from the sidebar and filed here
 * afterwards picks them up exactly as one started from this page does. The project is a property of
 * the conversation, not of how it was created.
 *
 * # What this page deliberately does not have
 *
 * The composer here starts a conversation and then gets out of the way — sending switches to the
 * transcript. It is not a second chat surface: two places to hold a conversation would mean two
 * scroll positions, two streaming targets and two answers to "where is my chat".
 */
export function GroupView({ group }: { group: ChatGroup }) {
  const t = useT();
  const locale = useLocale();
  const conversations = useConversationStore((s) => s.conversations);
  const create = useConversationStore((s) => s.create);
  const send = useConversationStore((s) => s.send);
  const open = useConversationStore((s) => s.open);
  const setConversationGroup = useConversationStore((s) => s.setConversationGroup);
  const contextFiles = useConversationStore((s) => s.groupContext[group.id]);
  const attachContext = useConversationStore((s) => s.attachGroupContext);
  const removeContext = useConversationStore((s) => s.removeGroupContext);
  const loadContext = useConversationStore((s) => s.loadGroupContext);
  const setInstructions = useConversationStore((s) => s.setGroupInstructions);

  const provider = useTaskProvider("chat");
  const model = useAiProviderStore((s) => s.taskModels.chat ?? s.model);

  const [draft, setDraft] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void loadContext(group.id);
  }, [group.id, loadContext]);

  const filed = useMemo(
    () =>
      conversations
        .filter((c) => c.groupId === group.id && !c.archivedAt)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [conversations, group.id],
  );

  const start = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setDraft("");
    void create(null, provider, model).then(async (id) => {
      if (!id) return;
      // Filed *before* the first turn, not after: the instructions and the context are read on the
      // send path from the conversation's project, so a turn sent before the filing lands would be
      // the one turn in the thread that never saw them.
      await setConversationGroup(id, group.id);
      send(id, trimmed);
    });
  }, [draft, create, provider, model, setConversationGroup, group.id, send]);

  const addContext = useCallback(async () => {
    const picked = await openDialog({ multiple: true });
    const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    for (const path of paths) {
      try {
        await attachContext(group.id, path);
      } catch (e) {
        pushErrorToast(String(e));
      }
    }
  }, [attachContext, group.id]);

  return (
    /*
     * `@container`, and the aside below reads it instead of the viewport.
     *
     * It was `lg:block` — a *window* breakpoint on a panel that is not the window. The chat sits
     * next to a sidebar the user can drag to 420px, inside a window whose minimum is 1024, so
     * "the window is at least 1024 wide" was true at exactly the moment this pane had 600px left
     * and could least afford to give 320 of them away. The page then ran on ~280px: the title
     * wrapped, the composer squeezed, and the reading column stopped being one.
     *
     * The pane knows its own width, so the pane decides.
     */
    <div className="@container flex min-h-0 flex-1 overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`${READING_COLUMN} ${COLUMN_GUTTER} space-y-6 py-8`}>
          <h1 className="text-[26px] font-semibold tracking-tight">{group.name}</h1>

          <div className="rounded-2xl border border-[var(--cf-border)] bg-[var(--cf-surface-2)] p-3">
            <textarea
              ref={boxRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // The same contract as the main composer, including the IME guard: Enter accepts a
                // candidate in Japanese or Chinese input, and reading that as "send" would post the
                // first half of every sentence typed in those languages.
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  start();
                }
              }}
              rows={2}
              placeholder={t("chat.groupComposerPlaceholder", { name: group.name })}
              className="max-h-[200px] w-full resize-none bg-transparent px-1 text-[14px] leading-[1.6] outline-none placeholder:text-[var(--cf-text-muted)]"
            />
            <div className="flex items-center justify-end px-1">
              <button
                type="button"
                onClick={start}
                disabled={!draft.trim()}
                className={buttonClass({ variant: "primary", size: "sm" })}
              >
                {t("chat.groupStart")}
              </button>
            </div>
          </div>

          <div>
            <p className="px-1 pb-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("chat.recentGroup")}
            </p>
            {filed.length === 0 ? (
              <p className="px-1 text-[13px] text-[var(--cf-text-muted)]">{t("chat.groupNoChats")}</p>
            ) : (
              filed.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => void open(conversation.id)}
                  className="flex w-full items-center gap-2 border-b border-[var(--cf-border)] px-1 py-2.5 text-left last:border-b-0 hover:text-[var(--cf-accent)]"
                >
                  <ProviderGlyph providerId={conversation.provider} size={12} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate text-[14px]">
                    {conversation.title || t("chat.untitled")}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">
                    {relativeTime(conversation.updatedAt, locale)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* The rail. Fixed width and its own scroller: it is a settings surface for the project, and
          letting it share the reading column's scroll would mean the instructions scroll away while
          you are reading the conversation list they apply to. */}
      <aside className="hidden w-[320px] shrink-0 overflow-y-auto border-l border-[var(--cf-border)] p-4 @3xl:block">
        <section className="pb-5">
          {/* No explanatory line under this heading: the field's own placeholder is an example of
              exactly what goes in it, which teaches the same thing in the space the answer would
              have occupied anyway. */}
          <h2 className="pb-2 text-[13px] font-semibold">{t("chat.groupInstructions")}</h2>
          <InstructionsBox
            value={group.instructions}
            onCommit={(text) => void setInstructions(group.id, text)}
          />
        </section>

        <section className="border-t border-[var(--cf-border)] pt-4">
          <div className="flex items-center justify-between pb-1">
            <h2 className="text-[13px] font-semibold">{t("chat.groupContext")}</h2>
            <button
              type="button"
              onClick={() => void addContext()}
              title={t("chat.groupContextAdd")}
              aria-label={t("chat.groupContextAdd")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
            >
              <Plus size={14} />
            </button>
          </div>

          {!contextFiles || contextFiles.length === 0 ? (
            <button
              type="button"
              onClick={() => void addContext()}
              className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--cf-border)] px-3 py-6 text-center text-[12px] leading-relaxed text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-text)]"
            >
              <Paperclip size={16} />
              {t("chat.groupContextEmpty")}
            </button>
          ) : (
            <ul className="space-y-1">
              {contextFiles.map((file) => (
                <li
                  key={file.id}
                  className="group flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px] hover:bg-[var(--cf-surface-2)]"
                >
                  <FileText size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                  <span className="min-w-0 flex-1 truncate" title={file.path}>
                    {file.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => void removeContext(group.id, file.id)}
                    aria-label={t("chat.attachRemove")}
                    className="shrink-0 text-[var(--cf-text-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--cf-danger)]"
                  >
                    <X size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}

        </section>
      </aside>
    </div>
  );
}

/**
 * The instructions field, committed on blur rather than on every keystroke.
 *
 * Per-keystroke would be one IPC round trip and one database write per character, for a field
 * people type paragraphs into. On blur is also the honest moment: instructions are read fresh on
 * every turn, so a half-typed sentence saved mid-thought would be what the next chat in this
 * project is told.
 */
function InstructionsBox({ value, onCommit }: { value: string; onCommit: (text: string) => void }) {
  const t = useT();
  const [text, setText] = useState(value);

  // Follows the row when it changes underneath — another window, or a reload — but only while the
  // field is not being edited, which is what `value` changing and `text` being untouched means.
  useEffect(() => {
    setText(value);
  }, [value]);

  return (
    <textarea
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text !== value) onCommit(text);
      }}
      rows={6}
      placeholder={t("chat.groupInstructionsPlaceholder")}
      className="w-full resize-y rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-2)] p-2 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
    />
  );
}
