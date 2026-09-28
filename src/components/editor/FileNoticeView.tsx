import { useState } from "react";
import { ExternalLink, FileQuestion, FileWarning, HardDrive, RotateCw } from "lucide-react";
import { openInDefaultApp } from "../../lib/tauri/commands";
import type { FileNotice } from "../../lib/editorFiles";
import { formatBytes } from "../../state/systemLoadStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { buttonClass } from "../common/Button";

/**
 * What an editor tab shows when its file is not text it can edit — see `FileNotice`. Nothing here is
 * a buffer: there is nothing to type into, so nothing a save could write back over the file.
 *
 * Terse on purpose: one line saying what the file is, and the buttons for what can be done about it.
 */
export function FileNoticeView({
  notice,
  path,
  repoPath,
  onRetry,
  onOpenAnyway,
}: {
  notice: FileNotice;
  path: string;
  repoPath: string;
  onRetry: () => void;
  onOpenAnyway: () => void;
}) {
  const t = useT();
  const openExternally = () =>
    void openInDefaultApp(repoPath, path).catch((e: unknown) => pushErrorToast(String(e)));

  if (notice.kind === "image") return <ImageView src={notice.src} mime={notice.mime} size={notice.size} name={path} />;

  const external = (
    <button onClick={openExternally} className={buttonClass({ variant: "ghost", size: "sm" })}>
      <ExternalLink size={13} />
      {t("editor.noticeOpenExternal")}
    </button>
  );

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      {notice.kind === "error" ? (
        <>
          <FileWarning size={28} className="text-[var(--cf-danger)]" />
          <p className="text-[13px] text-[var(--cf-text)]">{t("editor.noticeError")}</p>
          {/* Selectable: an error worth reading is an error worth copying into a search. */}
          <p className="max-w-[560px] select-text break-words font-mono text-[12px] text-[var(--cf-text-muted)]">
            {notice.message}
          </p>
          <button onClick={onRetry} className={buttonClass({ variant: "secondary", size: "sm" })}>
            <RotateCw size={13} />
            {t("editor.noticeRetry")}
          </button>
        </>
      ) : notice.kind === "binary" ? (
        <>
          <FileQuestion size={28} className="text-[var(--cf-text-faint)]" />
          <p className="text-[13px] text-[var(--cf-text-muted)]">
            {t("editor.noticeBinary", { size: formatBytes(notice.size) })}
          </p>
          {external}
        </>
      ) : (
        <>
          <HardDrive size={28} className="text-[var(--cf-text-faint)]" />
          <p className="text-[13px] text-[var(--cf-text-muted)]">
            {t("editor.noticeTooLarge", { size: formatBytes(notice.size) })}
          </p>
          <div className="flex items-center gap-2">
            {notice.canForce && (
              <button onClick={onOpenAnyway} className={buttonClass({ variant: "secondary", size: "sm" })}>
                {t("editor.noticeOpenAnyway")}
              </button>
            )}
            {external}
          </div>
        </>
      )}
    </div>
  );
}

/** An image, on a checkerboard so a transparent one reads as transparent, with its size under it. */
function ImageView({ src, mime, size, name }: { src: string; mime: string; size: number; name: string }) {
  const [dimensions, setDimensions] = useState<string | null>(null);
  return (
    <div className="flex h-full flex-col">
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6"
        style={{
          backgroundImage: "repeating-conic-gradient(var(--cf-sunken) 0% 25%, transparent 0% 50%)",
          backgroundSize: "16px 16px",
        }}
      >
        <img
          src={src}
          alt={name}
          className="max-h-full max-w-full object-contain"
          onLoad={(e) => {
            // Read now, not inside an updater: React runs those later, when the event is gone.
            const image = e.currentTarget;
            setDimensions(`${image.naturalWidth} × ${image.naturalHeight}`);
          }}
        />
      </div>
      <div className="shrink-0 border-t border-[var(--cf-border)] px-3.5 py-1 text-[11px] text-[var(--cf-text-faint)]">
        {[dimensions, mime, formatBytes(size)].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
}
