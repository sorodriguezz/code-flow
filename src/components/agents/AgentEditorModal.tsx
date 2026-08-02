import { useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { CUSTOM_MODEL, Field, ModelField, customModelPlaceholder, modelOptionsFor, parseModel } from "../settings/modelPicker";
import { upsertWorkspaceAgent } from "../../lib/tauri/commands";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { useAgentsStore } from "../../state/agentsStore";
import { useAiModelsStore } from "../../state/aiModelsStore";
import { useT } from "../../state/languageStore";
import type { WorkspaceAgent } from "../../types/domain";

/**
 * Create or edit one agent.
 *
 * The reason this exists rather than deep-linking to Settings → SDD is the model field. There the
 * model is a free-text input — the one model surface in the app that isn't — and a typo, or a
 * blank, produces an agent that still *runs*: the backend only honours an agent's routing when
 * both its provider and its model are set, and otherwise falls back to the ordinary chat routing.
 * The result is a role that quietly answers on a different engine than the one it names. Here the
 * model comes from the same picker every other engine setting uses, with the hand-typed escape
 * hatch remembered for next time.
 */
export function AgentEditorModal({
  workspaceId,
  agent,
  onClose,
}: {
  workspaceId: string;
  /** `null` creates a new one. */
  agent: WorkspaceAgent | null;
  onClose: () => void;
}) {
  const t = useT();
  const modelsByProvider = useAiModelsStore((s) => s.byProvider);
  const ensureModels = useAiModelsStore((s) => s.ensure);
  const rememberModel = useAiModelsStore((s) => s.remember);

  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "");
  const [provider, setProvider] = useState(agent?.provider ?? "");
  const [prompt, setPrompt] = useState(agent?.prompt ?? "");
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const options = useMemo(
    () => (provider ? modelOptionsFor(provider, modelsByProvider[provider]) : []),
    [provider, modelsByProvider],
  );
  const [model, setModel] = useState(() => parseModel(agent?.model, []));

  useEffect(() => {
    if (provider) void ensureModels([provider]);
  }, [provider, ensureModels]);

  // The stored id can only be classified once this provider's option list has arrived: before it
  // does, a perfectly real model looks "custom". Re-derived when the list lands.
  useEffect(() => {
    setModel((current) =>
      current.choice === CUSTOM_MODEL && options.some((o) => o.id === current.custom)
        ? { choice: current.custom, custom: "" }
        : current,
    );
  }, [options]);

  const resolvedModel = model.choice === CUSTOM_MODEL ? model.custom.trim() : model.choice;
  const incomplete = provider.trim() === "" || resolvedModel === "";

  const save = async () => {
    setSaving(true);
    try {
      if (model.choice === CUSTOM_MODEL && resolvedModel) await rememberModel(provider, resolvedModel);
      await upsertWorkspaceAgent(
        agent?.id,
        workspaceId,
        name.trim() || t("settings.sddNewAgent"),
        role.trim(),
        provider,
        resolvedModel,
        prompt,
        enabled,
      );
      await useAgentsStore.getState().reloadRoster();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ApiModal
      icon={Bot}
      title={t(agent ? "agents.editAgent" : "agents.newAgent")}
      subtitle={t("agents.rosterHint")}
      width="max-w-lg"
      busy={saving}
      // A form holding unsaved input has nothing to recover from a mis-click on the backdrop.
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <label className="mr-auto flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
            <Checkbox checked={enabled} onChange={setEnabled} />
            {t("settings.enabled")}
          </label>
          <GhostButton onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </GhostButton>
          <PrimaryButton onClick={() => void save()} disabled={saving}>
            {t("common.save")}
          </PrimaryButton>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {incomplete && <Note tone="warning">{t("agents.agentIncomplete")}</Note>}

        <Field label={t("agents.fieldName")}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("settings.sddAgentNamePlaceholder")}
            className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[13px] font-medium outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>

        <Field label={t("agents.fieldRole")}>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder={t("settings.sddAgentRolePlaceholder")}
            className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("agents.fieldProvider")}>
            <Select
              size="field"
              value={provider}
              onChange={(value) => {
                setProvider(value);
                // The previous id means nothing to a different engine, so the field starts over.
                setModel({ choice: "", custom: "" });
              }}
              options={[
                { value: "", label: t("settings.sddAgentProviderDefault") },
                ...AI_PROVIDERS.filter((p) => p.available).map((p) => ({
                  value: p.id,
                  label: p.label ?? (p.labelKey ? t(p.labelKey) : p.id),
                  icon: p.icon,
                })),
              ]}
            />
          </Field>

          <Field label={t("agents.model")}>
            <ModelField
              size="field"
              options={options}
              choice={model.choice}
              custom={model.custom}
              // Not "the CLI's default": for an agent, leaving the model blank is the one setting
              // that makes the backend ignore the agent's routing entirely, so the option has to
              // say what it actually does rather than read as a recommendation.
              defaultLabel={t("agents.modelUnset")}
              customPlaceholder={customModelPlaceholder(provider, t("settings.sddAgentModelPlaceholder"))}
              onChoice={(choice) => setModel((current) => ({ ...current, choice }))}
              onCustom={(custom) => setModel((current) => ({ ...current, custom }))}
            />
          </Field>
        </div>

        <Field label={t("agents.fieldInstructions")}>
          <textarea
            value={prompt}
            rows={8}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("settings.sddAgentPromptPlaceholder")}
            className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>
      </div>
    </ApiModal>
  );
}
