import { useState } from "react";
import { buttonClass } from "../common/Button";
import { AiSparkles, AiWand } from "../common/AiGlyph";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { ApiModal } from "./ApiModal";
import { useApiStore } from "../../state/apiStore";
import { useApiAiStore } from "../../state/apiAiStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { requestAskForAi } from "../../lib/api/aiPayload";
import { parseDraftedRequest } from "../../lib/api/aiRequest";

const BUSY_KEY = "request";

/**
 * «Crear con IA»: a request written from a sentence («crear un usuario con email inválido»), with the
 * workspace's variables to use (`{{baseUrl}}`). It opens as a scratch tab to read and send — nothing
 * is sent, and nothing the model wrote becomes a script.
 */
export function AiRequestModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [description, setDescription] = useState("");
  const busy = useApiAiStore((s) => !!s.busy[BUSY_KEY]);

  const create = async () => {
    const text = description.trim();
    if (!text || busy) return;
    const store = useApiStore.getState();
    const active = store.openTabs.find((tab) => tab.id === store.activeTabId);
    const ctx = store.variableContext(active?.collectionId ?? null);
    try {
      const answer = await useApiAiStore.getState().run(BUSY_KEY, "request", requestAskForAi(text, [ctx.environment, ctx.collection, ctx.global]), text.slice(0, 80));
      if (answer === null) return;
      const drafted = parseDraftedRequest(answer);
      if (!drafted) {
        pushErrorToast(t("api.ai.requestUnreadable"));
        return;
      }
      const tabId = useApiStore.getState().openScratchTab("http", active?.collectionId ? { collectionId: active.collectionId, folderId: active.folderId } : undefined);
      useApiStore.getState().updateDraft(tabId, { ...drafted.spec, description: text });
      useApiStore.getState().renameTab(tabId, drafted.name);
      onClose();
    } catch (e) {
      pushErrorToast(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <ApiModal
      icon={AiWand}
      title={t("api.ai.requestTitle")}
      subtitle={t("api.ai.requestSubtitle")}
      width="max-w-lg"
      dismissOnBackdrop={!busy && description.trim() === ""}
      onClose={() => {
        if (busy) useApiAiStore.getState().stop(BUSY_KEY);
        onClose();
      }}
      footer={
        <>
          <button type="button" onClick={onClose} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {t("common.cancel")}
          </button>
          <ChatModelPicker
            task="api"
            variant="split"
            liveModel={null}
            chatActive={false}
            title={t("api.ai.requestHint")}
            action={{
              icon: busy ? <ThinkingOrb size="sm" /> : <AiSparkles size={13} />,
              label: t("api.ai.requestCreate"),
              onClick: () => void create(),
              disabled: busy || description.trim() === "",
            }}
          />
        </>
      }
    >
      <div className="p-4">
        <textarea
          autoFocus
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void create();
            }
          }}
          rows={5}
          placeholder={t("api.ai.requestPlaceholder")}
          className="w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-2 text-[13px] leading-5 text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)]"
        />
      </div>
    </ApiModal>
  );
}
