import { useEffect, useState } from "react";
import { Cable } from "lucide-react";
import { agentTransportKey, getSettings, providerCaps, setSetting, type ProviderCaps } from "../../lib/tauri/commands";
import { providerDisplayLabel } from "../../lib/aiProviders";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { Segmented } from "../common/Segmented";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

type Choice = "acp" | "cli";

/** Told when a provider's transport changes: what scripts can do there changes with it
 *  (`provider_caps::scripts_reach`), and «Scripts de CodeFlow» re-reads it. */
export const PROVIDER_CAPS_CHANGED = "codeflow:provider-caps-changed";

/**
 * «Conexión con el agente»: per provider that has an ACP mode (Gemini, Grok, opencode), whether its
 * turns run on an agent server kept open between turns (`src-tauri/src/acp.rs`) or one CLI process
 * per turn. ACP is the default; a server that will not start falls back to the CLI for that turn.
 */
export function AgentTransportSettings() {
  const t = useT();
  const [caps, setCaps] = useState<ProviderCaps[] | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const all = (await providerCaps()).filter((c) => c.acp);
        const saved = await getSettings(all.map((c) => agentTransportKey(c.id)));
        if (!live) return;
        setCaps(all);
        setChoices(Object.fromEntries(all.map((c) => [c.id, saved[agentTransportKey(c.id)] === "cli" ? "cli" : "acp"])));
      } catch {
        if (live) setCaps([]);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (!caps || caps.length === 0) return null;

  const choose = (id: string, next: Choice) => {
    const before = choices[id];
    setChoices((all) => ({ ...all, [id]: next }));
    void setSetting(agentTransportKey(id), next)
      .then(() => window.dispatchEvent(new Event(PROVIDER_CAPS_CHANGED)))
      .catch((error: unknown) => {
        setChoices((all) => ({ ...all, [id]: before }));
        pushErrorToast(String(error));
      });
  };

  return (
    <section aria-labelledby="agent-transport-title" className="space-y-2 rounded-xl bg-[var(--cf-surface)] p-3 shadow-[inset_0_0_0_1px_var(--cf-border)]">
      <div className="flex items-start gap-2">
        <span className="mt-[1px] flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_oklab,var(--cf-accent)_13%,transparent)] text-[var(--cf-accent)]">
          <Cable size={13} aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 id="agent-transport-title" className="text-[12.5px] font-medium text-[var(--cf-text)]">
            {t("settings.agentTransportTitle")}
          </h3>
          <p className="mt-0.5 max-w-[68ch] text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("settings.agentTransportHint")}</p>
        </div>
      </div>
      <ul className="divide-y divide-[var(--cf-border)] overflow-hidden rounded-lg bg-[var(--cf-surface-raised)] shadow-[inset_0_0_0_1px_var(--cf-border)]">
        {caps.map((cap) => {
          const name = providerDisplayLabel(cap.id, t) || cap.label;
          return (
            <li key={cap.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <ProviderGlyph providerId={cap.id} size={14} className="text-[var(--cf-text-muted)]" />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] text-[var(--cf-text)]">{name}</span>
                  {cap.id === "grok" && (
                    <span className="block text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("settings.agentTransportGrokHint")}</span>
                  )}
                </span>
              </span>
              <Segmented<Choice>
                size="sm"
                layoutId={`agent-transport-${cap.id}`}
                ariaLabel={`${t("settings.agentTransportTitle")} · ${name}`}
                value={choices[cap.id] ?? "acp"}
                onChange={(next) => choose(cap.id, next)}
                options={[
                  { value: "acp", label: t("settings.agentTransportAcp") },
                  { value: "cli", label: t("settings.agentTransportCli") },
                ]}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
