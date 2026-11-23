/** Cheap "is this worth auto-resolving?" test for one candidate link — the backend is the real
 * parser, this only decides whether to spend a round-trip on it. */
export function looksLikePrLink(text: string): boolean {
  const value = text.trim().toLowerCase();
  if (value.length > 500 || !/^https?:\/\//.test(value)) return false;
  return (
    value.includes("/pull/") ||
    value.includes("/pullrequest/") ||
    value.includes("/pullrequests/") ||
    // GitLab's own shape — without it a merge-request URL already on the clipboard is never
    // offered, which is the whole convenience the link modal exists for.
    value.includes("/merge_requests/") ||
    // Bitbucket's, hyphenated.
    value.includes("/pull-requests/")
  );
}

/**
 * The links in whatever was pasted: split on whitespace, newlines and commas, in order, each once.
 *
 * A batch arrives the way people send it — one per line from a chat, comma-separated from a ticket,
 * or a sentence with links inside it — so anything that is not a URL is dropped rather than looked
 * up. With no URL at all, the first token comes back alone: "one thing", which the modal then looks
 * up as typed, so the one-link flow still gets to say "that isn't a pull-request link" about it.
 */
export function splitPrLinks(text: string): string[] {
  const tokens = text
    .split(/[\s,]+/)
    .map((t) => t.trim().replace(/^[<(["']+|[>)\]"'.;]+$/g, ""))
    .filter(Boolean);
  const urls = tokens.filter((t) => /^https?:\/\//i.test(t));
  const picked = urls.length > 0 ? urls : tokens.slice(0, 1);
  return picked.filter((t, i) => picked.indexOf(t) === i);
}
