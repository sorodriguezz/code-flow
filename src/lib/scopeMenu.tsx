/**
 * The "global vs this workspace" block of the context menu, in one place.
 *
 * Three trees offer this — the notes shelf, the API collection tree and the database connection
 * tree — and the whole value of the feature is that the answer means the same thing in all three.
 * Written once here, "make available everywhere" cannot come to mean one thing for a notebook and
 * a subtly different one for a connection because two menus drifted apart.
 *
 * It is **not** a component. It returns `MenuItem` objects the caller splices into its own array,
 * at its own position, because where these entries belong differs per tree: under the colour
 * swatches in the notes shelf, under the pin in the collections tree. A component would have to own
 * the whole menu to place itself.
 *
 * The workspace chooser is a *replacement* menu rather than a nested one — `ContextMenu` does not
 * nest — opened at the same point the first one was. That is the pattern the colour submenu in
 * `NoteExplorer` and the group chooser in `DbExplorer` already use.
 */

import { Globe, House, FolderInput } from "lucide-react";

import type { MenuItem } from "../components/api/CollectionTree";
import { translate } from "../state/languageStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import type { RowScope } from "../types/domain";

/** Where a replacement menu should open: the point the first one was opened at. */
export interface MenuAnchor {
  x: number;
  y: number;
}

export interface ScopeMenuArgs {
  /** The row's current scope, which decides whether "make global" or "restrict" is offered. */
  scope: RowScope;
  anchor: MenuAnchor;
  /**
   * Opens the workspace chooser in place of the menu the user is looking at.
   *
   * A `heading` is always passed with it, and not only because the chooser is a question rather
   * than a list of actions: `ContextMenu` re-measures on `[x, y, items.length, heading]`, so a
   * replacement menu that happened to have the same number of entries would keep the first one's
   * clamp and could hang off the edge of the window.
   */
  openMenu: (menu: { x: number; y: number; items: MenuItem[]; heading: string }) => void;
  /** `true` = on every workspace's shelf. */
  onSetGlobal: (global: boolean) => void;
  onMoveToWorkspace: (workspaceId: string) => void;
  /** Marks the first entry with a hairline above it. Off when the block opens a menu, since a
   *  separator on the first item is suppressed anyway. */
  separated?: boolean;
}

/**
 * The three entries, in the order they are always offered.
 *
 * "Make global" and "restrict" are mutually exclusive by construction rather than by being greyed
 * out: only one of them is ever a thing you can do to a given row, and offering the other as an
 * inert entry would make the menu longer to read for no information.
 */
export function scopeMenuItems({
  scope,
  anchor,
  openMenu,
  onSetGlobal,
  onMoveToWorkspace,
  separated,
}: ScopeMenuArgs): MenuItem[] {
  const items: MenuItem[] = [];

  if (scope === "global") {
    items.push({
      label: translate("scope.restrictToWorkspace"),
      icon: House,
      onClick: () => onSetGlobal(false),
      separated,
    });
  } else {
    items.push({
      label: translate("scope.makeGlobal"),
      icon: Globe,
      onClick: () => onSetGlobal(true),
      separated,
    });
  }

  // Read at click time, not at menu-build time: the menu is built inside a `useCallback` whose
  // identity several trees depend on for their row memoisation, so it must not take the workspace
  // list as a dependency.
  items.push({
    label: translate("scope.moveToWorkspace"),
    icon: FolderInput,
    onClick: () => {
      const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState();
      const others = workspaces.filter((workspace) => workspace.id !== activeWorkspaceId);
      openMenu({
        x: anchor.x,
        y: anchor.y,
        heading: translate("scope.chooseWorkspace"),
        items: others.length
          ? others.map((workspace) => ({
              label: workspace.name,
              leading: (
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: workspace.color }}
                />
              ),
              onClick: () => onMoveToWorkspace(workspace.id),
            }))
          : // Shown rather than hidden: an entry that opens an empty menu reads as broken, and
            // "there is nowhere else to move it" is the actual answer.
            [
              {
                label: translate("scope.noOtherWorkspaces"),
                onClick: () => {},
                disabled: true,
              },
            ],
      });
    },
  });

  return items;
}
