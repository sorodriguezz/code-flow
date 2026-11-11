import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatImageMime, chatLocalFile, readChatImage } from "./chatLocalFiles";
import { readFileBytes } from "./tauri/commands";

vi.mock("./tauri/commands", () => ({ readFileBytes: vi.fn() }));

const IMAGE_PATH = "/private/tmp/pensamientos-preview.png";
const IMAGE_DIRECTORY = "/private/tmp/";
const IMAGE_NAME = "pensamientos-preview.png";
const FILE = { directory: IMAGE_DIRECTORY, name: IMAGE_NAME, path: IMAGE_PATH };
const REPO = "/Users/test/code-flow";
const ZERO = 0;
const ONE = 1;
const CHUNK_BYTES = 1024 * 1024;
const TOO_LARGE = CHUNK_BYTES * 8 + ONE;
const PNG_MIME = "image/png";
const BYTES = [137, 80, 78, 71];
const ERROR_TEXT = "missing file";

beforeEach(() => vi.resetAllMocks());

describe("chat local file references", () => {
  it("resolves the absolute temporary image path from the broken preview", () => {
    const file = chatLocalFile(IMAGE_PATH);
    expect(file).toMatchObject(FILE);
  });

  it("decodes spaces in file URLs and keeps source line numbers separate", () => {
    const href = "file:///Users/test/My%20Project/file.ts:84:2";
    const file = chatLocalFile(href);
    expect(file).toEqual({ directory: "/Users/test/My Project/", name: "file.ts", path: "/Users/test/My Project/file.ts", line: 84 });
  });

  it("uses the conversation repository for relative links", () => {
    const relative = "src/lib/thinking/cinema.ts:84";
    const file = chatLocalFile(relative, REPO);
    const withoutRoot = chatLocalFile(relative);
    expect(file).toEqual({ directory: REPO, name: "src/lib/thinking/cinema.ts", path: `${REPO}/src/lib/thinking/cinema.ts`, line: 84 });
    expect(withoutRoot).toBeNull();
  });

  it.each(["C:\\My Files\\preview.png", "file:///C:/My%20Files/preview.png"])("accepts Windows paths: %s", (href) => {
    const file = chatLocalFile(href);
    expect(file).toMatchObject({ directory: "C:/My Files/", name: "preview.png", path: "C:/My Files/preview.png" });
  });

  it.each(["https://example.com/a.png", "//example.com/a.png", "file://remote/a.png", "javascript:alert(1)", "data:image/png;base64,123", "#title", "%zz", ""])("leaves nonlocal and invalid references alone: %s", (href) => {
    const file = chatLocalFile(href, REPO);
    expect(file).toBeNull();
  });

  it("recognizes images case insensitively and refuses documents", () => {
    const uppercase = chatImageMime("PREVIEW.PNG");
    const document = chatImageMime("preview.html");
    expect(uppercase).toBe(PNG_MIME);
    expect(document).toBeNull();
  });
});

describe("loading local chat images", () => {
  it("reads local bytes through IPC and produces an image blob", async () => {
    const read = vi.mocked(readFileBytes);
    read.mockResolvedValue({ bytes: BYTES, total: BYTES.length });
    const blob = await readChatImage(FILE);
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    expect(blob.type).toBe(PNG_MIME);
    expect([...bytes]).toEqual(BYTES);
    expect(read).toHaveBeenCalledWith(IMAGE_DIRECTORY, IMAGE_NAME, ZERO, CHUNK_BYTES);
  });

  it("loads every IPC chunk for an image larger than the one-megabyte page limit", async () => {
    const read = vi.mocked(readFileBytes);
    const first = new Array<number>(CHUNK_BYTES).fill(ONE);
    const total = CHUNK_BYTES + BYTES.length;
    read.mockResolvedValueOnce({ bytes: first, total });
    read.mockResolvedValueOnce({ bytes: BYTES, total });
    const blob = await readChatImage(FILE);
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const tail = bytes.slice(CHUNK_BYTES);
    expect(blob.size).toBe(total);
    expect([...tail]).toEqual(BYTES);
    expect(read).toHaveBeenLastCalledWith(IMAGE_DIRECTORY, IMAGE_NAME, CHUNK_BYTES, CHUNK_BYTES);
  });

  it("rejects oversized images without fetching the remaining chunks", async () => {
    const read = vi.mocked(readFileBytes);
    read.mockResolvedValue({ bytes: BYTES, total: TOO_LARGE });
    const load = readChatImage(FILE);
    await expect(load).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(ONE);
  });

  it("propagates missing files", async () => {
    const read = vi.mocked(readFileBytes);
    const error = new Error(ERROR_TEXT);
    read.mockRejectedValue(error);
    const load = readChatImage(FILE);
    await expect(load).rejects.toThrow(ERROR_TEXT);
  });

  it.each([{ bytes: [], total: BYTES.length + ONE }, { bytes: BYTES, total: TOO_LARGE }])("stops when a file changes during a paged read", async (chunk) => {
    const read = vi.mocked(readFileBytes);
    read.mockResolvedValueOnce({ bytes: BYTES, total: BYTES.length + ONE });
    read.mockResolvedValueOnce(chunk);
    const load = readChatImage(FILE);
    await expect(load).rejects.toThrow();
  });
});
