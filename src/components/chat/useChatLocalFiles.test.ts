import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatLocalFiles } from "./useChatLocalFiles";
import { readChatImage } from "../../lib/chatLocalFiles";
import { openInDefaultApp } from "../../lib/tauri/commands";
import { focusEditorOn } from "../../lib/editorIslands";

const hooks = vi.hoisted(() => ({ effects: [] as (() => (() => void) | undefined)[] }));
vi.mock("react", () => ({
  useLayoutEffect: (effect: () => (() => void) | undefined) => hooks.effects.push(effect),
}));
vi.mock("../../lib/chatLocalFiles", async (original) => {
  const actual = await original<typeof import("../../lib/chatLocalFiles")>();
  return { ...actual, readChatImage: vi.fn() };
});
vi.mock("../../lib/tauri/commands", () => ({ openInDefaultApp: vi.fn() }));
vi.mock("../../lib/editorIslands", () => ({ focusEditorOn: vi.fn() }));

const IMAGE_PATH = "/private/tmp/pensamientos-preview.png";
const IMAGE_NAME = "Pensamientos";
const PAGE_PATH = "/private/tmp/pensamientos-preview.html";
const BLOB_URL = "blob:codeflow/preview";
const LOCAL_IMAGE = "data-cf-local-image";
const LOCAL_FILE = "data-cf-local-file";
const LOCAL_REFERENCE = "data-ref";
const IMAGE_SELECTOR = "img[data-cf-local-image]";
const LINK_SELECTOR = "[data-cf-local-file], a[href]";
const PASSIVE_SELECTOR = "img, [data-cf-local-file], code[data-ref]";
const ANCHOR_SELECTOR = "a[href]";
const IMAGE_TAG = "img";
const SPAN_TAG = "span";
const ANCHOR_TAG = "a";
const CODE_TAG = "code";
const LOADING = "Cargando";
const FAILED = "No se pudo mostrar";
const LABELS = { loading: LOADING, failed: FAILED };
const MARKUP = { __html: "preview" };
const EMPTY = "";
const CLICK = "click";
const AUXCLICK = "auxclick";
const KEYDOWN = "keydown";
const DRAGSTART = "dragstart";
const ZERO = 0;
const ONE = 1;
const FIRST = 0;
const REPO = "/repo";
const ROLE = "role";
const ALERT = "alert";
const SOURCE = "src";
const TAB = "tabindex";
const TARGET = "target";
const BLANK = "_blank";
const BUTTON = "button";
const ERROR_MESSAGE = "missing file";
const ENTER_KEY = "Enter";
const SPACE_KEY = " ";
const COPY_KEY = "c";
const READ_STAGE = "read";
const DECODE_STAGE = "decode";
const SOURCE_LINK = "/repo/src/main.ts:84";
const SOURCE_PATH = "src/main.ts";
const RESOLVED_SOURCE_PATH = "/repo/src/main.ts";
const EXTERNAL_URL = "https://example.com/preview.html";
const HREF = "href";
const ENCODED_PAGE = "file:///private/tmp/My%20Preview.html";
const DECODED_PAGE = "/private/tmp/My Preview.html";

class TestElement {
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: unknown) => void>();
  images: TestElement[] = [];
  links: TestElement[] = [];
  statuses: TestElement[] = [];
  parent: TestElement | null = null;
  tag = SPAN_TAG;
  hidden = false;
  removed = false;
  alt = EMPTY;
  src = EMPTY;
  title = EMPTY;
  textContent = EMPTY;
  style = {};
  decode = vi.fn().mockResolvedValue(undefined);
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelectorAll(selector: string) {
    if (selector === IMAGE_SELECTOR) return this.images;
    if (selector === LINK_SELECTOR) return this.links;
    return [];
  }
  after(node: TestElement) { this.statuses.push(node); }
  remove() { this.removed = true; }
  closest(selector: string): TestElement | null {
    const localFile = this.attributes.has(LOCAL_FILE);
    const reference = this.attributes.has(LOCAL_REFERENCE);
    const href = this.attributes.has(HREF);
    const passive = this.tag === IMAGE_TAG || localFile || (this.tag === CODE_TAG && reference);
    if (selector === PASSIVE_SELECTOR && passive) return this;
    if (selector === ANCHOR_SELECTOR && this.tag === ANCHOR_TAG && href) return this;
    return this.parent?.closest(selector) ?? null;
  }
  addEventListener(name: string, callback: (event: unknown) => void) { this.listeners.set(name, callback); }
  removeEventListener(name: string) { this.listeners.delete(name); }
}

let host: TestElement;
let img: TestElement;
let cleanups: (() => void)[];

function mount(repoRoot: string | null = null) {
  const ref = { current: host as unknown as HTMLElement };
  useChatLocalFiles(ref, MARKUP, repoRoot, LABELS);
  const effect = hooks.effects.pop();
  const cleanup = effect?.();
  if (cleanup) cleanups.push(cleanup);
}

function dispatch(target: TestElement, type = CLICK, key = EMPTY, button = ZERO) {
  const event = { target, type, key, button, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  const listener = host.listeners.get(type);
  listener?.(event);
  return event;
}

function createLink(href: string, attribute = HREF) {
  const link = new TestElement();
  link.tag = ANCHOR_TAG;
  link.setAttribute(attribute, href);
  host.links.push(link);
  return link;
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.effects = [];
  cleanups = [];
  host = new TestElement();
  img = new TestElement();
  img.tag = IMAGE_TAG;
  img.alt = IMAGE_NAME;
  img.setAttribute(LOCAL_IMAGE, IMAGE_PATH);
  host.images = [img];
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("document", { createElement: () => new TestElement() });
  vi.spyOn(URL, "createObjectURL").mockReturnValue(BLOB_URL);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const read = vi.mocked(readChatImage);
  const blob = new Blob();
  read.mockResolvedValue(blob);
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  expect(openInDefaultApp).not.toHaveBeenCalled();
  expect(focusEditorOn).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("passive local files in chat bubbles", () => {
  it("loads images with a path tooltip and no zoom action, then releases the blob", async () => {
    mount();
    await vi.waitFor(() => {
      expect(img.hidden).toBe(false);
      expect(img.src).toBe(BLOB_URL);
    });
    expect(img.title).toBe(IMAGE_PATH);
    const role = img.getAttribute(ROLE);
    const tab = img.getAttribute(TAB);
    expect(role).toBeNull();
    expect(tab).toBeNull();
    const click = dispatch(img);
    expect(click.preventDefault).toHaveBeenCalledTimes(ONE);
    expect(click.stopPropagation).toHaveBeenCalledTimes(ONE);
    const cleanup = cleanups.pop();
    cleanup?.();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(BLOB_URL);
    expect(host.listeners.size).toBe(ZERO);
  });

  it.each([READ_STAGE, DECODE_STAGE])("replaces %s failures with a visible message and its path", async (stage) => {
    const error = new Error(ERROR_MESSAGE);
    const read = vi.mocked(readChatImage);
    if (stage === READ_STAGE) read.mockRejectedValue(error);
    else img.decode.mockRejectedValue(error);
    mount();
    await vi.waitFor(() => {
      const status = img.statuses[FIRST];
      const role = status.getAttribute(ROLE);
      expect(role).toBe(ALERT);
      expect(status.textContent).toContain(FAILED);
      expect(status.title).toBe(IMAGE_PATH);
      expect(img.hidden).toBe(true);
    });
  });

  it.each([
    [PAGE_PATH, null, PAGE_PATH],
    [SOURCE_LINK, REPO, RESOLVED_SOURCE_PATH],
    [SOURCE_PATH, REPO, RESOLVED_SOURCE_PATH],
    [SOURCE_PATH, null, SOURCE_PATH],
    [ENCODED_PAGE, null, DECODED_PAGE],
  ])("makes a local HTML anchor inert and exposes its path: %s", (path, root, title) => {
    const link = createLink(path!);
    link.setAttribute(TARGET, BLANK);
    link.setAttribute(TAB, EMPTY);
    link.setAttribute(ROLE, BUTTON);
    mount(root);
    expect(link.title).toBe(title);
    for (const attribute of [HREF, TARGET, TAB, ROLE]) {
      const value = link.getAttribute(attribute);
      expect(value).toBeNull();
    }
    const child = new TestElement();
    child.parent = link;
    const event = dispatch(child);
    expect(event.preventDefault).toHaveBeenCalledTimes(ONE);
    expect(event.stopPropagation).toHaveBeenCalledTimes(ONE);
  });

  it.each([CLICK, AUXCLICK, KEYDOWN, DRAGSTART])("blocks %s on images inside external links", (eventName) => {
    const link = createLink(EXTERNAL_URL);
    img.parent = link;
    mount();
    const event = dispatch(img, eventName, ENTER_KEY, ONE);
    expect(event.preventDefault).toHaveBeenCalledTimes(ONE);
    expect(event.stopPropagation).toHaveBeenCalledTimes(ONE);
  });

  it.each([ENTER_KEY, SPACE_KEY])("blocks keyboard activation of local references: %s", (key) => {
    const link = createLink(PAGE_PATH, LOCAL_FILE);
    mount();
    const event = dispatch(link, KEYDOWN, key);
    expect(event.preventDefault).toHaveBeenCalledTimes(ONE);
  });

  it("keeps inline code references passive", () => {
    const code = new TestElement();
    code.tag = CODE_TAG;
    code.setAttribute(LOCAL_REFERENCE, SOURCE_PATH);
    mount(REPO);
    const event = dispatch(code);
    expect(event.preventDefault).toHaveBeenCalledTimes(ONE);
    expect(event.stopPropagation).toHaveBeenCalledTimes(ONE);
  });

  it("preserves copy shortcuts on references", () => {
    const link = createLink(PAGE_PATH, LOCAL_FILE);
    mount();
    const event = dispatch(link, KEYDOWN, COPY_KEY);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves external text links to the existing browser handler", () => {
    const link = createLink(EXTERNAL_URL);
    mount();
    const href = link.getAttribute(HREF);
    expect(href).toBe(EXTERNAL_URL);
    const event = dispatch(link);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("blocks local anchors inserted after the effect", () => {
    mount();
    const link = createLink(PAGE_PATH);
    const event = dispatch(link);
    expect(event.preventDefault).toHaveBeenCalledTimes(ONE);
  });

  it("ignores an image read that completes after its bubble was removed", async () => {
    const read = vi.mocked(readChatImage);
    let resolveRead: ((blob: Blob) => void) | undefined;
    const pending = new Promise<Blob>((resolve) => { resolveRead = resolve; });
    read.mockReturnValue(pending);
    mount();
    const cleanup = cleanups.pop();
    cleanup?.();
    const blob = new Blob();
    resolveRead?.(blob);
    await pending;
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(img.decode).not.toHaveBeenCalled();
    const source = img.getAttribute(SOURCE);
    expect(source).toBeNull();
  });
});
