import { useSyncExternalStore } from "react";
import { Folder, FolderOpen } from "lucide-react";
import {
  iconCatalogVersion,
  iconEntry,
  openedVariant,
  subscribeIconCatalog,
  type CatalogIcon,
} from "../../lib/icons/catalog";
import { customIconFor, type IconRule } from "../../lib/icons/rules";
import { catalogIconFor, fileIconFor } from "../../lib/fileIcon";
import { useIconRulesStore } from "../../state/iconRulesStore";

/**
 * Re-renders the caller each time a set of the icon catalogue lands.
 *
 * `useSyncExternalStore` rather than the `useState` + `useEffect` pair this used to be: this hook
 * runs once *per drawn row*, and on a cold explorer that pair was a state initialiser, an effect
 * and a re-render each, for a subscription that fires twice a session at most. Subscribing is also
 * what triggers the load — see `subscribeIconCatalog`, which pulls the file set only.
 */
function useIconCatalog(): number {
  return useSyncExternalStore(subscribeIconCatalog, iconCatalogVersion);
}

/** One catalogue glyph, drawn inline. */
export function CatalogGlyph({ icon, size = 13 }: { icon: CatalogIcon; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${icon.width} ${icon.height}`}
      className="shrink-0"
      aria-hidden
      // The markup comes from the icon packages or from this repo's own bundled set, never from
      // anything the user typed — the rules only ever store an *id*, which is looked up here. See the
      // note on `CatalogIcon.body`.
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}

/** A catalogue glyph by id, with nothing drawn until it resolves. For the rule list and the picker,
 * which are always talking about a specific icon rather than about a path. */
export function IconGlyph({ id, size = 13 }: { id: string; size?: number }) {
  // Subscribed for the re-render, not for the value: `iconEntry` answers `null` on its own until
  // the set holding this id has arrived (and asks for it, when the id is a brand mark).
  useIconCatalog();
  const icon = iconEntry(id);
  if (!icon) return <span style={{ width: size, height: size }} className="inline-block shrink-0" />;
  return <CatalogGlyph icon={icon} size={size} />;
}

/**
 * The icon for a path, wherever a path is drawn: the tree, the tabs, search hits, bookmarks.
 *
 * Four sources, in the order that lets the specific beat the general. **The user's rules** first —
 * they are the only ones that know `.spec.ts` is a test rather than TypeScript. Then, for a handful of
 * extensions, a **built-in catalogue id** (`catalogIconFor`): the file types whose right answer is a
 * glyph rather than a silhouette, `.cls` and its ObjectScript siblings among them. Then the **built-in
 * Lucide table**, which covers extensions and well-known filenames and needs no download. A folder
 * with no rule keeps the plain folder, open or closed, because the open/closed state is information
 * the catalogue's static glyphs cannot carry.
 *
 * The Lucide fallback is not a placeholder to be outgrown: it is what the tree draws for the first
 * few hundred milliseconds of a cold start, and what it keeps drawing forever if the catalogue
 * fails to load. The explorer never has a column of empty squares.
 */
export function FileGlyph(props: FileGlyphProps) {
  const rules = useIconRulesStore((s) => s.rules);
  const defaultFolderIcon = useIconRulesStore((s) => s.defaultFolderIcon);
  return <FileGlyphView {...props} rules={rules} defaultFolderIcon={defaultFolderIcon} />;
}

interface FileGlyphProps {
  path: string;
  isFolder?: boolean;
  /** Folders only: whether the row is expanded, for the built-in glyph. */
  open?: boolean;
  size?: number;
  /** Overrides the built-in colour — the git status tint the tree applies to a changed file. Never
   * applied to a catalogue glyph, which carries the brand's own colours inside its markup. */
  color?: string;
}

/**
 * `FileGlyph` with the rules handed in rather than subscribed to.
 *
 * For callers that draw *many* rows at once — the explorer. `FileGlyph` opens two `iconRulesStore`
 * subscriptions, which is nothing once and several hundred of them on a big tree; a caller that
 * already re-renders as a whole when the rules change can subscribe once at its root and prop them
 * down. Deliberately props and not `useIconRulesStore.getState()`: reading the store without
 * subscribing would sever the notification path, and editing a rule in the icons panel would stop
 * updating the tree.
 */
export function FileGlyphView({
  path,
  isFolder = false,
  open = false,
  size = 13,
  color,
  rules,
  defaultFolderIcon,
}: FileGlyphProps & { rules: IconRule[]; defaultFolderIcon: string | null }) {
  // Subscribed for the re-render, not for the value: the lookups below answer `null` on their own
  // until the set holding the id has landed, and re-answer once it has.
  useIconCatalog();

  // A rule first, then — for folders only — whatever the user chose as the default. A file with no
  // rule keeps the built-in table, which already knows sixty extensions by colour.
  const chosen =
    customIconFor(rules, path, isFolder) ?? (isFolder ? defaultFolderIcon : catalogIconFor(path));
  // Expanded folders take the `-opened` twin when the set has one, so a custom icon keeps the
  // open/closed signal the plain folder always carried.
  const resolved = chosen && isFolder && open ? (openedVariant(chosen) ?? chosen) : chosen;
  const custom = resolved ? iconEntry(resolved) : null;
  if (custom) return <CatalogGlyph icon={custom} size={size} />;

  if (isFolder) {
    const FolderIcon = open ? FolderOpen : Folder;
    return (
      <FolderIcon
        size={size}
        className="shrink-0"
        style={color ? { color } : { color: "var(--cf-text-muted)" }}
      />
    );
  }

  const { Icon, color: fileColor } = fileIconFor(path);
  return <Icon size={size} className="shrink-0" style={{ color: color ?? fileColor }} />;
}
