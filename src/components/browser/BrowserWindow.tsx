import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight, CircleAlert, CircleCheck, ExternalLink, Globe, Info, LoaderCircle, Plus, RotateCw, X } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { KeepOnTop, WindowsControls } from "../layout/SatelliteTitleBar";
import {
  browserGo,
  browserFocusBar,
  browserLayout,
  browserOpen,
  browserState,
  browserTabClose,
  browserTabNew,
  browserTabSelect,
  onBrowserNewTab,
  onBrowserState,
  type BrowserState,
} from "../../lib/tauri/browserCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { addressLabel, normalizeAddress } from "../../lib/webPreview";
import { isMac as platformIsMac, usePlatform } from "../../lib/platform";
import { getWindowStatus, subscribeWindowStatus } from "../../lib/windowControls";
import { useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore, type Toast } from "../../state/toastStore";

/** How long a notice stays in the bar when it does not say otherwise. Errors stay longer: they are
 *  the ones worth reading to the end. */
const NOTICE_MS = { error: 8000, success: 4000, info: 5000 } as const;

/**
 * «Navegador»'s bar — the whole of what this window's own webview draws: the tabs, the address, and
 * whatever the app has to say. The pages are native webviews laid under the bar by
 * `browser_window.rs`, so nothing drawn here can reach below it.
 *
 * That is the rule everything here follows:
 * - **Tooltips are the platform's** (`title`): drawn by the OS in a window of their own, they float
 *   above the page, where the app's tooltips would be drawn behind it.
 * - **Notices are rows of the bar** ([`BarNotices`]) instead of toasts in a corner: the bar grows by
 *   a row, reports its new height (`browser_layout`), and the page moves down for as long as the
 *   notice is up — said where it can be seen rather than painted under a web page.
 * - No popovers and no menus.
 */
export function BrowserWindow() {
  const t = useT();
  const isMac = usePlatform() === "macos";
  const fullscreen = useSyncExternalStore(subscribeWindowStatus, () => platformIsMac() && getWindowStatus().fullscreen);
  const [browser, setBrowser] = useState<BrowserState>({ tabs: [], active: null });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);

  const page = browser.tabs.find((tab) => tab.id === browser.active) ?? null;
  /** The tab on screen is a new, empty one (the + button) — no page yet, its address to be written. */
  const blank = page !== null && page.url === "";

  useEffect(() => {
    let live = true;
    void browserState()
      .then((state) => {
        if (!live) return;
        setBrowser(state);
        // A window opened on an empty tab, or with nothing in it, starts at the address bar: there is
        // nothing else to do.
        const active = state.tabs.find((tab) => tab.id === state.active);
        if (!active || active.url === "") focusAddress();
      })
      .catch(() => undefined);
    const unlisten = onBrowserState((state) => setBrowser(state));
    return () => {
      live = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!editing) setDraft(page?.url ?? "");
  }, [page?.id, page?.url, editing]);

  useEffect(() => {
    document.title = page?.title || t("browser.windowTitle");
  }, [page?.title, t]);

  // Where the pages start: the bottom of the bar, measured — so a notice row, a font size or a
  // platform's taller row never leaves a page over the bar or a gap above it.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const report = () => void browserLayout(bar.getBoundingClientRect().bottom).catch(() => undefined);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  /** The caret into the address bar — after taking the keyboard back from the page (see
   *  `browser_focus_bar`), or the keys typed go to the page under it. */
  const focusAddress = () => {
    void browserFocusBar()
      .catch(() => undefined)
      .finally(() => {
        addressRef.current?.focus();
        addressRef.current?.select();
      });
  };

  /** The +: a new, empty tab in the strip (`browser_tab_new`), and the caret in its address. */
  const startNewTab = () => {
    setDraft("");
    void browserTabNew()
      .then(focusAddress)
      .catch((e: unknown) => pushErrorToast(String(e)));
  };

  // The rail's button and its chord (`browser_show`) made the empty tab already: the caret, only.
  useEffect(() => {
    const unlisten = onBrowserNewTab(() => {
      setDraft("");
      focusAddress();
    });
    return () => void unlisten.then((stop) => stop());
  }, []);

  const go = () => {
    const url = normalizeAddress(draft);
    if (!url) {
      pushErrorToast(t("browser.badAddress", { address: draft }));
      return;
    }
    setEditing(false);
    addressRef.current?.blur();
    // The tab on screen — an empty one gets its page — or, with no tab at all, a first one.
    void browserOpen(url, !page).catch((e: unknown) => pushErrorToast(String(e)));
  };

  const act = (action: "back" | "forward" | "reload" | "stop") => void browserGo(action).catch((e: unknown) => pushErrorToast(String(e)));

  return (
    <div className="cf-frame flex h-screen flex-col overflow-hidden">
      {/* Any press on the bar takes the keyboard back from the page first — see `focusAddress`. */}
      <div ref={barRef} className="shrink-0" onPointerDownCapture={() => void browserFocusBar().catch(() => undefined)}>
        {/* The tabs, on the title row — the traffic lights' row on macOS, as in a browser. */}
        <div data-tauri-drag-region className={`flex h-11 select-none items-end gap-1 pl-3 ${isMac ? "pr-2" : ""}`}>
          {isMac && !fullscreen && <div aria-hidden data-tauri-drag-region className="w-[62px] shrink-0 self-stretch" />}
          <div role="tablist" aria-label={t("browser.tabs")} className="flex min-w-0 items-end gap-0.5 self-stretch pt-1.5">
            {browser.tabs.map((tab) => {
              const active = tab.id === browser.active;
              const name = tab.title || addressLabel(tab.url) || t("browser.newTab");
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={active}
                  title={`${name}\n${tab.url}`}
                  onClick={() => void browserTabSelect(tab.id).catch(() => undefined)}
                  // The middle button closes a tab, as in every browser.
                  onAuxClick={(event) => {
                    if (event.button === 1) void browserTabClose(tab.id).catch(() => undefined);
                  }}
                  className={`group/tab flex h-full min-w-[72px] max-w-[220px] flex-1 cursor-default items-center gap-1.5 rounded-t-md px-2.5 text-[12px] ${
                    active
                      ? "bg-[var(--cf-bg)] text-[var(--cf-text)]"
                      : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                  }`}
                >
                  {tab.loading ? (
                    <LoaderCircle size={12} className="shrink-0 animate-spin text-[var(--cf-text-faint)]" />
                  ) : (
                    <Globe size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void browserTabClose(tab.id).catch(() => undefined);
                    }}
                    title={t("browser.closeTab")}
                    aria-label={t("browser.closeTab")}
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-[var(--cf-press)] ${active ? "" : "opacity-0 group-hover/tab:opacity-100"}`}
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
          <button onClick={startNewTab} title={t("browser.newTab")} aria-label={t("browser.newTab")} className={`${iconButtonClass({ size: "sm" })} mb-1`}>
            <Plus size={14} />
          </button>
          <div className="flex-1 self-stretch" data-tauri-drag-region />
          <div className="mb-1 flex items-center">
            <KeepOnTop native />
          </div>
          {!isMac && (
            <div className="flex self-stretch">
              <WindowsControls />
            </div>
          )}
        </div>

        {/* The address row, on the page's own colour so tab and page read as one sheet. */}
        <div className="flex h-10 items-center gap-1 border-b border-[var(--cf-border)] bg-[var(--cf-bg)] px-2">
          <button onClick={() => act("back")} title={t("browser.back")} aria-label={t("browser.back")} disabled={!page || blank} className={iconButtonClass({ size: "sm" })}>
            <ArrowLeft size={15} />
          </button>
          <button onClick={() => act("forward")} title={t("browser.forward")} aria-label={t("browser.forward")} disabled={!page || blank} className={iconButtonClass({ size: "sm" })}>
            <ArrowRight size={15} />
          </button>
          {page?.loading ? (
            <button onClick={() => act("stop")} title={t("browser.stop")} aria-label={t("browser.stop")} className={iconButtonClass({ size: "sm" })}>
              <X size={15} />
            </button>
          ) : (
            <button onClick={() => act("reload")} title={t("browser.reload")} aria-label={t("browser.reload")} disabled={!page || blank} className={iconButtonClass({ size: "sm" })}>
              <RotateCw size={14} />
            </button>
          )}
          <form
            className="relative mx-1 min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              go();
            }}
          >
            {blank ? (
              <Plus size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--cf-accent)]" />
            ) : (
              <Globe size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
            )}
            <input
              ref={addressRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => {
                setEditing(true);
                event.target.select();
              }}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setDraft(page?.url ?? "");
                  event.currentTarget.blur();
                }
              }}
              placeholder={blank || !page ? t("browser.newTabPlaceholder") : t("browser.addressPlaceholder")}
              spellCheck={false}
              aria-label={t("browser.address")}
              title={page?.url}
              className={fieldClass({ size: "sm", className: "w-full pl-7 font-mono text-[12px]" })}
            />
          </form>
          <button
            onClick={() => page?.url && void openExternalUrl(page.url).catch((e: unknown) => pushErrorToast(String(e)))}
            title={t("browser.openExternal")}
            aria-label={t("browser.openExternal")}
            disabled={!page || blank}
            className={iconButtonClass({ size: "sm" })}
          >
            <ExternalLink size={14} />
          </button>
        </div>

        <BarNotices />
      </div>

      {/* Where the pages are laid. An empty tab has none, so what shows through is this: the tab's
          own «new tab» page. */}
      <div className="min-h-0 flex-1 bg-[var(--cf-bg)]">
        {(!page || blank) && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--cf-hover)]">
              <Globe size={26} className="text-[var(--cf-accent)]" />
            </span>
            <p className="text-[15px] font-semibold text-[var(--cf-text)]">{t("browser.newTab")}</p>
            <p className="max-w-[420px] text-[13px] text-[var(--cf-text-muted)]">{t("browser.empty")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The app's toasts, as rows of the bar — see the module note. The same store every window's
 * `ToastContainer` reads, so anything that calls `pushErrorToast` in this window is said here; the
 * newest two, each going away on its own like a toast does.
 */
function BarNotices() {
  const t = useT();
  const toasts = useToastStore((s) => s.toasts);
  const shown = toasts.slice(-2);
  return (
    <>
      {shown.map((toast) => (
        <BarNotice key={toast.id} toast={toast} closeLabel={t("common.close")} />
      ))}
    </>
  );
}

function BarNotice({ toast, closeLabel }: { toast: Toast; closeLabel: string }) {
  const dismissToast = useToastStore((s) => s.dismissToast);
  const onDismiss = () => dismissToast(toast.id);
  // Keyed on the notice, not on the render: a second notice arriving must not restart the first's clock.
  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), toast.lifetimeMs ?? NOTICE_MS[toast.type]);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.lifetimeMs, toast.type, dismissToast]);
  const Icon = toast.type === "error" ? CircleAlert : toast.type === "success" ? CircleCheck : Info;
  const tone =
    toast.type === "error" ? "text-[var(--cf-danger)]" : toast.type === "success" ? "text-[var(--cf-success,var(--cf-accent))]" : "text-[var(--cf-accent)]";
  return (
    <div role={toast.type === "error" ? "alert" : "status"} className="flex min-h-8 items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-bg)] px-3 py-1 text-[12px]">
      <Icon size={13} className={`shrink-0 ${tone}`} />
      <span className="min-w-0 flex-1 select-text break-words text-[var(--cf-text)]">{toast.message}</span>
      {toast.action && (
        <button
          onClick={() => {
            toast.action?.run();
            onDismiss();
          }}
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-[var(--cf-accent)] hover:bg-[var(--cf-hover)]"
        >
          {toast.action.label}
        </button>
      )}
      <button onClick={onDismiss} title={closeLabel} aria-label={closeLabel} className={iconButtonClass({ size: "sm" })}>
        <X size={12} />
      </button>
    </div>
  );
}
