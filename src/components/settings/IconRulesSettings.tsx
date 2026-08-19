import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CopyPlus,
  Download,
  Eye,
  EyeOff,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Folder,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { IconGlyph } from "../common/FileGlyph";
import { Select } from "../common/Select";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import {
  iconCatalogReady,
  loadIconCatalog,
  onIconCatalogReady,
  releaseIconCatalog,
  searchIcons,
} from "../../lib/icons/catalog";
import {
  formatIconPattern,
  iconPatternDescription,
  newRuleId,
  parseIconPattern,
  ruleMatches,
  ruleMatchesSearch,
  sameRuleTarget,
  type IconRule,
} from "../../lib/icons/rules";
import { exportProfileFile, importProfileFile } from "../../lib/icons/profileFile";
import { shippedProfile } from "../../lib/icons/profiles";
import { useIconRulesStore } from "../../state/iconRulesStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

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

  // The picker is the only thing in the app that wants all ~3,600 glyphs; everything else draws
  // from the sixty-odd the rules name. Handing the rest back on close is what stops opening this
  // dialog once from costing ~10 MB of SVG markup for the rest of the session.
  //
  // Borrow and hand back in **one** effect, so they are a matched pair for the whole time this is
  // mounted. They used to be two: the borrow was skipped when the catalogue happened to be loaded
  // already, while the hand-back ran either way. That is fine for a lone borrower and wrong the
  // moment there is a second one — an import running alongside this dialog would be counted out by
  // a release this component never paid for. Unconditional here also survives StrictMode's
  // mount/unmount/mount, which sees load, release, load.
  useEffect(() => {
    void loadIconCatalog();
    return releaseIconCatalog;
  }, []);

  useEffect(() => {
    if (ready) return;
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
        //
        // Columns from the width rather than a fixed seven, which is what the 280px rail this came
        // from wanted. In the Settings pane seven columns are ~70px each and the glyphs float in
        // the middle of them; `auto-fill` keeps the cells the size of an icon and puts as many on a
        // row as fit, at either width.
        <div
          className="mt-1.5 grid max-h-[220px] gap-0.5 overflow-y-auto"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(30px, 1fr))" }}
        >
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
 * The profile bar: which set of rules this repository draws with, and everything that acts on it.
 *
 * A row of its own above everything, because it is the frame the rest of the panel is inside — the
 * list underneath is not "the rules", it is *this profile's* rules, and a panel that did not say so
 * would make editing Angular's list while sitting in the Nest checkout look like a bug in the
 * editor rather than a profile left selected.
 *
 * **"New rule" and "restore" live here and not in the title bar.** Up there they read as belonging
 * to the panel — to file icons as a whole — when both have only ever acted on one profile's list.
 * Attached to the selector, the thing they change is named an inch to their left.
 */
function ProfileBar({ onAddRule }: { onAddRule: () => void }) {
  const t = useT();
  const profiles = useIconRulesStore((s) => s.profiles);
  const activeId = useIconRulesStore((s) => s.activeId);
  const repoPath = useIconRulesStore((s) => s.repoPath);
  const selectProfile = useIconRulesStore((s) => s.selectProfile);
  const addProfile = useIconRulesStore((s) => s.addProfile);
  const duplicateProfile = useIconRulesStore((s) => s.duplicateProfile);
  const renameProfile = useIconRulesStore((s) => s.renameProfile);
  const removeProfile = useIconRulesStore((s) => s.removeProfile);
  const resetProfile = useIconRulesStore((s) => s.resetProfile);
  const resetAll = useIconRulesStore((s) => s.resetAll);
  const importProfile = useIconRulesStore((s) => s.importProfile);
  /** Whether the profiles have actually been read yet. Both file actions hang off it — see
   * `runImport`, and the guard of the same name in the store. */
  const loaded = useIconRulesStore((s) => s.loaded);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** The name being typed, or `null` when the row is showing the select. */
  const [naming, setNaming] = useState<{ mode: "add" | "duplicate" | "rename"; value: string } | null>(
    null,
  );

  const active = profiles.find((profile) => profile.id === activeId);
  /** Whether there is a shipped version of this profile to go back to. A profile the user wrote has
   * no factory state, and a restore button that did nothing would be worse than one that says so. */
  const restorable = shippedProfile(activeId) !== null;

  /**
   * Restoring is asked about first: it is not undoable — this list is the only copy — and the
   * sentence has to name the profile, because the whole point of the change is that this button no
   * longer touches the others.
   */
  const confirmResetProfile = async () => {
    const message = t("icons.resetProfileConfirm", {
      name: active?.name ?? "",
      n: active?.rules.length ?? 0,
    });
    if (await confirmAction(message, true, t("icons.resetConfirmAction"))) void resetProfile();
  };

  /** The blunt one, kept in the menu rather than on the row. Its blast radius is every profile the
   * user owns, which is not something a button one pixel from "restore this profile" should do. */
  const confirmResetAll = async () => {
    const message = t("icons.resetConfirm", { n: profiles.length });
    if (await confirmAction(message, true, t("icons.resetConfirmAction"))) void resetAll();
  };

  const commit = () => {
    if (!naming) return;
    const name = naming.value.trim();
    setNaming(null);
    if (!name) return;
    if (naming.mode === "add") void addProfile(name);
    else if (naming.mode === "duplicate") void duplicateProfile(activeId, name);
    else void renameProfile(activeId, name);
  };

  const runExport = async () => {
    if (!active) return;
    try {
      const path = await exportProfileFile(active);
      // `null` is the dialog being dismissed, which is not an outcome worth a toast.
      if (path) {
        useToastStore
          .getState()
          .pushToast(t("icons.profileExported", { name: active.name, path }), "success");
      }
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  /**
   * Reading a file, saying what came out of it, and only then writing.
   *
   * **The report goes in the confirmation, not in a toast afterwards.** How many rules were dropped
   * is the only signal that the file did not arrive whole — the profile itself looks perfectly fine
   * either way — and a toast about it lands while the eye is already back on the tree looking for
   * the icons it was promised. In the confirmation it is the thing being read at the moment the
   * decision is made, and declining is still free.
   *
   * The sentence is assembled from independent clauses rather than from a key per combination:
   * renamed, missing icons, unusable entries and a missing folder icon are four flags that occur in
   * any mix, which is sixteen keys written as thirteen words of overlap. Each clause is a whole
   * sentence in both languages, so the order they arrive in never produces a fragment.
   *
   * `danger: false`, unlike `confirmResetProfile`: nothing is overwritten or lost here. The
   * imported profile is added to the list, and undoing it is the delete entry in this same menu.
   */
  const runImport = async () => {
    let result;
    try {
      result = await importProfileFile(profiles);
    } catch (e) {
      return pushErrorToast(String(e));
    }
    if (!result) return;
    if (!result.ok) return pushErrorToast(t(result.error, result.params));
    const clauses = [
      t("icons.importConfirm", { name: result.profile.name, n: result.profile.rules.length }),
    ];
    if (result.renamedFrom) clauses.push(t("icons.importRenamed", { original: result.renamedFrom }));
    if (result.droppedIcons) clauses.push(t("icons.importDroppedIcon", { n: result.droppedIcons }));
    if (result.droppedInvalid) {
      clauses.push(t("icons.importDroppedInvalid", { n: result.droppedInvalid }));
    }
    if (result.droppedFolderIcon) clauses.push(t("icons.importDroppedFolder"));
    if (await confirmAction(clauses.join(" "), false, t("icons.importAction"))) {
      void importProfile(result.profile);
    }
  };

  const items: MenuItem[] = [
    {
      label: t("icons.profileAdd"),
      icon: Plus,
      onClick: () => setNaming({ mode: "add", value: "" }),
    },
    {
      label: t("icons.profileDuplicate"),
      icon: CopyPlus,
      onClick: () => setNaming({ mode: "duplicate", value: `${active?.name ?? ""} 2` }),
    },
    {
      label: t("icons.profileRename"),
      icon: Pencil,
      onClick: () => setNaming({ mode: "rename", value: active?.name ?? "" }),
    },
  ];
  // Their own group under the three above: those manage *this list*, these move a profile between
  // machines. Hence `separated` on the first of the pair and not on the second.
  //
  // Disabled until the profiles have been read, because until then the list on screen is the shipped
  // one and writing from it would persist that over the user's own — the same window the store's
  // `loaded` guard covers, said here so the entry is visibly unavailable rather than silently inert.
  items.push(
    {
      label: t("icons.profileExport"),
      icon: Upload,
      separated: true,
      disabled: !loaded,
      onClick: () => void runExport(),
    },
    {
      label: t("icons.profileImport"),
      icon: Download,
      disabled: !loaded,
      onClick: () => void runImport(),
    },
  );
  // The last profile has no delete: with none left there is no rule list to fall back to.
  if (profiles.length > 1) {
    items.push({
      label: t("icons.profileRemove"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: async () => {
        if (await confirmAction(t("icons.profileRemoveConfirm", { name: active?.name ?? "" }))) {
          void removeProfile(activeId);
        }
      },
    });
  }
  items.push({
    label: t("icons.resetAll"),
    icon: RotateCcw,
    danger: true,
    separated: true,
    onClick: () => void confirmResetAll(),
  });

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] pb-2">
      {naming ? (
        <input
          autoFocus
          value={naming.value}
          onChange={(e) => setNaming({ ...naming, value: e.target.value })}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setNaming(null);
          }}
          placeholder={t("icons.profileNamePlaceholder")}
          className="min-w-0 flex-1 rounded-md border border-[var(--cf-accent)] bg-[var(--cf-bg)] px-1.5 py-1 text-[12px] outline-none"
        />
      ) : (
        <div className="min-w-0 flex-1">
          <Select
            size="compact"
            ariaLabel={t("icons.profile")}
            value={activeId}
            onChange={(id) => void selectProfile(id)}
            options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
          />
        </div>
      )}
      <button
        onClick={onAddRule}
        title={t("icons.addRule")}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
      >
        <Plus size={13} />
      </button>
      <button
        onClick={() => void confirmResetProfile()}
        disabled={!restorable}
        title={
          restorable
            ? t("icons.resetProfile", { name: active?.name ?? "" })
            : t("icons.resetProfileUnavailable")
        }
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-white/[0.08]"
      >
        <RotateCcw size={12} />
      </button>
      <button
        onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
        title={t("icons.more")}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
      >
        <MoreHorizontal size={13} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}

      {/* Said once, here, rather than on every row: the selection belongs to the repository, the
          rules belong to everybody. Without it, editing a profile shared by three repos looks
          local — and with no repo open there is nowhere for a selection to be written at all. */}
      {!repoPath && (
        <span className="shrink-0 text-[10.5px] text-[var(--cf-text-muted)]">
          {t("icons.profileNoRepo")}
        </span>
      )}
    </div>
  );
}

/**
 * The explorer's iconography: the profiles, the rules in the active one, and the folder icon that
 * applies when no rule claims a name.
 *
 * This lived in the editor's rail for a while, beside the tree it repaints, and the argument for
 * that was a good one: you notice every `.service.ts` looks like every other TypeScript file while
 * you are looking at them, and the fix should not be three screens away. What settled it the other
 * way is scope. **The profiles are global** — one list, shared by every repository in every
 * workspace, with only the *selection* filed per repo (see `iconRulesStore`). A rail that answers
 * for one checkout was the wrong place to edit a preference that belongs to all of them, and it was
 * also the only control in that rail you could not reach without a repository open.
 *
 * Every edit still writes through immediately, so any tree already drawn behind the Settings window
 * repaints as you type.
 */
export function IconRulesSettings() {
  const t = useT();
  const rules = useIconRulesStore((s) => s.rules);
  const save = useIconRulesStore((s) => s.save);
  const defaultFolderIcon = useIconRulesStore((s) => s.defaultFolderIcon);
  const setDefaultFolderIcon = useIconRulesStore((s) => s.setDefaultFolderIcon);
  const profileName = useIconRulesStore(
    (s) => s.profiles.find((profile) => profile.id === s.activeId)?.name ?? "",
  );
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
    // No height of its own and no scroll of its own: the pane in `EditorSettings` owns both. In the
    // rail this was `h-full` with the rule list scrolling inside it, which here would have produced
    // a short box scrolling within a column that also scrolls.
    //
    // No title bar either — the section rail beside it already says "File icons", and a heading
    // repeated one pane over reads as a second, narrower thing.
    <div className="flex flex-col">
      <ProfileBar onAddRule={add} />

      {/* What every folder no rule claims looks like. A row of its own above the list and not a
          rule in it, because it is the opposite of a rule: it has no pattern, it cannot be
          reordered, and it is what happens when nothing matches. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] py-2">
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
        <div className="shrink-0 pt-2">
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
      <div className="shrink-0 py-2">
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

      <div className="space-y-1 pb-1">
        {rules.length === 0 ? (
          <p className="px-1 py-6 text-center text-[11px] text-[var(--cf-text-muted)]">
            {t("icons.emptyProfile", { name: profileName })}
          </p>
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
