import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../state/languageStore", () => ({
  useT: () => (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
}));

import { FileNoticeView } from "./FileNoticeView";
import type { FileNotice } from "../../lib/editorFiles";

/**
 * What a tab shows when its file is not text to edit. The point of every one of these is what is
 * *not* there: no editor, so no buffer a save could write over the file.
 */

const render = (notice: FileNotice) =>
  renderToStaticMarkup(
    <FileNoticeView notice={notice} path="assets/logo.png" repoPath="/repo" onRetry={() => {}} onOpenAnyway={() => {}} />,
  );

describe("FileNoticeView", () => {
  it("shows a read error as a message with Retry — never as text in an editor", () => {
    const markup = render({ kind: "error", message: "Permission denied (os error 13)" });
    expect(markup).toContain("editor.noticeError");
    expect(markup).toContain("Permission denied (os error 13)");
    expect(markup).toContain("editor.noticeRetry");
    expect(markup).not.toContain("<textarea");
  });

  it("shows an image as the image, with its size", () => {
    const markup = render({ kind: "image", src: "data:image/png;base64,iVBOR", mime: "image/png", size: 2048 });
    expect(markup).toContain('src="data:image/png;base64,iVBOR"');
    expect(markup).toContain("image/png");
    expect(markup).toContain("2.0 KB");
  });

  it("names a binary file and offers the app that can open it", () => {
    const markup = render({ kind: "binary", size: 5 * 1024 * 1024 });
    expect(markup).toContain("editor.noticeBinary {&quot;size&quot;:&quot;5.0 MB&quot;}");
    expect(markup).toContain("editor.noticeOpenExternal");
  });

  it("offers a large file read-only only while it is under the ceiling", () => {
    const openable = render({ kind: "tooLarge", size: 30 * 1024 * 1024, canForce: true });
    expect(openable).toContain("editor.noticeOpenAnyway");
    const past = render({ kind: "tooLarge", size: 300 * 1024 * 1024, canForce: false });
    expect(past).not.toContain("editor.noticeOpenAnyway");
    expect(past).toContain("editor.noticeOpenExternal");
  });
});
