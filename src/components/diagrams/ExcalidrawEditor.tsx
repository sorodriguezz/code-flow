import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, History, LayoutTemplate } from "lucide-react";
import {
  CaptureUpdateAction,
  Excalidraw,
  exportToBlob,
  exportToSvg,
  hashElementsVersion,
  MainMenu,
  restore,
  serializeAsJSON,
  THEME,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import { AiSparkles } from "../common/AiGlyph";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { EMPTY_EXCALIDRAW_DOC } from "../../lib/diagrams/doc";
import { THUMBNAIL_MAX_CHARS } from "../../lib/diagrams/embed";
import { saveBytes } from "../../lib/diagrams/exportFile";
import { pngToPdf } from "../../lib/diagrams/pdf";
import type { PendingExport } from "../../lib/diagrams/exportOptions";
import { useDiagramsStore } from "../../state/diagramsStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useThemeStore } from "../../state/themeStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";

/**
 * The editor for a diagram whose format is `excalidraw` — hand-drawn whiteboard sketches.
 *
 * **Import it only through a loader that has called `pointExcalidrawAtBundledFonts` first** — see
 * that function for why the fonts' address cannot be set from in here.
 *
 * Same contract as `DrawioFrame` and `DbmlWorkbench`: handed a diagram id, it reads the document out
 * of `diagramsStore.draft` and writes every edit back through `editDoc`. Unlike draw.io it is not an
 * iframe — Excalidraw is a React component — so it renders straight into this tree, follows the
 * app's theme and language as props, and the app's actions sit in its own top-right corner beside
 * its library button, styled by its own classes.
 *
 * # The document is the `.excalidraw` file
 *
 * What is stored is exactly what Excalidraw writes to disk (`serializeAsJSON(…, "local")`): the
 * scene's elements, the few settings a file keeps (background, grid) and any pasted images. So
 * exporting `.excalidraw` is the document itself, an imported file is a document as it stands, and
 * nothing here has a dialect of its own to keep in step.
 *
 * # What is turned off
 *
 * The editor's own open, save and image-export dialogs: they go through the browser's file APIs,
 * which a desktop webview does not have — the app's export menu and the explorer's import do that
 * job. Its theme toggle (the app's theme drives it), its AI dialog (which calls Excalidraw's
 * servers) and the links to its socials in its menu are off too. Its laser pointer is not: the
 * toolbar carries one, the same gesture as the other editors' — hold to draw, let go and it fades.
 */
export function ExcalidrawEditor({
  diagramId,
  onSaveAsTemplate,
  onExport,
  onAskAi,
  onHistory,
}: {
  diagramId: string;
  onSaveAsTemplate: () => void;
  /** Opens the export menu at a point in window coordinates — the same menu draw.io's button opens. */
  onExport: (at: { x: number; y: number }) => void;
  onAskAi?: () => void;
  onHistory: () => void;
}) {
  const t = useT();
  const doc = useDiagramsStore((s) => (s.draft?.id === diagramId ? s.draft.doc : null));
  const title = useDiagramsStore((s) => s.diagrams.find((d) => d.id === diagramId)?.title ?? "");
  const theme = useThemeStore((s) => s.resolved);
  const language = useLanguageStore((s) => s.language);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  /**
   * The document as this editor last wrote or loaded it.
   *
   * Every write comes straight back through the store as a new `doc`, and telling that echo apart
   * from a document replaced from outside — a restored version, a generation, a reload from disk —
   * is what this is for: only the second kind is pushed into the scene.
   */
  const written = useRef<string | null>(null);
  /** The scene's fingerprint at the last write, so a pan or a selection writes nothing. */
  const writtenKey = useRef<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const thumbTimer = useRef<number | null>(null);

  /**
   * The scene the editor opens on — read once per diagram, from the document as it stood when the
   * editor mounted. Later changes reach the scene through `updateScene`, never through this.
   */
  const initialData = useMemo<ExcalidrawInitialDataState | null>(
    () => {
      const scene = doc === null ? null : readScene(doc);
      written.current = doc;
      if (scene) writtenKey.current = sceneKey(scene.elements ?? [], scene.appState ?? {}, scene.files ?? {});
      return scene ? { ...scene, libraryItems: loadLibrary(), scrollToContent: true } : null;
    },
    // Once per diagram, and only once the document has arrived: `doc` itself changes on every
    // edit, and re-reading it would hand the editor a new initial scene it ignores anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diagramId, doc === null],
  );

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      if (thumbTimer.current !== null) window.clearTimeout(thumbTimer.current);
    },
    [],
  );

  /**
   * Every change the editor reports — which is every pointer move over the canvas, a scroll, a
   * selection. Most of them change nothing a file keeps, so they are fingerprinted first and only a
   * real edit is serialised and written, a quarter of a second after the last one.
   */
  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      const key = sceneKey(elements, appState, files);
      if (key === writtenKey.current) return;
      writtenKey.current = key;
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        const json = serializeAsJSON(elements, appState, files, "local");
        written.current = json;
        const store = useDiagramsStore.getState();
        store.editDoc(json);
        // A real edit — a document put on the canvas from outside writes nothing (see
        // `writtenKey`) — so the last generation stops being the last thing that happened, and
        // undoing back past this drawing would discard it. The same rule draw.io's autosave keeps.
        store.clearGenerationUndo();
      }, SAVE_DEBOUNCE_MS);
      if (thumbTimer.current !== null) window.clearTimeout(thumbTimer.current);
      thumbTimer.current = window.setTimeout(() => {
        thumbTimer.current = null;
        void drawThumbnail(diagramId, elements, appState, files);
      }, THUMBNAIL_DEBOUNCE_MS);
    },
    [diagramId],
  );

  /**
   * A document replaced from outside — a restored version, a generation, the file reloaded — put
   * on the canvas. The editor's own writes come back here too and are recognised by `written`.
   */
  useEffect(() => {
    if (!api || doc === null || doc === written.current) return;
    written.current = doc;
    const scene = readScene(doc);
    const elements = scene?.elements ?? [];
    writtenKey.current = sceneKey(elements, scene?.appState ?? {}, scene?.files ?? {});
    if (scene?.files) api.addFiles(Object.values(scene.files));
    api.updateScene({
      elements,
      appState: { viewBackgroundColor: scene?.appState?.viewBackgroundColor ?? "#ffffff" },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    api.scrollToContent(undefined, { fitToContent: true });
  }, [api, doc]);

  /** The export the menu asked for — see `requestExport`. Drawn here: only this editor can. */
  const pendingExport = useDiagramsStore((s) => s.pendingExport);
  useEffect(() => {
    if (!pendingExport || !api) return;
    useDiagramsStore.getState().clearPendingExport();
    void exportScene(api, pendingExport, title || "diagram", theme).then(
      (saved) => {
        if (saved) useToastStore.getState().pushToast(t("diagrams.exported"), "success");
      },
      (error) => pushErrorToast(String(error)),
    );
  }, [pendingExport, api, title, theme, t]);

  if (doc === null || initialData === null) return <ViewSkeleton />;

  return (
    <div className="h-full w-full">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        onLibraryChange={saveLibrary}
        theme={theme === "dark" ? THEME.DARK : THEME.LIGHT}
        langCode={language === "es" ? "es-ES" : "en"}
        name={title}
        aiEnabled={false}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            saveAsImage: false,
            toggleTheme: false,
          },
        }}
        renderTopRightUI={() => (
          <div className="flex items-center gap-2" style={{ pointerEvents: "auto" }}>
            <CornerButton label={t("diagrams.saveAsTemplate")} onClick={onSaveAsTemplate}>
              <LayoutTemplate size={16} />
            </CornerButton>
            <CornerButton
              label={t("diagrams.export")}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                onExport({ x: box.left, y: box.bottom + 4 });
              }}
            >
              <Download size={16} />
            </CornerButton>
            {onAskAi && (
              <CornerButton label={t("diagrams.ai.title")} onClick={onAskAi}>
                <AiSparkles size={16} />
              </CornerButton>
            )}
            <CornerButton label={t("versions.open")} onClick={onHistory}>
              <History size={16} />
            </CornerButton>
          </div>
        )}
      >
        {/* The menu the editor would draw anyway, minus what the options above turned off and the
            links to its GitHub, Twitter and Discord, which are not this app's to advertise. */}
        <MainMenu>
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}

/**
 * One of the app's actions in the editor's top-right corner, wearing the editor's own button class
 * — the one its library button wears — so the corner reads as one row of one toolkit's controls.
 */
function CornerButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className="sidebar-trigger" title={label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** How long after the last edit the document is serialised and handed to the store. */
const SAVE_DEBOUNCE_MS = 250;
/** And the gallery's picture, which rasterises. Same pace as the schema workbench's. */
const THUMBNAIL_DEBOUNCE_MS = 1400;
/** The thumbnail's longest edge. The gallery draws cards a fraction of this wide. */
const THUMBNAIL_EDGE = 480;

/**
 * A stored document as a scene — `null` when it is not one, and an empty scene for the empty string
 * a diagram created before this format had a blank of its own would carry.
 */
export function readScene(doc: string): ExcalidrawInitialDataState | null {
  try {
    const data = JSON.parse(doc.trim() || EMPTY_EXCALIDRAW_DOC);
    if (data?.type !== "excalidraw") return null;
    const restored = restore(data, null, null, { repairBindings: true });
    return { elements: restored.elements, appState: restored.appState, files: restored.files };
  } catch {
    return null;
  }
}

/**
 * What a write would change, in one string: the elements' versions (an edit, a delete, a restyle
 * all bump one), the two settings a file keeps, and which images are attached. A pan, a zoom, a
 * selection or a hover changes none of them.
 */
function sceneKey(
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): string {
  return [
    hashElementsVersion(elements),
    appState.viewBackgroundColor ?? "",
    appState.gridModeEnabled ? 1 : 0,
    Object.keys(files).sort().join(","),
  ].join("|");
}

/** The gallery's picture: a light PNG on the scene's own background, small enough to store. */
async function drawThumbnail(
  diagramId: string,
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): Promise<void> {
  const drawn = elements.filter((element) => !element.isDeleted);
  try {
    const uri =
      drawn.length === 0
        ? ""
        : await blobToDataUri(
            await exportToBlob({
              elements: drawn,
              appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
              files,
              mimeType: "image/png",
              maxWidthOrHeight: THUMBNAIL_EDGE,
            }),
          );
    useDiagramsStore.getState().setThumbnail(diagramId, uri.length > THUMBNAIL_MAX_CHARS ? "" : uri);
  } catch {
    // A picture that could not be drawn is not worth a message: the card falls back to its glyph,
    // which is what a diagram with no thumbnail has always looked like.
  }
}

/**
 * One export, written where the user picks.
 *
 * `.excalidraw` is the scene serialised the way the editor itself saves it — the document, current
 * to the last stroke rather than to the last debounced write. The pictures are drawn by Excalidraw
 * from the same scene; a PDF is the PNG, wrapped (see `lib/diagrams/pdf`), as draw.io's is.
 *
 * The export dialog's options map onto the editor's own: zoom is the scale, the border is the
 * padding, "transparent" drops the background, and the appearance picks the dark rendering — on
 * "auto", whichever the app is showing.
 */
async function exportScene(
  api: ExcalidrawImperativeAPI,
  request: PendingExport,
  name: string,
  theme: "light" | "dark",
): Promise<boolean> {
  const elements = api.getSceneElements();
  const appState = api.getAppState();
  const files = api.getFiles();
  if (request.format === "excalidraw") {
    const json = serializeAsJSON(elements, appState, files, "local");
    return saveBytes(new TextEncoder().encode(json), "excalidraw", name);
  }
  if (request.format === "drawio") return false;
  const { zoom, border, transparent, appearance } = request.options;
  const scale = zoom / 100;
  const exportAppState = {
    ...appState,
    exportScale: scale,
    exportBackground: !transparent,
    exportWithDarkMode: appearance === "auto" ? theme === "dark" : appearance === "dark",
    exportEmbedScene: false,
  };
  if (request.format === "svg") {
    const svg = await exportToSvg({ elements, appState: exportAppState, files, exportPadding: border });
    return saveBytes(new TextEncoder().encode(svg.outerHTML), "svg", name);
  }
  const blob = await exportToBlob({
    elements,
    appState: exportAppState,
    files,
    mimeType: "image/png",
    exportPadding: border,
  });
  const png = new Uint8Array(await blob.arrayBuffer());
  return request.format === "pdf"
    ? saveBytes(await pngToPdf(png, scale), "pdf", name)
    : saveBytes(png, "png", name);
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * The shape library — the editor's own panel of saved pieces — kept on this machine.
 *
 * Excalidraw embedded holds it in memory only; without this, every piece somebody saved would be
 * gone the next time a diagram opened. One library for every diagram, which is how the editor
 * presents it: a toolbox, not part of any one drawing.
 */
const LIBRARY_KEY = "cf.excalidraw.library";

function loadLibrary(): LibraryItems {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function saveLibrary(items: LibraryItems): void {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(items));
  } catch {
    // Too large for the store, or the store is off: the library lasts the session.
  }
}
