import { FileText, ImageIcon, X } from "lucide-react";
import type { ChatAttachment } from "../../lib/tauri/chatCommands";
import { useT } from "../../state/languageStore";

/** Human-readable size. Bytes below a kilobyte are shown as bytes, because "0.0 KB" reads as a
 *  failure and an empty file is worth noticing. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The files staged for the next turn, above the composer.
 *
 * # These are already on disk
 *
 * Nothing here is a pending upload. A file is copied into the conversation's own folder the moment
 * it is picked, so a chip is a view of something that exists — which is why removing one is a real
 * deletion and not a cancelled intent. That ordering is deliberate: it means a half-composed
 * message with three attachments survives the app being closed, and it means the path shown to the
 * engine is stable from the moment the user sees the chip.
 *
 * # Why an image chip can still say the model will not see it
 *
 * Attaching works on all six engines, because the message names the absolute paths and every one of
 * these CLIs has a file-reading tool. *Seeing* an image is a different capability, and only Codex
 * has a flag that hands a model an actual image. So a PNG attached to a provider that cannot see
 * one is not refused — the model can still be told it is there, and some can read it — but the chip
 * says so rather than letting the user believe they sent a screenshot to something that will read
 * it as bytes.
 */
export function AttachmentBar({
  files,
  canSeeImages,
  onRemove,
}: {
  files: ChatAttachment[];
  /** Whether this conversation's engine can look at an image as an image. */
  canSeeImages: boolean;
  onRemove: (attachmentId: string) => void;
}) {
  const t = useT();
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
      {files.map((file) => {
        const blind = file.isImage && !canSeeImages;
        return (
          <span
            key={file.id}
            title={blind ? t("chat.attachImageBlind") : file.path}
            className={`group flex max-w-[240px] items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] ${
              blind
                ? "border-[var(--cf-warning)]/40 bg-[color-mix(in_oklab,var(--cf-warning)_8%,transparent)]"
                : "border-[var(--cf-border)] bg-[var(--cf-surface-2)]"
            }`}
          >
            {file.isImage ? (
              <ImageIcon size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            ) : (
              <FileText size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            )}
            <span className="truncate">{file.name}</span>
            <span className="shrink-0 text-[10.5px] text-[var(--cf-text-muted)]">{size(file.bytes)}</span>
            <button
              type="button"
              onClick={() => onRemove(file.id)}
              aria-label={t("chat.attachRemove")}
              className="shrink-0 rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
            >
              <X size={11} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
