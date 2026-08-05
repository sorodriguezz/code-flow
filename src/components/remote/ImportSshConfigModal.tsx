import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { ApiModal, Field, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { useRemoteStore } from "../../state/remoteStore";
import {
  remoteImportSshConfig,
  remoteScanSshConfig,
  remoteSshConfigPath,
} from "../../lib/tauri/remoteCommands";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { describeHost, type ImportedHost } from "../../types/remote";

/**
 * Importing hosts from `~/.ssh/config`.
 *
 * Every entry is listed with a checkbox rather than imported wholesale, because a config with forty
 * `Host` blocks is normal and most of them are aliases for things nobody manages from a GUI. The
 * ones this workspace already has by name are pre-unticked and labelled, so running the import
 * again after adding a machine adds the machine rather than a second copy of the estate — the
 * backend enforces the same rule, since a name can be taken between the scan and the confirm.
 */
export function ImportSshConfigModal({ onClose }: { onClose: () => void }) {
  const hosts = useRemoteStore((s) => s.hosts);
  const workspaceId = useRemoteStore((s) => s.workspaceId);
  const refresh = useRemoteStore((s) => s.refresh);
  const t = useT();

  const [available, setAvailable] = useState<ImportedHost[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState("");
  const [importing, setImporting] = useState(false);
  // Read rather than assumed: `~/.ssh/config` is not the path on Windows, and a dialog naming the
  // wrong file is what sends someone looking in the wrong place.
  const [configPath, setConfigPath] = useState("");

  const existing = useMemo(() => new Set(hosts.map((host) => host.name)), [hosts]);

  useEffect(() => {
    void remoteSshConfigPath().then(setConfigPath).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    void remoteScanSshConfig()
      .then((found) => {
        if (cancelled) return;
        setAvailable(found);
        setSelected(new Set(found.filter((host) => !existing.has(host.name)).map((h) => h.name)));
      })
      .catch((error) => {
        if (!cancelled) {
          pushErrorToast(String(error));
          setAvailable([]);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const runImport = async () => {
    if (!workspaceId || selected.size === 0) return;
    setImporting(true);
    try {
      const result = await remoteImportSshConfig(workspaceId, [...selected], group.trim());
      await refresh();
      useToastStore
        .getState()
        .pushToast(
          t("remote.importDone", {
            created: String(result.created.length),
            skipped: String(result.skipped.length),
          }),
          "success",
        );
      onClose();
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setImporting(false);
    }
  };

  const allSelectable = available?.filter((host) => !existing.has(host.name)) ?? [];

  return (
    <ApiModal
      icon={Download}
      title={t("remote.importSshConfig")}
      subtitle={configPath || t("remote.importSubtitle")}
      width="max-w-xl"
      height="h-[520px]"
      busy={importing}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="flex-1 text-[11px] text-[var(--cf-text-muted)]">
            {t("remote.importSelected", { n: String(selected.size) })}
          </span>
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton onClick={() => void runImport()} disabled={importing || selected.size === 0}>
            {t("remote.import")}
          </PrimaryButton>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 space-y-2 border-b border-[var(--cf-border)] px-4 py-3">
          <label className="flex items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] text-[var(--cf-text)]">
                {t("remote.importIntoGroup")}
              </span>
              <span className="block text-[11px] text-[var(--cf-text-muted)]">
                {t("remote.importIntoGroupHint")}
              </span>
            </span>
            <span className="w-[180px] shrink-0">
              <Field value={group} onChange={setGroup} placeholder={t("remote.ungrouped")} />
            </span>
          </label>

          {allSelectable.length > 0 && (
            <div className="flex gap-3 text-[11px]">
              <button
                type="button"
                onClick={() => setSelected(new Set(allSelectable.map((host) => host.name)))}
                className="text-[var(--cf-accent)] hover:underline"
              >
                {t("remote.selectAll")}
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                {t("remote.selectNone")}
              </button>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {available === null ? (
            <div className="flex h-full items-center justify-center gap-2 text-[var(--cf-text-muted)]">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-[12px]">{t("remote.importScanning")}</span>
            </div>
          ) : available.length === 0 ? (
            <p className="px-4 py-8 text-center text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
              {t("remote.importEmpty", { path: configPath || "~/.ssh/config" })}
            </p>
          ) : (
            available.map((host) => {
              const taken = existing.has(host.name);
              return (
                <label
                  key={host.name}
                  className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 ${
                    taken ? "opacity-50" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  }`}
                >
                  <Checkbox
                    checked={selected.has(host.name)}
                    disabled={taken}
                    onChange={() => toggle(host.name)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-[var(--cf-text)]">
                      {host.name}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                      {describeHost(host.spec)}
                    </span>
                  </span>
                  {taken && (
                    <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">
                      {t("remote.importAlreadyHere")}
                    </span>
                  )}
                </label>
              );
            })
          )}
        </div>
      </div>
    </ApiModal>
  );
}
