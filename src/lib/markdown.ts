import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

/** Renders untrusted markdown (arbitrary repo file contents) to sanitized HTML — repo files
 * aren't a trusted source, so raw `marked` output is run through DOMPurify before it's ever
 * handed to `dangerouslySetInnerHTML`. */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

/** Same as `renderMarkdown`, but for a single short field (a finding's subtitle/why/
 * suggestion) rather than a full document — inline-only, so `**bold**`/`` `code` ``/links
 * render without `marked` wrapping the result in a block-level `<p>`. */
export function renderInlineMarkdown(source: string): string {
  const html = marked.parseInline(source, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}
