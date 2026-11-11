import { describe, expect, it, vi } from "vitest";
import { renderChatMarkdown } from "./chatMarkdown";
import DOMPurify from "dompurify";

vi.mock("dompurify", () => ({ default: { sanitize: vi.fn((html: string) => html) } }));
vi.mock("./tauri/commands", () => ({ readFileBytes: vi.fn() }));

const LOCAL_IMAGE = "![Vista de los cuatro pensamientos](/private/tmp/pensamientos-preview.png)";
const LOCAL_ATTRIBUTE = 'data-cf-local-image="/private/tmp/pensamientos-preview.png"';
const SOURCE_ATTRIBUTE = "src=";
const IMAGE_ALT = 'alt="Vista de los cuatro pensamientos"';
const FILE_URI = "![Vista](file:///private/tmp/My%20Preview.png)";
const RELATIVE_IMAGE = "![Vista](./preview.png)";
const EXTERNAL_IMAGE = "![Vista](https://example.com/preview.png)";
const EXTERNAL_SOURCE = 'src="https://example.com/preview.png"';
const LOCAL_LINK = "[Abrir vista animada](/private/tmp/pensamientos-preview.html)";
const LOCAL_LINK_HTML = '<span class="cf-local-file" data-cf-local-file="/private/tmp/pensamientos-preview.html" title="/private/tmp/pensamientos-preview.html">Abrir vista animada</span>';
const CODE_BLOCK = "```md\n![Vista](/private/tmp/pensamientos-preview.png)\n```";
const CODE_LANGUAGE = 'class="language-md"';
const CODE_IMAGE = "![Vista](/private/tmp/pensamientos-preview.png)";
const ESCAPED_ALT = '![" onerror="alert(1)](/private/tmp/preview.png)';
const SAFE_ALT = 'alt="&quot; onerror=&quot;alert(1)"';
const OPTIONS = { ADD_ATTR: ["target", "data-cf-local-image", "data-cf-local-file"] };

describe("chat Markdown local images", () => {
  it("defers a local image to the IPC loader without asking the webview for a file URL", () => {
    const html = renderChatMarkdown(LOCAL_IMAGE);
    expect(html).toContain(LOCAL_ATTRIBUTE);
    expect(html).toContain(IMAGE_ALT);
    expect(html).not.toContain(SOURCE_ATTRIBUTE);
    expect(DOMPurify.sanitize).toHaveBeenLastCalledWith(html, OPTIONS);
  });

  it.each([FILE_URI, RELATIVE_IMAGE])("defers file URLs and repository images: %s", (source) => {
    const html = renderChatMarkdown(source);
    expect(html).toContain("data-cf-local-image=");
    expect(html).not.toContain(SOURCE_ATTRIBUTE);
  });

  it("keeps external images and renders local file references without a navigation target", () => {
    const image = renderChatMarkdown(EXTERNAL_IMAGE);
    const link = renderChatMarkdown(LOCAL_LINK);
    expect(image).toContain(EXTERNAL_SOURCE);
    expect(link).toContain(LOCAL_LINK_HTML);
    expect(link).not.toContain("href=");
  });

  it("leaves examples inside code blocks as source", () => {
    const html = renderChatMarkdown(CODE_BLOCK);
    expect(html).toContain(CODE_LANGUAGE);
    expect(html).toContain(CODE_IMAGE);
    expect(html).not.toContain(LOCAL_ATTRIBUTE);
  });

  it("escapes image labels before building markup", () => {
    const html = renderChatMarkdown(ESCAPED_ALT);
    expect(html).toContain(SAFE_ALT);
  });
});
