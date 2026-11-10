import { Marked, type Token, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { renderMermaid } from "./diagrams/mermaidRuntime";

const CODE_TOKEN = "code";
const STRING_TYPE = "string";
const MERMAID_LANGUAGE = "mermaid";
const EMPTY_LANGUAGE = "";
const PLAIN_LANGUAGES = new Set([EMPTY_LANGUAGE, "text", "plain", "plaintext"]);
const LANGUAGE_SEPARATOR = /\s+/;
const FIRST_LANGUAGE_INDEX = 0;
const MERMAID_HEADER = /^\s*(?:%%[^\n]*\n\s*)*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|sankey-beta|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|architecture-beta|kanban|radar-beta|treemap-beta)\b/;
const SVG_SANITIZE_OPTIONS = { USE_PROFILES: { svg: true, svgFilters: true } };
const MARKDOWN_SANITIZE_OPTIONS = { ADD_ATTR: ["target"] };
const HTML_TEXT_REPLACEMENTS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const HTML_TEXT_PATTERN = /[&<>"']/g;
const DIAGRAM_OPEN = '<div class="cf-chat-diagram">';
const DIAGRAM_CLOSE = "</div>";
const ERROR_OPEN = '<p class="cf-chat-diagram-error" role="alert">';
const ERROR_CLOSE = "</p>";

function isDiagram(token: Token): token is Tokens.Code {
  if (token.type !== CODE_TOKEN) return false;
  const hasText = typeof token.text === STRING_TYPE;
  if (!hasText) return false;
  const hasLanguage = typeof token.lang === STRING_TYPE;
  const trimmedLanguage = hasLanguage ? token.lang.trim() : EMPTY_LANGUAGE;
  const normalizedLanguage = trimmedLanguage.toLowerCase();
  const languageWords = normalizedLanguage.split(LANGUAGE_SEPARATOR);
  const language = languageWords[FIRST_LANGUAGE_INDEX];
  if (language === MERMAID_LANGUAGE) return true;
  const plainLanguage = PLAIN_LANGUAGES.has(language);
  if (!plainLanguage) return false;
  const mermaidHeader = MERMAID_HEADER.test(token.text);
  return mermaidHeader;
}

export async function renderArtifactMarkdown(source: string, dark: boolean, diagramFailed: string): Promise<string> {
  const diagrams = new Map<Tokens.Code, string>();
  const escapedFailure = diagramFailed.replace(HTML_TEXT_PATTERN, (character) => HTML_TEXT_REPLACEMENTS[character]);
  const failureMarkup = `${ERROR_OPEN}${escapedFailure}${ERROR_CLOSE}`;
  const parser = new Marked({
    gfm: true,
    breaks: false,
    async: true,
    renderer: {
      code(token) {
        const diagram = diagrams.get(token);
        return diagram ?? false;
      },
    },
    async walkTokens(token) {
      const diagram = isDiagram(token);
      if (!diagram) return;
      try {
        const svg = await renderMermaid(token.text, dark);
        const sanitizedSvg = DOMPurify.sanitize(svg, SVG_SANITIZE_OPTIONS);
        const diagramMarkup = `${DIAGRAM_OPEN}${sanitizedSvg}${DIAGRAM_CLOSE}`;
        diagrams.set(token, diagramMarkup);
      } catch {
        diagrams.set(token, failureMarkup);
      }
    },
  });
  const html = await parser.parse(source);
  return DOMPurify.sanitize(html, MARKDOWN_SANITIZE_OPTIONS);
}
