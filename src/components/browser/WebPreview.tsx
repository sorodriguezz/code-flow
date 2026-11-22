import { useEffect, useState } from "react";
import { AppWindow, ExternalLink, Monitor, RotateCw, Smartphone, Tablet } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { Segmented } from "../common/Segmented";
import { iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { BouncingDots } from "../common/BouncingDots";
import { browserSeen, previewFileUrl } from "../../lib/tauri/browserCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { addressLabel, normalizeAddress, openInBrowserWindow } from "../../lib/webPreview";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";

/** The widths the frame can be drawn at: the pane's own, a tablet's and a phone's. */
type Viewport = "full" | "tablet" | "phone";
const VIEWPORT_WIDTH: Record<Viewport, number | null> = { full: null, tablet: 768, phone: 390 };

/**
 * A page inside the app: the user's own — a dev server on `localhost`, a file of the repository
 * served by `preview_server.rs` — in an iframe, with a slim bar over it.
 *
 * The frame's origin is never the app's (the app is `tauri://` or `http://tauri.localhost`; these are
 * `http://localhost:<port>` and `http://127.0.0.1:<port>`), so `allow-same-origin` gives the page its
 * own storage and cookies — which a dev server's app needs — and nothing of the app's. It cannot
 * navigate the app away (no `allow-top-navigation`) or open windows (no `allow-popups`). A PDF gets
 * no sandbox at all: a sandboxed frame switches the engine's PDF viewer off, and a PDF runs nothing.
 *
 * No back and forward: the page is another origin, so its history is not this document's to read.
 * Reload, the address, and the two ways out — «Navegador» and the system's browser — are.
 */
export function WebPreview({
  url,
  kind = "page",
  reloadKey = "",
  onNavigate,
  title,
}: {
  url: string;
  kind?: "page" | "pdf";
  /** Changes when what the page shows changed on disk (a save): the frame loads it again. */
  reloadKey?: string;
  /** An address bar that can be typed into — a web tab's. Without it the address is shown only. */
  onNavigate?: (url: string) => void;
  /** What an agent is told this preview is (`browser_current`). The address's short form otherwise. */
  title?: string;
}) {
  const t = useT();
  const [reloads, setReloads] = useState(0);
  const [loading, setLoading] = useState(true);
  const [viewport, setViewport] = useState<Viewport>("full");
  const [draft, setDraft] = useState(url);
  useEffect(() => setDraft(url), [url]);

  // What an agent's `browser_current` answers: the last page the user was shown here.
  useEffect(() => {
    void browserSeen(url, title ?? addressLabel(url)).catch(() => undefined);
  }, [url, title]);

  useEffect(() => setLoading(true), [url, reloadKey, reloads]);

  const submit = () => {
    if (!onNavigate) return;
    const next = normalizeAddress(draft);
    if (!next) {
      pushErrorToast(t("browser.badAddress", { address: draft }));
      return;
    }
    if (next === url) setReloads((n) => n + 1);
    else onNavigate(next);
  };

  const width = VIEWPORT_WIDTH[viewport];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2">
        <Tooltip side="bottom" label={t("browser.reload")}>
          <button onClick={() => setReloads((n) => n + 1)} aria-label={t("browser.reload")} className={iconButtonClass({ size: "sm" })}>
            <RotateCw size={13} className={loading ? "animate-spin [animation-duration:1.2s]" : ""} />
          </button>
        </Tooltip>
        {onNavigate ? (
          <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.target.select()}
              spellCheck={false}
              aria-label={t("browser.address")}
              className={fieldClass({ size: "sm", className: "w-full font-mono text-[11.5px]" })}
            />
          </form>
        ) : (
          <span className="min-w-0 flex-1 select-text truncate px-1 font-mono text-[11.5px] text-[var(--cf-text-muted)]" title={url}>
            {url}
          </span>
        )}
        {kind === "page" && (
          <Segmented<Viewport>
            size="sm"
            layoutId={`cf-web-viewport-${url}`}
            value={viewport}
            onChange={setViewport}
            ariaLabel={t("browser.viewport")}
            options={[
              { value: "full", icon: Monitor, title: t("browser.viewportFull") },
              { value: "tablet", icon: Tablet, title: t("browser.viewportTablet") },
              { value: "phone", icon: Smartphone, title: t("browser.viewportPhone") },
            ]}
          />
        )}
        <Tooltip side="bottom" label={t("browser.openInWindow")} description={t("browser.openInWindowHint")}>
          <button onClick={() => openInBrowserWindow(url)} aria-label={t("browser.openInWindow")} className={iconButtonClass({ size: "sm" })}>
            <AppWindow size={13} />
          </button>
        </Tooltip>
        <Tooltip side="bottom" label={t("browser.openExternal")}>
          <button
            onClick={() => void openExternalUrl(url).catch((e: unknown) => pushErrorToast(String(e)))}
            aria-label={t("browser.openExternal")}
            className={iconButtonClass({ size: "sm" })}
          >
            <ExternalLink size={13} />
          </button>
        </Tooltip>
      </div>
      <div className={`relative min-h-0 flex-1 ${width ? "flex justify-center overflow-auto bg-[var(--cf-sunken)] p-3" : ""}`}>
        <iframe
          key={`${url}#${reloadKey}#${reloads}`}
          src={url}
          title={title ?? addressLabel(url)}
          onLoad={() => setLoading(false)}
          {...(kind === "pdf" ? {} : { sandbox: "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock" })}
          // A page written for a browser assumes the UA's light canvas; painted over the app's dark
          // surface every unstyled element on it would vanish.
          style={{ colorScheme: "light", background: "Canvas", ...(width ? { width, flexShrink: 0 } : {}) }}
          className={`border-0 ${width ? "h-full rounded-md shadow-[0_0_0_1px_var(--cf-border)]" : "h-full w-full"}`}
        />
        {loading && (
          <div className="pointer-events-none absolute right-3 top-3">
            <BouncingDots />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A file of the repository, previewed: its URL asked of `preview_server.rs`, then a
 * [`WebPreview`] of it. `reloadKey` is the file's version on disk, so every save shows.
 */
export function RepoFilePreview({
  repoPath,
  path,
  kind = "page",
  reloadKey,
}: {
  repoPath: string;
  path: string;
  kind?: "page" | "pdf";
  reloadKey?: string;
}) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    setError(null);
    previewFileUrl(repoPath, path)
      .then((next) => live && setUrl(next))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [repoPath, path]);
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[12px] text-[var(--cf-text-muted)]">
        <p>{t("browser.previewFailed")}</p>
        <p className="max-w-[560px] select-text break-words font-mono text-[11.5px]">{error}</p>
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex h-full items-center justify-center">
        <BouncingDots />
      </div>
    );
  }
  return <WebPreview url={url} kind={kind} reloadKey={reloadKey} title={path.split("/").pop() ?? path} />;
}

/** Whether a repository path is a file the editor previews as a page. */
export function isPagePath(path: string): boolean {
  return /\.(html?|xhtml)$/i.test(path);
}

/** Whether a repository path is a PDF, which the editor shows instead of the binary notice. */
export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}
