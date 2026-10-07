import { useEffect, useRef, useState } from "react";
import { Sparkles, Workflow } from "lucide-react";
import { ContextMenu } from "../common/ContextMenu";
import { flowsChatAssistants, type FlowChatAssistant } from "../../lib/tauri/flowsCommands";
import { useConversationStore } from "../../state/conversationStore";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

/**
 * The flows that answer in the Chat («Asistente del Chat» triggers of active flows), beside the
 * model chip. Picking one points the conversation at it (`provider: "flow"`, `model: <flow id>`);
 * while one answers, the chip names it. Drawn only when there is at least one to pick, or the
 * conversation is already on one.
 */
export function FlowAssistantPicker({
  provider,
  model,
  locked,
  onPick,
  onLeave,
  onLocked,
}: {
  provider: string;
  model: string;
  /** The thread already answered on an engine: a flow picked now opens a new chat on it, the way a
   *  locked provider does in the model chip. */
  locked: boolean;
  onPick: (provider: string, model: string) => void | Promise<void>;
  /** Back to the model, where nothing else offers it: the empty state's model chip writes the
   *  routing, which a held flow pick would otherwise outrank. */
  onLeave?: () => void;
  /** Where a flow picked on a `locked` thread goes: a new chat on it. Without it one is created on
   *  the spot (the quick-ask window, which has no empty state to hold the pick on). */
  onLocked?: (flowId: string) => void;
}) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [assistants, setAssistants] = useState<FlowChatAssistant[]>([]);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    const load = () =>
      void flowsChatAssistants(workspaceId)
        .then((list) => alive && setAssistants(list))
        .catch(() => alive && setAssistants([]));
    load();
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen("flows:triggers", load).then((unlisten) => (stop = unlisten)));
    return () => {
      alive = false;
      stop?.();
    };
  }, [workspaceId]);
  const onFlow = provider === "flow";
  const current = onFlow ? assistants.find((assistant) => assistant.flowId === model) : undefined;
  if (assistants.length === 0 && !onFlow) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        title={current ? `${current.name} — ${current.description}` : t("chat.flowAssistants")}
        aria-label={t("chat.flowAssistants")}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect();
          if (rect) setMenu(rect);
        }}
        className={`inline-flex h-6 min-w-0 max-w-[14rem] items-center gap-1 rounded-full border px-2 text-[11.5px] transition-colors ${
          onFlow
            ? "border-[var(--cf-accent)] text-[var(--cf-text)]"
            : "border-transparent text-[var(--cf-text-muted)] hover:border-[var(--cf-border)] hover:text-[var(--cf-text)]"
        }`}
      >
        <Workflow size={12} className="shrink-0" />
        {onFlow && <span className="min-w-0 truncate">{current?.name ?? t("chat.flowGone")}</span>}
      </button>
      {menu && (
        <ContextMenu
          x={menu.left}
          y={menu.top}
          anchor={{ top: menu.top, bottom: menu.bottom, left: menu.left, right: menu.right }}
          heading={t("chat.flowAssistants")}
          items={[
            ...assistants.map((assistant) => ({
              label: assistant.name,
              icon: Workflow,
              onClick: () =>
                locked
                  ? onLocked
                    ? onLocked(assistant.flowId)
                    : void useConversationStore.getState().create(null, "flow", assistant.flowId)
                  : void onPick("flow", assistant.flowId),
            })),
            ...(onFlow && onLeave ? [{ label: t("chat.flowLeave"), icon: Sparkles, separated: true, onClick: onLeave }] : []),
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
