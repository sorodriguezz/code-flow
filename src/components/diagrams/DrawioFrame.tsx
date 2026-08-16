import { useCallback, useEffect, useRef, useState } from "react";
import { Workflow } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ViewSkeleton } from "../common/ViewSkeleton";
import {
  editorConfig,
  embedUrl,
  forwardFramePresses,
  injectToolbarButtons,
  parseEmbedMessage,
  seedEditorLibraries,
  postToEditor,
  setEditorDarkMode,
  THUMBNAIL_EXPORT,
  THUMBNAIL_MAX_CHARS,
} from "../../lib/diagrams/embed";
import { bytesFromDataUri, saveBytes, type ExportFormat } from "../../lib/diagrams/exportFile";
import { useDiagramsStore } from "../../state/diagramsStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useThemeStore } from "../../state/themeStore";
import { afterThemeTransition } from "../../lib/themeTransition";

/**
 * The canvas: draw.io, in an iframe, wired to this workspace's store.
 *
 * **Mounted only while a diagram is open, and unmounted the moment one isn't.** That is the whole
 * memory strategy and it is not incidental — booting the editor costs ~25 MB of fetched JavaScript
 * and a comparable heap, and someone who never opens a diagram should pay none of it. `NotesView`
 * does the same with Monaco for the same reason; this is that decision applied to something an
 * order of magnitude heavier.
 *
 * **The frame is keyed on language**, which is a URL parameter the editor reads once while booting.
 * Changing it remounts the iframe, which reboots the editor and reloads the document from the
 * store. That is why the store's draft is the source of truth rather than whatever is inside the
 * frame: a remount must not lose an edit.
 *
 * **Theme is not part of that key.** It starts as one — the frame boots light or dark — but a later
 * light/dark switch is handed to the running editor instead (`setEditorDarkMode`), which repaints
 * it in a frame rather than rebooting it. `bootTheme` below is what the URL carries, and it only
 * moves if that live switch ever reports failure.
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
  /** The editor has booted and will accept messages — it has been sent its document. */
  const [ready, setReady] = useState(false);
  /** Which boot of the editor — see `frameKey` — has a drawing on its canvas. */
  const [paintedFrame, setPaintedFrame] = useState<string | null>(null);
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

  /**
   * The mode the frame is *booted* in — normally the mode the app was in when the diagram was
   * opened, and from then on a mode the running editor is simply told about.
   *
   * It moves only when `setEditorDarkMode` reports that it could not do the live switch, which is
   * the reload this used to do every time. Even then it waits for the theme wipe to finish:
   * rebooting draw.io inside the transition's synchronous commit put a blank iframe in the "after"
   * photograph the wipe animates towards, and then had a cold boot competing with the animation for
   * the main thread for the whole half-second.
   */
  const [bootTheme, setBootTheme] = useState(theme);
  /**
   * What the editor is actually wearing, which is not the same question as what it booted in — the
   * whole point of the live switch is that the two come apart. A ref because nothing renders from
   * it: it exists so a flip to dark and back to light is recognised as leaving the editor already
   * correct, rather than as two changes to apply.
   */
  const wearing = useRef(theme);

  const dark = bootTheme === "dark";
  const url = embedUrl({ dark, language });

  /**
   * One boot of the editor. Every change to it throws the iframe's document away and starts
   * another: the URL covers theme and language, and `diagramId` covers the rest, because switching
   * diagrams unmounts the frame through the draft guard further down rather than by changing `src`.
   */
  const frameKey = `${url}|${diagramId}`;
  const frameKeyRef = useRef(frameKey);
  frameKeyRef.current = frameKey;

  /**
   * Whether the editor has *drawn* its document, as opposed to having been handed it.
   *
   * This used to be one flag with `ready`, set in the same tick the `load` action was posted, and
   * that tick is far too early: `postMessage` only queues the document, so lifting the cover there
   * uncovered an editor mid-boot — an empty canvas at whatever scale it had guessed, the format
   * panel and toolbar still arriving, the drawing snapping into place a moment later. That settling
   * is what opening a diagram looked like.
   *
   * draw.io answers a completed `load` with a `load` event of its own whenever `proto=json` is in
   * the URL, which it always is here — checked in the vendored build, not assumed — so the cover
   * comes off on that instead. See the fallback below for what happens if it never arrives.
   *
   * **Derived from `frameKey` rather than reset by an effect**, which is the difference between a
   * remount being covered and a remount being covered *one frame late*. An effect runs after the
   * commit that swapped the iframe, so a boolean would have left the new, blank frame briefly
   * uncovered — a white flash in the canvas, on exactly the theme change this was meant to smooth.
   */
  const painted = paintedFrame === frameKey;

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
    // A remount — language, a different diagram, or the fallback reboot — starts from nothing.
    // `painted` is not here: it is derived from `frameKey`, so it is already false by the time this
    // runs. A fresh editor wears what its URL asked for, whatever the last one had been told.
    setReady(false);
    setMissing(false);
    wearing.current = bootTheme;
  }, [url, diagramId, bootTheme]);

  /**
   * A light/dark switch, handed to the editor that is already running.
   *
   * Gated on `painted` rather than `ready`, and that is not fussiness: `ready` is turned off in an
   * effect, so on the commit that swaps the iframe it is still reading `true` for one pass — long
   * enough for this to try to theme a frame that is empty, fail, and conclude the live route is
   * broken. `painted` is derived from `frameKey`, so it is already false in that same render.
   *
   * A `false` from `setEditorDarkMode` means the editor's internals moved under us; the reboot is
   * still there, and takes the same wipe-shaped detour it always did.
   */
  /**
   * Lets the rest of the app hear a click on the diagram — see `forwardFramePresses`. Bound as
   * soon as the editor is up rather than once it has drawn: a press on a booting canvas is still a
   * press, and a menu left open over it should close on that one too.
   */
  useEffect(() => {
    if (!ready) return;
    return forwardFramePresses(frame.current);
  }, [ready, frameKey]);

  useEffect(() => {
    if (!painted || wearing.current === theme) return;
    if (setEditorDarkMode(frame.current, theme === "dark")) {
      wearing.current = theme;
      return;
    }
    return afterThemeTransition(() => setBootTheme(theme));
  }, [painted, theme, frameKey]);

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

        case "load": {
          // The drawing is on the canvas and fitted. One frame further on before the cover comes
          // off, because this message is built and posted while the editor is still inside the call
          // that laid the document out — the frame after it is the first one that has been painted.
          //
          // The boot this answers is read *now* and not inside the frame: a remount landing in
          // between would otherwise have this stale confirmation uncover it.
          const booted = frameKeyRef.current;
          requestAnimationFrame(() => setPaintedFrame(booted));
          break;
        }

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
            // `.drawio` answers on `xml` and leaves `data` unset — there is no picture to render,
            // the document *is* the file. Everything else arrives as a `data:` URI.
            const xml = typeof message.xml === "string" ? message.xml : "";
            void writeExport(wanted === "drawio" ? xml : data, wanted);
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

  /**
   * Turns what the editor exported into a file the user chose a place for.
   *
   * `exported` is a `data:` URI for the rendered formats and the document's own markup for
   * `.drawio` — the one case where there is nothing to decode, because the text is already the
   * file. An empty answer is refused rather than written: a zero-byte `.drawio` on disk looks like
   * a saved diagram and opens as nothing.
   */
  const writeExport = useCallback(
    async (exported: string, format: ExportFormat) => {
      try {
        if (!exported) throw new Error(t("diagrams.exportEmpty"));
        const bytes =
          format === "drawio" ? new TextEncoder().encode(exported) : bytesFromDataUri(exported);
        const title = useDiagramsStore.getState().diagrams.find((d) => d.id === diagramId)?.title;
        const saved = await saveBytes(bytes, format, title || "diagram");
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
   *
   * `.drawio` goes through the editor too, and that is a choice worth stating: the store already
   * holds the document, so it could be written straight from `draft.doc`. It isn't, because the
   * draft is only as current as the last `autosave`, which draw.io debounces — exporting a second
   * after a stroke would save the drawing as it was before it. Asking the canvas is what makes
   * every format mean "what is on screen right now". It also hands back the full `<mxfile>`
   * wrapper, which is what other tools open, rather than the bare model the store keeps.
   */
  const pendingExport = useDiagramsStore((s) => s.pendingExport);
  useEffect(() => {
    if (!pendingExport || !ready) return;
    awaitingFile.current = pendingExport;
    useDiagramsStore.getState().clearPendingExport();
    // Nothing is rendered for `.drawio`, so the picture options are left off rather than sent and
    // ignored — a background and a scale on a text export would only read as if they did something.
    postToEditor(
      frame.current,
      pendingExport === "drawio"
        ? { action: "export", format: "xml" }
        : {
            action: "export",
            format: pendingExport,
            background: pendingExport === "svg" ? "none" : "#ffffff",
            scale: 2,
          },
    );
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

  /**
   * The cover comes off anyway, a second after the editor took its document.
   *
   * `painted` waits on a message from inside the iframe, and the failure mode of waiting on a
   * message is waiting forever — a bumped draw.io that stops answering `load` would leave a
   * skeleton over a perfectly working editor, which is a far worse bug than the flicker this
   * replaced. So the confirmation makes the reveal *accurate*, and this makes it *certain*. A
   * second is long past a local load and short enough to be recoverable if it is ever reached.
   */
  useEffect(() => {
    if (!ready || painted) return;
    const timer = setTimeout(() => setPaintedFrame(frameKey), 1000);
    return () => clearTimeout(timer);
  }, [ready, painted, frameKey]);

  /**
   * Holds the cover in the tree for the length of its fade, so the editor arrives by turning up
   * rather than by replacing a skeleton between two frames. Only ever *extends* the cover — what
   * puts it on screen is `!painted`, which is synchronous with the remount.
   *
   * Armed while still covered rather than on the reveal, and that ordering is the whole trick: set
   * on the way *out* it would arrive a commit after the veil had already been dropped from the
   * tree, and an element that is unmounted and remounted at `opacity-0` does not transition — it
   * blinks. Armed on the way in, the same node is on screen across the flip and only its class
   * changes, which is what a CSS transition needs.
   */
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (!painted) {
      setFading(true);
      return;
    }
    const timer = setTimeout(() => setFading(false), 260);
    return () => clearTimeout(timer);
  }, [painted]);

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
      {(!painted || fading) && (
        <div
          // **Opaque, unlike everywhere else `ViewSkeleton` is used.** It is a set of shimmer bars
          // on a transparent container — fine as a stand-in for a view that has not rendered, but
          // here it is laid over an iframe that is very much rendering, and a booting draw.io is a
          // sheet of white. Without a background of its own the cover showed that white between
          // its bars, which on a dark theme was most of what "opening a diagram flashes" was.
          //
          // `pointer-events-none` from the moment it starts fading: it is still on top for a
          // quarter of a second after the editor is usable, and a click swallowed by a skeleton
          // nobody can see any more is the kind of dead first click that reads as a hung app.
          className={`absolute inset-0 z-10 bg-[var(--cf-bg)] transition-opacity duration-[250ms] ease-out ${
            painted ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          <ViewSkeleton />
        </div>
      )}
      <iframe
        // Remounts on theme or language change — both are read once, while booting. The theme in
        // here is `frameTheme`, which is the app's a wipe later; see the component comment.
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
