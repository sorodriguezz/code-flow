import { useEffect, useState } from "react";
import { MessageSquare, Search, Trash2, X } from "lucide-react";
import { listChatConversations } from "../../lib/tauri/commands";
import { useChatHistoryStore } from "../../state/activityStore";
import { useChatStore } from "../../state/chatStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { ChatConversationSummary } from "../../types/domain";

export function ChatHistoryModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const t = useT();
  const activeSessionId = useChatStore((s) => s.byProject[projectId]?.sessionId ?? null);
  const switchTo = useChatStore((s) => s.switchTo);
  const remove = useChatHistoryStore((s) => s.remove);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChatConversationSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listChatConversations(projectId, query.trim() || undefined).then((r) => {
      if (!cancelled) setResults(r);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, query]);

  const open = async (sessionId: string) => {
    await switchTo(projectId, sessionId);
    onClose();
  };

  const handleDelete = async (sessionId: string) => {
    if (!(await confirmAction(t("chatHistory.confirmDelete")))) return;
    await remove(projectId, sessionId);
    setResults((r) => r?.filter((c) => c.session_id !== sessionId) ?? r);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-16" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[75vh] w-[540px] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--cf-border)] px-3 py-2">
          <p className="text-[13px] font-semibold">{t("chatHistory.modalTitle")}</p>
          <button onClick={onClose} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
            <X size={15} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <Search size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder={t("chatHistory.search")}
            className="flex-1 bg-transparent text-[13px] outline-none"
          />
        </div>

        <div className="flex-1 overflow-auto p-2">
          {results !== null && results.length === 0 && (
            <p className="px-2 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">
              {t("chatHistory.noMatches")}
            </p>
          )}
          {results !== null && results.length > 0 && (
            <div className="space-y-1">
              {results.map((conv) => (
                <div
                  key={conv.session_id}
                  className={`group flex items-start gap-2 rounded-lg border p-2.5 ${
                    conv.session_id === activeSessionId
                      ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
                      : "border-[var(--cf-border)] hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                  }`}
                >
                  <button onClick={() => open(conv.session_id)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
                    <MessageSquare size={13} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-[var(--cf-text)]">{conv.title}</p>
                      <p className="mt-0.5 text-[10px] text-[var(--cf-text-muted)]">
                        {new Date(conv.updated_at).toLocaleString()}
                      </p>
                    </div>
                  </button>
                  <button
                    onClick={() => handleDelete(conv.session_id)}
                    title={t("chatHistory.delete")}
                    className="shrink-0 text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-danger)] group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
