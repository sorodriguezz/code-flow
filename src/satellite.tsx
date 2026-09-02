import React from "react";
import ReactDOM from "react-dom/client";
import SatelliteApp from "./SatelliteApp";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
// The same four document-level listeners `main.tsx` starts, and for the same reasons — a satellite
// is a webview like any other: it scrolls, it holds links that must open in the browser rather than
// replacing the window, it has a right-click menu that is not the app's, and it draws its own title
// bar under modal backdrops. See the notes in `main.tsx`, which are not repeated here.
import { startScrollFeedback } from "./lib/scrollFeedback";
import { startExternalLinks } from "./lib/externalLinks";
import { startContextMenuGuard } from "./lib/contextMenuGuard";
import { startOverlayDragRegion } from "./lib/overlayDragRegion";
import "./index.css";

startScrollFeedback();
startExternalLinks();
startContextMenuGuard();
startOverlayDragRegion();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* A satellite has no shell to fall back to, so a throw anywhere in it takes the whole window.
        The reload this offers rebuilds the webview without restarting the process, which is exactly
        the right cost here: everything this window shows lives in Rust or in SQLite. */}
    <ErrorBoundary fatal>
      <SatelliteApp />
    </ErrorBoundary>
  </React.StrictMode>,
);
