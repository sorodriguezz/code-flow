import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Before any editor mounts: points @monaco-editor/react at the bundled copy (no CDN, so the app
// works offline) and wires its language workers. See the module for the full story.
import "./lib/monacoSetup";
// Widens a scrollbar slightly while its pane is moving. One document-level listener rather than a
// hook every scrollable pane would have to remember to call.
import { startScrollFeedback } from "./lib/scrollFeedback";
import "./index.css";

startScrollFeedback();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
