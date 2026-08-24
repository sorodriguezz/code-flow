import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { locale } from "./i18n";
import { initNav } from "./nav";
import { rememberBundle } from "./transport";
import { trackViewport } from "./viewport";
import "./mobile.css";

// Before the first render, so the shell is laid out against the real viewport from its first frame
// rather than resizing under the user a moment later. See `viewport.ts` for why `100%` and `100dvh`
// both describe the wrong box once the keyboard is up.
trackViewport();

// Also before the first render: `initNav` writes this client's first history entry, and a `push`
// that happened before it existed would leave the entry underneath with no state of ours on it —
// so the first back press would restore a default instead of closing what was open. See `nav.ts`.
initNav();

// The document is authored in Spanish and its `lang` says so, but `i18n.ts` picks its table from
// the phone's own locale — so an English phone was being read out by VoiceOver in a Spanish voice,
// pronouncing English words. One line, and the two finally agree.
document.documentElement.lang = locale;

// Which build this page is, recorded before anything renders so a later reconnection can notice the
// desktop has been rebuilt underneath it. Not awaited: nothing on screen depends on the answer, and
// a phone must not wait on a round trip to draw its first frame.
void rememberBundle();

// No `StrictMode`, unlike the desktop entry, and for one concrete reason: it double-invokes
// effects in development, which here would open two WebSockets and redeem the pairing code twice —
// and a pairing code is single-use by design, so the second call would fail and the first would
// look broken. The trade is losing a development-only warning on a client with three screens.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
