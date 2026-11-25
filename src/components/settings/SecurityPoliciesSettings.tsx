import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { fieldClass } from "../common/recipes";
import { POLICY_RULES, samePolicy } from "../containers/sandboxModel";
import { containersCosignDetect, containersPolicyGet, containersPolicyReset, containersPolicySave } from "../../lib/tauri/containersSandboxCommands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { SecurityPolicy, StoredPolicy } from "../../types/containersSandbox";

const DEFAULT_IMAGE = "mcr.microsoft.com/devcontainers/base:bookworm";

/**
 * «Políticas de seguridad»: what a container may be, per workspace with a global default — the rules
 * the agent sandboxes are held to (a hard block), the Flows container nodes when the policy says so,
 * and what the Run container dialog warns about. One editor for both scopes: the open workspace's
 * own policy, or the default every workspace without one follows.
 */
export function SecurityPoliciesSettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.name ?? "");
  const [scope, setScope] = useState<"workspace" | "default">(workspaceId ? "workspace" : "default");
  const target = scope === "workspace" && workspaceId ? workspaceId : "";
  const [stored, setStored] = useState<StoredPolicy | null>(null);
  const [draft, setDraft] = useState<SecurityPolicy | null>(null);
  const [cosign, setCosign] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setStored(null);
    void containersPolicyGet(target)
      .then((found) => {
        if (!live) return;
        setStored(found);
        setDraft(found.policy);
      })
      .catch((e) => pushErrorToast(String(e)));
    return () => {
      live = false;
    };
  }, [target]);

  useEffect(() => {
    void containersCosignDetect().then(setCosign).catch(() => setCosign(null));
  }, []);

  const set = (patch: Partial<SecurityPolicy>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const dirty = !!stored && !!draft && !samePolicy(stored.policy, draft);
  // Saving a workspace that follows the default gives it a policy of its own, even unchanged.
  const canSave = !!draft && !saving && (dirty || (scope === "workspace" && stored?.source !== "own"));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const next = await containersPolicySave(target, draft);
      setStored(next);
      setDraft(next.policy);
      pushSuccessToast(t("settings.policies.saved"));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      const next = await containersPolicyReset(target);
      setStored(next);
      setDraft(next.policy);
      pushSuccessToast(t("settings.policies.resetDone"));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };

  const chooseKey = async () => {
    const picked = await openDialog({ multiple: false, directory: false, filters: [{ name: "cosign", extensions: ["pub", "pem", "key"] }] }).catch(() => null);
    if (typeof picked === "string") set({ signingKey: picked });
  };

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <p className="text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{t("settings.policies.intro")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.policies.scope")}</span>
        <Segmented
          size="sm"
          value={scope}
          onChange={setScope}
          layoutId="policy-scope"
          options={[
            { value: "workspace", label: t("settings.policies.scope.workspace", { name: workspaceName || "—" }), disabled: !workspaceId },
            { value: "default", label: t("settings.policies.scope.default") },
          ]}
        />
      </div>
      {!workspaceId && <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("settings.policies.noWorkspace")}</p>}
      {!stored || !draft ? (
        <Loader2 size={14} className="animate-spin text-[var(--cf-text-muted)]" />
      ) : (
        <>
          {(scope === "workspace" || stored.source === "builtIn") && <p className="text-[11.5px] text-[var(--cf-text-faint)]">{t(`settings.policies.source.${stored.source}`)}</p>}
          <ul className="flex flex-col divide-y divide-[var(--cf-border)] rounded-[10px] border border-[var(--cf-border)]">
            {POLICY_RULES.map((rule) => (
              <li key={rule} className="flex items-start gap-2.5 px-3 py-2.5">
                <span className="mt-[2px]">
                  <Checkbox checked={draft[rule]} onChange={(checked) => set({ [rule]: checked } as Partial<SecurityPolicy>)} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium text-[var(--cf-text)]">{t(`settings.policies.rule.${rule}`)}</span>
                  <span className="block text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(`settings.policies.hint.${rule}`)}</span>
                  {rule === "requireSigned" && draft.requireSigned && (
                    <span className="mt-2 flex flex-col gap-1.5">
                      <span className={`flex items-center gap-1.5 text-[11.5px] ${cosign ? "text-[var(--cf-success)]" : "text-[var(--cf-warning)]"}`}>
                        {cosign ? <CheckCircle2 size={12} /> : <TriangleAlert size={12} />}
                        {cosign === undefined ? "…" : cosign ? t("settings.policies.cosignFound", { path: cosign }) : t("settings.policies.cosignMissing")}
                      </span>
                      <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t("settings.policies.signingKey")}</span>
                      <span className="flex items-center gap-1.5">
                        <input value={draft.signingKey} onChange={(e) => set({ signingKey: e.target.value })} placeholder="/path/to/cosign.pub" spellCheck={false} className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono" })} />
                        <Button size="sm" variant="secondary" onClick={() => void chooseKey()}>
                          {t("settings.policies.chooseKey")}
                        </Button>
                      </span>
                      <span className="text-[11px] text-[var(--cf-text-faint)]">{t("settings.policies.signingKeyHint")}</span>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-[var(--cf-text)]">{t("settings.policies.sandboxImage")}</span>
            <input value={draft.sandboxImage} onChange={(e) => set({ sandboxImage: e.target.value })} placeholder={DEFAULT_IMAGE} spellCheck={false} className={fieldClass({ size: "sm", className: "font-mono" })} />
            <span className="text-[11px] text-[var(--cf-text-faint)]">{t("settings.policies.sandboxImageHint", { image: DEFAULT_IMAGE })}</span>
          </label>
          <div className="flex items-center gap-2">
            <Button size="md" variant="primary" onClick={() => void save()} disabled={!canSave}>
              {saving && <Loader2 size={12} className="animate-spin" />}
              {t("settings.policies.save")}
            </Button>
            {((scope === "workspace" && stored.source === "own") || (scope === "default" && stored.source !== "builtIn")) && (
              <Button size="md" variant="ghost" onClick={() => void reset()} disabled={saving}>
                {scope === "workspace" ? t("settings.policies.reset") : t("settings.policies.resetBuiltIn")}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
