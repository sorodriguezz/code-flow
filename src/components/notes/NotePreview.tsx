import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";
import { diagramsLoadThumbnails, diagramsLoadTree } from "../../lib/tauri/diagramsCommands";
import { renderMarkdown } from "../../lib/markdown";
import { findTheme } from "../../lib/codeThemes";
import type { renderRichMarkdown } from "../../lib/notes/richMarkdown";
import { resolveNoteLink, useNotesStore } from "../../state/notesStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { useToastStore } from "../../state/toastStore";

/**
 * The rendered note: Markdown, with code blocks coloured the way the editor colours them and a
 * copy button on each.
 *
 * **The renderer is loaded on demand and cached at module scope.** It pulls in `monaco-editor` for
 * tokenising (see `lib/notes/richMarkdown`), so importing it directly would put the largest chunk
 * in the app behind the Notes *gallery* — a screen that renders no Markdown at all. Until it
 * resolves, the shared `renderMarkdown` draws the same document without the colours: correct
 * immediately, prettier a tick later. After the first note containing code, the module is cached
 * and every later render is synchronous, so the upgrade is visible exactly once per session.
 */
let cached: typeof renderRichMarkdown | null = null;

/** The workspace's diagrams by folded title, for `![[Title]]` — read once per workspace while the
 *  app runs, and again whenever an embed names one it does not know (a diagram made since). */
const diagramTitles = new Map<string, Map<string, { id: string; title: string }>>();

function foldTitle(title: string): string {
  return title.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function loadDiagramTitles(workspaceId: string): Promise<Map<string, { id: string; title: string }>> {
  const tree = await diagramsLoadTree(workspaceId);
  const map = new Map(tree.diagrams.map((d) => [foldTitle(d.title), { id: d.id, title: d.title }] as const));
  diagramTitles.set(workspaceId, map);
  return map;
}

export function NotePreview({ source, className }: { source: string; className?: string }) {
  const resolved = useThemeStore((s) => s.resolved);
  const darkThemeId = useThemeStore((s) => s.darkThemeId);
  const lightThemeId = useThemeStore((s) => s.lightThemeId);
  const t = useT();
  const notes = useNotesStore((s) => s.notes);
  const openNote = useNotesStore((s) => s.openNote);
  const workspaceId = useNotesStore((s) => s.workspaceId);
  const container = useRef<HTMLDivElement>(null);

  /**
   * The rendered HTML. Seeded with the plain rendering so there is never a blank frame, then
   * replaced once the highlighter has loaded *and* Monaco has the tokenizers this note needs.
   */
  const [html, setHtml] = useState(() => renderMarkdown(source));

  const theme = useMemo(
    () => findTheme(resolved === "dark" ? darkThemeId : lightThemeId, resolved),
    [resolved, darkThemeId, lightThemeId],
  );
  const copyLabel = t("notes.copyCode");
  const missingLabel = t("notes.linkMissing");
  // Resolution reads the whole workspace's titles, so a reference finds its note whether it is
  // loose or filed inside a book — see `resolveNoteLink`.
  const resolve = useCallback(
    (title: string) => resolveNoteLink(notes, title),
    [notes],
  );

  useEffect(() => {
    // The plain rendering for *this* source, immediately — otherwise switching notes would leave
    // the previous note's highlighted HTML on screen until the async pass below resolves.
    setHtml(renderMarkdown(source));

    let live = true;
    const render = async () => {
      if (!cached) {
        const module = await import("../../lib/notes/richMarkdown");
        cached = module.renderRichMarkdown;
      }
      let diagrams = workspaceId ? diagramTitles.get(workspaceId) : undefined;
      if (workspaceId && source.includes("![[") && !diagrams) diagrams = await loadDiagramTitles(workspaceId).catch(() => undefined);
      const resolveDiagram = (title: string) => diagrams?.get(foldTitle(title)) ?? null;
      const rich = await cached(source, theme, copyLabel, resolve, missingLabel, resolveDiagram);
      // The note may have been edited or closed while the tokenizers were loading; a stale render
      // dropped in here would show text the user has already changed.
      if (live) setHtml(rich);
    };
    // Silent on failure: the plain rendering is already on screen and readable, so a toast about
    // missing syntax colours would be noise about something the reader can see for themselves.
    void render().catch(() => {});

    return () => {
      live = false;
    };
  }, [source, theme, copyLabel, resolve, missingLabel, workspaceId]);

  // What the HTML marks for drawing after it lands: Mermaid blocks, and diagrams embedded with
  // `![[Title]]`. Done on the element rather than in the HTML string, because both are fetched or
  // computed — and redone whenever the HTML is replaced, which throws the drawn ones away.
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let live = true;
    const dark = resolved === "dark";
    root.querySelectorAll<HTMLElement>(".cf-note-mermaid").forEach((block) => {
      // Kept on the block, because drawing replaces the source it was read from. A theme switch that
      // leaves the HTML string as it was reruns this over the drawn diagram — React only rewrites
      // `innerHTML` when the string changes — and has to draw it again in the new colours.
      const code = block.querySelector(".cf-mermaid-src")?.textContent ?? block.dataset.cfMermaidCode ?? "";
      if (!code.trim()) return;
      block.dataset.cfMermaidCode = code;
      void import("../../lib/diagrams/mermaidRuntime")
        .then(({ renderMermaid }) => renderMermaid(code, dark))
        .then((svg) => {
          if (!live) return;
          block.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["style"] });
          block.classList.add("cf-note-mermaid-drawn");
        })
        .catch((error: unknown) => {
          if (!live) return;
          block.classList.add("cf-note-mermaid-error");
          block.setAttribute("title", String(error));
        });
    });
    const embeds = Array.from(root.querySelectorAll<HTMLElement>("[data-cf-diagram]"));
    const ids = [...new Set(embeds.map((el) => el.getAttribute("data-cf-diagram") ?? "").filter(Boolean))];
    if (ids.length > 0) {
      void diagramsLoadThumbnails(ids)
        .then((rows) => {
          if (!live) return;
          const byId = new Map(rows.map((row) => [row.id, row.thumbnail]));
          for (const el of embeds) {
            const picture = byId.get(el.getAttribute("data-cf-diagram") ?? "");
            if (!picture || el.querySelector("img")) continue;
            const img = document.createElement("img");
            img.src = picture;
            img.alt = el.getAttribute("title") ?? "";
            img.draggable = false;
            el.prepend(img);
          }
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [html, resolved]);

  /**
   * Copying, by delegation.
   *
   * The buttons live inside `dangerouslySetInnerHTML`, so they have no React handlers of their own
   * — one listener on the container finds the button that was clicked and reads the code out of
   * the DOM beside it. That also means the markup never has to carry a second copy of the block.
   */
  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;

      // An ordinary Markdown link — `[text](url)` — as opposed to a `[[note]]` reference, which
      // renders as a `<span>` and never reaches this branch. `marked` doesn't add
      // `target="_blank"`, so left alone this would navigate the app's own webview to wherever the
      // link points and leave the reader stranded on a website where CodeFlow used to be, with no
      // way back — the same bug `UpdateNotesModal`'s `openLinkExternally` exists to avoid, and the
      // same fix. Only http(s) is sent out; anything else (a `javascript:` URL slipped past
      // sanitizing, say) is simply swallowed.
      const anchor = target.closest?.("a");
      if (anchor) {
        event.preventDefault();
        const href = anchor.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(href)) void openUrl(href).catch(() => {});
        return;
      }

      // An embedded diagram opens in Diagramas.
      const embed = target.closest?.("[data-cf-diagram]");
      if (embed) {
        const id = embed.getAttribute("data-cf-diagram");
        if (id && workspaceId) void import("../../lib/dbmlBridge").then(({ showDiagramAnywhere }) => showDiagramAnywhere(workspaceId, id));
        return;
      }

      // A reference to another note. Checked before the copy branch below: a link inside a code
      // block's caption would otherwise be swallowed by it.
      const link = target.closest?.("[data-cf-note]");
      if (link) {
        const id = link.getAttribute("data-cf-note");
        if (id) void openNote(id);
        return;
      }

      const button = target.closest?.("[data-cf-copy]");
      if (!button) return;
      const code = button.parentElement?.querySelector("code")?.textContent ?? "";
      if (!code) return;
      void navigator.clipboard
        .writeText(code)
        .then(() => {
          useToastStore.getState().pushToast(t("notes.codeCopied"), "success");
          // A tick of state on the button itself, so the feedback is *where the click was* as well
          // as in the corner of the window. Removed on a timer rather than tracked in React: the
          // element is not ours to re-render.
          button.classList.add("cf-code-copied");
          window.setTimeout(() => button.classList.remove("cf-code-copied"), 1200);
        })
        .catch(() => {
          useToastStore.getState().pushToast(t("notes.copyFailed"), "error");
        });
    },
    [t, openNote, workspaceId],
  );

  return (
    <div
      ref={container}
      className={className}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        const link = (event.target as HTMLElement).closest?.("[data-cf-note]");
        const id = link?.getAttribute("data-cf-note");
        if (!id) return;
        event.preventDefault();
        void openNote(id);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
