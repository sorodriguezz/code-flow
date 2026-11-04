/**
 * The models an engine offers, as the settings' picker lists them (fetched when there is a list,
 * the curated catalogue otherwise), labelled for this view.
 */
import { useEffect, useMemo } from "react";
import { useAiModelsStore } from "../../../state/aiModelsStore";
import { useT } from "../../../state/languageStore";
import { modelOptionsFor } from "../../settings/modelPicker";

export function useModelOptions(provider: string): { id: string; label: string; legacy: boolean }[] {
  const t = useT();
  const byProvider = useAiModelsStore((s) => s.byProvider);
  const ensure = useAiModelsStore((s) => s.ensure);
  useEffect(() => {
    if (provider) void ensure([provider]);
  }, [provider, ensure]);
  return useMemo(
    () =>
      provider
        ? modelOptionsFor(provider, byProvider[provider]).map((o) => ({
            id: o.id,
            label: o.label ?? (o.labelKey ? t(o.labelKey) : o.id),
            legacy: Boolean(o.legacy),
          }))
        : [],
    [provider, byProvider, t],
  );
}
