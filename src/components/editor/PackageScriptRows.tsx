import { useState } from "react";
import { Ban, Check, Package, Play } from "lucide-react";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { usePackageManagerStore } from "../../state/packageManagerStore";
import {
  LOCKFILE,
  PACKAGE_MANAGERS,
  SCRIPT_ROW_CAP,
  scriptCommandLine,
  type PackageManager,
  type PackageScript,
  type PackageScriptsState,
} from "../../lib/packageScripts";
import { useT } from "../../state/languageStore";

/** Where `manager` came from, which is the only thing the header row has to say. */
export type ManagerSource = "explicit" | "lockfile" | "fallback";

/**
 * The rows a `package.json` unfolds into: one per declared script, under a header naming the
 * package manager they will be run with.
 *
 * Its own file rather than three more branches inside `FileTree.tsx`, which is already a thousand
 * lines and holds the tree's expansion, listing cache, drafts, renames, drag-and-drop and keyboard
 * commands. None of that is involved here — these rows have no children, no selection and no drop
 * behaviour — so the only thing merging them in would achieve is making the file harder to read.
 *
 * # Why the manager picker lives here and not in the manifest's context menu
 *
 * It appears at exactly the moment it is relevant: the question "which manager?" only occurs to
 * anyone while they are looking at a list of scripts about to be run. A right-click menu would hide
 * it behind two gestures, on a row whose menu is otherwise about files (new, rename, delete), and
 * would need a submenu to hold four choices — a two-step menu for a setting most people set once.
 *
 * There is also a structural reason it is a row and not a button on the manifest's row: the tree
 * row *is* a `<button>`, and a button inside a button is invalid HTML that browsers silently
 * un-nest, which breaks the click target it was added to. In flow, as its own row, it is simply a
 * button among buttons.
 */
export function PackageScriptRows({
  filePath,
  depth,
  state,
  manager,
  source,
  onRun,
}: {
  /** Repo-relative path of the `package.json` these rows belong to. */
  filePath: string;
  /** Depth of the manifest's own row; these draw one level in from it. */
  depth: number;
  state: PackageScriptsState | undefined;
  manager: PackageManager;
  source: ManagerSource;
  onRun: (script: PackageScript) => void;
}) {
  const t = useT();
  const choose = usePackageManagerStore((s) => s.choose);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** Local, so it resets when the manifest is collapsed. That is the right lifetime: having lifted
   *  the cap on a two-hundred-script file once should not mean it opens that way for the rest of
   *  the session. */
  const [showAll, setShowAll] = useState(false);

  // The same arithmetic `DraftRow` and the "Empty" line use, so these sit on the indent the tree
  // would have given a child of this row.
  const indent = { paddingLeft: (depth + 1) * 14 + 6 };
  const muted = "flex items-center gap-1.5 py-0.5 pr-2 text-[11px] text-[var(--cf-text-muted)]";

  const managerItems = (): MenuItem[] => [
    {
      label: t("editor.pmAuto"),
      // A fixed-width slot whether or not it holds the tick, so the labels keep one left edge —
      // the same thing `NoteGallery` does to mark which ordering is active.
      leading: (
        <span className="flex h-3 w-3 items-center justify-center">
          {source !== "explicit" && <Check size={11} className="text-[var(--cf-accent)]" />}
        </span>
      ),
      onClick: () => choose(null),
    },
    ...PACKAGE_MANAGERS.map((option) => ({
      label: option,
      leading: (
        <span className="flex h-3 w-3 items-center justify-center">
          {source === "explicit" && option === manager && (
            <Check size={11} className="text-[var(--cf-accent)]" />
          )}
        </span>
      ),
      onClick: () => choose(option),
    })),
  ];

  const scripts = state?.status === "ok" ? state.scripts : [];
  const capped = showAll ? scripts : scripts.slice(0, SCRIPT_ROW_CAP);
  const hiddenByCap = scripts.length - capped.length;

  return (
    // Marked with the manifest's own path so the tree's drag hit test resolves a drop anywhere in
    // this block to the directory the manifest sits in — which is what it already does for the
    // manifest's row. Without it `dirAt` finds no `data-cf-treepath` ancestor here, falls through
    // to the tree root, and a file dragged over an expanded script list lands at the top of the
    // repository instead of beside the row it was aimed at.
    <div data-cf-treepath={filePath} data-cf-treedir="0">
      {state?.status === "ok" && (
        <button
          type="button"
          onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
          title={t("editor.pmChange")}
          style={indent}
          className="flex w-full items-center gap-1.5 truncate rounded-md py-0.5 pr-2 text-left text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
        >
          <Package size={12} className="shrink-0" />
          <span className="shrink-0 font-medium">{manager}</span>
          <span className="truncate opacity-60">
            {source === "lockfile"
              ? t("editor.pmFromLock", { file: LOCKFILE[manager] })
              : source === "fallback"
                ? t("editor.pmNoLock")
                : t("editor.pmPinned")}
          </span>
        </button>
      )}

      {(state === undefined || state.status === "loading") && (
        <p style={indent} className={muted}>
          {t("editor.loading")}
        </p>
      )}
      {state?.status === "invalid" && (
        <p style={indent} className={muted}>
          {t("editor.scriptsInvalid")}
        </p>
      )}
      {state?.status === "unreadable" && (
        <p style={indent} className={muted} title={state.error}>
          {t("editor.scriptsUnreadable")}
        </p>
      )}
      {state?.status === "ok" && scripts.length === 0 && (
        <p style={indent} className={muted}>
          {t("editor.scriptsNone")}
        </p>
      )}

      {capped.map((script) => {
        const line = scriptCommandLine(manager, script.name);
        return (
          <button
            key={script.name}
            type="button"
            // Whole row, not just the glyph: the play icon is the *signal* that the row does
            // something, the same way the eye is on a hidden entry — a 12px target for an action
            // whose row already spans the panel would be an aim test for no reason.
            // `aria-disabled` and an inert handler rather than the `disabled` attribute. A
            // genuinely disabled control receives no pointer events in any browser, and therefore
            // shows no `title` tooltip — which would leave the one row that needs an explanation
            // as the only row that cannot give one.
            aria-disabled={!script.runnable}
            onClick={() => script.runnable && onRun(script)}
            title={
              script.runnable
                ? t("editor.scriptRun", { command: line ?? script.name })
                : t("editor.scriptUnsafe")
            }
            style={indent}
            className={`group flex w-full items-center gap-1.5 truncate rounded-md py-0.5 pr-2 text-left text-[13px] ${
              script.runnable
                ? "text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
                : "cursor-default text-[var(--cf-text-muted)] opacity-50"
            }`}
          >
            {script.runnable ? (
              <Play size={12} className="shrink-0 opacity-60 group-hover:opacity-100" />
            ) : (
              // Drawn anyway, inert. A script that simply vanished from the list with no
              // explanation is the worse failure: it reads as the app not having seen the file,
              // and there is nowhere to go and find out otherwise. No "copy command" either —
              // handing over a line built from the dangerous name is handing over the injection
              // with a suggestion to paste it.
              <Ban size={12} className="shrink-0 opacity-60" />
            )}
            <span className="shrink-0">{script.name}</span>
            <span className="truncate opacity-50">{script.command}</span>
          </button>
        );
      })}

      {hiddenByCap > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          style={indent}
          className="flex w-full items-center gap-1.5 truncate rounded-md py-0.5 pr-2 text-left text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
        >
          {t("editor.scriptsShowAll", { n: hiddenByCap })}
        </button>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          heading={t("editor.pmHeading")}
          items={managerItems()}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
