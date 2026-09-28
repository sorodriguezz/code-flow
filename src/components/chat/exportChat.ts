import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Braces, FileText, type LucideIcon } from "lucide-react";
import {
  conversationToJson,
  conversationToMarkdown,
  exportFileName,
  type ExportConversation,
  type ExportFormat,
  type ExportTurn,
} from "../../lib/chatExport";
import { chatGetConversation, chatListAttachments } from "../../lib/tauri/chatCommands";
import { getChatConversation, writeFileBytes } from "../../lib/tauri/commands";
import { parseTrace } from "../../lib/turnTrace";
import { pathsOf, traceOf, useConversationStore } from "../../state/conversationStore";
import { useChatStore } from "../../state/chatStore";
import { translate } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import type { MenuItem } from "../common/ContextMenu";

/**
 * Saving a conversation as a file, from either chat: the chat workspace's sidebar and a repository
 * chat in the assistant. Both read the conversation **from disk** rather than from what is on
 * screen — the export is the record, and a transcript a window is holding may have been trimmed or
 * may still be mid-turn — and only ask for traces when the export includes them.
 */

/** The four ways out, as menu entries. The process is a second entry per format rather than a
 * checkbox: a menu that holds its own settings is a form, and this is two clicks. */
export function exportMenuItems(run: (format: ExportFormat, traces: boolean) => void): MenuItem[] {
  const entry = (format: ExportFormat, traces: boolean, icon: LucideIcon, key: Parameters<typeof translate>[0]) => ({
    label: translate(key),
    icon,
    onClick: () => run(format, traces),
  });
  return [
    entry("markdown", false, FileText, "chat.exportMarkdown"),
    entry("markdown", true, FileText, "chat.exportMarkdownTraces"),
    { ...entry("json", false, Braces, "chat.exportJson"), separated: true },
    entry("json", true, Braces, "chat.exportJsonTraces"),
  ];
}

/** Writes the file, after the platform's save dialog. Cancelling the dialog is not an error. */
export async function saveConversationExport(conversation: ExportConversation, format: ExportFormat): Promise<void> {
  const text =
    format === "markdown"
      ? conversationToMarkdown(conversation, {
          exported: translate("chat.exportExported"),
          repository: translate("chat.exportRepository"),
          attachments: translate("chat.exportAttachments"),
          you: translate("chat.exportYou"),
          assistant: translate("chat.exportAssistant"),
          error: translate("chat.exportError"),
          stopped: translate("chat.exportStopped"),
          outputs: translate("chat.exportOutputs"),
          process: (steps) => translate("ai.traceSteps", { n: steps }),
        })
      : conversationToJson(conversation);
  const extension = format === "markdown" ? "md" : "json";
  const path = await saveDialog({
    defaultPath: exportFileName(conversation.title, format),
    filters: [{ name: format === "markdown" ? "Markdown" : "JSON", extensions: [extension] }],
  });
  if (!path) return;
  await writeFileBytes(path, new TextEncoder().encode(text));
  const name = path.split(/[\\/]/).pop() ?? path;
  useToastStore.getState().pushToast(translate("chat.exported", { name }), "success");
}

/** A chat-workspace conversation, read from disk, attachments referenced by path. */
export async function exportChatConversation(conversationId: string, format: ExportFormat, traces: boolean) {
  try {
    const [rows, attachments] = await Promise.all([
      chatGetConversation(conversationId, traces),
      chatListAttachments(conversationId).catch(() => []),
    ]);
    const meta = useConversationStore.getState().conversations.find((c) => c.id === conversationId);
    const turns: ExportTurn[] = rows.map((row) => ({
      role: row.role,
      content: row.content,
      createdAt: row.createdAt,
      provider: row.provider ?? undefined,
      model: row.model ?? undefined,
      isError: row.isError,
      isCancelled: row.isCancelled,
      outputs: pathsOf(row.outputs),
      trace: traces ? traceOf(row.trace) : undefined,
    }));
    await saveConversationExport(
      {
        title: meta?.title ?? "",
        exportedAt: new Date().toISOString(),
        attachments: attachments.map((file) => ({ name: file.name, path: file.path, bytes: file.bytes })),
        turns,
      },
      format,
    );
  } catch (e: unknown) {
    pushErrorToast(String(e));
  }
}

/** A repository chat from the assistant, read from disk. It has no attachments to reference. */
export async function exportRepoConversation(
  projectId: string,
  conversationId: string,
  repository: string,
  format: ExportFormat,
  traces: boolean,
) {
  try {
    const entries = await getChatConversation(projectId, conversationId, traces);
    const turns: ExportTurn[] = entries.flatMap((entry) => [
      { role: "user" as const, content: entry.question, createdAt: entry.created_at },
      {
        role: "assistant" as const,
        content: entry.answer,
        createdAt: entry.created_at,
        provider: entry.provider ?? undefined,
        model: entry.model ?? undefined,
        isError: entry.is_error,
        trace: traces ? parseTrace(entry.trace) : undefined,
      },
    ]);
    const title = useChatStore.getState().byConversation[conversationId]?.title || entries[0]?.question || "";
    await saveConversationExport(
      { title, repository, exportedAt: new Date().toISOString(), attachments: [], turns },
      format,
    );
  } catch (e: unknown) {
    pushErrorToast(String(e));
  }
}
