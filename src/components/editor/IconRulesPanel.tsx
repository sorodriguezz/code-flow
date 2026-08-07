import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Folder,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { IconGlyph } from "../common/FileGlyph";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import {
  iconCatalogReady,
  loadIconCatalog,
  onIconCatalogReady,
  searchIcons,
} from "../../lib/icons/catalog";
import {
  formatIconPattern,
  iconPatternDescription,
  parseIconPattern,
  ruleMatches,
  ruleMatchesSearch,
  sameRuleTarget,
  type IconRule,
} from "../../lib/icons/rules";
import { useIconRulesStore } from "../../state/iconRulesStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/** Ids only have to be unique within the list, and the list is small and local — a counter off the
 * clock is enough, and it keeps the rules file readable when someone opens it. */
function newRuleId(): string {
  return `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/**
 * The picker: 3,600 glyphs behind a search box.
 *
 * Search-first and not a browsable grid, because there is no order 3,600 icons can be put in that
 * anyone would scroll through — the names are the index, and `searchIcons` ranks them so the
 * shortest exact-prefix match comes first. It opens on the icons whose names contain what the rule
 * already matches on, which is right far more often than chance: a rule about `*.service.ts` opens
 * on the service glyphs.
 */
function IconPicker({
  seed,
  onPick,
  onClose,
}: {
  seed: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState(seed);
  const [ready, setReady] = useState(iconCatalogReady);

  useEffect(() => {
    if (ready) return;
    void loadIconCatalog();
    return onIconCatalogReady(() => setReady(true));
  }, [ready]);

  const results = useMemo(() => (ready ? searchIcons(query) : []), [query, ready]);

  return (
    <div className="mt-1.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] p-1.5">
      <div className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-1.5 focus-within:border-[var(--cf-accent)]">
        <Search size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("icons.searchPlaceholder")}
          className="min-w-0 flex-1 bg-transparent py-1 text-[12px] outline-none"
        />
        <button
          onClick={onClose}
          title={t("common.close")}
          className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <X size={11} />
        </button>
      </div>

      {!ready ? (
        <p className="px-1 py-3 text-center text-[11px] text-[var(--cf-text-muted)]">{t("icons.loading")}</p>
      ) : results.length === 0 ? (
        <p className="px-1 py-3 text-center text-[11px] text-[var(--cf-text-muted)]">{t("icons.noResults")}</p>
      ) : (
        // Fixed height rather than growing with the results: the picker opens inside a rule row in a
        // scrolling panel, and a list that resized with every keystroke moved the row under the
        // pointer while it was being aimed at.
        <div className="mt-1.5 grid max-h-[220px] grid-cols-7 gap-0.5 overflow-y-auto">
          {results.map((icon) => (
            <button
              key={icon.id}
              // The whole id, because the name is the only thing that distinguishes two glyphs that
              // look alike at 13px — `logos:react` from `vscode-icons:file-type-reactjs`.
              title={icon.id}
              onClick={() => onPick(icon.id)}
              className="flex h-6 w-full items-center justify-center rounded hover:bg-[var(--cf-accent-soft)]"
            >
              <IconGlyph id={icon.id} size={15} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One rule, on one line: the icon, the pattern, and a `⋯`.
 *
 * The sentence under the field is what pays for the compressed syntax — it is the parser reading
 * its own input back, so `*.spec.ts` and `.spec.ts` (which means the *file named* `.spec.ts`, and
 * matches nothing) are told apart while typing rather than by wondering why the tree did not
 * change.
 *
 * Everything that is not "which icon" and "which files" — delete, disable, reorder — is behind the
 * `⋯`, because those are done once and read never, and as permanent controls they were most of the
 * row's width.
 */
function RuleRow({
  rule,
  first,
  last,
  shadowed,
  winner,
  onChange,
  onMove,
  onRemove,
}: {
  rule: IconRule;
  first: boolean;
  last: boolean;
  /** An identical rule sits above this one. First-match-wins means this can never fire. */
  shadowed: boolean;
  /** This is the rule that would claim the name being searched for. */
  winner: boolean;
  onChange: (next: IconRule) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** The field is uncontrolled *while focused*: a pattern is edited a character at a time and
   * round-tripping every keystroke through parse-and-format would rewrite `*.spe` into `*.spe` on
   * the way past `*.sp`, moving the caret. Committed on change into the structured fields; the
   * stored rule is what the row shows again once focus leaves. */
  const [draft, setDraft] = useState<string | null>(null);
  const written = draft ?? formatIconPattern(rule);

  const items: MenuItem[] = [
    {
      label: rule.enabled ? t("icons.disable") : t("icons.enable"),
      icon: rule.enabled ? EyeOff : Eye,
      onClick: () => onChange({ ...rule, enabled: !rule.enabled }),
    },
    { label: t("icons.moveUp"), icon: ArrowUp, onClick: () => onMove(-1) },
    { label: t("icons.moveDown"), icon: ArrowDown, onClick: () => onMove(1) },
    { label: t("icons.removeRule"), icon: Trash2, danger: true, separated: true, onClick: onRemove },
  ].filter((item) => (item.label !== t("icons.moveUp") || !first) && (item.label !== t("icons.moveDown") || !last));

  return (
    <div
      className={`rounded-md border px-2 py-1.5 ${
        shadowed
          ? "border-[var(--cf-danger)]"
          : winner
            ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
            : "border-[var(--cf-border)]"
      } ${rule.enabled ? "" : "opacity-45"}`}
    >
      {/* `items-center` on the row, with the two lines of text in their own column: the icon is
          centred against the pair, not pinned to the pattern above the sentence. */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPicking((v) => !v)}
          title={t("icons.pickIcon")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--cf-accent-soft)]"
        >
          <IconGlyph id={rule.icon} size={16} />
        </button>

        <span className="flex min-w-0 flex-1 flex-col">
          <input
            value={written}
            onChange={(e) => {
              setDraft(e.target.value);
              onChange({ ...rule, ...parseIconPattern(e.target.value) });
            }}
            onBlur={() => setDraft(null)}
            placeholder={t("icons.patternPlaceholder")}
            spellCheck={false}
            className="w-full bg-transparent font-mono text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)]"
          />
          {/* One line, and the duplicate warning takes it over: a rule that can never fire has
              nothing useful to say about what it matches. */}
          {shadowed ? (
            <span className="flex items-center gap-1 truncate text-[10.5px] leading-tight text-[var(--cf-danger)]">
              <AlertTriangle size={10} className="shrink-0" />
              {t("icons.duplicate")}
            </span>
          ) : (
            <span className="truncate text-[10.5px] leading-tight text-[var(--cf-text-muted)]">
              {rule.pattern.trim()
                ? t(iconPatternDescription(rule) as TranslationKey, { pattern: rule.pattern })
                : t("icons.saysNothing")}
            </span>
          )}
        </span>

        <button
          onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
          title={t("icons.more")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
        >
          <MoreHorizontal size={13} />
        </button>
      </div>

      {picking && (
        <IconPicker
          // Seeded from the pattern with its punctuation dropped: `*.service.ts` opens the picker on
          // "service", which is the word the user would have typed anyway.
          seed={rule.pattern.replace(/[^a-z0-9]+/gi, " ").trim().split(/\s+/)[0] ?? ""}
          onPick={(id) => {
            onChange({ ...rule, icon: id });
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * The explorer's iconography, configured from the rail beside the tree it changes.
 *
 * In the rail and not in Settings, because this is edited *while looking at the tree* — you notice
 * that every `.service.ts` looks like every other TypeScript file, and the fix should not be three
 * screens and a lost place away. Every edit writes through immediately and the tree behind it
 * repaints, so the panel is its own preview.
 */
export function IconRulesPanel() {
  const t = useT();
  const rules = useIconRulesStore((s) => s.rules);
  const save = useIconRulesStore((s) => s.save);
  const reset = useIconRulesStore((s) => s.reset);
  const defaultFolderIcon = useIconRulesStore((s) => s.defaultFolderIcon);
  const setDefaultFolderIcon = useIconRulesStore((s) => s.setDefaultFolderIcon);
  const [query, setQuery] = useState("");
  const [pickingFolder, setPickingFolder] = useState(false);

  /**
   * Which rules the search leaves on screen, and which of them wins.
   *
   * The winner is worth marking because the list is first-match-wins and the search is usually a
   * name — typing `src` asks "what icon does src get?", and with three rules that all claim it the
   * answer is the topmost one. Computed over the *whole* list rather than the filtered one, or a
   * rule that the search happened to hide would silently promote the next.
   */
  const { visible, winnerId } = useMemo(() => {
    const needle = query.trim();
    const asFolder = needle.endsWith("/");
    const name = asFolder ? needle.slice(0, -1) : needle;
    const claimant = needle
      ? rules.find(
          (rule) =>
            ruleMatches(rule, name, true) || (!asFolder && ruleMatches(rule, name, false)),
        )
      : undefined;
    return {
      visible: needle ? rules.filter((rule) => ruleMatchesSearch(rule, needle)) : rules,
      winnerId: claimant?.id ?? null,
    };
  }, [rules, query]);

  /** Rules an identical one already covers. Keyed by id so the row can say so — and it is a fact
   * about the list, not a warning we invent: with first-match-wins, the second `src/` never fires. */
  const shadowed = useMemo(() => {
    const dead = new Set<string>();
    rules.forEach((rule, index) => {
      if (!rule.pattern.trim()) return;
      if (rules.slice(0, index).some((earlier) => sameRuleTarget(earlier, rule))) dead.add(rule.id);
    });
    return dead;
  }, [rules]);

  const update = (index: number, next: IconRule) =>
    void save(rules.map((rule, i) => (i === index ? next : rule)));

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target], next[index]];
    void save(next);
  };

  /**
   * Resetting is asked about first, and the question says what is actually at stake.
   *
   * Two things make it worth a dialog rather than a click. It is **not undoable** — the rules are
   * the only copy — and it is **global**: this list is one setting for the whole app, not something
   * a workspace owns, so restoring it changes how every repository in every workspace draws its
   * tree. Neither fact is visible from a panel that sits inside one project's editor, which is
   * exactly why it has to be said out loud. The count comes from the list so the sentence is about
   * *their* rules and not about the idea of rules.
   */
  const confirmReset = async () => {
    const custom = rules.length;
    const message = defaultFolderIcon
      ? t("icons.resetConfirmWithFolder", { n: custom })
      : t("icons.resetConfirm", { n: custom });
    if (await confirmAction(message, true, t("icons.resetConfirmAction"))) void reset();
  };

  /** Refuses a second blank rule. The `+` is next to a list where the top row may already be an
   * empty one waiting to be typed into, and stacking three of them is the fastest way to make this
   * panel look broken. */
  const add = () => {
    if (rules.some((rule) => !rule.pattern.trim())) return;
    void save([
      // Prepended, not appended: a new rule is almost always more specific than the ones already
      // there, and a rule added at the bottom of a list that is first-match-wins would appear to do
      // nothing.
      {
        id: newRuleId(),
        target: "file",
        match: "suffix",
        pattern: "",
        icon: "vscode-icons:file-type-typescript",
        enabled: true,
      },
      ...rules,
    ]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1.5">
        <span className="flex-1 truncate text-[12px] font-medium text-[var(--cf-text)]">
          {t("icons.title")}
        </span>
        <button
          onClick={add}
          title={t("icons.addRule")}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
        >
          <Plus size={12} />
        </button>
        <button
          onClick={() => void confirmReset()}
          title={t("icons.resetAll")}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
        >
          <RotateCcw size={11} />
        </button>
      </div>

      {/* What every folder no rule claims looks like. A row of its own above the list and not a
          rule in it, because it is the opposite of a rule: it has no pattern, it cannot be
          reordered, and it is what happens when nothing matches. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1.5">
        <button
          onClick={() => setPickingFolder((v) => !v)}
          title={t("icons.pickIcon")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--cf-accent-soft)]"
        >
          {defaultFolderIcon ? (
            <IconGlyph id={defaultFolderIcon} size={16} />
          ) : (
            <Folder size={14} className="text-[var(--cf-text-muted)]" />
          )}
        </button>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12px] text-[var(--cf-text)]">{t("icons.defaultFolder")}</span>
          <span className="truncate text-[10.5px] leading-tight text-[var(--cf-text-muted)]">
            {defaultFolderIcon ? t("icons.defaultFolderCustom") : t("icons.defaultFolderBuiltIn")}
          </span>
        </span>
        {defaultFolderIcon && (
          <button
            onClick={() => void setDefaultFolderIcon(null)}
            title={t("icons.defaultFolderReset")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            <RotateCcw size={11} />
          </button>
        )}
      </div>
      {pickingFolder && (
        <div className="shrink-0 px-2">
          {/* Seeded on "folder" so the 199 folder types are the first thing offered. */}
          <IconPicker
            seed="folder"
            onPick={(id) => {
              void setDefaultFolderIcon(id);
              setPickingFolder(false);
            }}
            onClose={() => setPickingFolder(false)}
          />
        </div>
      )}

      {/* Above the list, because it filters it. Takes a pattern *or* a name — see
          `ruleMatchesSearch`; typing `src` finds the rule for `src/`, the one for `src*` that would
          claim `srctest`, and any rule that would claim `src.ts`. */}
      <div className="shrink-0 px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-1.5 focus-within:border-[var(--cf-accent)]">
          <Search size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("icons.filterPlaceholder")}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-1 text-[12px] outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              title={t("icons.clearFilter")}
              className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {rules.length === 0 ? (
          <p className="px-1 py-6 text-center text-[11px] text-[var(--cf-text-muted)]">{t("icons.empty")}</p>
        ) : visible.length === 0 ? (
          <p className="px-1 py-6 text-center text-[11px] text-[var(--cf-text-muted)]">
            {t("icons.noMatches", { query: query.trim() })}
          </p>
        ) : (
          visible.map((rule) => {
            // Indices come from the full list: reordering and deleting act on the real order, which
            // a filtered view must not renumber.
            const index = rules.indexOf(rule);
            return (
              <RuleRow
                key={rule.id}
                rule={rule}
                first={index === 0}
                last={index === rules.length - 1}
                shadowed={shadowed.has(rule.id)}
                winner={rule.id === winnerId}
                onChange={(next) => update(index, next)}
                onMove={(delta) => move(index, delta)}
                onRemove={() => void save(rules.filter((_, i) => i !== index))}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
