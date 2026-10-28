import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, Maximize2, X } from "lucide-react";
import { FIT, settle, wheelFactor, zoomAt, type View } from "../../lib/lightboxMath";
import { useT } from "../../state/languageStore";

/**
 * An image, full size: wheel or the buttons to zoom about the pointer, drag to move, double-click to
 * toggle between fit and 2×, Escape or a click outside to close. The picture is the one the chip already
 * loaded; nothing here reads the disk.
 */
export function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const t = useT();
  const [view, setView] = useState<View>(FIT);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; from: View } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "+" || e.key === "=") setView((v) => settle(zoomAt(v, 1.25, 0, 0)));
      if (e.key === "-") setView((v) => settle(zoomAt(v, 0.8, 0, 0)));
      if (e.key === "0") setView(FIT);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** The pointer's offset from the stage's centre — the origin `zoomAt` reasons in. */
  const offset = (e: { clientX: number; clientY: number }) => {
    const rect = stage.current?.getBoundingClientRect();
    return rect ? { px: e.clientX - rect.left - rect.width / 2, py: e.clientY - rect.top - rect.height / 2 } : { px: 0, py: 0 };
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 z-[80] flex flex-col bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-2 text-[12px] text-white/80">
        <span className="min-w-0 truncate">{name}</span>
        <span className="flex items-center gap-1">
          <button type="button" aria-label={t("lightbox.zoomOut")} onClick={() => setView((v) => settle(zoomAt(v, 0.8, 0, 0)))} className="rounded p-1.5 hover:bg-white/10">
            <Minus size={15} />
          </button>
          <span className="w-12 text-center tabular-nums">{Math.round(view.scale * 100)}%</span>
          <button type="button" aria-label={t("lightbox.zoomIn")} onClick={() => setView((v) => settle(zoomAt(v, 1.25, 0, 0)))} className="rounded p-1.5 hover:bg-white/10">
            <Plus size={15} />
          </button>
          <button type="button" aria-label={t("lightbox.fit")} onClick={() => setView(FIT)} className="rounded p-1.5 hover:bg-white/10">
            <Maximize2 size={14} />
          </button>
          <button type="button" aria-label={t("common.close")} onClick={onClose} className="ml-1 rounded p-1.5 hover:bg-white/10">
            <X size={16} />
          </button>
        </span>
      </div>
      <div
        ref={stage}
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        onWheel={(e) => {
          const { px, py } = offset(e);
          setView((v) => settle(zoomAt(v, wheelFactor(e.deltaY), px, py)));
        }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) return;
          drag.current = { x: e.clientX, y: e.clientY, from: view };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (!start) return;
          setView({ ...start.from, x: start.from.x + e.clientX - start.x, y: start.from.y + e.clientY - start.y });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) return;
          const { px, py } = offset(e);
          setView((v) => (v.scale > 1 ? FIT : zoomAt(v, 2, px, py)));
        }}
      >
        <img
          src={src}
          alt={name}
          draggable={false}
          className="absolute left-1/2 top-1/2 max-h-full max-w-full select-none"
          style={{ transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: "center" }}
        />
      </div>
    </div>,
    document.body,
  );
}
