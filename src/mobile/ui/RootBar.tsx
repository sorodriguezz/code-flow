import type { ReactNode } from "react";
import { ChevronDown, Settings2 } from "lucide-react";
import { t } from "../i18n";
import { useMobileStore } from "../store";
import { useNav } from "../nav";
import { navigated, tapped } from "../haptics";
import { AppBar } from "./AppBar";
import { IconButton } from "./Button";

/**
 * The app bar every tab root wears: the screen's name, the project it is about, and the way to
 * change it.
 *
 * # Why the scope is here rather than in a bar of its own
 *
 * It used to be two native selects in a strip above every screen, costing ~97 px of the top of the
 * phone permanently. But the scope genuinely does have to be visible from every tab — it silently
 * decides what all five of them are about, and a scope you cannot see is one people forget is set.
 *
 * So the project's name became the app bar's subtitle, and the whole title block became the target
 * that opens the picker. It costs nothing above what a title costs, it says which project *and*
 * which screen at a glance, and the chevron says it can be changed. `aria-haspopup="dialog"` is
 * what tells a screen reader the same thing the chevron tells everybody else.
 */
export function RootBar({
  title,
  actions,
  below,
}: {
  title: string;
  actions?: ReactNode;
  below?: ReactNode;
}) {
  const push = useNav((s) => s.push);
  const project = useMobileStore((s) => s.projects.find((p) => p.id === s.projectId)?.name ?? null);

  return (
    <AppBar
      // `safeTop` off: the shell's connection strip above already owns the inset, and paying it
      // twice puts an empty band under the notch.
      safeTop={false}
      leading={null}
      title={
        <h1 className="min-w-0">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={`${title} · ${project ?? t("common.project")} — ${t("scope.change")}`}
          onClick={() => {
            tapped();
            push({ k: "scope" });
          }}
          className="cf-press -mx-1 flex max-w-full items-center gap-1 rounded-md px-1 text-left"
        >
          <span className="min-w-0">
            <span className="block truncate text-md font-semibold leading-tight">{title}</span>
            <span className="flex items-center gap-1 text-xs leading-tight text-[var(--cf-text-muted)]">
              <span className="truncate">{project ?? t("common.project")}</span>
              <ChevronDown size={12} className="shrink-0" aria-hidden />
            </span>
          </span>
        </button>
        </h1>
      }
      actions={
        <>
          {actions}
          <IconButton
            icon={<Settings2 size={18} />}
            label={t("nav.settings")}
            onClick={() => {
              navigated();
              push({ k: "settings" });
            }}
          />
        </>
      }
      below={below}
    />
  );
}
