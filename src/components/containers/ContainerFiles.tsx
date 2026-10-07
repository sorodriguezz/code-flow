import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowUp, Download, File, FileSymlink, Folder, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { RowAction } from "./containerBits";
import { DataTable, EmptyLine, Td, Th, fmtBytes, trClass } from "./ui";
import { containersFileDelete, containersFileDownload, containersFileUpload, containersFiles } from "../../lib/tauri/containersCommands";
import { confirmAction } from "../../state/confirmStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { FileEntry, RuntimeId } from "../../types/containers";

/**
 * «Archivos» — the inside of a running container, a folder at a time: walk into folders, copy
 * files in from this computer, copy files or folders out, and delete. Everything goes through the
 * engine's own `exec` and `cp` (see `containers::files`), so it is the same as a terminal would do.
 */

const join = (dir: string, name: string) => `${dir === "/" ? "" : dir.replace(/\/$/, "")}/${name}`;

export function ContainerFiles({ runtime, context, id, running }: { runtime: RuntimeId; context: string | null; id: string; running: boolean }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(
    async (dir: string) => {
      setLoading(true);
      try {
        const found = await containersFiles(runtime, context, id, dir);
        setEntries(found);
        setPath(dir);
        setPicked(new Set());
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [runtime, context, id],
  );
  useEffect(() => {
    if (running) void load("/");
  }, [running, load]);

  const crumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    return parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` }));
  }, [path]);
  const up = () => {
    if (path === "/") return;
    const parts = path.replace(/\/$/, "").split("/");
    parts.pop();
    void load(parts.join("/") || "/");
  };
  const upload = async () => {
    const chosen = await openDialog({ multiple: true, title: t("containers.m.files.uploadTitle") });
    const files = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : [];
    if (!files.length) return;
    setWorking("upload");
    try {
      await containersFileUpload(runtime, context, id, path, files);
      pushSuccessToast(t("containers.m.files.uploaded", { count: files.length }));
      void load(path);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setWorking(null);
    }
  };
  const download = async (names: string[]) => {
    if (!names.length) return;
    const dir = await openDialog({ directory: true, title: t("containers.m.files.downloadTitle") });
    if (typeof dir !== "string") return;
    setWorking("download");
    try {
      const written: string[] = [];
      for (const name of names) written.push(await containersFileDownload(runtime, context, id, join(path, name), dir));
      pushSuccessToast(written.length === 1 ? t("containers.m.files.downloadedOne", { path: written[0] }) : t("containers.m.files.downloaded", { count: written.length, dir }));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setWorking(null);
    }
  };
  const remove = async (names: string[]) => {
    if (!names.length) return;
    if (!(await confirmAction(t("containers.m.files.confirmDelete", { count: names.length, names: names.join(", ") }), true, t("containers.remove")))) return;
    setWorking("delete");
    try {
      for (const name of names) await containersFileDelete(runtime, context, id, join(path, name));
      pushSuccessToast(t("containers.m.files.deleted", { count: names.length }));
      void load(path);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setWorking(null);
    }
  };

  if (!running) return <EmptyLine>{t("containers.m.files.notRunning")}</EmptyLine>;
  const pickedNames = [...picked];
  const all = (entries ?? []).length > 0 && (entries ?? []).every((e) => picked.has(e.name));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2">
        <RowAction label={t("containers.m.files.up")} disabled={path === "/"} onClick={up}>
          <ArrowUp size={13} />
        </RowAction>
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-[12px]">
          <button onClick={() => void load("/")} className="shrink-0 rounded px-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]">
            /
          </button>
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
              {i > 0 && <span className="text-[var(--cf-text-faint)]">/</span>}
              <button onClick={() => void load(crumb.path)} className={`rounded px-1 hover:bg-[var(--cf-hover)] ${i === crumbs.length - 1 ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
        {pickedNames.length > 0 ? (
          <>
            <Button size="sm" variant="secondary" disabled={!!working} onClick={() => void download(pickedNames)}>
              {working === "download" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {t("containers.m.files.download", { count: pickedNames.length })}
            </Button>
            <Button size="sm" variant="danger-ghost" disabled={!!working} onClick={() => void remove(pickedNames)}>
              <Trash2 size={12} />
              {t("containers.remove")}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" disabled={!!working} onClick={() => void upload()}>
            {working === "upload" ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
            {t("containers.m.files.upload")}
          </Button>
        )}
        <RowAction label={t("containers.refresh")} onClick={() => void load(path)}>
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </RowAction>
      </div>
      {error ? (
        <EmptyLine>{error}</EmptyLine>
      ) : !entries ? (
        <EmptyLine>{t("containers.m.loading")}</EmptyLine>
      ) : entries.length === 0 ? (
        <EmptyLine>{t("containers.m.files.empty")}</EmptyLine>
      ) : (
        <DataTable minWidth={480}>
          <thead>
            <tr>
              <Th align="center" width={32}>
                <Checkbox checked={all} onChange={() => setPicked(all ? new Set() : new Set(entries.map((e) => e.name)))} />
              </Th>
              <Th>{t("containers.m.col.name")}</Th>
              <Th align="right" width={90}>
                {t("containers.m.files.size")}
              </Th>
              <Th width={150}>{t("containers.m.files.modified")}</Th>
              <Th align="right" width={64} />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.name} className={trClass(picked.has(entry.name))} onDoubleClick={() => (entry.dir ? void load(join(path, entry.name)) : void download([entry.name]))}>
                <Td align="center">
                  <Checkbox
                    checked={picked.has(entry.name)}
                    onChange={() =>
                      setPicked((current) => {
                        const next = new Set(current);
                        if (next.has(entry.name)) next.delete(entry.name);
                        else next.add(entry.name);
                        return next;
                      })
                    }
                  />
                </Td>
                <Td>
                  <button
                    onClick={() => (entry.dir ? void load(join(path, entry.name)) : undefined)}
                    className={`flex min-w-0 items-center gap-1.5 text-left ${entry.dir ? "hover:text-[var(--cf-accent)]" : "cursor-default"}`}
                  >
                    {entry.dir ? (
                      <Folder size={13} className="shrink-0 text-[var(--cf-accent)]" />
                    ) : entry.link ? (
                      <FileSymlink size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                    ) : (
                      <File size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                    )}
                    <span className="truncate font-mono text-[12px]">{entry.name}</span>
                  </button>
                </Td>
                <Td align="right" className="text-[var(--cf-text-muted)]">
                  {entry.dir ? "" : fmtBytes(entry.size)}
                </Td>
                <Td className="text-[11.5px] text-[var(--cf-text-muted)]">{entry.modified ? new Date(entry.modified * 1000).toLocaleString(language === "es" ? "es" : "en") : ""}</Td>
                <Td align="right">
                  <span className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100">
                    <RowAction label={t("containers.m.files.downloadOne")} onClick={() => void download([entry.name])}>
                      <Download size={12} />
                    </RowAction>
                    <RowAction label={t("containers.remove")} danger onClick={() => void remove([entry.name])}>
                      <Trash2 size={12} />
                    </RowAction>
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
