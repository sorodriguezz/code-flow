import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  FolderOpen,
  GitBranch,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { StatusDot, type ConversationStatus } from "./StatusDot";
import { ICON_BUTTON, ROW, ROW_ACTIVE, ROW_IDLE, useLocale } from "./chatChrome";
import { relativeTime } from "../notes/notesChrome";
import type { ChatConversation, ChatGroup, ChatSearchHit } from "../../lib/tauri/chatCommands";
import { providerCapabilities, providerDisplayLabel } from "../../lib/aiProviders";
import { dropTarget, useChatDragStore, type ChatDrag } from "../../state/chatDragStore";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { useConversationStore } from "../../state/conversationStore";
import { useT } from "../../state/languageStore";

/** How long the search box waits before asking the backend. Title matches are filtered locally and
 *  are instant; this delay only governs the round trip that looks *inside* messages. */
const SEARCH_DEBOUNCE_MS = 200;

/**
 * The conversation list.
 *
 * **Flat and global**, which is the product decision this whole workspace is built around and the
 * one thing about it that is easy to "fix" by accident. Every other list in this app narrows to the
 * active workspace, and a `workspace_id` *is* written on every conversation here — backup groups by
 * it and the run-isolation stamp needs it — so adding a filter on it would look like tidying up an
 * oversight. It is not one. A conversation is usually about nothing in particular; scoping the list
 * would mean a question you asked this morning disappears because you clicked a different
 * repository, which is exactly the behaviour nobody tolerates from a chat client.
 *
 * Pinned rows come first, then everything by `updated_at`. Archived rows are hidden rather than
 * dropped, and are one toggle away — archiving is the "I am done with this but not willing to lose
 * it" gesture, and a destination you cannot get back to is a delete with extra steps.
 *
 * Search is two searches on purpose. Titles match locally and instantly, which covers the common
 * case of half-remembering what you called something. Message bodies go through
 * `chat_search_conversations`, debounced, and are shown as a separate group with the matching
 * snippet — because a hit inside a transcript needs its evidence beside it to be worth anything.
 */
export function ConversationSidebar() {
  const t = useT();
  const locale = useLocale();
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const open = useConversationStore((s) => s.open);
  const deselect = useConversationStore((s) => s.deselect);
  const search = useConversationStore((s) => s.search);

  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [hits, setHits] = useState<ChatSearchHit[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const searchField = useRef<HTMLInputElement>(null);

  const trimmed = query.trim();

  // The body search. Debounced, and guarded by a liveness flag rather than by cancelling the
  // promise: an `invoke` cannot be aborted, so the only thing that matters is that a reply for a
  // query the user has already moved past never reaches `setHits`.
  useEffect(() => {
    if (trimmed.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void search(trimmed, 20)
        .then((found) => {
          if (live) setHits(found);
        })
        .catch(() => {
          if (live) setHits([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [trimmed, search]);

  /**
   * How many *other* conversations sit on the same provider.
   *
   * Only meaningful for an engine whose resume is ambiguous — `agy` hands back a fixed sentinel and
   * continues from whatever it ran last, so with two Gemini conversations in this list the second
   * one silently inherits the first one's context. That was a latent defect when the AI panel had
   * one chat per repository; a flat sidebar where both are visibly open at once makes it a daily
   * one, which is why the warning lives on the row rather than in a release note.
   */
  const perProvider = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const conversation of conversations) {
      if (conversation.archivedAt) continue;
      counts[conversation.provider] = (counts[conversation.provider] ?? 0) + 1;
    }
    return counts;
  }, [conversations]);

  const groups = useConversationStore((s) => s.groups);
  const activeGroupId = useConversationStore((s) => s.activeGroupId);

  // ---- drag and drop ----
  const dragging = useChatDragStore((s) => s.drag);
  const overGroup = useChatDragStore((s) => s.over);
  const overUngrouped = useChatDragStore((s) => s.overUngrouped);
  const pointer = useChatDragStore((s) => s.pointer);
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Whether a drag has just ended, so the click that follows it can be ignored.
   *
   * A pointer-driven drag does not suppress the browser's own click: a release over a row fires
   * `pointerup` and *then* `click`, so dropping a conversation into a folder would also open that
   * conversation. A ref rather than state, because nothing renders from it.
   *
   * Cleared on a timeout rather than by the click it is waiting for — the two events are dispatched
   * in the same input task, so a `setTimeout(0)` scheduled during `pointerup` always runs after the
   * click, and clearing it only on the click would leave the flag armed forever whenever a drop
   * lands somewhere that produces no click at all.
   */
  const swallowClick = useRef(false);

  /**
   * Ends the gesture without moving anything.
   *
   * Separate from [`dropHere`] on purpose, and the distinction is the difference between a feature
   * and a hazard. A drag ends for three reasons and only one of them is a drop: the user releases
   * over a target, the pointer leaves the list, or the button comes back up somewhere this
   * component never saw. Committing on all three would file a conversation into whichever folder
   * the pointer last happened to cross on its way out — a write the user never asked for, into a
   * folder they were only passing over.
   */
  const cancelDrag = useCallback(() => {
    setDragCursor(false);
    if (useChatDragStore.getState().drag) {
      swallowClick.current = true;
      setTimeout(() => {
        swallowClick.current = false;
      }, 0);
    }
    useChatDragStore.getState().end();
  }, []);

  /** A release *inside* the list, which is the only thing that moves a conversation. */
  const dropHere = useCallback(() => {
    const { drag, over, overUngrouped: outOf } = useChatDragStore.getState();
    if (drag) {
      // `undefined` and `null` mean different things here — see `dropTarget`. `null` files the
      // conversation back out into the loose list; `undefined` is "this release writes nothing".
      const target = dropTarget(drag, over, outOf);
      if (target !== undefined) {
        void useConversationStore.getState().setConversationGroup(drag.conversationId, target);
      }
    }
    cancelDrag();
  }, [cancelDrag]);

  /**
   * One listener on the scroller rather than one per row: the pointer leaves the pressed row almost
   * immediately, so a per-row `onPointerMove` would stop firing exactly when the drag is deciding
   * whether it has started.
   */
  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const { origin, drag: live, move } = useChatDragStore.getState();
      if (live) {
        move(event.clientX, event.clientY);
        return;
      }
      if (!origin) return;
      // No button held means this is a plain hover. Without the check, a press whose release we
      // never saw — the pointer left the window, the OS took the gesture — leaves `origin` armed,
      // and the next pass across the sidebar starts a drag nobody began.
      if (event.buttons === 0) {
        cancelDrag();
        return;
      }
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD) return;
      useChatDragStore.getState().begin();
      setDragCursor(true);
    },
    [cancelDrag],
  );

  const pressRow = useCallback((event: React.PointerEvent, conversation: ChatConversation) => {
    // Left button only: the right one raises the context menu, and arming a drag on it means the
    // menu opens with the page in drag mode behind it.
    if (event.button !== 0) return;
    // Suppresses press-and-sweep text selection. See `lib/pointerDrag`.
    event.preventDefault();
    const drag: ChatDrag = {
      conversationId: conversation.id,
      fromGroupId: conversation.groupId,
      title: conversation.title,
    };
    useChatDragStore.getState().press(drag, event.clientX, event.clientY);
  }, []);

  const visible = useMemo(() => {
    const needle = trimmed.toLowerCase();
    return conversations.filter((conversation) => {
      if (!showArchived && conversation.archivedAt) return false;
      if (!needle) return true;
      return conversation.title.toLowerCase().includes(needle);
    });
  }, [conversations, trimmed, showArchived]);

  // Three groups in the order the eye should meet them, and archived last on purpose: it is the
  // shelf, not the desk. A pinned row that has also been archived stays in the archived group,
  // because "I am done with this" is the more recent statement of the two.
  const archived = visible.filter((conversation) => conversation.archivedAt);
  /** Everything still on the desk, which is then split by *where it is filed* before anything else.
   *
   * # A filed conversation never appears outside its folder
   *
   * This is the rule, and it holds without exception — including for a pinned one. An earlier cut
   * let a pinned-and-filed conversation show under "Pinned" at the top instead, on the reasoning
   * that pinning is the louder statement of the two. That was wrong in the way that matters: it
   * meant dragging a chat into a folder sometimes moved it and sometimes appeared to do nothing,
   * because the row stayed exactly where it was. A sidebar where filing something has no visible
   * effect is one nobody trusts to have filed it.
   *
   * So pinning now sorts *within* whichever zone the conversation is in. In the loose list it
   * still lifts a thread to the top; inside a folder it lifts it to the top of that folder.
   */
  const live = visible.filter((conversation) => !conversation.archivedAt);
  const loose = live.filter((conversation) => !conversation.groupId);
  const pinned = loose.filter((conversation) => conversation.pinnedAt);
  const ungrouped = loose.filter((conversation) => !conversation.pinnedAt);

  /** One bucket per folder, pinned first inside each.
   *
   * Where the folders are drawn is decided in the render below — above the loose list, the way
   * ChatGPT's sidebar orders "Anclados", "Proyectos", "Recientes" — and the comment there says why.
   */
  const byGroup = useMemo(() => {
    const buckets: Record<string, ChatConversation[]> = {};
    for (const conversation of live) {
      if (!conversation.groupId) continue;
      (buckets[conversation.groupId] ??= []).push(conversation);
    }
    // Stable: the backend already returned pinned-first then by recency, and this only has to keep
    // that true after the split, so an equal comparison must not reorder.
    for (const bucket of Object.values(buckets)) {
      bucket.sort((a, b) => Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)));
    }
    return buckets;
  }, [live]);

  /** Rows found by body text that the title filter did not already surface — otherwise a query
   *  matching both a title and its own messages would list the same conversation twice. */
  const bodyOnly = useMemo(() => {
    const shown = new Set(visible.map((conversation) => conversation.id));
    return hits.filter((hit) => !shown.has(hit.conversationId));
  }, [hits, visible]);

  /** Wraps selection so a click synthesised by the end of a drag cannot open a conversation. */
  const selectRow = useCallback(
    (id: string) => {
      if (swallowClick.current) return;
      void open(id);
    },
    [open],
  );

  const openMenu = useCallback(
    (event: React.MouseEvent, conversation: ChatConversation) => {
      event.preventDefault();
      const store = useConversationStore.getState();
      const items: MenuItem[] = [
        {
          label: t("chat.rename"),
          icon: Pencil,
          onClick: () => {
            void promptAction(t("chat.renamePrompt"), { initial: conversation.title }).then((title) => {
              if (title) void store.rename(conversation.id, title);
            });
          },
        },
        {
          label: conversation.pinnedAt ? t("chat.unpin") : t("chat.pin"),
          icon: conversation.pinnedAt ? PinOff : Pin,
          onClick: () => void store.setPinned(conversation.id, !conversation.pinnedAt),
        },
        {
          label: conversation.archivedAt ? t("chat.unarchive") : t("chat.archive"),
          icon: conversation.archivedAt ? ArchiveRestore : Archive,
          onClick: () => void store.setArchived(conversation.id, !conversation.archivedAt),
        },
        // Filing, flattened into the menu rather than hidden behind a submenu: `ContextMenu` has no
        // submenus, and the alternative — a modal with a folder list — turns a one-click action
        // into three. A user with twenty folders would want the submenu; a user with twenty folders
        // is not who this list is for.
        ...(() => {
          const folders = useConversationStore.getState().groups;
          if (folders.length === 0) return [] as MenuItem[];
          return [
            ...(conversation.groupId
              ? [
                  {
                    label: t("chat.groupNone"),
                    icon: FolderOpen,
                    separated: true,
                    onClick: () => void store.setConversationGroup(conversation.id, null),
                  } satisfies MenuItem,
                ]
              : []),
            ...folders
              // The folder it is already in is not a destination.
              .filter((group) => group.id !== conversation.groupId)
              .map((group, at) => ({
                label: t("chat.groupMoveTo") + ": " + group.name,
                icon: FolderOpen,
                separated: at === 0 && !conversation.groupId,
                onClick: () => void store.setConversationGroup(conversation.id, group.id),
              })),
          ] satisfies MenuItem[];
        })(),
        {
          label: t("chat.cmdBranch"),
          icon: GitBranch,
          separated: true,
          // A separate action from the transcript's per-turn `branch` rather than the same one with
          // a sentinel turn: "branch at turn -1" is a magic number that has to be understood
          // identically by this file, the store and a Rust command, and the day one of the three
          // reads it as an index is the day it silently branches at the first turn.
          onClick: () => {
            void (async () => {
              // Read the transcript first: a row in this list is metadata, and "the end" is a turn
              // number only the transcript knows. Branching a conversation the store is not holding
              // would otherwise need a sentinel turn understood identically by this file, the store
              // and a Rust query — and the day one of the three reads it as an index is the day it
              // silently branches at the first turn instead of the last.
              await store.open(conversation.id);
              const session = useConversationStore.getState().sessionFor(conversation.id);
              const last = session.messages[session.messages.length - 1];
              if (last) await store.branch(conversation.id, last.turn);
            })();
          },
        },
        {
          label: t("chat.delete"),
          icon: Trash2,
          danger: true,
          separated: true,
          onClick: () => {
            void confirmAction(t("chat.deleteConfirm", { title: conversation.title })).then((ok) => {
              if (ok) void store.remove(conversation.id);
            });
          },
        },
      ];
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [t],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-tour="chat-sidebar">
      <div className="flex items-center gap-1 px-2 pb-1 pt-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
          />
          <input
            ref={searchField}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("chat.searchPlaceholder")}
            className="w-full rounded-lg border border-[var(--cf-border)] bg-transparent py-[5px] pl-7 pr-6 text-[12px] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                searchField.current?.focus();
              }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={deselect}
          title={t("chat.newChat")}
          aria-label={t("chat.newChat")}
          className={ICON_BUTTON}
          data-tour="chat-new"
        >
          <MessageSquarePlus size={15} />
        </button>
        <button
          type="button"
          onClick={() => {
            void promptAction(t("chat.groupNamePlaceholder"), { initial: "" }).then((name) => {
              if (name?.trim()) void useConversationStore.getState().createGroup(name.trim(), "");
            });
          }}
          title={t("chat.groupNew")}
          aria-label={t("chat.groupNew")}
          className={ICON_BUTTON}
        >
          <FolderPlus size={15} />
        </button>
      </div>

      <div
        ref={listRef}
        onPointerMove={onPointerMove}
        onPointerUp={dropHere}
        // A pointer that leaves the window mid-drag never sends `pointerup` here, and the gesture
        // would otherwise stay armed until the next click somewhere unrelated.
        onPointerLeave={() => {
          if (useChatDragStore.getState().drag) cancelDrag();
        }}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
      >
        {/* Pinned first, then folders, then everything else — the order the ChatGPT desktop
            sidebar uses ("Anclados", "Proyectos", "Recientes"), and the one asked for here.

            An earlier cut put the folders at the *bottom*, reasoning that the common case is the
            conversation from ten minutes ago and that collapsed folders above it would bury the
            common case under the filed one. That reasoning is not wrong in the abstract and it is
            wrong here: a folder is a place the user *chose* to put something, so it is a
            destination they navigate to deliberately, and burying the deliberate thing under the
            incidental one is the wrong way round. It also makes the drop targets the thing you have
            to scroll to find, which is the opposite of what a drag wants. Do not move it back. */}
        {pinned.length > 0 && (
          // Also an "ungrouped" drop target, and not as a convenience: a pinned conversation is by
          // definition a loose one — filing something now takes it out of the pinned list entirely
          // — so the two blocks are one destination that the folders happen to sit between. A
          // release here un-files; it does not pin, because pinning is a separate statement and
          // silently making one gesture mean both is how a drag stops being predictable.
          <div
            onPointerEnter={() => useChatDragStore.getState().hover("ungrouped")}
            onPointerMove={() => useChatDragStore.getState().hover("ungrouped")}
            className={`rounded-lg transition-colors ${
              overUngrouped && dragging?.fromGroupId
                ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]"
                : ""
            }`}
          >
            <GroupHeading text={t("chat.pinnedGroup")} />
            {pinned.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeId}
                locale={locale}
                siblings={perProvider[conversation.provider] ?? 1}
                onSelect={selectRow}
                onMenu={openMenu}
                onPressRow={pressRow}
              />
            ))}
          </div>
        )}

        {groups.length > 0 && <GroupHeading text={t("chat.groupsTitle")} />}
        {/* Empty folders are still drawn — a folder that disappears when its last chat is moved out
            is a folder the user has to create again, and they made it on purpose. It is also the
            only thing there is to aim a drag at. */}
        {groups.map((group) => (
          <FolderSection
            key={group.id}
            group={group}
            conversations={byGroup[group.id] ?? []}
            activeId={activeId}
            locale={locale}
            perProvider={perProvider}
            onSelect={selectRow}
            onMenu={openMenu}
            onPressRow={pressRow}
            active={activeGroupId === group.id}
            dropActive={overGroup === group.id && dragging?.fromGroupId !== group.id}
            dragging={dragging !== null}
          />
        ))}

        {/* The loose list, and a drop target in its own right: releasing here is how a filed
            conversation comes back out of a folder. It stays a target even when it is empty, which
            is why the wrapper is always rendered and only its contents are conditional — a user
            whose every chat is filed would otherwise have nowhere to drop one back to. */}
        <div
          onPointerEnter={() => useChatDragStore.getState().hover("ungrouped")}
          onPointerMove={() => useChatDragStore.getState().hover("ungrouped")}
          className={`rounded-lg transition-colors ${
            overUngrouped && dragging?.fromGroupId
              ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]"
              : ""
          } ${dragging ? "min-h-[36px]" : ""}`}
        >
          {/* The heading earns its place only when something sits above this list. A sidebar whose
              only content is six recent chats does not need to be told they are recent. */}
          {ungrouped.length > 0 && (groups.length > 0 || pinned.length > 0) && (
            <GroupHeading text={t("chat.recentGroup")} />
          )}
          {ungrouped.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === activeId}
              locale={locale}
              siblings={perProvider[conversation.provider] ?? 1}
              onSelect={selectRow}
              onMenu={openMenu}
              onPressRow={pressRow}
            />
          ))}
        </div>

        {archived.length > 0 && (
          <>
            <GroupHeading text={t("chat.archivedGroup")} />
            {archived.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeId}
                locale={locale}
                siblings={perProvider[conversation.provider] ?? 1}
                onSelect={selectRow}
                onMenu={openMenu}
                onPressRow={pressRow}
              />
            ))}
          </>
        )}

        {visible.length === 0 && (
          <p className="px-2 py-4 text-center text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {trimmed ? t("chat.searchNoMatches") : t("chat.sidebarEmpty")}
          </p>
        )}

        {bodyOnly.length > 0 && (
          <>
            <GroupHeading text={t("chat.foundInMessages")} />
            {bodyOnly.map((hit) => (
              <button
                key={hit.conversationId}
                type="button"
                onClick={() => void open(hit.conversationId)}
                className={`${ROW} ${ROW_IDLE} flex-col items-start gap-0.5`}
              >
                <span className="w-full truncate text-[12.5px]">{hit.title || t("chat.untitled")}</span>
                <span className="w-full truncate text-[10.5px] text-[var(--cf-text-muted)]">{hit.snippet}</span>
              </button>
            ))}
          </>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowArchived((v) => !v)}
        className="flex items-center gap-1.5 border-t border-[var(--cf-border)] px-3 py-1.5 text-left text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      >
        <Archive size={11} />
        {showArchived ? t("chat.hideArchived") : t("chat.showArchived")}
      </button>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {/* What is being dragged, following the pointer.
          A hand-rolled gesture gets no ghost from the browser — that is one of the things HTML5
          drag-and-drop would have given us and that Tauri's webview takes away (see
          `state/chatDragStore`). Without it the row stays where it was and nothing moves under the
          cursor, so the drag reads as a click that failed.

          `pointer-events-none` is not optional: this element sits directly under the cursor, and
          without it every `pointerenter` for the rest of the drag would land on the ghost instead
          of on the folder the user is aiming at — the drop target would never light up. */}
      {dragging && pointer && (
        <div
          className="pointer-events-none fixed z-50 max-w-[200px] truncate rounded-md border border-[var(--cf-accent)] bg-[var(--cf-surface)] px-2 py-1 text-[11.5px] shadow-lg"
          style={{ left: pointer.x + 12, top: pointer.y + 12 }}
        >
          {dragging.title || t("chat.untitled")}
        </div>
      )}
    </div>
  );
}

/**
 * One folder in the sidebar: a heading that collapses, and the conversations filed under it.
 *
 * `collapsed` is persisted on the row rather than held here, so the shape of the sidebar survives a
 * restart and looks the same in a detached window. The toggle writes optimistically — collapsing a
 * folder has to feel instant, and the worst a failed write costs is a folder that reopens next
 * launch.
 *
 * Deleting a folder is in this menu and not on the rows, and its label says what happens to the
 * contents. That sentence is the whole reason the menu item reads the way it does: "delete folder"
 * next to a list of conversations is ambiguous in exactly the way that loses someone's work, and
 * the backend backs the promise up — `delete_group` clears `group_id` in the same transaction that
 * removes the row.
 */
function FolderSection({
  group,
  conversations,
  activeId,
  locale,
  perProvider,
  onSelect,
  onMenu,
  onPressRow,
  active,
  dropActive,
  dragging,
}: {
  group: ChatGroup;
  conversations: ChatConversation[];
  activeId: string | null;
  locale: string;
  perProvider: Record<string, number>;
  onSelect: (id: string) => void;
  onMenu: (event: React.MouseEvent, conversation: ChatConversation) => void;
  onPressRow: (event: React.PointerEvent, conversation: ChatConversation) => void;
  /** This project's own page is the thing on screen. */
  active: boolean;
  /** Releasing now would file into this folder. Drawn, because a drop target the user cannot see
   *  is a drop target they aim at by luck. */
  dropActive: boolean;
  /** Whether any drag is live, which is what opens a collapsed folder's landing strip. */
  dragging: boolean;
}) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const store = useConversationStore();

  const items: MenuItem[] = [
    {
      label: t("chat.groupRename"),
      icon: Pencil,
      onClick: () => {
        void promptAction(t("chat.groupRename"), { initial: group.name }).then((name) => {
          if (name?.trim()) void store.renameGroup(group.id, name.trim(), group.color);
        });
      },
    },
    {
      label: t("chat.groupDelete"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () => {
        // The hint is in the message, not just in the docs: "delete folder" next to a list of
        // conversations is ambiguous in exactly the way that loses someone's work, so the dialog
        // says the chats are kept before the user presses anything.
        void confirmAction(
          `${group.name} — ${t("chat.groupDeleteHint")}`,
          true,
          t("chat.groupDelete"),
        ).then((yes) => {
          if (yes) void store.deleteGroup(group.id);
        });
      },
    },
  ];

  return (
    <div
      onPointerEnter={() => useChatDragStore.getState().hover(group.id)}
      onPointerMove={() => useChatDragStore.getState().hover(group.id)}
      className={`rounded-lg transition-colors ${
        dropActive ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]" : ""
      }`}
    >
      {/* Two affordances on one row, and the split matters: the chevron folds the list, the name
          opens the project's own page. A project is a place you go — it holds instructions and
          shared documents — so its name must lead somewhere, and collapsing must stay reachable
          without leaving where you are. Nested buttons are invalid HTML, so this is a row with two
          buttons rather than a button containing one. */}
      <div
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        className={`mt-3 flex w-full items-center gap-1 px-1.5 pb-1 text-[10.5px] uppercase tracking-wide ${
          active ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
        }`}
      >
        <button
          type="button"
          onClick={() => void store.toggleGroup(group.id)}
          aria-label={group.collapsed ? t("chat.groupExpand") : t("chat.groupCollapse")}
          className="shrink-0 rounded hover:text-[var(--cf-text)]"
        >
          {group.collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
        <button
          type="button"
          onClick={() => void store.openGroup(group.id)}
          title={t("chat.groupOpen")}
          className="min-w-0 flex-1 truncate text-left uppercase hover:text-[var(--cf-text)]"
        >
          {group.name}
        </button>
        <span className="shrink-0 normal-case tracking-normal">
          {conversations.length > 0 ? conversations.length : t("chat.groupEmpty")}
        </span>
      </div>

      {!group.collapsed &&
        conversations.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            active={conversation.id === activeId}
            locale={locale}
            siblings={perProvider[conversation.provider] ?? 1}
            onSelect={onSelect}
            onMenu={onMenu}
            onPressRow={onPressRow}
          />
        ))}

      {/* A collapsed folder is one line of text, which is a hard thing to aim a drag at — and an
          empty one is no taller. So while a drag is live every folder keeps a landing strip under
          its heading, which is what turns "hit the label exactly" into "drop anywhere near it".
          It costs nothing when nothing is being dragged, because it is not rendered then. */}
      {dragging && (group.collapsed || conversations.length === 0) && (
        <div className="mx-1.5 mb-1 h-6 rounded-md border border-dashed border-[var(--cf-border)]" />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function GroupHeading({ text }: { text: string }) {
  return (
    <p className="px-2 pb-0.5 pt-2 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
      {text}
    </p>
  );
}

/**
 * One conversation.
 *
 * Memoised on primitives plus the row object, because this list is the thing on screen during every
 * token of every reply: the active conversation's `updated_at` changes when a turn lands, and
 * without this every other row in a list of two hundred re-renders with it.
 *
 * The triangle on the right is the honest mark and it is deliberately not decoration: it appears
 * only on an engine whose resume is ambiguous *and* only when a second conversation on that engine
 * exists — the exact condition under which opening this row can pull in another chat's context.
 * (The other honest hazard, an engine that cannot resume at all and therefore re-sends the whole
 * transcript every turn, is shown under the composer instead, where the real turn count lives; a
 * row in this list only knows how many turns a conversation has if it happens to be one of the five
 * the store is holding.)
 */
const ConversationRow = memo(function ConversationRow({
  conversation,
  active,
  locale,
  siblings,
  onSelect,
  onMenu,
  onPressRow,
}: {
  conversation: ChatConversation;
  active: boolean;
  locale: string;
  /** How many live conversations share this row's provider, this one included. */
  siblings: number;
  onSelect: (id: string) => Promise<void> | void;
  onMenu: (event: React.MouseEvent, conversation: ChatConversation) => void;
  /** Arms a drag. The row does not decide whether one has begun — that is the scroller's job, from
   *  the distance travelled — because the pointer leaves this row within a few pixels. */
  onPressRow?: (event: React.PointerEvent, conversation: ChatConversation) => void;
}) {
  const t = useT();
  // Read from the live session rather than from the row: "a turn is in flight" is a fact about this
  // window's memory, not about the database, and the list row is refreshed only when the backend
  // says something changed.
  const running = useConversationStore(
    (s) => s.byConversation[conversation.id]?.sending ?? false,
  );
  const caps = providerCapabilities(conversation.provider);
  const name = providerDisplayLabel(conversation.provider, t);
  const when = relativeTime(conversation.updatedAt, locale);

  const crossTalk = caps.resumeIsAmbiguous && siblings > 1;

  /** Running beats unread beats failed, and the order is the point: a thread whose last turn failed
   *  but which is being retried right now is *running*, and saying "failed" over a live run would
   *  be describing the past. `unread` outranks `failed` for the same reason in reverse — the flag
   *  is set by the same write that recorded the failure, so an unseen failure is unread, and once
   *  it has been opened the ring is what remains to say the last turn died. */
  const status: ConversationStatus = running
    ? "running"
    : conversation.unread
      ? "unread"
      : conversation.lastFailed
        ? "failed"
        : "read";

  return (
    <button
      type="button"
      onPointerDown={(event) => onPressRow?.(event, conversation)}
      onClick={() => void onSelect(conversation.id)}
      onContextMenu={(event) => onMenu(event, conversation)}
      className={`${ROW} ${active ? ROW_ACTIVE : ROW_IDLE} ${conversation.archivedAt ? "opacity-55" : ""}`}
    >
      <StatusDot status={status} />
      <ProviderGlyph providerId={conversation.provider} size={12} className="shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate">{conversation.title || t("chat.untitled")}</span>
      {conversation.parentConversationId && (
        <GitBranch size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
      )}
      {crossTalk && (
        // A native `title` rather than a tooltip component: the row is already a button carrying a
        // context menu, and a third interactive layer on it would fight both.
        <span title={t("chat.ambiguousResumeWarning", { provider: name })} className="shrink-0">
          <AlertTriangle size={11} className="text-[var(--cf-warning)]" />
        </span>
      )}
      {when && (
        <span className="shrink-0 text-[10px] tabular-nums text-[var(--cf-text-muted)] opacity-0 group-hover/row:opacity-100">
          {when}
        </span>
      )}
    </button>
  );
});
