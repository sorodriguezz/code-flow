import { useEffect, useRef, useState, type ReactNode } from "react";
import { scrollMoves } from "../../lib/scrollMoves";
import { chatAttachmentPreview } from "../../lib/tauri/chatCommands";
import { OPEN_DELAY, TooltipBubble, tooltipClosed, tooltipIsWarm } from "../common/Tooltip";

/** The picture's box inside the bubble (whose content is 17rem less its padding). */
const MAX_W = 252;
const MAX_H = 180;
/** Previews kept in memory: a screenshot is megabytes as a `data:` URL, so only the last few. */
const CACHE_SIZE = 12;

interface Picture {
  src: string;
  width: number;
  height: number;
}

/** By path, so a chip hovered twice — or the same image in the composer and in the sent question —
 *  is read and decoded once. A file that cannot be previewed is remembered as `null`. */
const cache = new Map<string, Promise<Picture | null>>();

function picture(path: string): Promise<Picture | null> {
  const hit = cache.get(path);
  if (hit) return hit;
  const load = chatAttachmentPreview(path)
    .then(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      // Sized here, so the bubble measures the box it will show rather than an image still loading.
      const scale = Math.min(1, MAX_W / img.naturalWidth, MAX_H / img.naturalHeight);
      return { src, width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) };
    })
    .catch(() => null);
  cache.set(path, load);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return load;
}

/**
 * An image chip — staged in a composer or sent in a question, in any of the chats — that shows the
 * image and where it was copied to when the pointer rests on it.
 *
 * The app's tooltip bubble, opened with its delay and shared warm-up, but drawn here rather than by
 * `TitleTooltips`: a `title` is text, and this one carries a picture. `data-cf-tooltip` keeps that
 * one away. A file that is gone or too large to preview still shows its path.
 */
export function ImageChipHover({
  path,
  name,
  note,
  className,
  children,
}: {
  /** The copy under the app's attachment folder — what the engine is given. */
  path: string;
  name: string;
  /** Said above the path — the warning that this model will not see the image. */
  note?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const hovering = useRef(false);
  const shown = useRef(false);
  const [tip, setTip] = useState<{ rect: DOMRect; picture: Picture | null } | null>(null);

  const hide = () => {
    hovering.current = false;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (shown.current) tooltipClosed();
    shown.current = false;
    setTip(null);
  };

  const show = async () => {
    const loaded = await picture(path);
    if (!hovering.current || !ref.current) return;
    shown.current = true;
    setTip({ rect: ref.current.getBoundingClientRect(), picture: loaded });
  };

  // A scroll that moves the chip leaves the bubble behind — not a transcript following its answer
  // somewhere else (`scrollMoves`).
  useEffect(() => {
    if (!tip) return;
    const onScroll = (e: Event) => {
      if (scrollMoves(e, ref.current)) hide();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", hide);
    };
  }, [tip]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  return (
    <span
      ref={ref}
      data-cf-tooltip=""
      className={className}
      onPointerEnter={(e) => {
        if (e.pointerType === "touch") return;
        hovering.current = true;
        if (tooltipIsWarm()) void show();
        else timer.current = window.setTimeout(() => void show(), OPEN_DELAY);
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
    >
      {children}
      {tip && (
        <TooltipBubble
          anchor={tip.rect}
          label={
            tip.picture ? (
              <img
                src={tip.picture.src}
                alt={name}
                width={tip.picture.width}
                height={tip.picture.height}
                className="block rounded-md"
              />
            ) : (
              name
            )
          }
          description={
            <>
              {note && <span className="mb-1 block text-[var(--cf-warning)]">{note}</span>}
              <span className="font-mono [overflow-wrap:anywhere]">{path}</span>
            </>
          }
        />
      )}
    </span>
  );
}
