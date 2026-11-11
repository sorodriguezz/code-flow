import { Marked } from "marked";
import DOMPurify from "dompurify";
import { chatLocalFile } from "./chatLocalFiles";

const LOCAL_IMAGE_ATTRIBUTE = "data-cf-local-image";
const LOCAL_LINK_ATTRIBUTE = "data-cf-local-file";
const LOCAL_LINK_CLASS = "cf-local-file";
const ESCAPE_PATTERN = /[&<>"']/g;
const ESCAPED_CHARACTERS: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const SANITIZE_OPTIONS = { ADD_ATTR: ["target", LOCAL_IMAGE_ATTRIBUTE, LOCAL_LINK_ATTRIBUTE] };
const RELATIVE_ROOT = ".";

function escapeAttribute(value: string): string {
  return value.replace(ESCAPE_PATTERN, (character) => ESCAPED_CHARACTERS[character]);
}

const chatParser = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    link(token) {
      const local = chatLocalFile(token.href, RELATIVE_ROOT);
      if (!local) return false;
      const href = escapeAttribute(token.href);
      const text = this.parser.parseInline(token.tokens);
      return `<span class="${LOCAL_LINK_CLASS}" ${LOCAL_LINK_ATTRIBUTE}="${href}" title="${href}">${text}</span>`;
    },
    image(token) {
      const local = chatLocalFile(token.href, RELATIVE_ROOT);
      if (!local) return false;
      const href = escapeAttribute(token.href);
      const alt = escapeAttribute(token.text);
      return `<img ${LOCAL_IMAGE_ATTRIBUTE}="${href}" alt="${alt}">`;
    },
  },
});

export function renderChatMarkdown(source: string): string {
  const html = chatParser.parse(source, { async: false });
  return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
}
