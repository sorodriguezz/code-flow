import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { EngineGlyph } from "./dbChrome";
import { useT } from "../../state/languageStore";
import { DB_ENGINES, type DbKind } from "../../types/database";

/**
 * "Which engine?", asked before the connection dialog opens.
 *
 * The engine used to be the first field *inside* the dialog, which put the choice that decides what
 * every other field means underneath those fields — you opened a form for Postgres, then re-pointed
 * it at IRIS and watched the labels change under your cursor. Asking first is both a smaller
 * question and the one that has to be answered first, and it means the dialog can open already
 * dressed for the engine: the right default port, the right word for "database", the right URL
 * example.
 *
 * It is the app's `ContextMenu` rather than a bespoke popover, so the dismiss-on-outside-click, the
 * Escape handling and the clamp against the window edge are the ones every other menu here has.
 */
export function EngineMenu({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  onPick: (kind: DbKind) => void;
  onClose: () => void;
}) {
  const t = useT();
  const items: MenuItem[] = DB_ENGINES.map((engine) => ({
    label: engine.label,
    leading: <EngineGlyph kind={engine.kind} />,
    onClick: () => onPick(engine.kind),
  }));

  return <ContextMenu x={x} y={y} items={items} heading={t("db.whichEngine")} onClose={onClose} />;
}

/** Where to open the menu so it hangs under the button that asked for it, not over it. */
export function menuAnchor(e: React.MouseEvent<HTMLElement>) {
  const rect = e.currentTarget.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}
