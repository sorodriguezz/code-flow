import { forwardRef, useMemo } from "react";
import { renderMarkdown } from "../../lib/markdown";

export const MarkdownPreview = forwardRef<HTMLDivElement, { content: string; onScroll?: () => void }>(
  function MarkdownPreview({ content, onScroll }, ref) {
    const html = useMemo(() => renderMarkdown(content), [content]);
    return (
      <div ref={ref} onScroll={onScroll} className="h-full overflow-auto px-6 py-4">
        <div className="cf-markdown-preview mx-auto max-w-[820px]" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    );
  },
);
