import { ArrowRight } from "lucide-react";
import { showMainWindow } from "../../lib/tauri/windows";
import { sendTo } from "../../lib/windowBus";
import { isMainWindow, MAIN_LABEL } from "../../lib/windowIdentity";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { useUiStore } from "../../state/uiStore";

export function openToolInstallations(tool?: string) {
  if (isMainWindow()) {
    const ui = useUiStore.getState();
    if (tool) ui.openSettingsAt("installations", tool);
    else ui.openSettings("installations");
    return;
  }

  void showMainWindow()
    .catch(() => {})
    .then(() => sendTo(MAIN_LABEL, { kind: "open-settings", to: MAIN_LABEL, section: "installations", tab: tool ?? "" }))
    .catch((error) => pushErrorToast(String(error)));
}

export function ToolInstallationLink({ tool, onOpen }: { tool: string; onOpen?: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => {
        onOpen?.();
        openToolInstallations(tool);
      }}
      className="inline-flex shrink-0 items-center gap-1 text-left text-[12px] text-[var(--cf-accent)] hover:underline"
    >
      {t("installations.open")}
      <ArrowRight size={12} />
    </button>
  );
}
