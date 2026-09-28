import { LoaderCircle } from "lucide-react";
import { useNotebookStore, type KernelStatus } from "../../../state/notebookStore";
import { useT } from "../../../state/languageStore";
import type { TranslationKey } from "../../../lib/i18n/translations";

/**
 * The kernel's state as the notebook's chip and the Editor's status line show it. Its own small
 * module so the status line — which is in the editor's chunk — does not pull the notebook view in.
 */

export const STATUS_LABEL: Record<KernelStatus | "none", TranslationKey> = {
  none: "notebook.kernel.none",
  starting: "notebook.kernel.starting",
  idle: "notebook.kernel.idle",
  busy: "notebook.kernel.busy",
  restarting: "notebook.kernel.restarting",
  unresponsive: "notebook.kernel.unresponsive",
  dead: "notebook.kernel.dead",
};

/** Green idle, amber busy, red dead, and a plain spinner while a process starts — starting a
 *  process is not a model thinking, so no orb here. */
export function KernelDot({ status }: { status: KernelStatus | "none" }) {
  if (status === "starting" || status === "restarting") {
    return <LoaderCircle size={11} className="shrink-0 animate-spin text-[var(--cf-text-muted)]" />;
  }
  const color =
    status === "idle"
      ? "bg-[var(--cf-success)]"
      : status === "busy"
        ? "animate-pulse bg-[var(--cf-warning)]"
        : status === "dead" || status === "unresponsive"
          ? "bg-[var(--cf-danger)]"
          : "border border-[var(--cf-text-muted)] bg-transparent";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

/** The focused notebook's kernel, for the Editor's status line. Draws nothing for anything else. */
export function NotebookStatusItem() {
  const t = useT();
  const session = useNotebookStore((s) => (s.focusedKey ? s.sessions[s.focusedKey] : undefined));
  const mode = useNotebookStore((s) => (s.focusedKey ? (s.modes[s.focusedKey] ?? "notebook") : "notebook"));
  if (!session || mode !== "notebook") return null;
  const kernel = session.kernel;
  const status: KernelStatus | "none" = kernel?.status ?? "none";
  const chosen = kernel?.choice ?? session.discovery?.kernels.find((k) => k.id === session.choiceId) ?? null;
  const running = Object.keys(session.runs).length;
  return (
    <span
      className="flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap px-1.5"
      title={chosen ? `${chosen.displayName} · ${t(STATUS_LABEL[status])}` : t(STATUS_LABEL[status])}
    >
      <KernelDot status={status} />
      <span className="max-w-[220px] truncate">{chosen?.displayName ?? t("notebook.kernel.none")}</span>
      <span>· {t(STATUS_LABEL[status])}</span>
      {running > 0 && <span className="tabular-nums">· {t("notebook.kernel.queue", { n: running })}</span>}
    </span>
  );
}
