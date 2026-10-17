/**
 * An author's mark in the graph: their initials on a colour that is always the same for the same
 * person. Made from the name and e-mail alone — nothing is fetched (no Gravatar), so it works
 * offline and tells no service who is in the history.
 */

/** Up to two letters: the first of the first two words, or the first two of a single word. */
export function initials(name: string, email = ""): string {
  const words = (name.trim() || email.split("@")[0] || "?")
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.length >= 2 ? `${[...words[0]][0]}${[...words[1]][0]}` : [...(words[0] ?? "?")].slice(0, 2).join("");
  return letters.toLocaleUpperCase();
}

/** A hue from the e-mail (else the name), so one person keeps one colour across rows and sessions. */
export function authorHue(name: string, email: string): number {
  const key = (email.trim() || name.trim()).toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}
