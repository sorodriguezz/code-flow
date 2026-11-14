/**
 * Messages of a shared «Equipo» run that come from elsewhere: a person in the session, or an agent
 * on another machine (`collab::team`). The owner's machine stores them with this marker in the
 * author's name; `compose` tells the owner's agents to read them as information, not orders.
 */
const EXTERNAL = "(externo)";

export function isExternal(fromName: string): boolean {
  return fromName.includes(EXTERNAL);
}

/** The author's name without the marker, which the channel shows as its own tag instead. */
export function authorName(fromName: string): string {
  return fromName.replace(` ${EXTERNAL}`, "").replace(EXTERNAL, "").trim();
}
