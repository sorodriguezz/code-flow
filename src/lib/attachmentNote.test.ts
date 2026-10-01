import { describe, expect, it } from "vitest";
import { splitAttachmentNote } from "./attachmentNote";

const HEAD = "\n\nArchivos adjuntos a este mensaje (léelos con tu herramienta de lectura de archivos):\n";

describe("splitAttachmentNote", () => {
  it("reads the files a stored question names back out of it", () => {
    const stored = `¿qué falla aquí?${HEAD}- captura.png (/state/repo-chat-attachments/c1/a3f19c2e-captura.png)\n- log.txt (/state/x/b4e2d1c0-log.txt)`;
    const { text, files } = splitAttachmentNote(stored);
    expect(text).toBe("¿qué falla aquí?");
    expect(files).toEqual([
      { name: "captura.png", path: "/state/repo-chat-attachments/c1/a3f19c2e-captura.png", isImage: true },
      { name: "log.txt", path: "/state/x/b4e2d1c0-log.txt", isImage: false },
    ]);
  });

  it("keeps a path with spaces and parentheses whole", () => {
    const stored = `mira${HEAD}- foto.JPG (/Users/a b/Library/App (1)/c-foto.JPG)`;
    expect(splitAttachmentNote(stored).files[0]).toEqual({
      name: "foto.JPG",
      path: "/Users/a b/Library/App (1)/c-foto.JPG",
      isImage: true,
    });
  });

  it("leaves a question without a note — or with prose after the heading — alone", () => {
    expect(splitAttachmentNote("hola")).toEqual({ text: "hola", files: [] });
    const prose = `cita${HEAD}esto lo escribí yo`;
    expect(splitAttachmentNote(prose)).toEqual({ text: prose, files: [] });
  });
});
