import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// `./lib/monacoSetup` is deliberately NOT imported here, and that absence is the point.
//
// It used to be, "before any editor mounts" — which is true of every module that renders one, and
// was the cheapest place to say it. The cost was invisible until the entry chunk was measured:
// `monacoSetup` imports `monaco-editor` at the top level, so importing it here made the editor a
// *static* dependency of the entry — 3.98 MB of JS and 162 KB of CSS fetched, parsed, evaluated and
// kept resident on every launch, before the first frame, for a session that may never open an
// editor at all. Monaco is not inert on evaluation either: it stands up ~90 language contributions
// and its theme/command/keybinding registries, and `monacoSetup` then defines 21 themes on top.
//
// So the statement moved to the modules that actually put an editor on screen — `EditorPane`,
// `EditorView`, `SplitFileDiff`, `ConflictResolveModal`, `StreamPanel`, and every panel that
// imports `OVERFLOW_SAFE_OPTIONS` from it — all of which live in lazy chunks. The module is
// idempotent and module-cached, so repeating it there is free, and Monaco now arrives with the
// first thing that needs it.
//
// If you add a component that renders `<Editor>` or `<DiffEditor>`, import `lib/monacoSetup` in it.
// Forgetting shows up as `@monaco-editor/react` trying to fetch the editor from a CDN.
// Widens a scrollbar slightly while its pane is moving. One document-level listener rather than a
// hook every scrollable pane would have to remember to call.
import { startScrollFeedback } from "./lib/scrollFeedback";
// Sends link clicks to the user's browser instead of navigating this webview — which, for a link
// inside an AI answer or a repo file, means replacing the app with a web page it can't come back
// from. One document-level listener, for the links no component of ours ever sees.
import { startExternalLinks } from "./lib/externalLinks";
// Leaves right-click to the app's own menus by swallowing the webview's — the Reload/Back/Inspect
// one, which belongs to a browser this window isn't.
import { startContextMenuGuard } from "./lib/contextMenuGuard";
// Keeps the title bar draggable underneath a modal's backdrop, which covers it and would otherwise
// leave the window stuck in place for as long as a dialog is open.
import { startOverlayDragRegion } from "./lib/overlayDragRegion";
import "./index.css";

startScrollFeedback();
startExternalLinks();
startContextMenuGuard();
startOverlayDragRegion();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
