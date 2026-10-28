import { useLayoutEffect, type RefObject } from "react";
import DOMPurify from "dompurify";
import { mayContainMath, splitMath } from "../../lib/mathText";

/** What the extra blocks say. */
export interface RichBlockLabels {
  preview: string;
  hidePreview: string;
  diagramFailed: string;
}

/** Where a block is drawn relative to the code frame the bubble puts around every `<pre>`. */
function frameOf(pre: Element): Element {
  return pre.closest(".cf-chat-code") ?? pre;
}

/** Text nodes worth scanning: not inside code, a link or a formula already drawn. */
function mathCandidates(host: HTMLElement): Text[] {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("pre, code, a, .katex, .cf-math-block, script, style")) return NodeFilter.FILTER_REJECT;
      return mayContainMath(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const found: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) found.push(node as Text);
  return found;
}

/** KaTeX's own output, sanitised anyway: the formula text came from a model. */
function formula(katex: typeof import("katex").default, source: string, display: boolean): string {
  try {
    return DOMPurify.sanitize(katex.renderToString(source, { displayMode: display, throwOnError: false, output: "html", strict: "ignore", trust: false }));
  } catch {
    return "";
  }
}

async function renderMath(host: HTMLElement): Promise<void> {
  const nodes = mathCandidates(host);
  if (nodes.length === 0) return;
  const [{ default: katex }] = await Promise.all([import("katex"), import("katex/dist/katex.min.css")]);
  for (const node of nodes) {
    // The answer may have been replaced while KaTeX loaded: a node that left the page is nobody's now.
    if (!node.isConnected) continue;
    const segments = splitMath(node.nodeValue ?? "");
    if (segments.every((segment) => segment.kind === "text")) continue;
    const fragment = document.createDocumentFragment();
    for (const segment of segments) {
      if (segment.kind === "text") {
        fragment.append(segment.value);
        continue;
      }
      const html = formula(katex, segment.value, segment.kind === "display");
      if (!html) {
        // A formula KaTeX refused stays as the text the model wrote.
        fragment.append(segment.kind === "display" ? `$$${segment.value}$$` : `$${segment.value}$`);
        continue;
      }
      const holder = document.createElement(segment.kind === "display" ? "div" : "span");
      holder.className = segment.kind === "display" ? "cf-math-block" : "cf-math-inline";
      holder.innerHTML = html;
      fragment.append(holder);
    }
    node.replaceWith(fragment);
  }
}

/** A diagram above its code block. The code stays, with its Copy bar: a diagram that fails to draw leaves
 * the person exactly what they had. */
async function drawDiagrams(host: HTMLElement, dark: boolean, added: HTMLElement[], failed: string, alive: () => boolean): Promise<void> {
  const blocks = Array.from(host.querySelectorAll("pre > code.language-mermaid"));
  if (blocks.length === 0) return;
  const { renderMermaid } = await import("../../lib/diagrams/mermaidRuntime");
  for (const code of blocks) {
    const source = code.textContent ?? "";
    const pre = code.parentElement;
    if (!pre || !source.trim()) continue;
    try {
      const svg = await renderMermaid(source, dark);
      if (!alive() || !pre.isConnected) return;
      const box = document.createElement("div");
      box.className = "cf-chat-diagram";
      // Mermaid ran with `securityLevel: "strict"`, and the SVG goes through the sanitiser too.
      box.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      frameOf(pre).before(box);
      added.push(box);
    } catch {
      // A parse error: say so under the code rather than drawing nothing and saying nothing.
      if (!alive() || !pre.isConnected) return;
      const note = document.createElement("div");
      note.className = "cf-chat-diagram-error";
      note.textContent = failed;
      frameOf(pre).after(note);
      added.push(note);
    }
  }
}

/** HTML in a fence can be looked at, in a frame that can run nothing and reach nothing. */
function previewHtml(host: HTMLElement, labels: RichBlockLabels, added: HTMLElement[]): void {
  for (const code of Array.from(host.querySelectorAll("pre > code.language-html"))) {
    const pre = code.parentElement;
    const frame = pre ? frameOf(pre) : null;
    const bar = frame?.querySelector(".cf-chat-code-bar");
    if (!pre || !frame || !bar) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cf-chat-code-btn";
    button.textContent = labels.preview;
    let box: HTMLElement | null = null;
    button.addEventListener("click", () => {
      if (box) {
        box.remove();
        added.splice(added.indexOf(box), 1);
        box = null;
        button.textContent = labels.preview;
        return;
      }
      const iframe = document.createElement("iframe");
      // No scripts, no forms, no same-origin: it can draw and nothing else. And no network either — the
      // policy blocks every fetch, so a page in an answer cannot phone anywhere to say it was opened.
      iframe.setAttribute("sandbox", "");
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.className = "cf-chat-html-preview";
      iframe.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">${code.textContent ?? ""}`;
      box = document.createElement("div");
      box.className = "cf-chat-html-preview-box";
      box.append(iframe);
      frame.after(box);
      added.push(box);
      button.textContent = labels.hidePreview;
    });
    bar.append(button);
    added.push(button);
  }
}

/**
 * What an answer's fences and formulas become, drawn on the markup after the fact: Mermaid as a diagram,
 * `$…$` as KaTeX, HTML as a preview on request.
 *
 * Done to the DOM and not in the markdown pipeline for the same reason the code bars are
 * (`useCodeBlockActions`): the sanitiser sees every byte that came from the model, and nothing here lets
 * one through it. It runs after that hook, so the code frames it hangs things on already exist, and
 * everything it adds is removed with the markup it belongs to.
 */
export function useRichChatBlocks(ref: RefObject<HTMLElement | null>, markup: { __html: string } | null, dark: boolean, labels: RichBlockLabels): void {
  const { preview, hidePreview, diagramFailed } = labels;
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || markup === null) return;
    let live = true;
    const added: HTMLElement[] = [];
    void renderMath(host).catch(() => {});
    void drawDiagrams(host, dark, added, diagramFailed, () => live).catch(() => {});
    previewHtml(host, { preview, hidePreview, diagramFailed }, added);
    return () => {
      live = false;
      added.forEach((node) => node.remove());
    };
  }, [ref, markup, dark, preview, hidePreview, diagramFailed]);
}
