import { useEffect, useState } from "react";
import { Folder, FolderOpen } from "lucide-react";
import {
  iconCatalogReady,
  iconEntry,
  loadIconCatalog,
  onIconCatalogReady,
  openedVariant,
  type CatalogIcon,
} from "../../lib/icons/catalog";
import { customIconFor } from "../../lib/icons/rules";
import { fileIconFor } from "../../lib/fileIcon";
import { useIconRulesStore } from "../../state/iconRulesStore";

/**
 * Re-renders the caller once the icon catalogue has loaded.
 *
 * The catalogue arrives asynchronously and is then permanent, so this is a subscription that fires
 * at most once per mount. Cheaper than threading a loading flag through a store nothing else reads,
 * and it keeps "the icons are here now" a fact about the module that owns them.
 */
function useIconCatalog(): boolean {
  const [ready, setReady] = useState(iconCatalogReady);
  useEffect(() => {
    if (ready) return;
    void loadIconCatalog();
    return onIconCatalogReady(() => setReady(true));
  }, [ready]);
  return ready;
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
      // The markup comes from the icon packages and never from anything the user typed — the rules
      // only ever store an *id*, which is looked up here. See the note on `CatalogIcon.body`.
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}

/** A catalogue glyph by id, with nothing drawn until it resolves. For the rule list and the picker,
 * which are always talking about a specific icon rather than about a path. */
export function IconGlyph({ id, size = 13 }: { id: string; size?: number }) {
  const ready = useIconCatalog();
  const icon = ready ? iconEntry(id) : null;
  if (!icon) return <span style={{ width: size, height: size }} className="inline-block shrink-0" />;
  return <CatalogGlyph icon={icon} size={size} />;
}

/**
 * The icon for a path, wherever a path is drawn: the tree, the tabs, search hits, bookmarks.
 *
 * Three sources, in the order that lets the specific beat the general. **The user's rules** first —
 * they are the only ones that know `.spec.ts` is a test rather than TypeScript. Then the **built-in
 * Lucide table**, which covers extensions and well-known filenames and needs no download. A folder
 * with no rule keeps the plain folder, open or closed, because the open/closed state is information
 * the catalogue's static glyphs cannot carry.
 *
 * The Lucide fallback is not a placeholder to be outgrown: it is what the tree draws for the first
 * few hundred milliseconds of a cold start, and what it keeps drawing forever if the catalogue
 * fails to load. The explorer never has a column of empty squares.
 */
export function FileGlyph({
  path,
  isFolder = false,
  open = false,
  size = 13,
  color,
}: {
  path: string;
  isFolder?: boolean;
  /** Folders only: whether the row is expanded, for the built-in glyph. */
  open?: boolean;
  size?: number;
  /** Overrides the built-in colour — the git status tint the tree applies to a changed file. Never
   * applied to a catalogue glyph, which carries the brand's own colours inside its markup. */
  color?: string;
}) {
  const rules = useIconRulesStore((s) => s.rules);
  const defaultFolderIcon = useIconRulesStore((s) => s.defaultFolderIcon);
  const ready = useIconCatalog();

  // A rule first, then — for folders only — whatever the user chose as the default. A file with no
  // rule keeps the built-in table, which already knows sixty extensions by colour.
  const chosen = customIconFor(rules, path, isFolder) ?? (isFolder ? defaultFolderIcon : null);
  // Expanded folders take the `-opened` twin when the set has one, so a custom icon keeps the
  // open/closed signal the plain folder always carried.
  const resolved = chosen && isFolder && open ? (openedVariant(chosen) ?? chosen) : chosen;
  const custom = resolved && ready ? iconEntry(resolved) : null;
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
