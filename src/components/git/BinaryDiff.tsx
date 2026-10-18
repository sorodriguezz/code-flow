import { useEffect, useState } from "react";
import { Columns2, Download, FileQuestion, Layers, LoaderCircle, SplitSquareHorizontal } from "lucide-react";
import { Segmented } from "../common/Segmented";
import { buttonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { useRepoStore } from "../../state/repoStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { gitFileSide, gitLfsPull, type FileSide } from "../../lib/tauri/gitCommands";
import type { FileDiffInfo } from "../../types/domain";

/**
 * Where a diff's two sides can be read from: `WORKDIR`, `INDEX`, or a revision (`HEAD`,
 * `<commit>`, `<commit>^`). Handed to `DiffView` by the views that know — the Changes screen and the
 * graph — so a binary change can be drawn instead of named.
 */
export interface DiffSides {
  repoPath: string;
  old: string;
  new: string;
}

/** The first line of a Git LFS pointer — a diff whose lines are these is a pointer's diff. */
const LFS_VERSION_LINE = "version https://git-lfs.github.com/spec/v1";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

function imageType(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_TYPES[ext] ?? null;
}

/** Whether a file's change is better shown as its two sides than as lines: a binary file, or an
 *  LFS pointer (whose "lines" are an oid and a size). */
export function showsAsBinary(file: FileDiffInfo): boolean {
  if (file.binary) return true;
  return file.hunks.some((hunk) => hunk.lines.some((line) => line.content.trimEnd() === LFS_VERSION_LINE));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ImageMode = "side" | "swipe" | "onion";

/**
 * A binary change, shown as what it is: two images — side by side, behind a slider, or one over
 * the other — or, for anything else, the two sizes. An LFS file is followed to its object; one not
 * downloaded yet says so and offers `git lfs pull`, rather than drawing a pointer as the file.
 */
export function BinaryDiff({ file, sides }: { file: FileDiffInfo; sides: DiffSides }) {
  const t = useT();
  const oldPath = file.old_path ?? file.new_path ?? "";
  const newPath = file.new_path ?? file.old_path ?? "";
  const [pair, setPair] = useState<{ key: string; old: FileSide; new: FileSide } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ImageMode>("side");
  const [pulling, setPulling] = useState(false);
  const [nonce, setNonce] = useState(0);
  const key = `${sides.repoPath}\n${sides.old}\n${sides.new}\n${oldPath}\n${newPath}\n${nonce}`;

  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([gitFileSide(sides.repoPath, oldPath, sides.old), gitFileSide(sides.repoPath, newPath, sides.new)])
      .then(([before, after]) => live && setPair({ key, old: before, new: after }))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [key, sides.repoPath, sides.old, sides.new, oldPath, newPath]);

  const pull = async () => {
    setPulling(true);
    try {
      await gitLfsPull(sides.repoPath);
      pushSuccessToast(t("binaryDiff.lfsPulled"));
      await useRepoStore.getState().refreshStatus();
      setNonce((n) => n + 1);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setPulling(false);
    }
  };

  if (error) return <p className="p-4 text-[12.5px] text-[var(--cf-danger)]">{error}</p>;
  if (!pair || pair.key !== key) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle size={16} className="animate-spin text-[var(--cf-text-muted)]" />
      </div>
    );
  }

  const type = imageType(newPath) ?? imageType(oldPath);
  const missingLfs = [pair.old, pair.new].some((side) => side.lfs && !side.lfs.downloaded);
  const src = (side: FileSide) => (type && side.data ? `data:${type};base64,${side.data}` : null);
  const before = src(pair.old);
  const after = src(pair.new);
  const delta = pair.new.size - pair.old.size;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)]">
        <span className="tabular-nums">
          {pair.old.exists ? formatSize(pair.old.size) : t("binaryDiff.none")} → {pair.new.exists ? formatSize(pair.new.size) : t("binaryDiff.none")}
          {pair.old.exists && pair.new.exists && delta !== 0 && (
            <span className={delta > 0 ? "text-[var(--cf-danger)]" : "text-[var(--cf-success)]"}>
              {" "}
              ({delta > 0 ? "+" : "−"}
              {formatSize(Math.abs(delta))})
            </span>
          )}
        </span>
        {(pair.old.lfs || pair.new.lfs) && <span className={chipClass("neutral")}>Git LFS</span>}
        <span className="flex-1" />
        {missingLfs && (
          <button type="button" disabled={pulling} onClick={() => void pull()} className={buttonClass({ variant: "secondary", size: "sm" })}>
            {pulling ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />}
            {t("binaryDiff.lfsPull")}
          </button>
        )}
        {before && after && (
          <Segmented<ImageMode>
            size="sm"
            value={mode}
            onChange={setMode}
            layoutId="cf-binary-diff-mode"
            options={[
              { value: "side", icon: Columns2, title: t("binaryDiff.side") },
              { value: "swipe", icon: SplitSquareHorizontal, title: t("binaryDiff.swipe") },
              { value: "onion", icon: Layers, title: t("binaryDiff.onion") },
            ]}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--cf-sunken)] p-4">
        {type && (before || after) ? (
          before && after && mode !== "side" ? (
            <Overlay before={before} after={after} mode={mode} />
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <ImagePane label={t("binaryDiff.before")} src={before} side={pair.old} />
              <ImagePane label={t("binaryDiff.after")} src={after} side={pair.new} />
            </div>
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[12.5px] text-[var(--cf-text-muted)]">
            <FileQuestion size={22} className="text-[var(--cf-text-faint)]" />
            <p>{missingLfs ? t("binaryDiff.lfsMissing") : type ? t("binaryDiff.tooLarge") : t("binaryDiff.binary")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** A checkerboard behind an image, so transparency reads as transparency. */
const CHECKER: React.CSSProperties = {
  backgroundColor: "var(--cf-surface)",
  backgroundImage:
    "linear-gradient(45deg, var(--cf-hover) 25%, transparent 25%), linear-gradient(-45deg, var(--cf-hover) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--cf-hover) 75%), linear-gradient(-45deg, transparent 75%, var(--cf-hover) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

function ImagePane({ label, src, side }: { label: string; src: string | null; side: FileSide }) {
  const t = useT();
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[11.5px] text-[var(--cf-text-muted)]">
        <span className="font-medium text-[var(--cf-text)]">{label}</span>
        {size && <span className="tabular-nums">{size.w} × {size.h}</span>}
      </div>
      {src ? (
        <div className="flex items-center justify-center rounded-md border border-[var(--cf-border)] p-2" style={CHECKER}>
          <img
            src={src}
            alt={label}
            draggable={false}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            className="max-h-[60vh] max-w-full object-contain"
          />
        </div>
      ) : (
        <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-[var(--cf-border)] text-[12px] text-[var(--cf-text-faint)]">
          {!side.exists ? t("binaryDiff.none") : side.lfs && !side.lfs.downloaded ? t("binaryDiff.lfsMissingShort") : t("binaryDiff.tooLarge")}
        </div>
      )}
    </div>
  );
}

/** The two images stacked: a slider uncovers the new one over the old ("swipe"), or fades it in
 *  ("onion skin") — where a small change hides in a side-by-side. */
function Overlay({ before, after, mode }: { before: string; after: string; mode: "swipe" | "onion" }) {
  const t = useT();
  const [value, setValue] = useState(50);
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative inline-block rounded-md border border-[var(--cf-border)] p-2" style={CHECKER}>
        <img src={before} alt={t("binaryDiff.before")} draggable={false} className="block max-h-[60vh] max-w-full object-contain" />
        <img
          src={after}
          alt={t("binaryDiff.after")}
          draggable={false}
          className="absolute left-2 top-2 block max-h-[60vh] max-w-[calc(100%-16px)] object-contain"
          style={mode === "swipe" ? { clipPath: `inset(0 0 0 ${value}%)` } : { opacity: value / 100 }}
        />
        {mode === "swipe" && (
          <div className="pointer-events-none absolute bottom-2 top-2 w-px bg-[var(--cf-accent)]" style={{ left: `calc(8px + (100% - 16px) * ${value / 100})` }} />
        )}
      </div>
      <label className="flex items-center gap-2 text-[11.5px] text-[var(--cf-text-muted)]">
        {t("binaryDiff.before")}
        <input type="range" min={0} max={100} value={value} onChange={(e) => setValue(Number(e.target.value))} className="w-56" />
        {t("binaryDiff.after")}
      </label>
    </div>
  );
}
