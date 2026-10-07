import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileSearch, FolderOpen, Hammer, Play, RotateCw, Undo2 } from "lucide-react";
import { Button } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { RowAction, SectionTitle, StateDot, ago } from "./containerBits";
import { EmptyLine, Field, PageHead, Td, Th, trClass } from "./ui";
import { RunContainerDialog } from "./RunContainerDialog";
import { relativeTo, validImageTag } from "./pageModel";
import { useContainersJobsStore } from "../../state/containersJobsStore";
import { useContainersStore } from "../../state/containersStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { RuntimeInfo } from "../../types/containers";

/**
 * «Construir»: an image from a folder and its Dockerfile, tagged, built by the engine's own `build` as
 * one of the manager's jobs — BuildKit's progress as it prints it, still building if the page is left.
 * A build that ends well can be run at once; the last few are listed, to build again or to fill the
 * form with.
 */

interface BuildParams {
  folder: string;
  dockerfile: string;
  tag: string;
}

interface PastBuild extends BuildParams {
  /** ms since the epoch. */
  at: number;
  /** The exit code; `null` when the build was cut short or never started. */
  code: number | null;
}

const RECENT = 5;
const sameParams = (a: BuildParams, b: BuildParams) => a.folder === b.folder && a.dockerfile === b.dockerfile && a.tag === b.tag;

export function BuildPage({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const startJob = useContainersJobsStore((s) => s.start);
  const history = useContainersJobsStore((s) => s.history);
  const [folder, setFolder] = useState("");
  const [dockerfile, setDockerfile] = useState("Dockerfile");
  const [tag, setTag] = useState("");
  const [runImage, setRunImage] = useState<string | null>(null);
  const ctr = runtime.id === "ctr";
  // The newest of each folder, Dockerfile and tag this engine built.
  const recent = useMemo(() => {
    const list: PastBuild[] = [];
    for (const past of history) {
      if (past.kind !== "build" || past.runtime !== runtime.id) continue;
      const params: BuildParams = { folder: past.meta.folder ?? "", dockerfile: past.meta.dockerfile ?? "", tag: past.meta.tag ?? "" };
      if (!list.some((b) => sameParams(b, params))) list.push({ ...params, at: past.at, code: past.code });
      if (list.length === RECENT) break;
    }
    return list;
  }, [history, runtime.id]);
  const tagOk = validImageTag(tag);
  const ready = !!folder.trim() && !!dockerfile.trim() && tagOk;

  const build = (params: BuildParams) => {
    const request = {
      kind: "build" as const,
      runtime: runtime.id,
      context,
      target: params.tag,
      buildContext: params.folder,
      dockerfile: params.dockerfile,
      tag: params.tag,
    };
    void startJob(t("containers.m.build.building", { tag: params.tag }), request, {
      refresh: ["images"],
      done: t("containers.m.build.built", { tag: params.tag }),
      runImage: params.tag,
      meta: { folder: params.folder, dockerfile: params.dockerfile, tag: params.tag },
    });
  };
  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, title: t("containers.m.build.pickContext"), defaultPath: folder || undefined });
    if (typeof dir === "string") setFolder(dir);
  };
  const pickDockerfile = async () => {
    const file = await openDialog({ title: t("containers.m.build.pickDockerfile"), defaultPath: folder || undefined });
    // Inside the folder it is written relative to it, the way `-f` is usually given.
    if (typeof file === "string") setDockerfile(folder ? relativeTo(folder, file) : file);
  };
  const fill = (params: BuildParams) => {
    setFolder(params.folder);
    setDockerfile(params.dockerfile);
    setTag(params.tag);
  };

  const mono = fieldClass({ size: "sm", className: "w-full min-w-0 font-mono" });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("containers.m.section.build")} />
      <div className="flex min-h-0 flex-1 flex-col">
        {ctr ? (
          <EmptyLine>{t("containers.m.build.unsupported")}</EmptyLine>
        ) : !runtime.running ? (
          <EmptyLine>{runtime.problem ?? t("containers.notRunningHint")}</EmptyLine>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <form
              className="grid shrink-0 grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1fr)_auto] items-start gap-2 border-b border-[var(--cf-border)] px-3 py-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (ready) build({ folder: folder.trim(), dockerfile: dockerfile.trim(), tag: tag.trim() });
              }}
            >
              <Field label={t("containers.m.build.context")}>
                <div className="flex gap-1">
                  <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={t("containers.m.build.contextPlaceholder")} spellCheck={false} className={mono} />
                  <button type="button" onClick={() => void pickFolder()} title={t("containers.m.build.pickContext")} className="shrink-0 rounded-md border border-[var(--cf-field-border)] px-1.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
                    <FolderOpen size={13} />
                  </button>
                </div>
              </Field>
              <Field label={t("containers.m.build.dockerfile")}>
                <div className="flex gap-1">
                  <input value={dockerfile} onChange={(e) => setDockerfile(e.target.value)} placeholder="Dockerfile" spellCheck={false} className={mono} />
                  <button type="button" onClick={() => void pickDockerfile()} title={t("containers.m.build.pickDockerfile")} className="shrink-0 rounded-md border border-[var(--cf-field-border)] px-1.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
                    <FileSearch size={13} />
                  </button>
                </div>
              </Field>
              <Field label={t("containers.m.run.tag")} hint={tag.trim() && !tagOk ? t("containers.m.build.tagInvalid") : undefined}>
                <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder={t("containers.m.build.tagPlaceholder")} spellCheck={false} className={mono} />
              </Field>
              {/* Lined up with the fields, under their labels' line. */}
              <div className="pt-[19px]">
                <Button size="sm" variant="primary" type="submit" disabled={!ready} title={ready ? undefined : t("containers.m.build.needs")}>
                  <Hammer size={13} />
                  {t("containers.m.build.build")}
                </Button>
              </div>
            </form>
            {recent.length > 0 && (
              <div className="shrink-0 px-3 pb-2 pt-2.5">
                <SectionTitle>{t("containers.m.build.recent")}</SectionTitle>
                <table className="w-full table-fixed border-separate border-spacing-0 text-[12px]">
                  <thead>
                    <tr>
                      <Th>{t("containers.m.run.tag")}</Th>
                      <Th>{t("containers.m.build.context")}</Th>
                      <Th width={190}>{t("containers.m.col.state")}</Th>
                      <Th align="right" width={80}>
                        {t("containers.m.col.actions")}
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((past) => (
                      <tr key={`${past.tag}|${past.folder}|${past.dockerfile}`} className={trClass(false)}>
                        <Td>
                          <span className="block truncate font-mono text-[var(--cf-text)]" title={past.tag}>
                            {past.tag}
                          </span>
                        </Td>
                        <Td>
                          <span className="block truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]" title={`${past.folder}\n${past.dockerfile}`}>
                            {past.folder}
                          </span>
                        </Td>
                        <Td>
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <StateDot tone={past.code === 0 ? "ok" : "bad"} />
                            <span className={past.code === 0 ? "text-[var(--cf-text)]" : "text-[var(--cf-danger)]"}>
                              {past.code === 0 ? t("containers.m.build.ok") : past.code === null ? t("containers.m.job.cut") : t("containers.m.job.failed", { code: past.code })}
                            </span>
                            <span className="text-[11px] text-[var(--cf-text-faint)]">{ago(new Date(past.at).toISOString(), language)}</span>
                          </span>
                        </Td>
                        <Td className="w-[80px]">
                          <div className="flex items-center justify-end gap-0.5">
                            {past.code === 0 && (
                              <RowAction label={t("containers.m.run.run")} onClick={() => setRunImage(past.tag)}>
                                <Play size={12} className="text-[var(--cf-success)]" />
                              </RowAction>
                            )}
                            <RowAction label={t("containers.m.build.rebuild")} onClick={() => build(past)}>
                              <RotateCw size={12} />
                            </RowAction>
                            <RowAction label={t("containers.m.build.useParams")} onClick={() => fill(past)}>
                              <Undo2 size={12} />
                            </RowAction>
                          </div>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      {runImage !== null && <RunContainerDialog runtime={runtime} context={context} initialImage={runImage} onClose={() => setRunImage(null)} />}
    </div>
  );
}
