import { useMemo, useState } from "react";
import { DriversView } from "../db/DriversView";
import { buttonClass } from "../common/Button";
import { SettingsHeader } from "../api/settingsChrome";
import { rowDriverId } from "../../lib/db/drivers";
import type { DbDriverSettings } from "../../types/database";
import { useDbStore } from "../../state/dbStore";
import { useDbModalStore } from "../../state/dbModalStore";
import { useDriverStore } from "../../state/driverStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";

/**
 * «Bases de datos»: the drivers every connection is made with — the same list the data sources
 * dialog shows on its Drivers half, which until 2026-10-09 was the only door to it.
 *
 * The dialog's rules hold here too: an edit is a draft until it is saved, and a driver still being
 * added has to be saved before a connection can name it. «Create data source» leaves Settings for
 * the database client's own dialog, where a connection is made.
 */
export function DatabasesSettings() {
  const t = useT();
  const connections = useDbStore((s) => s.connections);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DbDriverSettings>>({});
  const [saving, setSaving] = useState(false);
  const dirty = Object.keys(drafts).length > 0;

  const usage = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of connections) {
      const id = rowDriverId(entry);
      counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }, [connections]);

  /** `false` when one was refused (a custom driver with no class), which stays selected. */
  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const drivers = useDriverStore.getState();
      for (const draft of Object.values(drafts)) {
        if (!(await drivers.saveSettings(draft))) {
          pushErrorToast(useDriverStore.getState().errors[draft.id] ?? t("db.drivers.saveFailed"));
          setSelected(draft.id);
          return false;
        }
      }
      setDrafts({});
      return true;
    } finally {
      setSaving(false);
    }
  };

  const createDataSource = async (id: string) => {
    if (drafts[id] && !(await save())) return;
    const ui = useUiStore.getState();
    ui.closeSettings();
    useUiStore.setState({ activeView: "api", apiWorkspace: "database" });
    useDbModalStore.getState().openDbModal({ kind: "connections" });
  };

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <SettingsHeader
          title={t("settings.databasesTitle")}
          hint={t("settings.databasesHint")}
          aside={
            dirty ? (
              <div className="flex items-center gap-2">
                <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => setDrafts({})} disabled={saving}>
                  {t("common.discard")}
                </button>
                <button type="button" className={buttonClass({ variant: "primary", size: "sm" })} onClick={() => void save()} disabled={saving}>
                  {t("common.save")}
                </button>
              </div>
            ) : undefined
          }
        />
      </div>
      {/* The dialog's two columns, at the height the window gives them: its list scrolls itself. */}
      <div className="mb-6 flex min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--cf-border)]">
        <DriversView
          selected={selected}
          onSelect={setSelected}
          drafts={drafts}
          onDraft={(next) =>
            setDrafts((current) => {
              if ("discard" in next) {
                const { [next.id]: _dropped, ...rest } = current;
                return rest;
              }
              return { ...current, [next.id]: next };
            })
          }
          onCreateDataSource={(id) => void createDataSource(id)}
          usage={usage}
        />
      </div>
    </section>
  );
}
