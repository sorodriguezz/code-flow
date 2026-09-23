import * as monaco from "monaco-editor";
import { CSV_SEPARATORS, CSV_START, tokenizeCsvLine, type CsvLineState } from "./csvDialect";

/**
 * Delimited text in the editor, one colour per column — the Rainbow CSV look.
 *
 * One language per separator (see `csvDialect.ts` for why), each with a hand-written tokenizer
 * rather than a Monarch grammar. Monarch can count columns only by spelling out a state per column,
 * and it has no clean way to say "a new line starts a new record — unless a quoted field is still
 * open", which is exactly the rule a CSV lives by. A `TokensProvider` is handed the previous line's
 * end state and decides that in two lines.
 *
 * The tokens are `rainbow1…rainbow8` for the columns and `delimiter.csv` for the separators, and
 * every scheme defines them (`tokenRulesFor` → `rainbowPalette`), so the colours follow the theme,
 * light or dark, without anything here knowing which one is on.
 */

class State implements monaco.languages.IState {
  constructor(readonly value: CsvLineState) {}

  clone(): State {
    return new State({ ...this.value });
  }

  equals(other: monaco.languages.IState): boolean {
    return (
      other instanceof State &&
      other.value.column === this.value.column &&
      other.value.quoted === this.value.quoted
    );
  }
}

/**
 * The end state of a line that closed every quote it opened.
 *
 * Every such line hands the next one the same thing — "start a record" — whatever column it ended
 * in, so it is normalised here. Monaco stops re-tokenizing below an edit as soon as a line's end
 * state equals what it was before; carrying the column along would make every edit re-tokenize the
 * rest of the file for no visible change.
 */
const RECORD_START = new State(CSV_START);

function providerFor(sep: string): monaco.languages.TokensProvider {
  return {
    getInitialState: () => RECORD_START,
    tokenize(line, state) {
      const { spans, end } = tokenizeCsvLine(line, sep, (state as State).value);
      return {
        tokens: spans.map(({ start, slot }) => ({
          startIndex: start,
          scopes: slot === null ? "delimiter.csv" : `rainbow${slot}`,
        })),
        endState: end.quoted ? new State(end) : RECORD_START,
      };
    },
  };
}

let registered = false;

/** Registers every dialect. Idempotent, and called once from `monacoSetup`. */
export function registerCsvLanguages(): void {
  if (registered) return;
  registered = true;
  for (const separator of CSV_SEPARATORS) {
    // No `extensions`: every editor in this app passes its language explicitly, and which dialect a
    // `.csv` gets is a decision about its contents — see `csvLanguageFor` — not about its name.
    monaco.languages.register({ id: separator.language });
    monaco.languages.setTokensProvider(separator.language, providerFor(separator.char));
  }
}
