/** Pure helpers of «Voz y sonido › Codi», kept apart so they test without the app's stores. */

/** «Codi, jarvis ,, compu» → «jarvis, compu»: its own name is always heard, the rest once each. */
export function tidyNames(raw: string): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim().replace(/\s+/g, " ");
    const key = name.toLowerCase();
    if (!name || key === "codi" || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.join(", ");
}

/** Below this many billion parameters the measured bench (F0) missed actions: 4B was the smallest
 *  that got all of them right. `3.8B` (Phi mini) is the same class, so the line sits under it. */
export const SMALL_MODEL_B = 3.5;

/** «7.6B · Q4_K_M» (catalogue) or «8B» (Ollama) → 7.6 / 8; anything else → null. */
export function billions(params: string | null | undefined): number | null {
  const match = params?.match(/(\d+(?:\.\d+)?)\s*B\b/i);
  return match ? Number(match[1]) : null;
}
