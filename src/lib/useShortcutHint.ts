import { useShortcutsStore, bindingFor } from "../state/shortcutsStore";
import { chordLabel } from "./keys";
import type { ShortcutId } from "./shortcuts";

/**
 * Returns a formatter for `title` tooltips that appends an action's current key combination —
 * `"Toggle sidebar (⌘B)"`. Reading the binding through the store rather than baking it into the
 * string keeps every tooltip in sync the moment the user rebinds something in settings.
 */
export function useShortcutHint(): (id: ShortcutId, label: string) => string {
  const overrides = useShortcutsStore((s) => s.overrides);
  return (id, label) => {
    const chord = bindingFor(id, overrides);
    return chord ? `${label} (${chordLabel(chord)})` : label;
  };
}
