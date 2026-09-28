import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { ContextMenu, type MenuItem } from "../../common/ContextMenu";
import { notebookActions, useNotebookStore, type KernelStatus } from "../../../state/notebookStore";
import { KernelDot, STATUS_LABEL } from "./kernelStatus";
import { useTerminalStore } from "../../../state/terminalStore";
import { confirmAction } from "../../../state/confirmStore";
import { useT, type Translate } from "../../../state/languageStore";
import { currentPlatform } from "../../../lib/platform";
import { installCommand } from "../../../lib/notebook/install";

/**
 * "Install ipykernel": asks first — naming the interpreter and the exact command — and only then
 * types the command into a terminal of the dock, in the notebook's folder. Nothing is installed
 * without that answer.
 */
export async function installIpykernel(projectId: string, cwd: string, python: string, t: Translate): Promise<void> {
  const command = installCommand(python, currentPlatform() === "windows");
  const ok = await confirmAction(t("notebook.kernel.installConfirm", { python, command }), false, t("notebook.kernel.installGo"));
  if (!ok) return;
  await useTerminalStore.getState().runCommand(projectId, {
    cwd,
    command,
    reuseKey: `notebook-ipykernel:${python}`,
    title: "ipykernel",
  });
}

/**
 * Which kernel the notebook runs on, and how it is doing — the chip at the right of the notebook's
 * toolbar. Its menu lists what `discover` found (re-read every time it opens: a kernel installed a
 * minute ago should be there), the kernel's own actions, and, for a Python without ipykernel, the
 * install — asked first, naming the interpreter and the command.
 */
export function KernelPicker({ sessionKey, projectId, notebookDir }: { sessionKey: string; projectId: string; notebookDir: string }) {
  const t = useT();
  const session = useNotebookStore((s) => s.sessions[sessionKey]);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!session) return null;
  const kernel = session.kernel;
  const status: KernelStatus | "none" = kernel?.status ?? "none";
  const kernels = session.discovery?.kernels ?? [];
  const chosen = kernel?.choice ?? kernels.find((k) => k.id === session.choiceId) ?? null;
  const label = chosen?.displayName ?? t("notebook.kernel.pick");

  const items: MenuItem[] = [];
  for (const choice of kernels) {
    items.push({
      label: choice.displayName,
      leading: (
        <span className="flex w-3.5 shrink-0 justify-center">{chosen?.id === choice.id && <Check size={13} />}</span>
      ),
      onClick: () => void notebookActions.chooseKernel(sessionKey, choice.id),
    });
  }
  if (kernels.length === 0) {
    items.push({
      label: session.discovering ? t("notebook.kernel.searching") : t("notebook.kernel.noneFound"),
      onClick: () => {},
      disabled: true,
    });
  }
  (session.discovery?.withoutIpykernel ?? []).forEach((candidate, index) => {
    items.push({
      label: t("notebook.kernel.install", {
        where: `${candidate.label}${candidate.version ? ` · Python ${candidate.version}` : ""}`,
      }),
      separated: index === 0,
      onClick: () => void installIpykernel(projectId, notebookDir, candidate.path, t),
    });
  });
  items.push({
    label: t("notebook.kernel.refresh"),
    separated: true,
    onClick: () => void notebookActions.discover(sessionKey, true),
  });
  if (kernel && kernel.status !== "dead") {
    items.push(
      { label: t("notebook.interrupt"), separated: true, onClick: () => void notebookActions.interrupt(sessionKey) },
      { label: t("notebook.restart"), onClick: () => void notebookActions.restart(sessionKey, false) },
      { label: t("notebook.shutdown"), danger: true, onClick: () => void notebookActions.shutdown(sessionKey) },
    );
  }

  return (
    <>
      <button
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor((open) => (open ? null : rect));
          if (!anchor) void notebookActions.discover(sessionKey, true);
        }}
        title={`${label} · ${t(STATUS_LABEL[status])}`}
        aria-haspopup="menu"
        className="flex h-6 min-w-0 max-w-[260px] items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 text-[11.5px] text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
      >
        <KernelDot status={status} />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
      </button>
      {anchor && (
        <ContextMenu
          x={anchor.left}
          y={anchor.bottom}
          heading={t("notebook.kernel.heading")}
          items={items}
          anchor={{ top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right, align: "end" }}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
