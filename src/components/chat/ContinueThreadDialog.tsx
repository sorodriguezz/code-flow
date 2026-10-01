import { useEffect, useRef, useState } from "react";
import { Forward } from "lucide-react";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { modelRouteLabel } from "../ai/ModelTag";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { resolveAccount } from "../../lib/aiAccounts";
import { useDialog } from "../../lib/useFocusTrap";
import { useAiAccountsStore } from "../../state/aiAccountsStore";
import { newRunId, useAiRunStore } from "../../state/aiRunStore";
import { useContinueThreadStore, type ThreadEngine } from "../../state/continueThreadStore";
import { useConversationStore } from "../../state/conversationStore";
import { useT } from "../../state/languageStore";

/**
 * "Continuar en un hilo nuevo": the way to go on with another model, since a thread keeps the
 * provider it first answered on.
 *
 * The thread's own engine summarises the whole of it (the user's call: the model that held the
 * conversation knows what in it mattered), and the new thread starts from that summary and nothing
 * else — text only, no file or image comes along. The new one says where it came from at its top
 * (`ContinuedMark`); the two are not otherwise tied, so deleting either leaves the other whole.
 *
 * Opened from the row's menu, from `/continue`, and from a locked provider in the composer's model
 * menu — which arrives with the engine already chosen. While the summary runs the dialog stays, with
 * the orb and a Stop: closing it would leave a turn running that nothing on screen owns.
 */
export function ContinueThreadDialog() {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const request = useContinueThreadStore((s) => s.request);
  const close = useContinueThreadStore((s) => s.close);
  const origin = useConversationStore((s) =>
    request ? (s.conversations.find((c) => c.id === request.conversationId) ?? null) : null,
  );
  const accounts = useAiAccountsStore((s) => s.accounts);
  const taskPins = useAiAccountsStore((s) => s.taskPins);
  const workspaceDefaults = useAiAccountsStore((s) => s.workspaceDefaults);
  const providerDefaults = useAiAccountsStore((s) => s.providerDefaults);

  const [engine, setEngine] = useState<ThreadEngine | null>(null);
  const [guidance, setGuidance] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per request, not per render: each opening starts from what opened it.
  useEffect(() => {
    if (!request) return;
    const from = useConversationStore.getState().conversations.find((c) => c.id === request.conversationId);
    // A thread no longer in the list (deleted from another window meanwhile) has nothing to give.
    if (!from) {
      close();
      return;
    }
    // A version picked with no account gets the one a new chat in this workspace would.
    const picked = request.engine;
    const prefs = useAiAccountsStore.getState();
    setEngine(
      picked
        ? { ...picked, account: picked.account ?? resolveAccount(prefs, picked.provider, "chat", from.workspaceId) }
        : { provider: from.provider, model: from.model, account: from.accountId ?? null },
    );
    setGuidance(request.guidance ?? "");
    setError(null);
    setRunId(null);
  }, [request, close]);

  // No Escape while the summary runs — Stop is the way out of that.
  useDialog(panelRef, request !== null, runId ? null : close);

  if (!request || !origin || !engine) return null;

  const originEngine = modelRouteLabel(origin.provider, origin.model, t);
  const running = runId !== null;

  /** A version picked in the menu. Its account, unless one was picked with it: this thread's when
   *  the provider stays, else the one a new chat in this workspace would get. */
  const pick = (provider: string, model: string, account?: string) => {
    const prefs = { accounts, taskPins, workspaceDefaults, providerDefaults };
    setEngine({
      provider,
      model,
      account: account ?? (provider === engine.provider ? engine.account : resolveAccount(prefs, provider, "chat", origin.workspaceId)),
    });
  };

  const start = async () => {
    if (running) return;
    const id = newRunId("chat");
    setRunId(id);
    setError(null);
    try {
      const created = await useConversationStore.getState().continueInNewThread(origin.id, engine, guidance, id);
      if (created) close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={running ? undefined : close}>
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.continueInNewThread")}
        tabIndex={-1}
        className="cf-fade-in w-[440px] max-w-[92vw] rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]"
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            <Forward size={15} />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-[13px] font-semibold text-[var(--cf-text)]">{t("chat.continueInNewThread")}</p>
            <p className="truncate text-[11.5px] text-[var(--cf-text-muted)]">
              {`«${origin.title || t("chat.untitled")}» · ${originEngine}`}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[11.5px] text-[var(--cf-text-muted)]">{t("chat.continueEngine")}</span>
            {/* Bound to this dialog, not to the routing or to the thread: every provider is open,
                which is the point, and nothing is written until the thread exists. */}
            <div className={`rounded-md border border-[var(--cf-border)] ${running ? "pointer-events-none opacity-60" : ""}`}>
              <ChatModelPicker
                liveModel={null}
                chatActive={false}
                bound={engine}
                onPick={pick}
                className="w-full"
              />
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11.5px] text-[var(--cf-text-muted)]">{t("chat.continueGuidance")}</span>
            <input
              value={guidance}
              disabled={running}
              onChange={(e) => setGuidance(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void start();
                }
              }}
              placeholder={t("chat.continueGuidancePlaceholder")}
              className={fieldClass({ size: "sm", className: "w-full" })}
            />
          </label>
          <p className="text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{t("chat.continueNote", { engine: originEngine })}</p>
          {error && <p className="text-[11.5px] leading-relaxed text-[var(--cf-danger)]">{error}</p>}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          {running ? (
            <>
              <span className="mr-auto flex min-w-0 items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
                <ThinkingOrb size="sm" />
                <span className="truncate">{t("chat.continueRunning", { engine: originEngine })}</span>
              </span>
              <button type="button" onClick={() => runId && void useAiRunStore.getState().cancel(runId)} className={buttonClass({ variant: "ghost" })}>
                {t("chat.stop")}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={close} className={buttonClass({ variant: "ghost" })}>
                {t("common.cancel")}
              </button>
              <button type="button" onClick={() => void start()} className={buttonClass({ variant: "primary" })}>
                {t("chat.continueStart")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
