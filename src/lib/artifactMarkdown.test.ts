import { beforeEach, describe, expect, it, vi } from "vitest";
import DOMPurify from "dompurify";
import { renderArtifactMarkdown } from "./artifactMarkdown";
import { splitArtifacts } from "./chatArtifacts";
import { renderMarkdown } from "./markdown";
import { renderMermaid } from "./diagrams/mermaidRuntime";

vi.mock("dompurify", () => ({ default: { sanitize: vi.fn((html: string) => html) } }));
vi.mock("./diagrams/mermaidRuntime", () => ({ renderMermaid: vi.fn() }));

const FLOWCHART = 'flowchart TD\nA[Paciente] --> B["Cita<br/>confirmada"]';
const SEQUENCE = "sequenceDiagram\nPaciente->>API: Reservar";
const STATE = "stateDiagram-v2\n[*] --> Reservada";
const INVALID_DIAGRAM = "flowchart TD\nA[";
const DIAGRAM_SVG = '<svg viewBox="0 0 300 100"><style>.label { fill: red; }</style><text>Diagrama</text></svg>';
const SEQUENCE_SVG = '<svg viewBox="0 0 300 100"><text>Secuencia</text></svg>';
const FAILURE_LABEL = "Revisa la pestaña Código";
const FAILURE_WITH_HTML = '<error> & "Código"';
const ESCAPED_FAILURE = "&lt;error&gt; &amp; &quot;Código&quot;";
const MARKDOWN_HEADING = "# Autoagendamiento";
const BETWEEN_DIAGRAMS = "Contacto **enmascarado**.";
const TYPESCRIPT = "const reserva = true;";
const CODE_FENCE = "```";
const TILDE_FENCE = "~~~";
const MERMAID_LANGUAGE = "mermaid";
const TYPESCRIPT_LANGUAGE = "ts";
const NEWLINE = "\n";
const DOCUMENT_SEPARATOR = "\n\n";
const EMPTY_TEXT = "";
const DARK_THEME = true;
const LIGHT_THEME = false;
const FIRST_INDEX = 0;
const SINGLE_CALL = 1;
const TWO_CALLS = 2;
const DIAGRAM_CLASS = 'class="cf-chat-diagram"';
const DIAGRAM_PATTERN = /class="cf-chat-diagram"/g;
const ERROR_CLASS = 'class="cf-chat-diagram-error"';
const SVG_SANITIZE_OPTIONS = { USE_PROFILES: { svg: true, svgFilters: true } };
const MARKDOWN_SANITIZE_OPTIONS = { ADD_ATTR: ["target"] };
const HEADING_HTML = "<h1>Autoagendamiento</h1>";
const PARAGRAPH_HTML = "<p>Contacto <strong>enmascarado</strong>.</p>";
const TYPESCRIPT_HTML = '<pre><code class="language-ts">const reserva = true;';
const MERMAID_CODE_CLASS = "language-mermaid";
const EXPLICIT_CODE_LANGUAGES = ["js", "json", "markdown"];
const INFERRED_LANGUAGES = [EMPTY_TEXT, "text", "plain", "plaintext"];
const MERMAID_LANGUAGES = [MERMAID_LANGUAGE, "Mermaid", "mermaid title=Flujo"];
const PLAIN_DOCUMENT = "# Documento\n\nTexto normal.\n\n```ts\nconst reserva = true;\n```";
const BLOCKQUOTE_DIAGRAM = "> ```mermaid\n> flowchart TD\n> A --> B\n> ```";
const LIST_DIAGRAM = "- Flujo:\n\n  ```mermaid\n  graph LR\n  A --> B\n  ```";
const NESTED_DOCUMENT = `${BLOCKQUOTE_DIAGRAM}${DOCUMENT_SEPARATOR}${LIST_DIAGRAM}`;
const NAMED_ARTIFACT_OPEN = '````artefacto {"name":"flujo","type":"markdown"}';
const NAMED_ARTIFACT_CLOSE = "````";
const SECOND_DOCUMENT = "# Otra versión";
const PARSE_ERROR = "Invalid diagram";

function fenced(source: string, language = MERMAID_LANGUAGE, fence = CODE_FENCE): string {
  return `${fence}${language}${NEWLINE}${source}${NEWLINE}${fence}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  const mockRender = vi.mocked(renderMermaid);
  mockRender.mockReset();
  mockRender.mockResolvedValue(DIAGRAM_SVG);
});

describe("Markdown artifact previews", () => {
  it("renders every diagram between prose and regular code without showing Mermaid source", async () => {
    const flowchart = fenced(FLOWCHART);
    const sequence = fenced(SEQUENCE);
    const code = fenced(TYPESCRIPT, TYPESCRIPT_LANGUAGE);
    const source = [MARKDOWN_HEADING, flowchart, BETWEEN_DIAGRAMS, code, sequence].join(DOCUMENT_SEPARATOR);
    const html = await renderArtifactMarkdown(source, DARK_THEME, FAILURE_LABEL);
    const diagrams = html.match(DIAGRAM_PATTERN);
    const headingPosition = html.indexOf(HEADING_HTML);
    const diagramPosition = html.indexOf(DIAGRAM_SVG);
    const paragraphPosition = html.indexOf(PARAGRAPH_HTML);
    const codePosition = html.indexOf(TYPESCRIPT_HTML);
    expect(diagrams).toHaveLength(TWO_CALLS);
    expect(headingPosition).toBeLessThan(diagramPosition);
    expect(diagramPosition).toBeLessThan(paragraphPosition);
    expect(paragraphPosition).toBeLessThan(codePosition);
    expect(html).not.toContain(MERMAID_CODE_CLASS);
    expect(html).not.toContain(FLOWCHART);
    expect(renderMermaid).toHaveBeenCalledWith(FLOWCHART, DARK_THEME);
    expect(renderMermaid).toHaveBeenCalledWith(SEQUENCE, DARK_THEME);
  });

  it.each(MERMAID_LANGUAGES)("renders explicit %s fences", async (language) => {
    const source = fenced(STATE, language);
    const html = await renderArtifactMarkdown(source, LIGHT_THEME, FAILURE_LABEL);
    expect(html).toContain(DIAGRAM_SVG);
    expect(renderMermaid).toHaveBeenCalledWith(STATE, LIGHT_THEME);
  });

  it.each(INFERRED_LANGUAGES)("recognizes Mermaid headers in '%s' fences", async (language) => {
    const source = fenced(FLOWCHART, language, TILDE_FENCE);
    const html = await renderArtifactMarkdown(source, DARK_THEME, FAILURE_LABEL);
    expect(html).toContain(DIAGRAM_CLASS);
    expect(html).not.toContain(FLOWCHART);
  });

  it.each(EXPLICIT_CODE_LANGUAGES)("keeps explicit %s examples as code even when they start with a diagram header", async (language) => {
    const source = fenced(FLOWCHART, language);
    const html = await renderArtifactMarkdown(source, DARK_THEME, FAILURE_LABEL);
    const codeClass = `language-${language}`;
    expect(html).toContain(codeClass);
    expect(renderMermaid).not.toHaveBeenCalled();
  });

  it("renders diagrams nested inside blockquotes and lists", async () => {
    const html = await renderArtifactMarkdown(NESTED_DOCUMENT, DARK_THEME, FAILURE_LABEL);
    const diagrams = html.match(DIAGRAM_PATTERN);
    expect(diagrams).toHaveLength(TWO_CALLS);
    expect(renderMermaid).toHaveBeenCalledTimes(TWO_CALLS);
  });

  it("leaves ordinary documents identical to the shared Markdown renderer", async () => {
    const html = await renderArtifactMarkdown(PLAIN_DOCUMENT, DARK_THEME, FAILURE_LABEL);
    const plain = renderMarkdown(PLAIN_DOCUMENT);
    expect(html).toBe(plain);
    expect(renderMermaid).not.toHaveBeenCalled();
  });

  it("isolates a failed diagram and escapes its message without hiding the rest of the document", async () => {
    const mockRender = vi.mocked(renderMermaid);
    const error = new Error(PARSE_ERROR);
    mockRender.mockRejectedValueOnce(error);
    mockRender.mockResolvedValueOnce(SEQUENCE_SVG);
    const invalid = fenced(INVALID_DIAGRAM);
    const valid = fenced(SEQUENCE);
    const source = [MARKDOWN_HEADING, invalid, BETWEEN_DIAGRAMS, valid].join(DOCUMENT_SEPARATOR);
    const html = await renderArtifactMarkdown(source, DARK_THEME, FAILURE_WITH_HTML);
    expect(html).toContain(HEADING_HTML);
    expect(html).toContain(ERROR_CLASS);
    expect(html).toContain(ESCAPED_FAILURE);
    expect(html).toContain(PARAGRAPH_HTML);
    expect(html).toContain(SEQUENCE_SVG);
    expect(html).not.toContain(INVALID_DIAGRAM);
  });

  it("sanitizes the SVG and the complete document before returning preview HTML", async () => {
    const source = fenced(FLOWCHART);
    const html = await renderArtifactMarkdown(source, DARK_THEME, FAILURE_LABEL);
    expect(DOMPurify.sanitize).toHaveBeenCalledWith(DIAGRAM_SVG, SVG_SANITIZE_OPTIONS);
    expect(DOMPurify.sanitize).toHaveBeenLastCalledWith(html, MARKDOWN_SANITIZE_OPTIONS);
    expect(html).toContain(DIAGRAM_SVG);
  });

  it("renders the extracted artifact without changing the original content used by Code and downloads", async () => {
    const diagram = fenced(FLOWCHART);
    const content = [MARKDOWN_HEADING, diagram].join(DOCUMENT_SEPARATOR);
    const answer = [NAMED_ARTIFACT_OPEN, content, NAMED_ARTIFACT_CLOSE].join(NEWLINE);
    const result = splitArtifacts(answer);
    const artifact = result.artifacts[FIRST_INDEX];
    const html = await renderArtifactMarkdown(artifact.content, DARK_THEME, FAILURE_LABEL);
    expect(html).toContain(DIAGRAM_SVG);
    expect(result.artifacts).toHaveLength(SINGLE_CALL);
    expect(artifact.content).toBe(content);
  });

  it("keeps separate versions and themes independent during concurrent renders", async () => {
    const diagram = fenced(FLOWCHART);
    const darkSource = [MARKDOWN_HEADING, diagram].join(DOCUMENT_SEPARATOR);
    const lightSource = [SECOND_DOCUMENT, diagram].join(DOCUMENT_SEPARATOR);
    const renders = [
      renderArtifactMarkdown(darkSource, DARK_THEME, FAILURE_LABEL),
      renderArtifactMarkdown(lightSource, LIGHT_THEME, FAILURE_LABEL),
    ];
    const [darkHtml, lightHtml] = await Promise.all(renders);
    expect(darkHtml).toContain(HEADING_HTML);
    expect(lightHtml).not.toContain(HEADING_HTML);
    expect(renderMermaid).toHaveBeenCalledWith(FLOWCHART, DARK_THEME);
    expect(renderMermaid).toHaveBeenCalledWith(FLOWCHART, LIGHT_THEME);
  });
});
