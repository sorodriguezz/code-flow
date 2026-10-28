import { useMemo } from "react";
import { X } from "lucide-react";
import { useToastStore, type Toast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { MorphToast, useMorphStack } from "./MorphToast";
import { NoticeStack, useNoticePlacement } from "./NoticeDock";
import type { NoticeAlign, NoticeEdge } from "../../state/noticePositionStore";

/**
 * How long a toast stays: Sileo's six seconds, and eight for an error — the one kind you may need to
 * read twice. Either way the body folds back into the pill two seconds before the end.
 */
const DURATION_MS = 6000;
const DURATION_ERROR_MS = 8000;

const LABEL: Record<Toast["type"], TranslationKey> = {
  error: "toast.error",
  success: "toast.success",
  info: "toast.info",
};

/**
 * The widest message that is still the pill itself (at 13px, weight 500). Past this — or with a line
 * break in it — the pill says only what kind of toast it is and the message opens below. Leaves room
 * for the × that unfolds on hover without the text having to give way to it.
 */
const PILL_TEXT_MAX = 260;

let ruler: CanvasRenderingContext2D | null | undefined;
/** Measured once per message; bounded, since a session raises an open-ended set of them. */
const fitCache = new Map<string, boolean>();

function fitsInPill(text: string): boolean {
  let fits = fitCache.get(text);
  if (fits === undefined) {
    if (fitCache.size > 256) fitCache.clear();
    fits = measureFits(text);
    fitCache.set(text, fits);
  }
  return fits;
}

function measureFits(text: string): boolean {
  if (text.includes("\n")) return false;
  if (ruler === undefined) {
    ruler = null;
    try {
      // jsdom has no canvas and complains on every attempt; the length guess below is enough there.
      if (!/jsdom/i.test(navigator.userAgent)) ruler = document.createElement("canvas").getContext("2d");
    } catch {
      ruler = null;
    }
  }
  if (!ruler) return text.length <= 36;
  ruler.font = `500 13px ${getComputedStyle(document.body).fontFamily}`;
  return ruler.measureText(text).width <= PILL_TEXT_MAX;
}

/**
 * Identical toasts raised while one is still up — the same failure from a retry loop, the same
 * confirmation from a double click — are drawn as one card raised again rather than a column of
 * twins. The store keeps every entry (its tests count them, and so may callers); this is a view.
 */
interface ToastGroup {
  /** The first toast's id — stable for as long as the card is up. */
  key: string;
  ids: string[];
  message: string;
  type: Toast["type"];
  /** The message *is* the pill — nothing opens below it. */
  fits: boolean;
  raise: number;
  /** Where the most recent raise sits in the store: the newest card is the one that opens. */
  order: number;
  action?: Toast["action"];
  lifetimeMs?: number;
}

export function groupToasts(toasts: readonly Pick<Toast, "id" | "message" | "type" | "action" | "lifetimeMs">[]): ToastGroup[] {
  const byText = new Map<string, ToastGroup>();
  toasts.forEach((toast, order) => {
    // `type` is one of three plain words, so `type|message` can't collide across types. A toast with an
    // action is its own group: each one undoes a different thing.
    const text = toast.action ? `action|${toast.id}` : `${toast.type}|${toast.message}`;
    const group = byText.get(text);
    if (group) {
      group.ids.push(toast.id);
      group.raise += 1;
      group.order = order;
    } else {
      byText.set(text, {
        key: toast.id,
        ids: [toast.id],
        message: toast.message,
        type: toast.type,
        fits: fitsInPill(toast.message),
        raise: 0,
        order,
        action: toast.action,
        lifetimeMs: toast.lifetimeMs,
      });
    }
  });
  return [...byText.values()];
}

const durationOf = (group: ToastGroup) => group.lifetimeMs ?? (group.type === "error" ? DURATION_ERROR_MS : DURATION_MS);

function ToastCard({
  group,
  leaving,
  open,
  onHoverChange,
  onDismiss,
  align,
  edge,
}: {
  align: NoticeAlign;
  edge: NoticeEdge;
  group: ToastGroup;
  leaving: boolean;
  open: boolean;
  onHoverChange: (hovering: boolean) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const { fits } = group;

  return (
    <MorphToast
      tone={group.type}
      title={group.action ? `${group.message} · ${group.action.label}` : fits ? group.message : t(LABEL[group.type])}
      titleKey={group.action ? `${group.message}|${group.action.label}` : fits ? group.message : group.type}
      body={
        fits ? undefined : (
          // Selectable: an error is often something to paste somewhere.
          <span className="block max-h-40 select-text overflow-y-auto whitespace-pre-wrap break-words">
            {group.message}
          </span>
        )
      }
      align={align}
      edge={edge}
      duration={durationOf(group)}
      raise={group.raise}
      canExpand={open}
      leaving={leaving}
      urgent={group.type === "error"}
      onHoverChange={onHoverChange}
      // A card with an action *is* the button: pressing it runs the action and closes the card.
      onActivate={
        group.action
          ? () => {
              group.action?.run();
              onDismiss();
            }
          : undefined
      }
      activateLabel={group.action?.label}
      trailing={
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("common.close")}
          title={t("common.close")}
          className="cf-morph-close"
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      }
    />
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismissToast);
  const groups = useMemo(() => groupToasts(toasts), [toasts]);
  const placement = useNoticePlacement("toasts");
  const stack = useMorphStack(groups, {
    keyOf: (group) => group.key,
    orderOf: (group) => group.order,
    opensOf: (group) => !group.fits,
    durationOf,
    raiseOf: (group) => group.raise,
    onExpire: (group) => group.ids.forEach(dismiss),
  });

  if (stack.entries.length === 0) return null;

  // Newest nearest the edge (the status bar, by default); the ones before it are pushed away and
  // fold to pills.
  return (
    <NoticeStack kind="toasts" placement={placement}>
      {stack.entries.map(({ key, item, leaving }) => (
        <ToastCard
          key={key}
          align={placement.align}
          edge={placement.edge}
          group={item}
          leaving={leaving}
          open={stack.openKey === key}
          onHoverChange={stack.hoverChange(key)}
          onDismiss={() => item.ids.forEach(dismiss)}
        />
      ))}
    </NoticeStack>
  );
}
