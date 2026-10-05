import { LayoutTemplate } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { nodeIcon } from "../../lib/flows/nodeIcons";
import { FLOW_TEMPLATES } from "../../lib/flows/templates";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useFlowsStore } from "../../state/flowsStore";
import { useT } from "../../state/languageStore";

/** The template gallery: one card per template; a click makes the flow and opens it. */
export function TemplatesDialog({ folderId, onClose }: { folderId: string | null; onClose: () => void }) {
  const t = useT();
  const catalogMap = useFlowsStore((s) => s.catalogMap);
  return (
    <ApiModal icon={LayoutTemplate} title={t("flows.tpl.title")} width="max-w-2xl" onClose={onClose}>
      <div className="grid grid-cols-2 gap-2 p-4">
        {FLOW_TEMPLATES.map((template) => {
          const Icon = nodeIcon(catalogMap.get(template.icon)?.icon ?? "workflow");
          return (
            <button
              key={template.id}
              type="button"
              className="flex items-start gap-2.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2.5 text-left hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-hover)]"
              onClick={() => {
                onClose();
                void useFlowsStore.getState().createFromTemplate(template.id, folderId);
              }}
            >
              <Icon size={16} className="mt-[2px] shrink-0 text-[var(--cf-text-muted)]" />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-semibold text-[var(--cf-text)]">{t(`flows.tpl.${template.id}.name` as TranslationKey)}</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(`flows.tpl.${template.id}.desc` as TranslationKey)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </ApiModal>
  );
}
