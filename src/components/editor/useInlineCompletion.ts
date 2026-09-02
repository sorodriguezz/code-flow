import { useEffect } from "react";
import type { Monaco } from "@monaco-editor/react";
import { installInlineCompletion } from "../../lib/inlineCompletion";
import { useLocalAiStore } from "../../state/localAiStore";

/**
 * Installs the provider and makes sure the store knows whether the feature is on.
 *
 * The store load is what `completionIsUsable` reads on every keystroke; without it the first
 * completions after launch would be declined for want of an answer rather than for a reason.
 *
 * The provider itself is registered at startup by `monacoSetup`, not here — see the note on
 * `installInlineCompletion`. This still calls it because the latch makes that free, and because a
 * hook that quietly depended on some other module having run first would be the kind of ordering
 * nobody can see.
 */
export function useInlineCompletion(monaco: Monaco | null): void {
  const load = useLocalAiStore((state) => state.load);

  useEffect(() => {
    if (!monaco) return;
    installInlineCompletion(monaco);
    void load();
  }, [monaco, load]);
}
