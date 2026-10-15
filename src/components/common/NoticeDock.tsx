/**
 * Where a stack of floating notices is drawn — the toasts (messages, errors) and the bell's popups —
 * following Ajustes › Notificaciones (`noticePositionStore`), each kind at its own spot.
 *
 * Every spot is one fixed column on the body, made on first use and shared: two kinds sent to the
 * same spot are laid out one after the other instead of over each other — the toasts, the more
 * urgent, nearest the edge. Hanging from the top the column runs the other way round, so the newest
 * card is still the one nearest the edge.
 */

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  placementOf,
  useNoticePositionStore,
  type NoticeAlign,
  type NoticeEdge,
  type NoticeKind,
} from "../../state/noticePositionStore";

/** Above the status bar at the bottom, below the title bar at the top. */
const EDGE_CLASS: Record<NoticeEdge, string> = { top: "top-12", bottom: "bottom-10" };
const ALIGN_CLASS: Record<NoticeAlign, string> = {
  left: "left-3 items-start",
  center: "left-1/2 -translate-x-1/2 items-center",
  right: "right-3 items-end",
};
const ITEMS_CLASS: Record<NoticeAlign, string> = { left: "items-start", center: "items-center", right: "items-end" };

function dockFor(edge: NoticeEdge, align: NoticeAlign): HTMLElement {
  const id = `cf-notice-dock-${edge}-${align}`;
  let dock = document.getElementById(id);
  if (!dock) {
    dock = document.createElement("div");
    dock.id = id;
    dock.className = `pointer-events-none fixed z-50 flex flex-col gap-3 ${EDGE_CLASS[edge]} ${ALIGN_CLASS[align]}`;
    document.body.appendChild(dock);
  }
  return dock;
}

/** The placement a kind of notice draws its cards for. */
export function useNoticePlacement(kind: NoticeKind) {
  const spot = useNoticePositionStore((s) => s.spots[kind]);
  return placementOf(spot);
}

export function NoticeStack({
  kind,
  placement,
  children,
}: {
  kind: NoticeKind;
  placement: { edge: NoticeEdge; align: NoticeAlign };
  children: ReactNode;
}) {
  const { edge, align } = placement;
  const nearest = kind === "toasts";
  // Bottom: the column ends at the edge, so the nearest stack goes last; top: it starts there.
  const order = edge === "bottom" ? (nearest ? 2 : 1) : nearest ? 1 : 2;
  return createPortal(
    <div style={{ order }} className={`flex gap-3 ${edge === "top" ? "flex-col-reverse" : "flex-col"} ${ITEMS_CLASS[align]}`}>
      {children}
    </div>,
    dockFor(edge, align),
  );
}
