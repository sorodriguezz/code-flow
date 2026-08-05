import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Before any editor mounts: points @monaco-editor/react at the bundled copy (no CDN, so the app
// works offline) and wires its language workers. See the module for the full story.
import "./lib/monacoSetup";
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
