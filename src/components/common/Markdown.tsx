import { useMemo } from "react";
import { renderMarkdown } from "../../lib/markdown";

/**
 * A block of sanitized markdown, parsed once per distinct `source`.
 *
 * `marked.parse` + `DOMPurify.sanitize` on a full review or a changelog is milliseconds of work,
 * and it was being paid *inside JSX* at half a dozen sites — so every unrelated re-render of the
 * surrounding panel (a keystroke in the chat composer, a toast, a language switch) re-parsed and
 * re-sanitised the whole document and handed React a brand-new HTML string, forcing a full
 * `innerHTML` replacement. This is the same `useMemo(..., [source])` shape `MarkdownPreview` and
 * `FindingCard` already use, extracted so the remaining sites stop re-inventing it.
 *
 * The output is deliberately identical to what the call sites rendered before: the same
 * `renderMarkdown` (so the same `marked` options and the same DOMPurify config), the same
 * `dangerouslySetInnerHTML` on a plain `div`, and the caller's own `className` untouched — the
 * wrapper carries no styling of its own so `cf-markdown-preview` and friends still decide how it
 * looks.
 *
 * `onClick` is passed through for the sites that delegate link handling from the container (see
 * `UpdateNotesModal`, which opens anchors in the system browser instead of the webview).
 */
export function Markdown({
  source,
  className,
  onClick,
}: {
  source: string;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
