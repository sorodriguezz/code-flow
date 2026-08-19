import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, RotateCcw, Scissors, Trash2, X } from "lucide-react";
import { useSnippetsStore, type Snippet } from "../../state/snippetsStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { ASSIGNABLE_LANGUAGES, isAssignableLanguage } from "../../lib/monacoLanguage";
import { EmptyState } from "../common/EmptyState";
import { Tooltip } from "../common/Tooltip";
import { Status } from "../api/settingsChrome";

/**
 * The snippet list, edited in place.
 *
 * # A row at rest is the dropdown entry it becomes
 *
 * This was five identical stacks of three full-width boxes, each labelled only by a placeholder
 * that every shipped snippet was already covering up — so the pane told you nothing you could read
 * without clicking into it. A row now *rests* as what the completion widget will show: the prefix,
 * where it fires, what it does, and the body with its tab stops resolved. The fields, with real
 * labels above them, appear on the one row you opened. The list is a list of outcomes; the form is
 * a form.
 *
 * # Four fields, and still no dialog
 *
 * A snippet is a prefix, a body, a line about what it does, and where it applies. That is small
 * enough to edit on the row it lives on — a dialog per snippet would mean opening and closing one
 * for every `clg` anybody adds. Several rows can be open at once, because chasing a duplicate
 * prefix means reading two bodies side by side.
 *
 * Every keystroke is saved. There is no Save button because there is nothing to lose by saving: the
 * editor reads the list at the moment a dropdown opens, so a half-typed prefix is simply not
 * offered until it has a body (see `snippetsFor`). Deletion is the one act that cannot be taken
 * back, which is why it is the one that asks.
 *
 * # The body is still a plain textarea, on purpose
 *
 * `$1`, `${2:name}` and `$0` are what a snippet is made of, and a syntax-highlighted editor here
 * would be a second Monaco instance in a settings pane to colour four characters. What was
 * genuinely unobvious was what they *do*, so the block under the field renders them instead: a stop
 * with a default shows its text tinted, a bare stop shows a caret bar where the caret lands. That
 * retires the paragraph of prose this pane used to end with.
 */

/**
 * The resting row's tracks, as a grid rather than a flex row of `w-full` inputs.
 *
 * The old row was flex, and its shared `INPUT` class carried `w-full` while the prefix added
 * `w-28 shrink-0` — two width utilities of equal specificity, decided by stylesheet order, and
 * `w-full` is emitted last. The prefix therefore claimed 100% of the row and refused to shrink, the
 * description was the only elastic item left, and it was driven to exactly 0px. `minmax(0,1fr)` is
 * the grid form of `min-w-0` and no stray width utility can defeat it. The header row and every
 * card share this one string, so the columns cannot drift apart.
 */
const SUMMARY_GRID = "18px 104px minmax(0,1fr)";

/** `--cf-field` / `--cf-field-border`, not `--cf-surface` / `--cf-border`: the second pair divides
 *  regions, and in light theme `--cf-surface` is byte-identical to the dialog behind it, so a field
 *  painted with it has no fill at all. See the comment on the tokens in index.css. */
const FIELD =
  "w-full min-w-0 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]";
const LABEL = "mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]";
const HEAD = "text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]";
const ICON_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]";

interface Token {
  text: string;
  /** The tab stop this belongs to, or `null` for literal text. `0` is where the caret ends. */
  stop: number | null;
}

const STOPS = /\$\{(\d+):([^}]*)\}|\$\{(\d+)\}|\$(\d+)/g;

/** The body split into what the editor will leave behind: literal text, and the stops. */
function renderExpansion(body: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  for (const match of body.matchAll(STOPS)) {
    const index = match.index ?? 0;
    if (index > at) out.push({ text: body.slice(at, index), stop: null });
    out.push({ text: match[2] ?? "", stop: Number(match[1] ?? match[3] ?? match[4]) });
    at = index + match[0].length;
  }
  if (at < body.length) out.push({ text: body.slice(at), stop: null });
  return out;
}

/** The same expansion squeezed onto the one line the resting row has for it. */
function expandedText(body: string): string {
  return renderExpansion(body)
    .map((token) => token.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The language scope, as chips.
 *
 * This used to be `languages.join(", ")` driven straight from the row, and the round trip erased the
 * comma as fast as it was pressed: `typescript,` parsed to `["typescript"]` — the empty tail is
 * dropped, correctly — which joined back without the comma, on the same keystroke that made it, so
 * the second language was unreachable by the exact gesture the placeholder demonstrated.
 * `TagsField` in `HostDetailsPanel` fixes that shape by holding the typed text separately; chips
 * make the shape go away, because the input only ever holds the one token being typed and is never
 * re-derived from the stored array.
 *
 * **Free text, but no longer a guessing game.** Scoping is an exact string comparison
 * (`snippetsFor`), so `bash` where the app says `shell`, or VS Code's `typescriptreact` where this
 * app says `typescript`, silently matches nothing forever — and there was no way to find that out
 * from this screen. The `datalist` offers the ids this app can actually assign
 * (`ASSIGNABLE_LANGUAGES`, derived from the extension map, not from the two hundred languages Monaco
 * knows), and a chip outside that set is marked rather than accepted in silence. Still typing and
 * not a multi-select, because a scope is usually one or two ids and a picker of twenty-six would be
 * slower than the word.
 */
/** One id for the shared `datalist`; every chips field on the pane can point at the same options. */
const LANGUAGE_OPTIONS_ID = "cf-snippet-languages";

function LanguageChips({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const t = useT();
  const [pending, setPending] = useState("");
  const unknown = value.filter((lang) => !isAssignableLanguage(lang));

  const commit = (raw: string) => {
    const added = raw
      .split(",")
      // Monaco ids are lowercase, and `TypeScript` silently matching nothing is the next bug in
      // this family.
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .filter((lang, at, all) => all.indexOf(lang) === at && !value.includes(lang));
    if (added.length > 0) onChange([...value, ...added]);
    setPending("");
  };

  return (
    <div>
      {/* Composed field: the wrapper takes the focus state, the input is transparent. */}
      <div className="flex min-w-0 flex-wrap items-center gap-1 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-1.5 py-1 focus-within:border-[var(--cf-accent)]">
        {value.map((lang) => (
          <span
            key={lang}
            title={isAssignableLanguage(lang) ? undefined : t("snippets.languageUnknownOne", { name: lang })}
            className={`flex shrink-0 items-center gap-1 rounded py-px pl-1.5 pr-1 font-mono text-[11px] ${
              isAssignableLanguage(lang)
                ? "bg-black/[0.05] text-[var(--cf-text-muted)] dark:bg-white/[0.07]"
                : "bg-[var(--cf-warning)]/15 text-[var(--cf-warning)]"
            }`}
          >
            {lang}
            <button
              type="button"
              onClick={() => onChange(value.filter((entry) => entry !== lang))}
              aria-label={t("snippets.removeLanguage", { name: lang })}
              className="flex h-3.5 w-3.5 items-center justify-center rounded hover:text-[var(--cf-danger)]"
            >
              <X size={9} />
            </button>
          </span>
        ))}
        <input
          value={pending}
          // A comma anywhere in the value commits, which covers a pasted "typescript, javascript"
          // as well as a typed one without intercepting the keystroke.
          onChange={(e) => (e.target.value.includes(",") ? commit(e.target.value) : setPending(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(pending);
            } else if (e.key === "Backspace" && pending === "" && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => commit(pending)}
          spellCheck={false}
          placeholder={value.length === 0 ? t("snippets.languagesPlaceholder") : t("snippets.addLanguage")}
          aria-label={t("snippets.languages")}
          // The ids this app can actually give a file. A native `datalist` rather than a menu of our
          // own: it filters as you type, it is reachable from the keyboard without any work, and it
          // stays a text field for the case the list does not cover.
          list={LANGUAGE_OPTIONS_ID}
          className="min-w-[7rem] flex-1 bg-transparent py-0.5 font-mono text-[12px] text-[var(--cf-text)] outline-none placeholder:font-sans placeholder:text-[var(--cf-text-muted)]"
        />
        <datalist id={LANGUAGE_OPTIONS_ID}>
          {ASSIGNABLE_LANGUAGES.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
      </div>
      {/* Where it applies is a state, not a caption — so it sits under the field rather than beside
          it, where it used to take its width first and shrink the input it was describing. */}
      <div className="mt-1 flex flex-col gap-1">
        <Status tone={value.length === 0 ? "accent" : "muted"} wrap>
          {value.length === 0 ? t("snippets.scopeEverywhere") : t("snippets.scopeOf", { langs: value.join(", ") })}
        </Status>
        {/* Said out loud rather than left to the chip's colour: the whole failure this guards against
            is one that gives no feedback at all, so a tint on its own would repeat the problem. */}
        {unknown.length > 0 && (
          <Status tone="warning" wrap>
            {t("snippets.languageUnknown", { langs: unknown.join(", ") })}
          </Status>
        )}
      </div>
    </div>
  );
}

function SnippetRow({
  snippet,
  open,
  duplicate,
  autoFocus,
  onToggle,
  onFocused,
  onRemoved,
}: {
  snippet: Snippet;
  open: boolean;
  /** Another snippet claims this prefix in a language this one also covers. */
  duplicate: boolean;
  autoFocus: boolean;
  onToggle: () => void;
  onFocused: () => void;
  onRemoved: () => void;
}) {
  const t = useT();
  const update = useSnippetsStore((s) => s.update);
  const remove = useSnippetsStore((s) => s.remove);
  const prefixRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // A new snippet lands at the end of a list inside a scrolling pane in a fixed-height dialog, so
  // without this "New snippet" looks like it did nothing at all.
  useEffect(() => {
    if (!autoFocus) return;
    cardRef.current?.scrollIntoView({ block: "nearest" });
    prefixRef.current?.focus();
    onFocused();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const preview = expandedText(snippet.body);
  const noBody = snippet.prefix.trim() !== "" && snippet.body.trim() === "";
  const named = snippet.prefix.trim();
  const duplicateLine = t("snippets.duplicatePrefix", { prefix: named });

  const askRemove = () =>
    void confirmAction(
      named ? t("snippets.removeConfirm", { prefix: named }) : t("snippets.removeConfirmBlank"),
      true,
      t("snippets.removeAction"),
    ).then((ok) => {
      if (!ok) return;
      remove(snippet.id);
      onRemoved();
    });

  return (
    <div
      ref={cardRef}
      className="min-w-0 rounded-lg border border-[var(--cf-border)] px-2 py-1.5 transition-colors hover:bg-black/[0.02] focus-within:border-[var(--cf-accent)] dark:hover:bg-white/[0.03]"
    >
      <div className="flex min-w-0 items-start gap-1">
        {/* One button over the first three tracks: expanding is one tab stop, not three. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? t("snippets.collapse") : t("snippets.expand")}
          style={{ gridTemplateColumns: SUMMARY_GRID }}
          className="grid min-w-0 flex-1 items-start gap-2 rounded-md py-0.5 text-left"
        >
          <span className="flex h-[18px] items-center text-[var(--cf-text-muted)]">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>

          {/* When it fires. `title` on a merely-truncated value is the correct use of `title`. */}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span
              title={named || undefined}
              className={`truncate font-mono text-[12px] ${
                named ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"
              }`}
            >
              {named || t("snippets.untitled")}
            </span>
            <span
              title={snippet.languages.join(", ") || undefined}
              className="truncate text-[10px] leading-tight text-[var(--cf-text-muted)]"
            >
              {snippet.languages.length === 0
                ? t("snippets.everywhere")
                : snippet.languages.length === 1
                  ? snippet.languages[0]
                  : `${snippet.languages[0]} +${snippet.languages.length - 1}`}
            </span>
          </span>

          {/* What it produces — and the one line a warning takes over, because a snippet that can
              never be offered has nothing useful to say about what it would have written. */}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[12px] text-[var(--cf-text)]">{snippet.description}</span>
            {noBody || duplicate ? (
              <span
                title={noBody ? t("snippets.noBody") : duplicateLine}
                className="flex min-w-0 items-center gap-1 text-[10.5px] leading-tight text-[var(--cf-warning)]"
              >
                <AlertTriangle size={10} className="shrink-0" />
                <span className="truncate">{noBody ? t("snippets.noBody") : duplicateLine}</span>
              </span>
            ) : (
              <span
                title={preview || undefined}
                className="truncate font-mono text-[10.5px] leading-tight text-[var(--cf-text-muted)]"
              >
                {preview}
              </span>
            )}
          </span>
        </button>

        <Tooltip side="top" label={t("snippets.remove")}>
          <button
            type="button"
            onClick={askRemove}
            aria-label={t("snippets.remove")}
            className={`${ICON_BUTTON} hover:text-[var(--cf-danger)]`}
          >
            <Trash2 size={13} />
          </button>
        </Tooltip>
      </div>

      {open && (
        <div className="mt-2 border-t border-[var(--cf-border)] pt-2.5">
          <div className="grid gap-2" style={{ gridTemplateColumns: "112px minmax(0,1fr)" }}>
            <label className="min-w-0">
              <span className={LABEL}>{t("snippets.prefix")}</span>
              <input
                ref={prefixRef}
                value={snippet.prefix}
                onChange={(e) => update(snippet.id, { prefix: e.target.value })}
                placeholder={t("snippets.prefixPlaceholder")}
                spellCheck={false}
                className={`${FIELD} font-mono`}
              />
            </label>
            <label className="min-w-0">
              <span className={LABEL}>{t("snippets.description")}</span>
              <input
                value={snippet.description}
                onChange={(e) => update(snippet.id, { description: e.target.value })}
                placeholder={t("snippets.descriptionPlaceholder")}
                className={FIELD}
              />
            </label>
          </div>

          {duplicate && (
            <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-[var(--cf-warning)]">
              <AlertTriangle size={11} className="mt-[2px] shrink-0" />
              <span>{duplicateLine}</span>
            </p>
          )}

          <label className="mt-2 block">
            <span className={LABEL}>{t("snippets.body")}</span>
            {/* Fixed height. It used to be `rows={Math.min(8, Math.max(2, lines))}`, recomputed on
                every keystroke, so pressing Enter grew the card and shoved everything under it down
                while the caret was still in it. */}
            <textarea
              value={snippet.body}
              onChange={(e) => update(snippet.id, { body: e.target.value })}
              placeholder={t("snippets.bodyPlaceholder")}
              rows={4}
              spellCheck={false}
              className={`${FIELD} resize-y font-mono leading-snug`}
            />
          </label>
          {noBody ? (
            <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-[var(--cf-warning)]">
              <AlertTriangle size={11} className="mt-[2px] shrink-0" />
              <span>{t("snippets.noBody")}</span>
            </p>
          ) : (
            <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("snippets.bodyHint")}</p>
          )}

          {snippet.body.trim() !== "" && (
            <div className="mt-2">
              <span className={LABEL}>{t("snippets.preview")}</span>
              <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1.5 font-mono text-[11px] leading-snug text-[var(--cf-text)]">
                {renderExpansion(snippet.body).map((token, at) =>
                  token.stop === null ? (
                    <span key={at}>{token.text}</span>
                  ) : token.text ? (
                    <span
                      key={at}
                      className="rounded-[2px] bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)] text-[var(--cf-accent)]"
                    >
                      {token.text}
                    </span>
                  ) : (
                    // A stop with nothing in it is a place the caret goes, so it is drawn as one.
                    <span
                      key={at}
                      aria-hidden
                      className="inline-block h-[11px] w-[2px] translate-y-[2px] rounded-full bg-[var(--cf-accent)]"
                    />
                  ),
                )}
              </pre>
              <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("snippets.previewHint")}</p>
            </div>
          )}

          <div className="mt-2">
            <span className={LABEL}>{t("snippets.languages")}</span>
            <LanguageChips value={snippet.languages} onChange={(languages) => update(snippet.id, { languages })} />
          </div>
        </div>
      )}
    </div>
  );
}

export function SnippetsSettings() {
  const t = useT();
  const snippets = useSnippetsStore((s) => s.snippets);
  const add = useSnippetsStore((s) => s.add);
  const reset = useSnippetsStore((s) => s.reset);

  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

  /**
   * Which snippets are fighting over a prefix.
   *
   * Over the whole array, never a visible subset — two snippets collide when they share a trimmed
   * prefix *and* their language sets overlap, and an empty set means "every language" and so
   * overlaps with all of them. Scope matters: `clg` in TypeScript and `clg` in Rust are the two
   * snippets `snippetsStore` documents as the intended design, and flagging that pair would spend
   * `--cf-warning` on correct data, which is what makes real warnings invisible. Pairwise because
   * the list is five long.
   */
  const duplicates = useMemo(() => {
    const flagged = new Set<string>();
    for (let i = 0; i < snippets.length; i += 1) {
      for (let j = i + 1; j < snippets.length; j += 1) {
        const a = snippets[i];
        const b = snippets[j];
        const prefix = a.prefix.trim();
        if (!prefix || prefix !== b.prefix.trim()) continue;
        const overlap =
          a.languages.length === 0 ||
          b.languages.length === 0 ||
          a.languages.some((lang) => b.languages.includes(lang));
        if (overlap) {
          flagged.add(a.id);
          flagged.add(b.id);
        }
      }
    }
    return flagged;
  }, [snippets]);

  const blank = snippets.find((s) => !s.prefix.trim() && !s.body.trim());

  const reveal = (id: string) => {
    setOpen((current) => new Set(current).add(id));
    setPendingFocus(id);
  };

  // A second blank card is never what anybody wanted; the first one is still empty and still there,
  // so the click takes you to it — and putting the caret in it is the visible answer that the old
  // silent append never gave.
  const onAdd = () => reveal(blank ? blank.id : add());

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const forget = (id: string) =>
    setOpen((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });

  return (
    <div>
      {/* No `SettingsHeader`: this is a pane inside the Editor section's rail, which already names
          it and carries its hint. Wraps rather than overflowing — "Restore the shipped set" and
          "Nuevo fragmento" and the count together need ~415px, and a widened settings nav can leave
          this Panel with about 350. */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{t("snippets.yours", { n: snippets.length })}</p>
        <div className="flex shrink-0 items-center gap-3">
          <button
            onClick={() =>
              void confirmAction(t("snippets.resetConfirm"), true, t("snippets.resetAction")).then(
                (ok) => ok && reset(),
              )
            }
            className="flex items-center gap-1 text-[12px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <RotateCcw size={13} /> {t("snippets.reset")}
          </button>
          {/* Not `disabled` when a blank already exists: a disabled button dispatches no pointer
              events, so the tooltip explaining why would never appear. It stays clickable, says why
              in its label, and takes you to the blank you already have. */}
          <Tooltip side="top" label={blank ? t("snippets.blankPending") : t("snippets.add")}>
            <button
              onClick={onAdd}
              className="flex items-center gap-1 text-[12px] text-[var(--cf-accent)] hover:underline"
            >
              <Plus size={13} /> {t("snippets.add")}
            </button>
          </Tooltip>
        </div>
      </div>

      {snippets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--cf-border)]">
          <EmptyState icon={Scissors} title={t("snippets.emptyTitle")} subtitle={t("snippets.empty")} />
          {/* The way out lives where the eye lands, not in the opposite corner. */}
          <div className="flex justify-center pb-6">
            <button
              onClick={onAdd}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-2 text-[13px] font-medium hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <Plus size={13} /> {t("snippets.addFirst")}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* One header row over the stack, on the same track string the cards use, so the two
              columns are named once instead of by a placeholder that vanishes the moment there is
              content — which, on the shipped set, is always. */}
          <div className="mb-1 flex items-center gap-1 px-2">
            <div className="grid min-w-0 flex-1 gap-2" style={{ gridTemplateColumns: SUMMARY_GRID }}>
              <span />
              <span className={`truncate ${HEAD}`}>{t("snippets.prefix")}</span>
              <span className={`truncate ${HEAD}`}>{t("snippets.description")}</span>
            </div>
            <span className="w-7 shrink-0" />
          </div>

          <div className="space-y-1.5">
            {snippets.map((snippet) => (
              <SnippetRow
                key={snippet.id}
                snippet={snippet}
                open={open.has(snippet.id)}
                duplicate={duplicates.has(snippet.id)}
                autoFocus={pendingFocus === snippet.id}
                onToggle={() => toggle(snippet.id)}
                onFocused={() => setPendingFocus(null)}
                onRemoved={() => forget(snippet.id)}
              />
            ))}
          </div>

          {/* A heavier row gets an explicit button rather than a trailing blank row, and it sits
              under the list where a new row belongs. */}
          <button
            onClick={onAdd}
            className="mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            <Plus size={12} /> {t("snippets.add")}
          </button>
        </>
      )}
    </div>
  );
}
