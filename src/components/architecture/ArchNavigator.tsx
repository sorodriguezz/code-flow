import { useState } from "react";
import { Box, FolderOpen, Search } from "lucide-react";
import type { Scene } from "../../lib/architecture/layout";
import { useArchitectureViewStore, type Selection } from "../../state/architectureViewStore";
import { useT } from "../../state/languageStore";
import { iconButtonClass } from "../common/Button";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { Tooltip } from "../common/Tooltip";

export function ArchNavigator({ scene }: { scene: Scene }) {
  const t = useT();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const locate = (selection: Selection) => useArchitectureViewStore.getState().select(selection, { reveal: true });
  const items: MenuItem[] = anchor ? [
    ...scene.cards.map((card) => ({
      label: [...card.name, card.resource, card.type?.join(" "), card.id !== card.name.join(" ") ? card.id : ""].filter(Boolean).join(" · "),
      icon: Box,
      onClick: () => locate({ kind: "card", id: card.id }),
    })),
    ...scene.zones.map((zone) => ({
      label: [zone.title, zone.subtitle, zone.id !== zone.title ? zone.id : ""].filter(Boolean).join(" · "),
      icon: FolderOpen,
      onClick: () => locate({ kind: "zone", id: zone.id }),
    })),
  ] : [];

  return (
    <>
      <Tooltip label={t("arch.find.title")}>
        <button
          type="button"
          aria-label={t("arch.find.title")}
          aria-haspopup="menu"
          aria-expanded={!!anchor}
          disabled={!scene.cards.length && !scene.zones.length}
          className={iconButtonClass({ size: "sm", active: !!anchor })}
          onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
        >
          <Search size={15} />
        </button>
      </Tooltip>
      {anchor ? (
        <ContextMenu x={anchor.left} y={anchor.bottom} anchor={{ top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right, align: "end" }} items={items} searchPlaceholder={t("arch.find.placeholder")} onClose={() => setAnchor(null)} />
      ) : null}
    </>
  );
}
