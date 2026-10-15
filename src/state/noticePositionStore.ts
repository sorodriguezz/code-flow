import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

/**
 * Where the floating notices appear (Ajustes › Notificaciones › Avisos del sistema), chosen apart
 * for the two kinds the app has (user, 2026-10-15: "hay notificaciones de la campana y
 * notificaciones de errores y cosas así, hay que diferenciar eso"):
 *
 * - `toasts` — the app's own messages and errors ("Copiado", a failed push). Bottom centre by default.
 * - `popups` — the bell's notifications: work that finished (a review, a chat answer). Bottom right
 *   by default.
 *
 * Each stack is drawn into a column per spot (`NoticeDock`), so two kinds sent to the same spot are
 * laid out one after the other, never over each other.
 */
export type NoticeSpot = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
export type NoticeKind = "toasts" | "popups";

export const NOTICE_SPOTS: readonly NoticeSpot[] = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

export const NOTICE_DEFAULTS: Record<NoticeKind, NoticeSpot> = { toasts: "bottom-center", popups: "bottom-right" };

const KEYS: Record<NoticeKind, string> = {
  toasts: "notification_position_toasts",
  popups: "notification_position_popups",
};

export type NoticeEdge = "top" | "bottom";
export type NoticeAlign = "left" | "center" | "right";

/** The edge a stack hangs from and where along it. */
export function placementOf(spot: NoticeSpot): { edge: NoticeEdge; align: NoticeAlign } {
  const [edge, align] = spot.split("-") as [NoticeEdge, NoticeAlign];
  return { edge, align };
}

const valid = (value: string | null | undefined): value is NoticeSpot => NOTICE_SPOTS.includes(value as NoticeSpot);

interface NoticePositionState {
  spots: Record<NoticeKind, NoticeSpot>;
  init: () => Promise<void>;
  setSpot: (kind: NoticeKind, spot: NoticeSpot) => Promise<void>;
}

export const useNoticePositionStore = create<NoticePositionState>((set) => ({
  spots: { ...NOTICE_DEFAULTS },
  init: async () => {
    let stored: Record<string, string | null> = {};
    try {
      stored = (await getSettings(Object.values(KEYS))) as Record<string, string | null>;
    } catch {
      // No backend (a test, a probe page): the defaults stand.
    }
    const pick = (kind: NoticeKind) => {
      const value = stored?.[KEYS[kind]];
      return valid(value) ? value : NOTICE_DEFAULTS[kind];
    };
    set({ spots: { toasts: pick("toasts"), popups: pick("popups") } });
  },
  setSpot: async (kind, spot) => {
    set((s) => ({ spots: { ...s.spots, [kind]: spot } }));
    await setSetting(KEYS[kind], spot);
  },
}));

void useNoticePositionStore.getState().init();
// Chosen in the main window's Settings; a repository window follows. See `lib/settingsSync`.
watchSettings(Object.values(KEYS), () => useNoticePositionStore.getState().init());
