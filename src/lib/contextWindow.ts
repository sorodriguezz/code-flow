/**
 * How much of a model's context a conversation is taking up.
 *
 * # Two numbers, and the difference between them is the whole module
 *
 * **Measured** is the prompt the engine reported on the last *step* of the last turn — everything
 * it was holding when it wrote the answer, system prompt and tool schemas included — stored on the
 * conversation row by `chat_send`. It is exact, and it reaches things this file cannot see. Today
 * only Claude reports it, because it is the only engine whose output this app reads step by step;
 * see `AiRun::context_tokens` for why the cumulative figure the others print is a bill rather than
 * a gauge.
 *
 * **Estimated** is {@link estimateTokens} counting characters, and it covers everything else: the
 * other five engines, and any conversation whose turns all ran before this existed. It is marked as
 * an estimate everywhere it is shown, with the `~` the measured number does not carry.
 *
 * Those must not be quietly interchangeable. A meter is a number people plan around — "I have room
 * for one more question" — and a gauge that silently swaps a guess for a measurement is the kind of
 * lie that is only discovered when a long turn is refused.
 *
 * # Why the denominator is allowed to be missing
 *
 * A percentage needs a window, and this app cannot always know one. Model ids rotate, the same name
 * is served with different windows by different hosts, and a locally-served model is the worst case
 * of all: `ollama` will happily run a model whose nominal window is 128k with `num_ctx` at 4096, so
 * a table that read the *name* would show a gauge at 3% while the model was already forgetting the
 * question. That is precisely the user this feature is for.
 *
 * So the window is `null` for everything the app is not sure about, and the UI draws the token
 * count with no bar. A missing gauge says "I don't know your window", which is true and costs the
 * reader nothing. A gauge at the wrong scale says something false with a picture.
 *
 * # The table itself lives in Rust
 *
 * `ai::context_window_for`, read through `chatContextWindow` and cached in `conversationStore` the
 * way `effortByModel` is. Not for tidiness: the backend decides with that number too — it is what
 * `auto_compact_if_full` measures the last turn's occupancy against — and a second copy here would
 * let the ring say 92% while the turn that follows it believes there is room.
 */

/**
 * Characters per token, for the estimate.
 *
 * The usual rule of thumb is four, measured on English prose. This app's conversations are neither:
 * they are Spanish, which spends tokens on accented characters and on longer words, and they are
 * full of code, paths and identifiers, which tokenize far denser than prose. Both push the real
 * ratio down, so four would consistently *under*count — and an undercount is the direction that
 * hurts, because it is the one where the meter reads comfortable while the window is already full.
 *
 * Three and a half is deliberately pessimistic for the same reason a disk-space warning is.
 */
const CHARS_PER_TOKEN = 3.5;

/**
 * A rough token count for a piece of text.
 *
 * Every caller must present this as approximate — see the module note. Whitespace is counted, since
 * every tokenizer here charges for it.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * A token count at a glance: `840`, `12,3k`, `1,2M`.
 *
 * Abbreviated because this sits in a chip beside the model picker, where six digits would push the
 * composer's controls around every few turns. The separator follows the locale, so a Spanish UI
 * reads `12,3k` and an English one `12.3k` — the same rule the rest of the chat chrome follows.
 */
export function formatTokens(tokens: number, locale: string): string {
  if (tokens < 1_000) return tokens.toLocaleString(locale);
  if (tokens < 1_000_000) {
    // One decimal below 10k, none above: `9,4k` is worth reading, `142,7k` is noise on a gauge.
    const thousands = tokens / 1_000;
    return `${thousands.toLocaleString(locale, {
      maximumFractionDigits: thousands < 10 ? 1 : 0,
    })}k`;
  }
  return `${(tokens / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 1 })}M`;
}

/** How full the window is, 0–1, or `null` when there is no window to be a fraction of. Clamped at
 *  1: a measurement above the table's figure means the table is wrong about this model, not that
 *  the conversation is at 130% — and a bar drawn past its own end says nothing either way. */
export function contextFraction(tokens: number, window: number | null): number | null {
  if (!window || window <= 0) return null;
  return Math.min(1, tokens / window);
}

/** Where the meter stops being decoration and starts being a warning. Two thirds is early enough
 *  that a compaction still has a conversation worth summarising, and late enough that an ordinary
 *  exchange never sees it. */
export const CONTEXT_WARN_AT = 0.66;
/** Where it turns red: the next long turn is the one that will not fit. */
export const CONTEXT_FULL_AT = 0.85;
