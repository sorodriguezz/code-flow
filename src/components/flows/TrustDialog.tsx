import { useEffect, useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Button } from "../common/Button";
import { EXECUTABLE_TYPES, flowsGetFlow } from "../../lib/tauri/flowsCommands";
import type { FlowNodeSpec as FlowNode, FlowSpec } from "../../lib/flows/spec";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useFlowRunsStore } from "../../state/flowRunsStore";
import { useFlowsStore } from "../../state/flowsStore";
import { useT } from "../../state/languageStore";

/** A parameter's value as the review shows it: text as written, anything else as JSON. */
function shown(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/** Parameters worth reading in a review — the empty ones say nothing. */
function lines(node: FlowNode): [string, string][] {
  return Object.entries(node.params ?? {})
    .filter(([, value]) => value !== "" && value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0))
    .map(([name, value]) => [name, shown(value)]);
}

/**
 * The review a flow nobody here wrote gets before it may run: every node that runs code or commands,
 * with what it would run. Accepting trusts exactly that (the saved document's hash) — a later change
 * from outside the editor asks again. Opened by a manual run that was refused (`untrusted`), or from
 * the chip in the editor's header.
 */
export function TrustDialog() {
  const t = useT();
  const prompt = useFlowRunsStore((s) => s.trustPrompt);
  const draft = useFlowsStore((s) => s.draft);
  const flows = useFlowsStore((s) => s.flows);
  const catalogMap = useFlowsStore((s) => s.catalogMap);
  const [fetched, setFetched] = useState<FlowSpec | null>(null);
  const [busy, setBusy] = useState(false);

  const flowId = prompt?.flowId ?? null;
  const open = draft && draft.id === flowId ? draft.spec : fetched;
  useEffect(() => {
    setFetched(null);
    if (!flowId || draft?.id === flowId) return;
    let alive = true;
    void flowsGetFlow(flowId).then((row) => {
      if (!alive || !row) return;
      try {
        setFetched(JSON.parse(row.spec) as FlowSpec);
      } catch {
        // An unreadable document has nothing to show; the dialog says nothing runs.
      }
    });
    return () => {
      alive = false;
    };
  }, [flowId, draft?.id]);

  const nodes = useMemo(() => (open?.nodes ?? []).filter((node) => EXECUTABLE_TYPES.has(node.type)), [open]);
  if (!prompt) return null;
  const meta = flows.find((flow) => flow.id === prompt.flowId);
  const close = () => useFlowRunsStore.getState().askTrust(null);
  const accept = async () => {
    setBusy(true);
    const trusted = await useFlowsStore.getState().trust(prompt.flowId);
    setBusy(false);
    if (!trusted) return;
    close();
    if (prompt.then) void useFlowRunsStore.getState().start(prompt.flowId, prompt.then.mode, prompt.then.trigger, prompt.then.input ?? undefined);
  };

  return (
    <ApiModal
      icon={ShieldAlert}
      title={t("flows.trust.title", { name: meta?.name ?? "" })}
      subtitle={t("flows.trust.subtitle")}
      width="max-w-2xl"
      onClose={close}
      busy={busy}
      footer={
        <>
          <span className="flex-1" />
          <Button size="sm" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void accept()}>
            {prompt.then ? t("flows.trust.acceptAndRun") : t("flows.trust.accept")}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[56vh] flex-col gap-3 overflow-y-auto p-4">
        {nodes.map((node) => (
          <section key={node.id} className="rounded-lg border border-[var(--cf-border)]">
            <header className={`flex items-baseline gap-2 px-3 py-1.5 ${lines(node).length > 0 ? "border-b border-[var(--cf-border)]" : ""}`}>
              <span className="text-[12.5px] font-semibold">{node.name}</span>
              <span className="text-[11.5px] text-[var(--cf-text-muted)]">
                {catalogMap.get(node.type) ? t(`flows.node.${node.type}` as TranslationKey) : node.type}
              </span>
              {node.disabled && <span className="text-[11px] text-[var(--cf-text-faint)]">{t("flows.trust.disabled")}</span>}
            </header>
            {lines(node).length > 0 && (
              <dl className="flex flex-col gap-1 px-3 py-2">
                {lines(node).map(([name, value]) => (
                  <div key={name} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                    <dt className="truncate text-[11.5px] text-[var(--cf-text-muted)]">{name}</dt>
                    <dd className="m-0 whitespace-pre-wrap break-words font-mono text-[11.5px] text-[var(--cf-text)]">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        ))}
      </div>
    </ApiModal>
  );
}
