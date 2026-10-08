/**
 * Writing a transcript into the field it was dictated into, where the caret was.
 *
 * The fields are React-controlled, so assigning `value` alone would be undone on the next render:
 * the value goes through the element's own setter and an `input` event, which is what React's
 * `onChange` listens to — the same path typing takes, so every composer's state follows.
 */

export type DictationField = HTMLTextAreaElement | HTMLInputElement;

/** `text` into `value` between `start` and `end`, with a space on either side where words would
 *  otherwise run together. Returns the new value and where the caret goes. */
export function spliceDictation(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  const head = `${before}${lead}${text}`;
  return { value: `${head}${trail}${after}`, caret: head.length };
}

export function insertDictation(field: DictationField, text: string, at: { start: number; end: number } | null): void {
  if (!text) return;
  const start = at ? Math.min(at.start, field.value.length) : field.value.length;
  const end = at ? Math.min(at.end, field.value.length) : field.value.length;
  const next = spliceDictation(field.value, start, end, text);
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, next.value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  field.setSelectionRange(next.caret, next.caret);
}

/** The AI field `node` is in, if it is one: marked `data-ai-input` by the surfaces that send what is
 *  written in it to a model. */
export function aiFieldOf(node: EventTarget | null): DictationField | null {
  if (!(node instanceof HTMLElement)) return null;
  const marked = node.closest<HTMLElement>("[data-ai-input]");
  if (!marked) return null;
  if (marked instanceof HTMLTextAreaElement || marked instanceof HTMLInputElement) return marked;
  return marked.querySelector<DictationField>("textarea, input[type=text], input:not([type])");
}
