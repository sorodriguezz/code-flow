import type { AiRunLine } from "../state/aiRunStore";

/**
 * A conversation written out as a file — Markdown to read or paste somewhere, JSON to keep or feed
 * to something else.
 *
 * One shape for both chats: the chat workspace (`conversationStore`) and a repository's chat in the
 * assistant (`chatStore`) hold different row types, and each builds this from its own before
 * handing it over, so the two exports cannot drift apart.
 *
 * **Attachments are referenced, never embedded.** A spreadsheet in a Markdown file is noise, and in
 * JSON a base64 blob the size of the file; what the reader needs is which file was attached and
 * where it lives. The same for the files a turn wrote. **Traces are optional**: the process behind an
 * answer is often the longest part of a conversation and rarely what is being shared.
 */

export type ExportFormat = "markdown" | "json";

export interface ExportTurn {
  role: "user" | "assistant";
  content: string;
  /** RFC 3339. */
  createdAt?: string;
  provider?: string;
  model?: string;
  isError?: boolean;
  isCancelled?: boolean;
  /** Files this turn wrote, as paths relative to where the conversation keeps them. */
  outputs?: string[];
  /** Only present when the export was asked to include traces. */
  trace?: AiRunLine[];
}

export interface ExportAttachment {
  name: string;
  path: string;
  bytes?: number;
}

export interface ExportConversation {
  title: string;
  /** The repository the conversation was about, when it was about one. */
  repository?: string;
  /** RFC 3339 — when the file was written. */
  exportedAt: string;
  attachments: ExportAttachment[];
  turns: ExportTurn[];
}

/** The words the Markdown uses, handed in by the caller so this module stays free of the language
 * store — the headings are for a person, in their language. */
export interface ExportLabels {
  exported: string;
  repository: string;
  attachments: string;
  you: string;
  assistant: string;
  error: string;
  stopped: string;
  outputs: string;
  /** Already carrying the step count, e.g. "Process · 12 steps". */
  process: (steps: number) => string;
}

/** The app's markers (`QUOTA_EXCEEDED::`, `REPO_BUSY::`…) kept in a failed turn's text so the
 * transcript can re-derive its banner. A file has no banner to derive, so they go. */
function withoutMarker(text: string): string {
  return text.replace(/^[A-Z][A-Z_]+::/, "");
}

function stamp(iso: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  // Stable and locale-free: the file outlives the machine's settings, and a reader in another
  // country should see the same instant.
  return at.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** A fence long enough that nothing inside the block can close it early. */
function fence(body: string): string {
  let ticks = "```";
  while (body.includes(ticks)) ticks += "`";
  return ticks;
}

export function conversationToMarkdown(conversation: ExportConversation, labels: ExportLabels): string {
  const lines: string[] = [`# ${conversation.title.trim() || "—"}`, ""];
  lines.push(`- ${labels.exported}: ${stamp(conversation.exportedAt)}`);
  if (conversation.repository) lines.push(`- ${labels.repository}: ${conversation.repository}`);
  if (conversation.attachments.length > 0) {
    lines.push(`- ${labels.attachments}:`);
    for (const file of conversation.attachments) lines.push(`  - ${file.name} — \`${file.path}\``);
  }
  lines.push("");

  for (const turn of conversation.turns) {
    lines.push("---", "");
    const who =
      turn.role === "user"
        ? labels.you
        : [labels.assistant, turn.provider, turn.model].filter((part) => part && part.trim()).join(" · ");
    const when = stamp(turn.createdAt);
    lines.push(`## ${who}${when ? ` · ${when}` : ""}`, "");
    if (turn.isCancelled) {
      lines.push(`_${labels.stopped}_`, "");
    } else if (turn.isError) {
      const text = withoutMarker(turn.content).trim();
      lines.push(`> **${labels.error}:** ${text.replace(/\n/g, "\n> ")}`, "");
    } else if (turn.content.trim()) {
      lines.push(turn.content.trim(), "");
    }
    if (turn.outputs && turn.outputs.length > 0) {
      lines.push(`${labels.outputs}:`);
      for (const path of turn.outputs) lines.push(`- \`${path}\``);
      lines.push("");
    }
    if (turn.trace && turn.trace.length > 0) {
      const body = turn.trace.map((line) => line.text).join("\n");
      const ticks = fence(body);
      lines.push(
        `<details><summary>${labels.process(turn.trace.length)}</summary>`,
        "",
        ticks,
        body,
        ticks,
        "",
        "</details>",
        "",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The same conversation as data. Keys in English whatever the interface language — this is for
 * programs, and a program should not have to know which language exported it. */
export function conversationToJson(conversation: ExportConversation): string {
  return `${JSON.stringify(
    {
      title: conversation.title,
      repository: conversation.repository ?? null,
      exportedAt: conversation.exportedAt,
      attachments: conversation.attachments,
      turns: conversation.turns.map((turn) => ({
        role: turn.role,
        content: turn.isError ? withoutMarker(turn.content) : turn.content,
        createdAt: turn.createdAt ?? null,
        provider: turn.provider ?? null,
        model: turn.model ?? null,
        isError: turn.isError ?? false,
        isCancelled: turn.isCancelled ?? false,
        outputs: turn.outputs ?? [],
        ...(turn.trace ? { trace: turn.trace.map((line) => ({ stream: line.stream, text: line.text })) } : {}),
      })),
    },
    null,
    2,
  )}\n`;
}

/** A file name the three platforms all accept, from whatever the conversation is called. */
export function exportFileName(title: string, format: ExportFormat): string {
  const base =
    title
      // Characters Windows refuses in a name, the path separators, and control characters.
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "")
      .slice(0, 80) || "conversation";
  return `${base}.${format === "markdown" ? "md" : "json"}`;
}
