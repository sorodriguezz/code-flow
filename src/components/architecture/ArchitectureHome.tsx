import { ArrowRight, FilePlus2, GitBranch, Network, Pin, Upload } from "lucide-react";
import { useArchitectureStore } from "../../state/architectureStore";
import { useT } from "../../state/languageStore";
import { AiSparkles } from "../common/AiGlyph";
import { useArchSourceDialog } from "./sources/ArchSourceDialog";
import { importArchitecture } from "./importArchitecture";

export function ArchitectureHome() {
  const t = useT();
  const items = useArchitectureStore((s) => s.items);
  const folders = useArchitectureStore((s) => s.folders);
  const workspaceId = useArchitectureStore((s) => s.workspaceId);
  const recent = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const actions = [
    { title: t("arch.template.minimal"), detail: t("arch.home.blank"), icon: <FilePlus2 size={18} />, run: () => void useArchitectureStore.getState().create() },
    { title: t("arch.src.generate"), detail: t("arch.home.sources"), icon: <AiSparkles size={17} />, run: () => useArchSourceDialog.getState().openAs("new") },
    { title: t("arch.home.import"), detail: t("arch.home.file"), icon: <Upload size={18} />, run: () => void importArchitecture(t) },
  ];

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-[var(--cf-sunken)]" aria-labelledby="arch-home-title">
      <div className="mx-auto flex w-full max-w-[840px] flex-col gap-7 px-5 py-8 @min-[650px]:px-8 @min-[650px]:py-12">
        <div>
          <span className="mb-4 grid size-11 place-items-center rounded-xl border border-[var(--cf-border)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            <Network size={22} />
          </span>
          <h1 id="arch-home-title" className="m-0 text-[26px] font-semibold leading-tight tracking-tight text-[var(--cf-text)]">{t("tabbar.architecture")}</h1>
          <p className="mb-0 mt-2 max-w-lg text-[13px] leading-relaxed text-[var(--cf-text-muted)]">{t(workspaceId ? "arch.home.subtitle" : "arch.home.workspace")}</p>
        </div>
        {workspaceId ? (
          <>
            <div className="grid gap-2.5 @min-[680px]:grid-cols-3">
              {actions.map(({ title, detail, icon, run }) => (
                <button key={title} type="button" onClick={run} className="group flex min-w-0 items-start gap-3 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] p-3 text-left hover:border-[var(--cf-accent)] hover:bg-[var(--cf-hover)] @min-[680px]:flex-col @min-[680px]:p-4">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">{icon}</span>
                  <span className="grid min-w-0 flex-1 gap-1">
                    <span className="text-[13px] font-semibold leading-snug text-[var(--cf-text)]">{title}</span>
                    <span className="text-[12px] leading-snug text-[var(--cf-text-muted)]">{detail}</span>
                  </span>
                </button>
              ))}
            </div>
            {recent.length ? (
              <section aria-labelledby="arch-recent-title">
                <h2 id="arch-recent-title" className="mb-2.5 text-[13px] font-semibold text-[var(--cf-text)]">{t("arch.home.recent")}</h2>
                <div className="divide-y divide-[var(--cf-border)] overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)]">
                  {recent.map((item) => {
                    const folder = folders.find((f) => f.id === item.folderId);
                    return (
                      <button key={item.id} type="button" onClick={() => void useArchitectureStore.getState().open(item.id)} className="group flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-[var(--cf-hover)] focus-visible:-outline-offset-2">
                        <Network size={16} className="shrink-0 text-[var(--cf-accent)]" />
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate text-[13px] font-medium text-[var(--cf-text)]">{item.title}</span>
                          {folder ? <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{folder.name}</span> : null}
                        </span>
                        {item.pinned ? <Pin size={12} className="shrink-0 text-[var(--cf-text-muted)]" aria-label={t("arch.home.pinned")} /> : null}
                        {item.originPath ? <GitBranch size={13} className="shrink-0 text-[var(--cf-text-muted)]" aria-label={item.originPath} /> : null}
                        <ArrowRight size={15} className="shrink-0 text-[var(--cf-text-muted)] group-hover:text-[var(--cf-accent)]" />
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
