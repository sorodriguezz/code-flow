import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Pencil, Play, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { Segmented } from "../common/Segmented";
import { Select, type SelectOption } from "../common/Select";
import { Button, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { chipClass, fieldClass } from "../common/recipes";
import { PaneBlock } from "./settingsNav";
import { speechBuiltinPronunciations, speechSay, speechSpokenForm, type Pronunciation } from "../../lib/tauri/speechCommands";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useSpeechStore } from "../../state/speechStore";

/**
 * «Voz y sonido › Pronunciación», a tab of its own beside «Lectura en voz alta»: the words the voice says differently from
 * how they are written (user, 2026-11-19: «dice codeflow pero debería pronunciar Coud Flou»).
 *
 * The respelling itself is the backend's (`crate::speech::pronounce`), for everything that speaks —
 * the reading aloud, Codi, the tour, a flow. This tab is two blocks: a sentence to try, with the
 * words the voice gets differently marked; and the words — a line to add one above one list of every
 * word — the user's and CodeFlow's — searchable, by language, where one of CodeFlow's is made the
 * user's own with «Personalizar» (theirs wins over it).
 */

type Lang = "es" | "en";
type Filter = "all" | "mine" | "builtin";

/** One line of the list: a word of the user's (by its place in their list) or one CodeFlow brings. */
type Item =
  | {
      kind: "mine";
      index: number;
      entry: Pronunciation;
      replaces?: Pronunciation;
    }
  | { kind: "builtin"; entry: Pronunciation };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** A word of the user's applies to voice `lang`: theirs for both languages, or for that one. */
const appliesTo = (entry: Pronunciation, lang: Lang) => entry.lang === "" || entry.lang === lang;

/** The last save of the dictionary: «Escuchar» waits for it, so a word just typed is said as typed. */
let saving: Promise<void> = Promise.resolve();
const persist = (list: Pronunciation[]) => {
  saving = useSpeechStore.getState().setPronunciations(list);
  return saving;
};
const sayAfterSave = (text: string, lang: string) => {
  void saving.then(() => speechSay(text, "test", true, lang)).catch(() => {});
};

/** What the try line starts with: the words this pane exists for. */
const TRY_SAMPLE: Record<Lang, string> = {
  es: "Abre CodeFlow, revisa el repository en GitHub y haz commit del pull request.",
  en: "Open CodeFlow, check the repository on GitHub and commit the pull request.",
};

export function PronunciationSettings() {
  const t = useT();
  const appLanguage = useLanguageStore((s) => s.language);
  const mine = useSpeechStore((s) => s.pronunciations);
  const [builtin, setBuiltin] = useState<Pronunciation[]>([]);
  const [lang, setLang] = useState<Lang>(appLanguage);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  /** The user's row to focus once it is drawn — one just made from «Personalizar». */
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  useEffect(() => {
    speechBuiltinPronunciations()
      .then(setBuiltin)
      .catch(() => setBuiltin([]));
  }, []);

  const items = useMemo<Item[]>(() => {
    const own: Item[] = mine
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => appliesTo(entry, lang))
      .map(({ entry, index }) => ({
        kind: "mine" as const,
        index,
        entry,
        replaces: builtin.find((b) => b.lang === lang && same(b.from, entry.from)),
      }))
      // The newest first: the one just added is where the eye is.
      .reverse();
    const brought: Item[] = builtin
      .filter((b) => b.lang === lang && !mine.some((m) => appliesTo(m, lang) && same(m.from, b.from)))
      .sort((a, b) => a.from.localeCompare(b.from))
      .map((entry) => ({ kind: "builtin" as const, entry }));
    return [...own, ...brought];
  }, [mine, builtin, lang]);

  const counts = {
    all: items.length,
    mine: items.filter((i) => i.kind === "mine").length,
    builtin: items.filter((i) => i.kind === "builtin").length,
  };
  const needle = query.trim().toLowerCase();
  const shown = items.filter(
    (item) =>
      (filter === "all" || item.kind === filter) &&
      (!needle || item.entry.from.toLowerCase().includes(needle) || item.entry.to.toLowerCase().includes(needle)),
  );

  const commit = (next: Pronunciation[]) => void persist(next);
  const add = (entry: Pronunciation) => {
    const at = mine.findIndex((m) => same(m.from, entry.from) && m.lang === entry.lang);
    commit(at >= 0 ? mine.map((m, i) => (i === at ? entry : m)) : [...mine, entry]);
  };
  const customize = (entry: Pronunciation) => {
    commit([...mine, { ...entry }]);
    setFocusIndex(mine.length);
    if (filter === "builtin") setFilter("all");
    setQuery("");
  };

  return (
    <div>
      <PaneBlock title={t("speech.pronounceTry")}>
        <TryCard />
      </PaneBlock>

      <PaneBlock title={t("speech.pronounceWordsBlock")} hint={t("speech.pronounceWordsHint")}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("speech.pronounceSearch")}
              aria-label={t("speech.pronounceSearch")}
              className={fieldClass({
                size: "sm",
                className: "w-full pl-7 pr-7",
              })}
            />
            {query && (
              <button
                type="button"
                aria-label={t("common.clear")}
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--cf-text-faint)] hover:text-[var(--cf-text)]"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <Segmented
            size="sm"
            layoutId="cf-pronounce-filter"
            value={filter}
            onChange={setFilter}
            options={[
              {
                value: "all",
                label: <Counted label={t("speech.pronounceTabAll")} n={counts.all} />,
              },
              {
                value: "mine",
                label: <Counted label={t("speech.pronounceTabMine")} n={counts.mine} />,
              },
              {
                value: "builtin",
                label: <Counted label={t("speech.pronounceTabBuiltin")} n={counts.builtin} />,
              },
            ]}
          />
          <Segmented
            size="sm"
            layoutId="cf-pronounce-lang"
            value={lang}
            onChange={setLang}
            ariaLabel={t("speech.pronounceLangLabel")}
            options={[
              { value: "es", label: t("speech.pronounceEs") },
              { value: "en", label: t("speech.pronounceEn") },
            ]}
          />
        </div>

        <div className="mt-2 overflow-hidden rounded-lg border border-[var(--cf-border)]">
          <AddRow lang={lang} mine={mine} builtin={builtin} prefill={needle && shown.length === 0 ? query.trim() : ""} onAdd={add} />
          <div className="grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1.2fr)_96px_76px] items-center gap-x-2 border-y border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
            <span>{t("speech.pronounceWritten")}</span>
            <span />
            <span>{t("speech.pronounceSaid")}</span>
            <span>{t("speech.pronounceOrigin")}</span>
            <span />
          </div>
          <div className="max-h-[min(560px,60vh)] overflow-y-auto">
            {shown.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">
                {needle
                  ? t("speech.pronounceNoMatch", { q: query.trim() })
                  : filter === "mine"
                    ? t("speech.pronounceEmptyMine")
                    : t("speech.pronounceEmpty")}
              </p>
            ) : (
              shown.map((item) =>
                item.kind === "mine" ? (
                  <MineRow
                    key={`mine:${item.index}`}
                    item={item}
                    autoFocus={focusIndex === item.index}
                    onFocused={() => setFocusIndex(null)}
                    onChange={(entry) => commit(mine.map((m, i) => (i === item.index ? entry : m)))}
                    onRemove={() => commit(mine.filter((_, i) => i !== item.index))}
                    playLang={lang}
                  />
                ) : (
                  <BuiltinRow key={`builtin:${item.entry.from}`} entry={item.entry} onCustomize={() => customize(item.entry)} />
                ),
              )
            )}
          </div>
        </div>
      </PaneBlock>
    </div>
  );
}

function Counted({ label, n }: { label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <span className="tabular-nums text-[10.5px] opacity-60">{n}</span>
    </span>
  );
}

const rowClass = "group grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1.2fr)_96px_76px] items-center gap-x-2 px-3 py-1 hover:bg-[var(--cf-hover)]";
/** A field that reads as text until it is pointed at or edited. */
const inlineField =
  "h-[24px] w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-[12.5px] text-[var(--cf-text)] outline-none transition-colors placeholder:text-[var(--cf-text-faint)] hover:border-[var(--cf-field-border)] focus:border-[var(--cf-accent)] focus:bg-[var(--cf-field)]";

/** The line to add a word: written, said, for which voice. Enter adds it. */
function AddRow({
  lang,
  mine,
  builtin,
  prefill,
  onAdd,
}: {
  lang: Lang;
  mine: Pronunciation[];
  builtin: Pronunciation[];
  prefill: string;
  onAdd: (entry: Pronunciation) => void;
}) {
  const t = useT();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [scope, setScope] = useState<Pronunciation["lang"]>(lang);
  const toRef = useRef<HTMLInputElement>(null);
  useEffect(() => setScope(lang), [lang]);

  const ownMatch = from.trim() ? mine.find((m) => same(m.from, from) && m.lang === scope) : undefined;
  const builtinMatch = from.trim() ? builtin.find((b) => same(b.from, from) && (scope === "" || b.lang === scope)) : undefined;
  const ready = from.trim() !== "" && to.trim() !== "";
  const submit = () => {
    if (!ready) return;
    onAdd({ from: from.trim(), to: to.trim(), lang: scope });
    setFrom("");
    setTo("");
  };
  const scopeOptions: SelectOption[] = [
    { value: "es", label: t("speech.pronounceEs") },
    { value: "en", label: t("speech.pronounceEn") },
    { value: "", label: t("speech.pronounceBoth") },
  ];
  const note = ownMatch
    ? t("speech.pronounceExists", { to: ownMatch.to })
    : builtinMatch
      ? t("speech.pronounceWillReplace", { to: builtinMatch.to })
      : t("speech.pronounceTip");

  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") toRef.current?.focus();
          }}
          placeholder={prefill || t("speech.pronounceWrittenPlaceholder")}
          onFocus={() => {
            if (!from && prefill) setFrom(prefill);
          }}
          aria-label={t("speech.pronounceWritten")}
          className={fieldClass({
            size: "sm",
            className: "min-w-[120px] flex-1",
          })}
        />
        <ArrowRight size={13} className="shrink-0 text-[var(--cf-text-faint)]" />
        <input
          ref={toRef}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={t("speech.pronounceSaidPlaceholder")}
          aria-label={t("speech.pronounceSaid")}
          className={fieldClass({
            size: "sm",
            className: "min-w-[120px] flex-1",
          })}
        />
        <div className="w-[130px]">
          <Select
            value={scope}
            onChange={(next) => setScope(next as Pronunciation["lang"])}
            options={scopeOptions}
            size="sm"
            ariaLabel={t("speech.pronounceLangLabel")}
          />
        </div>
        <Tooltip label={t("speech.pronounceListen")}>
          <button
            type="button"
            className={iconButtonClass()}
            aria-label={t("speech.pronounceListen")}
            disabled={!to.trim()}
            onClick={() => sayAfterSave(to.trim(), scope || lang)}
          >
            <Play size={12} />
          </button>
        </Tooltip>
        <Button size="sm" variant="primary" disabled={!ready} onClick={submit}>
          <Plus size={12} />
          {ownMatch ? t("speech.pronounceUpdate") : t("speech.pronounceAdd")}
        </Button>
      </div>
      <p className={`mt-1.5 text-[11.5px] ${ownMatch || builtinMatch ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"}`}>{note}</p>
    </div>
  );
}

/** A word of the user's: both sides edited in place, saved when the field is left. */
function MineRow({
  item,
  autoFocus,
  onFocused,
  onChange,
  onRemove,
  playLang,
}: {
  item: Extract<Item, { kind: "mine" }>;
  autoFocus: boolean;
  onFocused: () => void;
  onChange: (entry: Pronunciation) => void;
  onRemove: () => void;
  playLang: Lang;
}) {
  const t = useT();
  const [from, setFrom] = useState(item.entry.from);
  const [to, setTo] = useState(item.entry.to);
  const toRef = useRef<HTMLInputElement>(null);
  useEffect(() => setFrom(item.entry.from), [item.entry.from]);
  useEffect(() => setTo(item.entry.to), [item.entry.to]);
  useEffect(() => {
    if (!autoFocus) return;
    toRef.current?.focus();
    toRef.current?.select();
    onFocused();
  }, [autoFocus, onFocused]);

  const save = () => {
    if (from.trim() === item.entry.from && to.trim() === item.entry.to) return;
    if (!from.trim()) {
      setFrom(item.entry.from);
      return;
    }
    onChange({ ...item.entry, from: from.trim(), to: to.trim() });
  };
  const enter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      setFrom(item.entry.from);
      setTo(item.entry.to);
      e.currentTarget.blur();
    }
  };

  return (
    <div className={rowClass}>
      <input
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        onBlur={save}
        onKeyDown={enter}
        aria-label={t("speech.pronounceWritten")}
        className={inlineField}
      />
      <ArrowRight size={12} className="text-[var(--cf-text-faint)]" />
      <input
        ref={toRef}
        value={to}
        onChange={(e) => setTo(e.target.value)}
        onBlur={save}
        onKeyDown={enter}
        aria-label={t("speech.pronounceSaid")}
        className={inlineField}
      />
      <span className="flex min-w-0 items-center gap-1">
        <Tooltip label={item.replaces ? t("speech.pronounceReplaces", { to: item.replaces.to }) : t("speech.pronounceMineHint")}>
          <span className={chipClass("accent")}>{t("speech.pronounceMine")}</span>
        </Tooltip>
        {item.entry.lang === "" && <span className={chipClass("neutral")}>{t("speech.pronounceBothShort")}</span>}
      </span>
      <span className="flex items-center justify-end gap-0.5">
        <Tooltip label={t("speech.pronounceListen")}>
          <button
            type="button"
            className={iconButtonClass()}
            aria-label={t("speech.pronounceListen")}
            onClick={() => sayAfterSave(from.trim(), item.entry.lang || playLang)}
          >
            <Play size={12} />
          </button>
        </Tooltip>
        <Tooltip label={item.replaces ? t("speech.pronounceRestore") : t("speech.pronounceRemove")}>
          <button
            type="button"
            className={iconButtonClass()}
            aria-label={item.replaces ? t("speech.pronounceRestore") : t("speech.pronounceRemove")}
            onClick={onRemove}
          >
            {item.replaces ? <RotateCcw size={12} /> : <Trash2 size={12} />}
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

/** A word CodeFlow brings: read-only, with «Personalizar» to make it the user's. */
function BuiltinRow({ entry, onCustomize }: { entry: Pronunciation; onCustomize: () => void }) {
  const t = useT();
  return (
    <div className={rowClass}>
      <span className="truncate px-1.5 text-[12.5px] text-[var(--cf-text)]">{entry.from}</span>
      <ArrowRight size={12} className="text-[var(--cf-text-faint)]" />
      <span className="truncate px-1.5 text-[12.5px] text-[var(--cf-text-muted)]">{entry.to}</span>
      <span>
        <span className={chipClass("neutral")}>{t("speech.pronounceIncluded")}</span>
      </span>
      <span className="flex items-center justify-end gap-0.5">
        <Tooltip label={t("speech.pronounceListen")}>
          <button
            type="button"
            className={`${iconButtonClass()} opacity-0 focus-visible:opacity-100 group-hover:opacity-100`}
            aria-label={t("speech.pronounceListen")}
            onClick={() => sayAfterSave(entry.from, entry.lang)}
          >
            <Play size={12} />
          </button>
        </Tooltip>
        <Tooltip label={t("speech.pronounceCustomize")}>
          <button
            type="button"
            className={`${iconButtonClass()} opacity-0 focus-visible:opacity-100 group-hover:opacity-100`}
            aria-label={t("speech.pronounceCustomize")}
            onClick={onCustomize}
          >
            <Pencil size={12} />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

/** Each word of `spoken`, marked when it is not in `written` at that point — what the voice gets differently. */
export function changedWords(written: string, spoken: string): { word: string; changed: boolean }[] {
  const key = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const a = written.split(/\s+/).filter(Boolean).map(key);
  const b = spoken.split(/\s+/).filter(Boolean);
  const bk = b.map(key);
  // Longest common run of words, by the usual table.
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(bk.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = bk.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === bk[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: { word: string; changed: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === bk[j]) {
      out.push({ word: b[j], changed: false });
      i++;
      j++;
    } else if (i < a.length && table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      out.push({ word: b[j], changed: true });
      j++;
    }
  }
  return out;
}

/** A sentence to try, and what the voice is handed for it — the words it gets differently marked. */
function TryCard() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const pronunciations = useSpeechStore((s) => s.pronunciations);
  const engine = useSpeechStore((s) => s.engine);
  const [text, setText] = useState(TRY_SAMPLE[language]);
  const [spoken, setSpoken] = useState<string | null>(null);

  useEffect(() => {
    const said = text.trim();
    if (!said) {
      setSpoken(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      speechSpokenForm(said, language)
        .then((form) => !cancelled && setSpoken(form.text))
        .catch(() => !cancelled && setSpoken(null));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, language, pronunciations, engine]);

  const words = spoken ? changedWords(text, spoken) : [];
  const changed = words.filter((w) => w.changed).length;
  const play = () => {
    if (text.trim()) sayAfterSave(text.trim(), language);
  };

  return (
    <div className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-sunken)] p-3">
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") play();
          }}
          aria-label={t("speech.pronounceTry")}
          placeholder={t("speech.pronounceTryPlaceholder")}
          className={fieldClass({ className: "min-w-0 flex-1" })}
        />
        <Button variant="primary" disabled={!text.trim()} onClick={play}>
          <Play size={13} />
          {t("speech.pronounceListen")}
        </Button>
      </div>
      {spoken && (
        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-1 gap-y-1 text-[12.5px] leading-relaxed">
          <span className="mr-1 text-[11.5px] text-[var(--cf-text-muted)]">{t("speech.pronounceHeard")}</span>
          {words.map((w, i) =>
            w.changed ? (
              <mark key={i} className="rounded bg-[var(--cf-accent-soft)] px-1 text-[var(--cf-accent)]">
                {w.word}
              </mark>
            ) : (
              <span key={i} className="text-[var(--cf-text)]">
                {w.word}
              </span>
            ),
          )}
          <span className="ml-auto pl-3 text-[11px] text-[var(--cf-text-muted)]">
            {changed > 0 ? t("speech.pronounceChanged", { n: changed }) : t("speech.pronounceUnchanged")}
          </span>
        </div>
      )}
    </div>
  );
}
