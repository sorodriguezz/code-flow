/**
 * The files a stored question names, read back out of its text.
 *
 * Both chats send attachments the same way: the question gets a note listing each file and where
 * it is (`ai::attachment_note` in Rust), and that is what the engine reads and what is stored. So a
 * reopened question carries its files in its own text — which drew as a paragraph of absolute paths
 * under the user's words. This splits the note off so the bubble can show the files as chips.
 *
 * The note's wording is a format, written word for word by the backend; a question that does not
 * end in one is returned whole.
 */

const NOTE_HEAD = "\n\nArchivos adjuntos a este mensaje (léelos con tu herramienta de lectura de archivos):\n";

/** What the backend calls an image, by extension — `chat_attach::IMAGE_EXTENSIONS`. */
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export interface NotedFile {
  name: string;
  path: string;
  isImage: boolean;
}

/** One `- name (path)` line. A stored name is sanitised to `[A-Za-z0-9._-]`, so it never holds a
 *  space and the first ` (` is where the path begins, whatever the path itself contains. */
function parseLine(line: string): NotedFile | null {
  const match = /^- (\S+) \((.+)\)$/.exec(line.trim());
  if (!match) return null;
  const [, name, path] = match;
  return { name, path, isImage: IMAGE.test(name) };
}

export function splitAttachmentNote(content: string): { text: string; files: NotedFile[] } {
  const at = content.lastIndexOf(NOTE_HEAD);
  if (at === -1) return { text: content, files: [] };
  const lines = content.slice(at + NOTE_HEAD.length).split("\n").filter((line) => line.trim());
  const files = lines.map(parseLine);
  // Every line must be a file: anything else means the user wrote this sentence themselves.
  if (files.length === 0 || files.some((file) => file === null)) return { text: content, files: [] };
  return { text: content.slice(0, at), files: files as NotedFile[] };
}
