import { useCallback, useEffect, useRef, useState } from "react";
import { Workflow } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ViewSkeleton } from "../common/ViewSkeleton";
import {
  editorConfig,
  embedUrl,
  injectToolbarButtons,
  parseEmbedMessage,
  seedEditorLibraries,
  postToEditor,
  THUMBNAIL_EXPORT,
  THUMBNAIL_MAX_CHARS,
} from "../../lib/diagrams/embed";
import { bytesFromDataUri, saveBytes, type ExportFormat } from "../../lib/diagrams/exportFile";
import { useDiagramsStore } from "../../state/diagramsStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useThemeStore } from "../../state/themeStore";

/**
 * The canvas: draw.io, in an iframe, wired to this workspace's store.
 *
 * **Mounted only while a diagram is open, and unmounted the moment one isn't.** That is the whole
 * memory strategy and it is not incidental — booting the editor costs ~25 MB of fetched JavaScript
 * and a comparable heap, and someone who never opens a diagram should pay none of it. `NotesView`
 * does the same with Monaco for the same reason; this is that decision applied to something an
 * order of magnitude heavier.
 *
 * **The frame is keyed on theme and language**, because neither can be changed after load — they
 * are URL parameters the editor reads once while booting. Changing either remounts the iframe,
 * which reboots the editor and reloads the document from the store. That is why the store's draft
 * is the source of truth rather than whatever is inside the frame: a remount must not lose an edit.
 *
 * **Every edit arrives as `autosave`.** The store debounces the write; this component only forwards.
 * After each one it asks for a fresh PNG, which is what the gallery draws.
 */
export function DrawioFrame({
  diagramId,
  onSaveAsTemplate,
  onExport,
  onAskAi,
}: {
  diagramId: string;
  /** The three actions injected into the editor's own toolbar. `at` is where the click landed, in
   *  window coordinates, so a menu opened from one appears under the pointer. */
  onSaveAsTemplate: () => void;
  onExport: (at: { x: number; y: number }) => void;
  onAskAi: () => void;
}) {
  const doc = useDiagramsStore((s) => s.draft?.doc ?? null);
  const draftId = useDiagramsStore((s) => s.draft?.id ?? null);
  const title = useDiagramsStore((s) => s.diagrams.find((d) => d.id === diagramId)?.title ?? "");

  const theme = useThemeStore((s) => s.resolved);
  const language = useLanguageStore((s) => s.language);
  const t = useT();

  const frame = useRef<HTMLIFrameElement>(null);
  /**
   * The callbacks and labels the injected buttons reach, held in refs.
   *
   * The listeners are attached to plain DOM nodes once, so whatever they close over is what they
   * will still be calling in ten minutes. A ref is the indirection that lets a re-render change
   * where they point without re-injecting the buttons.
   */
  const actions = useRef({ onSaveAsTemplate, onExport, onAskAi });
  actions.current = { onSaveAsTemplate, onExport, onAskAi };
  const [ready, setReady] = useState(false);
  /**
   * Whether the editor was ever reachable.
   *
   * `public/drawio/` is a build output (`pnpm drawio:webapp`), and a developer who has never run it
   * — or whose `--optional` run was skipped for want of a network — gets an iframe that loads
   * nothing. Saying so beats a blank rectangle that looks like a hung editor.
   */
  const [missing, setMissing] = useState(false);

  /**
   * The one-time correction of the stored shape-library set, run **during render** rather than in
   * an effect.
   *
   * That is deliberate and it is the whole point: draw.io reads `.drawio-config` while it boots,
   * and the boot starts the moment the iframe below is in the DOM. An effect fires after that node
   * exists, so it would be racing the very read it is trying to get in front of. A guarded call
   * here happens before the element is created at all. See `seedEditorLibraries`.
   */
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    seedEditorLibraries();
  }

  const dark = theme === "dark";
  const url = embedUrl({ dark, language });

  const labels = useRef({ template: "", export: "", ai: "" });
  labels.current = {
    template: t("diagrams.saveAsTemplate"),
    export: t("diagrams.export"),
    ai: t("diagrams.ai.title"),
  };

  /**
   * The document to hand the editor, captured at the moment `init` arrives.
   *
   * Read from the store rather than from the `doc` prop through a closure, because the boot
   * sequence and the store's fetch of the document race: whichever settles last, the editor must be
   * given what the store holds *now*, not what it held when this callback was built.
   */
  const currentDoc = useCallback(() => useDiagramsStore.getState().draft?.doc ?? "", []);

  useEffect(() => {
    // A remount — theme, language, or a different diagram — starts from nothing.
    setReady(false);
    setMissing(false);
  }, [url, diagramId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The editor is same-origin, so anything from elsewhere is not it. Checked before parsing:
      // this window receives messages from other sources, and none of them should reach the
      // switch below.
      if (event.origin !== window.location.origin) return;
      if (event.source !== frame.current?.contentWindow) return;
      const message = parseEmbedMessage(event.data);
      if (!message) return;

      switch (message.event) {
        case "configure":
          postToEditor(frame.current, { action: "configure", config: editorConfig(dark) });
          break;

        case "init":
          /**
           * **Deferred by two frames, and this is not a superstition.**
           *
           * `init` fires before the editor's canvas has been laid out, so a document sent in the
           * same tick is fitted against a container of no size — draw.io computes a scale from
           * that and lands on **1 % zoom**, showing a blank canvas for a diagram that is perfectly
           * intact underneath. Reproduced on every cold open until this was added.
           *
           * Two `requestAnimationFrame`s rather than one: the first returns before layout, the
           * second after it. A timeout would work too, and would be a guess about how long layout
           * takes on a machine slower than the one it was tuned on.
           */
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              postToEditor(frame.current, {
                action: "load",
                xml: currentDoc(),
                autosave: 1,
                title,
              });
              setReady(true);
              // After the document, not before: the toolbar exists from `init`, but injecting into
              // it in the same tick as the load competes with draw.io's own first layout.
              injectToolbarButtons(frame.current, [
                {
                  id: "template",
                  icon: "template",
                  title: labels.current.template,
                  onClick: () => actions.current.onSaveAsTemplate(),
                },
                {
                  id: "export",
                  icon: "download",
                  title: labels.current.export,
                  onClick: (at) => actions.current.onExport(at),
                },
                {
                  id: "ai",
                  icon: "sparkles",
                  title: labels.current.ai,
                  onClick: () => actions.current.onAskAi(),
                },
              ]);
            });
          });
          break;

        case "autosave": {
          const xml = typeof message.xml === "string" ? message.xml : null;
          if (xml === null) break;
          useDiagramsStore.getState().editDoc(xml);
          // A real edit — `autosave` fires for nothing else — so the last generation stops being
          // the last thing that happened, and undoing back past this drawing would discard it.
          useDiagramsStore.getState().clearGenerationUndo();
          // The picture, asked for after every edit rather than on a timer: the export is answered
          // asynchronously and the store debounces the write, so the cost of asking often is one
          // message, while a timer would routinely store a thumbnail of a diagram as it was two
          // edits ago.
          postToEditor(frame.current, THUMBNAIL_EXPORT);
          break;
        }

        case "export": {
          const data = typeof message.data === "string" ? message.data : "";
          /**
           * **One event, two jobs**, told apart by whether a file was asked for.
           *
           * draw.io answers every export with the same message, so a save-to-disk and a thumbnail
           * refresh are indistinguishable from the outside. `awaitingFile` is set immediately
           * before a user-requested export and cleared here — the alternative was a second,
           * parallel message channel for something the editor only offers once.
           */
          const wanted = awaitingFile.current;
          if (wanted) {
            awaitingFile.current = null;
            void writeExport(data, wanted);
            break;
          }
          // Oversized pictures are dropped rather than stored — see `THUMBNAIL_MAX_CHARS`. An empty
          // string is a real value here: it clears a stale thumbnail from a diagram that has since
          // been emptied.
          useDiagramsStore
            .getState()
            .setThumbnail(diagramId, data.length > THUMBNAIL_MAX_CHARS ? "" : data);
          // **The document comes back with the picture, and that is how a merge is noticed at all.**
          // `merge` does not fire `autosave` — verified against the vendored build — so without
          // this an AI-applied diagram would sit on the canvas unsaved until the user moved
          // something. On an ordinary export the xml equals the draft and `editDoc` no-ops.
          if (typeof message.xml === "string") useDiagramsStore.getState().editDoc(message.xml);
          break;
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [dark, title, diagramId, currentDoc]);

  /**
   * The format a user-requested export is waiting for, or `null` for "this one is a thumbnail".
   *
   * A ref rather than state: it is read inside the message listener, which is registered once, and
   * a re-render would achieve nothing but re-registering it.
   */
  const awaitingFile = useRef<ExportFormat | null>(null);

  /** Turns an exported `data:` URI into a file the user chose a place for. */
  const writeExport = useCallback(
    async (data: string, format: ExportFormat) => {
      try {
        const title = useDiagramsStore.getState().diagrams.find((d) => d.id === diagramId)?.title;
        const saved = await saveBytes(bytesFromDataUri(data), format, title || "diagram");
        if (saved) useToastStore.getState().pushToast(t("diagrams.exported"), "success");
      } catch (error) {
        pushErrorToast(String(error));
      }
    },
    [diagramId, t],
  );

  /**
   * The export the toolbar asked for.
   *
   * PDF goes through the editor rather than through `pdfmake`, which the app already carries: the
   * editor is the only thing that knows how the diagram is drawn, and a second renderer would be a
   * second answer to "what does this look like".
   */
  const pendingExport = useDiagramsStore((s) => s.pendingExport);
  useEffect(() => {
    if (!pendingExport || !ready) return;
    awaitingFile.current = pendingExport;
    useDiagramsStore.getState().clearPendingExport();
    postToEditor(frame.current, {
      action: "export",
      format: pendingExport === "pdf" ? "pdf" : pendingExport,
      background: pendingExport === "svg" ? "none" : "#ffffff",
      scale: 2,
    });
  }, [pendingExport, ready]);

  /**
   * A document the store wants on screen — the result of a generation, or of undoing one.
   *
   * Sent as `load` rather than `merge`: draw.io's merge puts the incoming model on a second page
   * instead of into the open drawing, which with the page-tab strip hidden means nowhere at all.
   * The store has already combined it with what was drawn; see `appendCells`.
   *
   * The store also already holds this exact document, so nothing here needs to read it back — the
   * export that follows is only for the gallery's picture.
   */
  const pendingLoad = useDiagramsStore((s) => s.pendingLoad);
  useEffect(() => {
    if (!pendingLoad || !ready) return;
    postToEditor(frame.current, { action: "load", xml: pendingLoad, autosave: 1 });
    useDiagramsStore.getState().clearPendingLoad();
    // A frame later, so the document is on the canvas before its picture is asked for.
    requestAnimationFrame(() => postToEditor(frame.current, THUMBNAIL_EXPORT));
  }, [pendingLoad, ready]);

  /**
   * A boot that never arrives.
   *
   * `onError` does not fire for an iframe whose document 404s — the browser navigates it to an
   * error page perfectly happily — so the only reliable signal is that `init` never came. Six
   * seconds is far past a local load of a bundle that is already on disk.
   */
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setMissing(true), 6000);
    return () => clearTimeout(timer);
  }, [ready, url]);

  // The document has not arrived from the database yet. The frame is deliberately not mounted
  // before it does: the editor takes its document once, at `init`, and booting it against an empty
  // string would show a blank canvas for a diagram that has content.
  if (doc === null || draftId !== diagramId) return <ViewSkeleton />;

  if (missing) {
    return (
      <EmptyState
        icon={Workflow}
        title={t("diagrams.editorMissingTitle")}
        subtitle={t("diagrams.editorMissingSubtitle")}
      />
    );
  }

  return (
    <div className="relative h-full min-h-0 w-full">
      {!ready && (
        <div className="absolute inset-0 z-10">
          <ViewSkeleton />
        </div>
      )}
      <iframe
        // Remounts on theme or language change — both are read once, while booting. See the
        // component comment.
        key={url}
        ref={frame}
        src={url}
        title={t("diagrams.editorFrameTitle")}
        className="h-full w-full border-0"
        // No `sandbox`: the editor is our own vendored code on our own origin, and sandboxing it
        // into an opaque origin is precisely what would break the same-origin `postMessage` the
        // whole integration is built on.
      />
    </div>
  );
}
