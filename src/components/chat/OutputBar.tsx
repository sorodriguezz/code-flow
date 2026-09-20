import { useCallback, useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Download, FileDown } from "lucide-react";
import { chatReadOutput, chatSaveOutput, type ChatOutput } from "../../lib/tauri/chatCommands";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";

/** Human-readable size. Bytes below a kilobyte are shown as bytes, because "0.0 KB" reads as a
 *  failure and an empty file is worth noticing. The same rule `AttachmentBar` uses. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The files a turn produced, under the answer that produced them.
 *
 * The mirror of `AttachmentBar`, and the distinction is worth keeping in view: that bar holds files
 * the user gave the model, this one holds files the model gave the user.
 *
 * # Why these are chips and not links
 *
 * The file is real and it is on disk already, in the conversation's own working directory, from the
 * moment the engine wrote it. But that directory is under the app's state root, which is somewhere
 * no user should be asked to go, and a path that long on a chip is unreadable. So the chip does the
 * one thing worth doing with it: a save dialog, and a copy to wherever they point it.
 *
 * **A copy, never a move.** The original stays put, because the next turn may be "add a column to
 * that spreadsheet" and the engine has to find it. Saving the same file twice is therefore ordinary
 * rather than an error, which is also what makes the chip safe to click without thinking.
 *
 * # Why it is under the answer and not in a strip above the composer
 *
 * It was a strip first, and the strip was wrong in the ordinary case: a conversation that produced
 * three spreadsheets over three turns showed all three at once, in a place with nothing to say
 * which question each answered — and it showed the scaffolding of the last build beside them. A
 * file is a *result*, and a result belongs with the answer that announced it.
 *
 * Which takes two records rather than one, and both are needed. `chat_messages.outputs` says which
 * paths this turn wrote — derived by diffing the working directory across the run, because the
 * directory is a flat set of files with no memory of which turn made which. The directory itself
 * still says what exists and how big it is, so a file deleted from disk quietly stops being offered
 * instead of leaving a chip that fails when pressed.
 */
/** What a `data:` URL has to call each of the image types the backend recognises. */
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/**
 * One produced image, shown rather than merely offered.
 *
 * # Why a `data:` URL and not a path
 *
 * The file is on disk, but the webview cannot read a path: this app enables no asset protocol, and
 * adding one would mean granting the whole frontend a filesystem scope in order to draw a
 * thumbnail. So the bytes come back through the same IPC boundary as everything else and are
 * inlined. `chat_read_output` refuses anything over 8 MB, which is far above what a model draws.
 *
 * # Why it fails quietly
 *
 * An image that will not load leaves the chip, and the chip still saves the file. A preview is the
 * nicer half of this component, not the working half — a red box where a picture should be would
 * make a file the user can perfectly well download look broken.
 */
function OutputImage({ conversationId, file }: { conversationId: string; file: ChatOutput }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      const mime = MIME[extension];
      if (!mime) return;
      try {
        const bytes = await chatReadOutput(conversationId, file.path);
        if (cancelled) return;
        // Chunked, because `String.fromCharCode(...bytes)` on a megabyte of pixels is a call with a
        // million arguments and blows the stack on every engine that has one.
        let binary = "";
        const CHUNK = 8192;
        for (let at = 0; at < bytes.length; at += CHUNK) {
          binary += String.fromCharCode(...bytes.slice(at, at + CHUNK));
        }
        setSrc(`data:${mime};base64,${btoa(binary)}`);
      } catch {
        // Too large, or gone since the listing. The chip below still offers it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, file.path, file.name]);

  if (!src) return null;
  return (
    <img
      src={src}
      alt={file.name}
      // Capped rather than sized: a transcript is a reading column, and an image that sets its own
      // height pushes the answer it belongs to off the screen.
      className="max-h-[260px] max-w-full rounded-lg border border-[var(--cf-border)] object-contain"
    />
  );
}

export function OutputBar({
  conversationId,
  files,
  label = true,
}: {
  conversationId: string;
  files: ChatOutput[];
  /** Whether to print "Files from this chat" before the chips. Off under an answer, where the
   *  chips are already under the turn that made them and the sentence would be a caption on a
   *  photograph of itself. */
  label?: boolean;
}) {
  const t = useT();

  const save = useCallback(
    async (file: ChatOutput) => {
      try {
        const destination = await saveDialog({ defaultPath: file.name });
        if (!destination) return;
        await chatSaveOutput(conversationId, file.path, destination);
      } catch (e) {
        // A file the engine has since removed, a directory the user cannot write to. Both are worth
        // saying: a chip that does nothing when pressed reads as the app losing the file.
        pushErrorToast(String(e));
      }
    },
    [conversationId],
  );

  if (files.length === 0) return null;

  const images = files.filter((file) => file.isImage);

  return (
    <div className="px-1 pb-1.5">
      {/* Above the chips, because for an image the chip is the *secondary* affordance: you want to
          look at it, and only then decide whether to keep it. */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 pb-1.5">
          {images.map((file) => (
            <OutputImage key={file.path} conversationId={conversationId} file={file} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
      {label && (
        <span className="flex items-center gap-1 text-[10.5px] text-[var(--cf-text-muted)]">
          <FileDown size={11} />
          {t("chat.outputsLabel")}
        </span>
      )}
      {files.map((file) => (
        <button
          key={file.path}
          type="button"
          onClick={() => void save(file)}
          // The relative path, not the name: two files called `datos.csv` in different
          // subdirectories are two chips that would otherwise be indistinguishable.
          title={t("chat.outputSave", { name: file.path })}
          className="group flex max-w-[240px] items-center gap-1.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-2)] px-2 py-1 text-[11.5px] text-[var(--cf-text)] transition-colors hover:border-[var(--cf-accent)]"
        >
          <Download size={11} className="shrink-0 text-[var(--cf-text-muted)] group-hover:text-[var(--cf-accent)]" />
          <span className="truncate">{file.name}</span>
          <span className="shrink-0 text-[10.5px] text-[var(--cf-text-muted)]">{size(file.bytes)}</span>
        </button>
      ))}
      </div>
    </div>
  );
}
