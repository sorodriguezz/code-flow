import { readFileBytes } from "./tauri/commands";

const EMPTY = "";
const PATH_SEPARATOR = "/";
const BACKSLASHES = /\\/g;
const WINDOWS_ROOT = /^[a-z]:\//i;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const FILE_SCHEME = /^file:/i;
const WINDOWS_FILE_ROOT = /^\/[a-z]:\//i;
const NETWORK_PREFIX = "//";
const ANCHOR_PREFIX = "#";
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;
const IMAGE_EXTENSION = /\.([a-z\d]+)$/i;
const LOCAL_FILE_PROTOCOL = "file:";
const LOCAL_HOST = "localhost";
const ROOT_INDEX = 0;
const NEXT_INDEX = 1;
const BYTE_OFFSET = 0;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = READ_CHUNK_BYTES * 8;
const IMAGE_TOO_LARGE = "Image exceeds the preview size limit";
const IMAGE_CHANGED = "Image changed while loading";
const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif",
};

export interface ChatLocalFile {
  directory: string;
  name: string;
  path: string;
  line?: number;
}

export function chatLocalFile(href: string, repoRoot?: string | null): ChatLocalFile | null {
  let path = href.trim();
  const fileUrl = FILE_SCHEME.test(path);
  if (fileUrl) {
    try {
      const url = new URL(path);
      const remoteHost = url.hostname !== EMPTY && url.hostname !== LOCAL_HOST;
      if (url.protocol !== LOCAL_FILE_PROTOCOL || remoteHost) return null;
      path = decodeURIComponent(url.pathname);
      const hasWindowsRoot = WINDOWS_FILE_ROOT.test(path);
      if (hasWindowsRoot) path = path.slice(NEXT_INDEX);
    } catch {
      return null;
    }
  } else {
    try {
      path = decodeURI(path);
    } catch {
      return null;
    }
  }
  path = path.replace(BACKSLASHES, PATH_SEPARATOR);
  const windowsPath = WINDOWS_ROOT.test(path);
  const scheme = SCHEME.test(path);
  const networkPath = path.startsWith(NETWORK_PREFIX);
  const anchor = path.startsWith(ANCHOR_PREFIX);
  if (!path || networkPath || anchor || (scheme && !windowsPath)) return null;
  const lineMatch = path.match(LINE_SUFFIX);
  const line = lineMatch ? Number(lineMatch[NEXT_INDEX]) : undefined;
  path = path.replace(LINE_SUFFIX, EMPTY);
  const absolute = path.startsWith(PATH_SEPARATOR) || windowsPath;
  if (!absolute) {
    if (!repoRoot) return null;
    return { directory: repoRoot, name: path, path: `${repoRoot}${PATH_SEPARATOR}${path}`, line };
  }
  const separator = path.lastIndexOf(PATH_SEPARATOR);
  const directory = path.slice(ROOT_INDEX, separator + NEXT_INDEX);
  const name = path.slice(separator + NEXT_INDEX);
  if (!name) return null;
  return { directory, name, path, line };
}

export function chatImageMime(path: string): string | null {
  const match = path.match(IMAGE_EXTENSION);
  const extension = match?.[NEXT_INDEX]?.toLowerCase() ?? EMPTY;
  return IMAGE_MIME_TYPES[extension] ?? null;
}

export async function readChatImage(file: ChatLocalFile): Promise<Blob> {
  const mime = chatImageMime(file.name);
  if (!mime) throw new Error(IMAGE_CHANGED);
  const first = await readFileBytes(file.directory, file.name, BYTE_OFFSET, READ_CHUNK_BYTES);
  if (first.total > MAX_IMAGE_BYTES) throw new Error(IMAGE_TOO_LARGE);
  const bytes = new Uint8Array(first.total);
  bytes.set(first.bytes, BYTE_OFFSET);
  let offset = first.bytes.length;
  while (offset < first.total) {
    const chunk = await readFileBytes(file.directory, file.name, offset, READ_CHUNK_BYTES);
    const empty = chunk.bytes.length === BYTE_OFFSET;
    const changed = chunk.total !== first.total || offset + chunk.bytes.length > first.total;
    if (empty || changed) throw new Error(IMAGE_CHANGED);
    bytes.set(chunk.bytes, offset);
    offset += chunk.bytes.length;
  }
  return new Blob([bytes], { type: mime });
}
