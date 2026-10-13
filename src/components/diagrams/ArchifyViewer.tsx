import { useEffect, useMemo, useRef } from "react";
import { FileWarning } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { archifyDocKind } from "../../lib/diagrams/archify/ir";
import { compareArchitectures } from "../../lib/diagrams/archify/delta";
import { presetNames, viewerLabels } from "../../lib/diagrams/archify/labels";
import { pageFromScene, renderArchifyPage, type PageOptions } from "../../lib/diagrams/archify/render";
import type { HostTheme } from "../../lib/diagrams/archify/viewer/html";
import { useDiagramsStore } from "../../state/diagramsStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useThemeStore } from "../../state/themeStore";

/** Where the frame's document comes from — see the comment at the top of that file. */
const HOST_PATH = "/archify/host.html";

/**
 * A colour as the browser resolves it. A token can be defined in terms of another, and a page in a
 * sandboxed frame cannot follow a `var()` into a stylesheet it does not have.
 */
function resolved(probe: HTMLElement, name: string, fallback: string): string {
  probe.style.color = "";
  probe.style.color = `var(${name}, ${fallback})`;
  return getComputedStyle(probe).color || fallback;
}

/** The app's palette, as the viewer's variables — so the diagram looks like the window it is in. */
export function readHostTheme(scheme: "dark" | "light"): HostTheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const c = (name: string, fallback: string) => resolved(probe, name, fallback);
  const dark = scheme === "dark";
  const host: HostTheme = {
    scheme,
    bg: c("--cf-surface", dark ? "#0a111e" : "#ffffff"),
    panel: c("--cf-surface", dark ? "#0e1727" : "#ffffff"),
    panel2: c("--cf-surface-2", dark ? "#131f33" : "#f3f5f9"),
    line: c("--cf-border", dark ? "#223149" : "#d8dee8"),
    line2: c("--cf-border", dark ? "#19273d" : "#e7ebf2"),
    text: c("--cf-text", dark ? "#e8eefc" : "#0f172a"),
    muted: c("--cf-text-muted", dark ? "#8fa1bc" : "#566277"),
    faint: c("--cf-text-faint", dark ? "#5f7089" : "#8793a6"),
    accent: c("--cf-accent", dark ? "#5eead4" : "#0d9488"),
    accent2: c("--cf-accent-soft", dark ? "rgba(94,234,212,.12)" : "rgba(13,148,136,.1)"),
    hover: c("--cf-hover", dark ? "#17243a" : "#eef2f7"),
  };
  probe.remove();
  return host;
}

/** What the open viewer can hand back: the drawing as a file's bytes. Absent for an imported page. */
export interface ArchifyExporter {
  svg(): Promise<string>;
  png(): Promise<Uint8Array>;
}
let activeExporter: ArchifyExporter | null = null;
/** The viewer on screen, for the export menu that lives in `DiagramsView`'s header. */
export const currentArchifyExporter = () => activeExporter;

/** A cheap fingerprint of the page, so a changed document remounts the frame. FNV-1a. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * An archify diagram, shown — read-only: the document is archify's, and changing it is a job for the
 * engine that wrote it or for the file in a repository.
 *
 * **Framed, sandboxed, and fed by message.** The page runs in `public/archify/host.html` under
 * `sandbox="allow-scripts"` — an opaque origin with no way into the app — and is posted to it once the
 * host has loaded. Not `srcdoc`: that inherits the app's build-time policy, which refuses the inline
 * scripts the whole viewer is made of. `pnpm tauri dev` has no policy, which is how the first version
 * of this shipped a map that only worked in development.
 *
 * The theme is *told* to the page rather than baked in, so changing it recolours the diagram in
 * place instead of reloading it and losing what was selected.
 */
export function ArchifyViewer({
  diagramId,
  title,
  compareWith,
}: {
  diagramId: string;
  title: string;
  /** The document of another architecture to hold this one against, if a comparison is on. */
  compareWith?: string | null;
}) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const scheme = useThemeStore((s) => s.resolved);
  const darkId = useThemeStore((s) => s.darkThemeId);
  const lightId = useThemeStore((s) => s.lightThemeId);
  const doc = useDiagramsStore((s) => (s.draft?.id === diagramId ? s.draft.doc : ""));
  /** Read when the page is built, not tracked: a theme change is a message, not a rebuild. */
  const hostRef = useRef<HostTheme | null>(null);

  const page = useMemo(() => {
    hostRef.current = readHostTheme(useThemeStore.getState().resolved);
    const options: PageOptions = {
      title,
      language,
      theme: useThemeStore.getState().resolved,
      labels: (mode) => viewerLabels(t, mode),
      presetNames: presetNames(t),
      linkSources: false,
      embed: true,
      host: hostRef.current,
    };
    if (compareWith) {
      const head = archifyDocKind(doc, title);
      const base = archifyDocKind(compareWith, title);
      if (head.kind === "document" && base.kind === "document" && head.ir.diagram_type === "architecture" && base.ir.diagram_type === "architecture") {
        const scene = compareArchitectures(base.ir, head.ir);
        scene.title = title;
        return { kind: "viewer" as const, html: pageFromScene(scene, options) };
      }
    }
    return renderArchifyPage(doc, options);
    // `t` changes with the language, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, title, language, compareWith]);

  const key = page.kind === "invalid" ? "" : fingerprint(page.html);
  const frame = useRef<HTMLIFrameElement>(null);
  /** The page the frame was last sent. The host replaces itself on the first message, and the
   *  document it writes fires `load` again — which must not post the page into the page. */
  const posted = useRef("");

  // The theme, told to the page already on screen.
  useEffect(() => {
    if (page.kind !== "viewer") return;
    const timer = window.setTimeout(() => {
      const host = readHostTheme(scheme);
      hostRef.current = host;
      frame.current?.contentWindow?.postMessage({ type: "archify:theme", host }, "*");
    }, 140);
    return () => window.clearTimeout(timer);
  }, [scheme, darkId, lightId, page.kind, key]);

  // The export menu's way into the page.
  useEffect(() => {
    if (page.kind !== "viewer") return;
    const pending = new Map<number, { resolve: (value: { svg?: string; png?: ArrayBuffer }) => void; reject: (error: Error) => void }>();
    let next = 0;
    const onMessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; id?: number; error?: boolean; svg?: string; png?: ArrayBuffer } | null;
      if (event.source !== frame.current?.contentWindow || message?.type !== "archify:exported" || message.id === undefined) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error("export failed"));
      else entry.resolve(message);
    };
    window.addEventListener("message", onMessage);
    const ask = (format: "svg" | "png") =>
      new Promise<{ svg?: string; png?: ArrayBuffer }>((resolve, reject) => {
        const target = frame.current?.contentWindow;
        if (!target) return reject(new Error("The diagram is not on screen"));
        const id = next++;
        pending.set(id, { resolve, reject });
        target.postMessage({ type: "archify:export", format, id }, "*");
        window.setTimeout(() => {
          if (pending.delete(id)) reject(new Error("The diagram did not answer"));
        }, 20000);
      });
    activeExporter = {
      svg: async () => (await ask("svg")).svg ?? "",
      png: async () => new Uint8Array((await ask("png")).png ?? new ArrayBuffer(0)),
    };
    return () => {
      window.removeEventListener("message", onMessage);
      activeExporter = null;
    };
  }, [page.kind, key]);

  if (page.kind === "invalid") {
    return (
      <EmptyState
        icon={FileWarning}
        title={t("archify.unreadable")}
        subtitle={page.error === "mode" ? t("archify.unknownMode", { mode: page.mode ?? "" }) : t("archify.unreadableHint")}
      />
    );
  }

  return (
    <iframe
      key={key}
      ref={frame}
      title={title}
      src={HOST_PATH}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-[var(--cf-surface)]"
      onLoad={() => {
        if (posted.current === key) return;
        posted.current = key;
        // `*` because the host's origin is opaque — there is no name to address it by. What is sent
        // is the diagram the user is looking at, to the frame this component just made.
        frame.current?.contentWindow?.postMessage({ type: "codeflow:archify-render", html: page.html }, "*");
      }}
    />
  );
}
