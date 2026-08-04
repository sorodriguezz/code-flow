import { Bookmark, Pencil, Play, Trash2 } from "lucide-react";
import { useAgentsStore } from "../../state/agentsStore";
import { useChainStore } from "../../state/chainStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

/**
 * One saved plan, open: the steps it will copy into a chain, in order.
 *
 * Read-only on purpose. A template is edited where a chain is authored — the same dialog, the same
 * agent pickers, the same gate checkboxes — because a second editor for the same six fields is a
 * second place for the two to disagree about what a step is. This pane's job is to answer "what is
 * in this one?" without starting anything, which is the question you bring to a list of five plans.
 *
 * The agents are resolved against the **current** roster rather than shown as they were saved: a
 * template names its agents by id and never snapshots their routing, so a step whose agent has since
 * been deleted is a hole the user has to fill before this plan can run, and saying so here is
 * cheaper than finding out in the authoring dialog.
 */
export function TemplateDetail({
  templateId,
  onUse,
}: {
  templateId: string;
  /** Opens the authoring dialog with this plan loaded — the one path to both running and editing it. */
  onUse: (templateId: string) => void;
}) {
  const t = useT();
  const template = useChainStore((s) => s.templates.find((candidate) => candidate.id === templateId) ?? null);
  const roster = useAgentsStore((s) => s.roster);

  if (!template) return null;

  const remove = () => {
    void confirmAction(t("agents.deleteTemplateConfirm", { name: template.name })).then((ok) => {
      if (!ok) return;
      // Cleared first: the pane is about to have nothing to draw, and leaving the selection behind
      // would put an empty middle column next to a row that is no longer in the list.
      useChainStore.getState().selectTemplate(null);
      void useChainStore.getState().removeTemplate(template.id);
    });
  };

  return (
    <>
      {/* Same 29px as the rails either side — see the note on the task header. */}
      <div className="flex h-[29px] shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        <Bookmark size={14} className="shrink-0 text-[var(--cf-accent)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={template.description || template.name}>
          {template.name}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
          {t("agents.templateStepsN", { n: template.steps.length })}
        </span>
      </div>

      <p className="shrink-0 border-b border-[var(--cf-border)] px-3 py-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
        {t("agents.templateDetailSubtitle")}
      </p>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {template.description.trim() !== "" && (
          <p className="whitespace-pre-wrap rounded-lg border border-dashed border-[var(--cf-border)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
            {template.description}
          </p>
        )}

        {template.steps.map((step, index) => {
          const agent = roster.find((candidate) => candidate.id === step.agent_id) ?? null;
          return (
            <div key={step.id} className="rounded-lg border border-[var(--cf-border)] px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-[10px] font-semibold tabular-nums dark:bg-white/[0.1]">
                  {index + 1}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate text-[12.5px] ${
                    agent ? "text-[var(--cf-text)]" : "text-[var(--cf-warning)]"
                  }`}
                >
                  {agent?.name || t("agents.templateAgentGone")}
                </span>
                {step.gate && (
                  <span className="shrink-0 rounded bg-black/[0.05] px-1.5 py-[1px] text-[10px] text-[var(--cf-text-muted)] dark:bg-white/[0.07]">
                    {t("agents.gateBefore")}
                  </span>
                )}
              </div>
              {step.instruction.trim() !== "" && (
                <p className="mt-1.5 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]">
                  {step.instruction}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-[var(--cf-border)] px-3 py-2">
        <Action primary icon={Play} label={t("agents.useTemplate")} onClick={() => onUse(template.id)} />
        <Action icon={Pencil} label={t("agents.editTemplate")} onClick={() => onUse(template.id)} />
        <span className="ml-auto">
          <Action danger icon={Trash2} label={t("agents.deleteTemplate")} onClick={remove} />
        </span>
      </div>
    </>
  );
}

/** The same button `ChainDetail` puts in its action bar. Kept local to each pane rather than shared:
 * they are two rows of controls that happen to look alike, and the day one of them grows a busy
 * state is the day a shared one would have to grow a prop for it. */
function Action({
  icon: Icon,
  label,
  onClick,
  primary,
  danger,
}: {
  icon: typeof Play;
  label: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium ${
        primary
          ? "bg-[var(--cf-accent)] text-white hover:brightness-110"
          : danger
            ? "border border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
            : "border border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      }`}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}
