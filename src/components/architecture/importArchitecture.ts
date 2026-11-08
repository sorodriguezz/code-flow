import { open } from "@tauri-apps/plugin-dialog";
import { parseArchText } from "../../lib/architecture/parse";
import type { TranslationKey } from "../../lib/i18n/translations";
import { diagramsReadImport } from "../../lib/tauri/diagramsCommands";
import { useArchitectureStore } from "../../state/architectureStore";
import type { Translate } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";

export async function importArchitecture(t: Translate) {
  const workspaceId = useArchitectureStore.getState().workspaceId;
  try {
    const picked = await open({ multiple: false, filters: [{ name: t("tabbar.architecture"), extensions: ["json", "jsonc"] }] });
    if (typeof picked !== "string") return;
    const text = await diagramsReadImport(picked);
    const parsed = parseArchText(text);
    if (!parsed.ok) {
      pushErrorToast(t("arch.importInvalid", { reason: t(`arch.parse.${parsed.error.code}` as TranslationKey) }));
      return;
    }
    const store = useArchitectureStore.getState();
    if (store.workspaceId !== workspaceId) return;
    const name = (picked.split(/[\\/]/).pop() ?? "").replace(/(\.arch)?\.jsonc?$/i, "");
    await store.importText(text, parsed.doc.meta?.title || name);
  } catch (error) {
    pushErrorToast(String(error));
  }
}
