/**
 * Finding the thing a spoken name means — a repository, a workspace, a branch, a service.
 *
 * Names arrive from speech, so they arrive mangled in predictable ways: "api pagos" for `api-pagos`,
 * "Api_Pagos", "apí pagos" from a model that likes accents, "pagos api" with the words swapped, and
 * "api pago" when the transcriber dropped an `s`. Every one of those is the same repository to the
 * person who said it, and a voice assistant that answers "no repository called api pagos" while
 * `api-pagos` sits in the sidebar is one nobody talks to twice.
 *
 * So matching runs in tiers, strictest first, and the first tier that finds anything decides:
 *
 * 1. **Equal once folded** — case, accents and every separator gone (`api pagos` = `api-pagos`).
 * 2. **Every word present** — each word of the query appears in the name (`pagos api`, `pagos`).
 * 3. **Contained** — the folded query inside the folded name, or the name inside the query (a model
 *    that says "the api-pagos repo").
 * 4. **Close** — a small edit distance on the folded forms, for a dropped or swapped letter.
 *
 * A tier with more than one hit is **ambiguous**, never a guess: the caller says "which one: a or b"
 * rather than switching to the wrong repository, which costs more than the question. `prefer` breaks
 * a tie only between candidates that are otherwise equal (two `web` repositories, one of them in the
 * workspace on screen) — it never promotes a weaker tier over a stronger one.
 */

/** Lowercase, no accents, nothing but letters and digits — what two spellings of one name share. */
export function foldName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** The words of a name, folded — split on anything that is not a letter or a digit, and on the
 *  case change inside `ApiPagos`. */
export function nameWords(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Levenshtein distance, capped: anything past `cap` is reported as `cap + 1`. */
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowBest) rowBest = value;
    }
    if (rowBest > cap) return cap + 1;
    previous = current;
  }
  return previous[b.length];
}

export type NameMatch<T> =
  | { kind: "match"; item: T }
  | { kind: "ambiguous"; candidates: T[] }
  | { kind: "none" };

/**
 * The one item `query` names, by the tiers in the module note.
 *
 * `nameOf` is what the item is called as the UI shows it. `prefer` marks the candidates to keep when
 * a tier finds several and some of them are the preferred ones (the active workspace's) — if exactly
 * one is, it wins; otherwise the tie stays ambiguous.
 */
export function matchByName<T>(
  items: readonly T[],
  query: string,
  nameOf: (item: T) => string,
  prefer?: (item: T) => boolean,
): NameMatch<T> {
  const wanted = foldName(query);
  if (!wanted) return { kind: "none" };
  const words = nameWords(query);
  const folded = items.map((item) => ({ item, name: foldName(nameOf(item)), words: nameWords(nameOf(item)) }));

  const tiers: ((entry: (typeof folded)[number]) => boolean)[] = [
    (entry) => entry.name === wanted,
    (entry) => words.length > 0 && words.every((word) => entry.words.some((own) => own.startsWith(word))),
    (entry) => entry.name.includes(wanted) || (entry.name.length >= 3 && wanted.includes(entry.name)),
  ];
  for (const tier of tiers) {
    const hits = folded.filter(tier).map((entry) => entry.item);
    const decided = decide(hits, prefer);
    if (decided) return decided;
  }

  // Close: one or two letters off, and only for names long enough that two letters is a slip
  // rather than a different word ("web" is two edits from "wiki").
  if (wanted.length >= 4) {
    const cap = wanted.length >= 8 ? 2 : 1;
    let best = cap + 1;
    let hits: T[] = [];
    for (const entry of folded) {
      const d = distance(wanted, entry.name, cap);
      if (d < best) {
        best = d;
        hits = [entry.item];
      } else if (d === best && d <= cap) {
        hits.push(entry.item);
      }
    }
    if (best <= cap) return decide(hits, prefer) ?? { kind: "none" };
  }
  return { kind: "none" };
}

function decide<T>(hits: T[], prefer?: (item: T) => boolean): NameMatch<T> | null {
  if (hits.length === 0) return null;
  if (hits.length === 1) return { kind: "match", item: hits[0] };
  const preferred = prefer ? hits.filter(prefer) : [];
  if (preferred.length === 1) return { kind: "match", item: preferred[0] };
  return { kind: "ambiguous", candidates: hits };
}

/**
 * The one item `query` most likely meant when [`matchByName`] found nothing — for «¿quisiste decir
 * api-pagos?», asked rather than run. Looser than the match's own last tier (a third of the name may
 * differ), and only when one item is clearly nearest: two at the same distance suggest neither.
 */
export function closestByName<T>(items: readonly T[], query: string, nameOf: (item: T) => string): T | null {
  const wanted = foldName(query);
  if (wanted.length < 3) return null;
  const cap = Math.max(2, Math.floor(wanted.length / 3));
  let best = cap + 1;
  let hits: T[] = [];
  for (const item of items) {
    const name = foldName(nameOf(item));
    // A name that starts like the query («pagos» for «pagos-api-v2») is as near as a typo.
    const d = name.startsWith(wanted) || wanted.startsWith(name) ? Math.min(cap, Math.abs(name.length - wanted.length)) : distance(wanted, name, cap);
    if (d < best) {
      best = d;
      hits = [item];
    } else if (d === best) {
      hits.push(item);
    }
  }
  return best <= cap && hits.length === 1 ? hits[0] : null;
}
