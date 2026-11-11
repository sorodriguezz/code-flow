import { useLayoutEffect, type RefObject } from "react";
import { chatLocalFile, readChatImage } from "../../lib/chatLocalFiles";

const IMAGE_SELECTOR = "img[data-cf-local-image]";
const IMAGE_ATTRIBUTE = "data-cf-local-image";
const LINK_SELECTOR = "[data-cf-local-file], a[href]";
const LINK_ATTRIBUTE = "href";
const LOCAL_LINK_ATTRIBUTE = "data-cf-local-file";
const PASSIVE_SELECTOR = "img, [data-cf-local-file], code[data-ref]";
const ANCHOR_SELECTOR = "a[href]";
const SOURCE_ATTRIBUTE = "src";
const TAB_ATTRIBUTE = "tabindex";
const TARGET_ATTRIBUTE = "target";
const EMPTY = "";
const RELATIVE_ROOT = ".";
const STATUS_TAG = "span";
const STATUS_ROLE = "status";
const ALERT_ROLE = "alert";
const ROLE_ATTRIBUTE = "role";
const STATUS_CLASS = "block text-[12px] text-[var(--cf-text-muted)] wrap-anywhere";
const PASSIVE_CURSOR = "text";
const IMAGE_MAX_HEIGHT = "28rem";
const IMAGE_FIT = "contain";
const ACTIVATION_EVENTS = ["click", "auxclick", "keydown", "dragstart"];
const KEYDOWN_EVENT = "keydown";
const ACTIVATION_KEYS = new Set(["Enter", " "]);
const CAPTURE_EVENTS = true;

interface LocalFileLabels {
  loading: string;
  failed: string;
}

export function useChatLocalFiles(
  ref: RefObject<HTMLElement | null>,
  markup: { __html: string } | null,
  repoRoot: string | null,
  labels: LocalFileLabels,
) {
  const { loading, failed } = labels;

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || markup === null) return;
    let active = true;
    const urls: string[] = [];
    const cleanups: (() => void)[] = [];
    const links = host.querySelectorAll<HTMLElement>(LINK_SELECTOR);
    for (const link of links) {
      const href = link.getAttribute(LOCAL_LINK_ATTRIBUTE) ?? link.getAttribute(LINK_ATTRIBUTE) ?? EMPTY;
      const candidate = chatLocalFile(href, RELATIVE_ROOT);
      if (!candidate) continue;
      const file = chatLocalFile(href, repoRoot);
      link.setAttribute(LOCAL_LINK_ATTRIBUTE, href);
      link.title = file?.path ?? href;
      link.removeAttribute(LINK_ATTRIBUTE);
      link.removeAttribute(TARGET_ATTRIBUTE);
      link.removeAttribute(TAB_ATTRIBUTE);
      link.removeAttribute(ROLE_ATTRIBUTE);
      link.style.cursor = PASSIVE_CURSOR;
    }
    const images = host.querySelectorAll<HTMLImageElement>(IMAGE_SELECTOR);
    for (const img of images) {
      const href = img.getAttribute(IMAGE_ATTRIBUTE) ?? EMPTY;
      const file = chatLocalFile(href, repoRoot);
      img.title = file?.path ?? href;
      const status = document.createElement(STATUS_TAG);
      status.className = STATUS_CLASS;
      status.setAttribute(ROLE_ATTRIBUTE, STATUS_ROLE);
      status.textContent = loading;
      img.hidden = true;
      img.after(status);
      const load = async () => {
        try {
          if (!file) throw new Error(failed);
          const blob = await readChatImage(file);
          if (!active) return;
          const src = URL.createObjectURL(blob);
          urls.push(src);
          img.src = src;
          await img.decode();
          if (!active) return;
          img.hidden = false;
          img.style.maxHeight = IMAGE_MAX_HEIGHT;
          img.style.objectFit = IMAGE_FIT;
          status.remove();
        } catch {
          if (!active) return;
          const name = img.alt || href;
          status.textContent = `${failed}: ${name}`;
          status.title = file?.path ?? href;
          status.setAttribute(ROLE_ATTRIBUTE, ALERT_ROLE);
        }
      };
      void load();
      cleanups.push(() => {
        status.remove();
        img.removeAttribute(SOURCE_ATTRIBUTE);
      });
    }

    const blockActivation = (event: Event) => {
      const keyEvent = event.type === KEYDOWN_EVENT;
      if (keyEvent) {
        const keyboard = event as KeyboardEvent;
        const activates = ACTIVATION_KEYS.has(keyboard.key);
        if (!activates) return;
      }
      const target = event.target;
      const element = target instanceof Element;
      if (!element) return;
      const passive = target.closest(PASSIVE_SELECTOR);
      if (!passive) {
        const anchor = target.closest(ANCHOR_SELECTOR);
        if (!anchor) return;
        const href = anchor.getAttribute(LINK_ATTRIBUTE) ?? EMPTY;
        const candidate = chatLocalFile(href, RELATIVE_ROOT);
        if (!candidate) return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    for (const eventName of ACTIVATION_EVENTS) {
      host.addEventListener(eventName, blockActivation, CAPTURE_EVENTS);
    }
    return () => {
      active = false;
      for (const eventName of ACTIVATION_EVENTS) {
        host.removeEventListener(eventName, blockActivation, CAPTURE_EVENTS);
      }
      for (const cleanup of cleanups) cleanup();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [ref, markup, repoRoot, loading, failed]);
}
