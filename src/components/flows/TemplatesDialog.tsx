import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { FileText, LayoutTemplate, MoreHorizontal, Pencil, Trash2, type LucideIcon } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { iconButtonClass } from "../common/Button";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { sectionLabelClass } from "../common/recipes";
import { nodeIcon } from "../../lib/flows/nodeIcons";
import { FLOW_TEMPLATES } from "../../lib/flows/templates";
import { flowsDeleteTemplate, flowsListTemplates, flowsUpdateTemplate, type FlowTemplateMeta } from "../../lib/tauri/flowsCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { confirmAction } from "../../state/confirmStore";
import { useFlowsStore } from "../../state/flowsStore";
import { useT } from "../../state/languageStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast } from "../../state/toastStore";

/**
 * The template gallery: the user's own templates — saved from a flow's menu (`saveAsTemplate`) and
 * offered in every workspace — then the ones the app ships. A click makes the flow and opens it. The
 * user's own are also managed here, from their ⋯ or a right-click: renamed, described, deleted.
 */
export function TemplatesDialog({ folderId, onClose }: { folderId: string | null; onClose: () => void }) {
  const t = useT();
  const catalogMap = useFlowsStore((s) => s.catalogMap);
  const [mine, setMine] = useState<FlowTemplateMeta[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; template: FlowTemplateMeta } | null>(null);
  const glyph = (type: string) => nodeIcon(catalogMap.get(type)?.icon ?? "workflow");

  const reload = useCallback(() => {
    void flowsListTemplates()
      .then(setMine)
      .catch((error: unknown) => pushErrorToast(String(error)));
  }, []);
  useEffect(reload, [reload]);

  const update = (template: FlowTemplateMeta, name: string, description: string) =>
    void flowsUpdateTemplate(template.id, name, description)
      .then(reload)
      .catch((error: unknown) => pushErrorToast(String(error)));

  const menuItems = (template: FlowTemplateMeta): MenuItem[] => [
    {
      label: t("flows.rename"),
      icon: Pencil,
      onClick: () =>
        void promptAction(t("flows.tpl.renamePrompt"), { initial: template.name, confirmLabel: t("flows.rename") }).then(
          (name) => name && update(template, name, template.description),
        ),
    },
    {
      label: t("flows.tpl.describe"),
      icon: FileText,
      onClick: () =>
        void promptAction(t("flows.tpl.describePrompt"), { initial: template.description, allowEmpty: true }).then(
          (description) => description !== null && update(template, template.name, description),
        ),
    },
    {
      label: t("flows.delete"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () =>
        void confirmAction(t("flows.tpl.deleteConfirm", { name: template.name })).then(
          (ok) =>
            ok &&
            void flowsDeleteTemplate(template.id)
              .then(reload)
              .catch((error: unknown) => pushErrorToast(String(error))),
        ),
    },
  ];

  const openMenu = (event: ReactMouseEvent, template: FlowTemplateMeta) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, template });
  };

  return (
    <ApiModal icon={LayoutTemplate} title={t("flows.tpl.title")} width="max-w-2xl" onClose={onClose}>
      <div className="min-h-0 overflow-y-auto px-4 pb-4 pt-1">
        {mine.length > 0 && (
          <>
            <p className={sectionLabelClass}>{t("flows.tpl.mine")}</p>
            <div className="grid grid-cols-2 gap-2">
              {mine.map((template) => (
                <TemplateCard
                  key={template.id}
                  icon={glyph(template.icon)}
                  name={template.name}
                  description={
                    template.description ||
                    (template.nodeCount === 1 ? t("flows.tpl.nodesOne") : t("flows.tpl.nodes", { count: template.nodeCount }))
                  }
                  moreLabel={t("flows.tpl.more")}
                  onUse={() => {
                    onClose();
                    void useFlowsStore.getState().createFromSavedTemplate(template.id, template.name, folderId);
                  }}
                  onMenu={(event) => openMenu(event, template)}
                />
              ))}
            </div>
            <p className={sectionLabelClass}>{t("flows.tpl.builtIn")}</p>
          </>
        )}
        <div className={`grid grid-cols-2 gap-2 ${mine.length > 0 ? "" : "pt-3"}`}>
          {FLOW_TEMPLATES.map((template) => (
            <TemplateCard
              key={template.id}
              icon={glyph(template.icon)}
              name={t(`flows.tpl.${template.id}.name` as TranslationKey)}
              description={t(`flows.tpl.${template.id}.desc` as TranslationKey)}
              onUse={() => {
                onClose();
                void useFlowsStore.getState().createFromTemplate(template.id, folderId);
              }}
            />
          ))}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.template)} onClose={() => setMenu(null)} />}
    </ApiModal>
  );
}

/** One card: a click uses it. With `onMenu` — the user's own templates — a ⋯ on hover and a
 *  right-click open its actions. */
function TemplateCard({
  icon: Icon,
  name,
  description,
  onUse,
  onMenu,
  moreLabel,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  onUse: () => void;
  onMenu?: (event: ReactMouseEvent) => void;
  moreLabel?: string;
}) {
  return (
    <div className="group relative" onContextMenu={onMenu}>
      <button
        type="button"
        className="flex h-full w-full items-start gap-2.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2.5 text-left hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-hover)]"
        onClick={onUse}
      >
        <Icon size={16} className="mt-[2px] shrink-0 text-[var(--cf-text-muted)]" />
        <span className={`min-w-0 ${onMenu ? "pr-5" : ""}`}>
          <span className="block truncate text-[12.5px] font-semibold text-[var(--cf-text)]">{name}</span>
          <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{description}</span>
        </span>
      </button>
      {onMenu && (
        <button
          type="button"
          className={iconButtonClass({
            size: "xs",
            className: "absolute right-1.5 top-1.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
          })}
          title={moreLabel}
          aria-label={moreLabel}
          onClick={onMenu}
        >
          <MoreHorizontal size={13} />
        </button>
      )}
    </div>
  );
}
