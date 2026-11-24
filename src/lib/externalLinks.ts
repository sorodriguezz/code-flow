import { openExternalUrl } from "./tauri/commands";
import { pushErrorToast } from "../state/toastStore";
import { openInCodeFlow } from "./webPreview";

/**
 * Sends every link click somewhere other than the app's own webview: a web page to «Navegador»,
 * CodeFlow's browser, and anything else worth opening (`mailto:`) to the OS.
 *
 * This is a webview, not a browser tab: an ordinary `<a href="https://…">` navigates *it*, so a
 * source link in an AI answer replaces the entire application with a web page — and there is no
 * back button, no address bar and no tab to close, because none of those are things this window
 * has. `target="_blank"` is no better; it opens a second webview with the same nothing around it.
 *
 * One document-level listener rather than an `onClick` every component that might render a link
 * would have to remember, for the same reason as `scrollFeedback`: most of these links are not
 * written by us at all. They arrive inside markdown from a model, a repository file or a pull
 * request description, get rendered through `dangerouslySetInnerHTML`, and there is no component
 * in between to hang a handler on.
 *
 * Untrusted markdown is also why the scheme is checked here rather than left to the backend.
 * DOMPurify already strips `javascript:` hrefs, and `open_external_url` refuses anything that is
 * not http(s) — but a `file:` link that reaches neither would still be handed to the webview to
 * follow. Anything absolute and not on the list is swallowed: not opened, and not navigated to.
 *
 * **A web page opens inside CodeFlow** (`lib/webPreview`): the user's own pages in an editor tab,
 * the internet in «Navegador» — where the reader stays in the app and can still hand the page to
 * their own browser with the address bar's «Abrir en tu navegador». **Shift-click goes straight to
 * the user's browser**, for the reader who already knows that is where they want it.
 */

/** Schemes worth opening at all: a web page, or a `mailto:` for the OS. */
const EXTERNAL = /^(?:https?|mailto):/i;

/** Anything with a scheme at all. What is left over — `#anchor`, a relative path — is the app's. */
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

export function startExternalLinks() {
  // Bubble phase, so a component that handles its own link — and says so by calling
  // `preventDefault` — has already been given the chance to.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]");
    if (!anchor) return;

    // The attribute rather than `anchor.href`, which resolves a relative path against the app's own
    // origin and would turn "./docs" into an `http://localhost` link worth opening. What matters is
    // what the document actually said.
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (!ABSOLUTE.test(href)) return;

    event.preventDefault();
    if (!EXTERNAL.test(href)) return;
    if (/^https?:/i.test(href) && !event.shiftKey) {
      openInCodeFlow(href);
      return;
    }
    void openExternalUrl(href).catch((e: unknown) => pushErrorToast(String(e)));
  });
}
