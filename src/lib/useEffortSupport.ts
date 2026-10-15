import { useEffect } from "react";
import { chatEffortSupport } from "./tauri/chatCommands";
import { effortKey, useConversationStore } from "../state/conversationStore";

let providersAsked = false;

/**
 * Whether `provider` + `model` take a thinking level — the same two-part answer the chat
 * workspace's composer reads (which CLIs accept the flag at all, and whether the model it is aimed at
 * would read it), for a composer that can mount before the chat workspace ever has. Unknown reads as
 * yes, as there.
 */
export function useEffortSupported(provider: string, model: string): boolean {
  const providers = useConversationStore((s) => s.effortProviders);
  const byModel = useConversationStore((s) => s.effortByModel);
  const ensure = useConversationStore((s) => s.ensureEffortSupport);
  useEffect(() => {
    if (providersAsked || providers.length > 0) return;
    providersAsked = true;
    void chatEffortSupport().then(
      (effortProviders) => useConversationStore.setState({ effortProviders }),
      () => {
        providersAsked = false;
      },
    );
  }, [providers.length]);
  useEffect(() => {
    if (providers.includes(provider)) ensure(provider, model);
  }, [providers, provider, model, ensure]);
  return providers.includes(provider) && (byModel[effortKey(provider, model)] ?? true);
}
