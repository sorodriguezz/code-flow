import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { buttonClass } from "../common/Button";
import { formatBytes } from "../../lib/toolbox/numbers";
import { diskIsTight, reclaimable, shares, visibleCategories } from "../../lib/storageView";
import { storageClear, storageUsage } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import type { TranslationKey } from "../../lib/i18n/translations";

type Usage = Awaited<ReturnType<typeof storageUsage>>;

/** Segment colours, in order; the app's own accent family so the bar reads as one thing. */
const TONES = ["var(--cf-accent)", "#0d9488", "#d97706", "#7c3aed", "#db2777", "#64748b"];

/**
 * Where the disk goes: each place the app keeps things, sized, with the free space of the disk they are
 * on. Only what the app rebuilds by itself (the cache, old log generations) has a Clear button, and it
 * says how much it would give back — everything else is somebody's data or a slow download.
 */
export function StorageBlock() {
  const t = useT();
  const pushToast = useToastStore((s) => s.pushToast);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);

  const load = useCallback(() => {
    storageUsage().then(setUsage).catch((e: unknown) => pushErrorToast(String(e)));
  }, []);
  useEffect(load, [load]);

  if (!usage) return <Loader2 size={14} className="animate-spin text-[var(--cf-text-muted)]" />;
  const rows = visibleCategories(usage);
  const widths = shares(rows);

  const clear = async (id: string) => {
    setClearing(id);
    try {
      const freed = await storageClear(id);
      pushToast(t("storage.freed", { size: formatBytes(freed, "iec", 1) }), "success");
      load();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setClearing(null);
    }
  };

  return (
    <div className="space-y-2.5">
      {usage.total_bytes > 0 && (
        <p className={`text-[12px] ${diskIsTight(usage) ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)]"}`}>
          {t("storage.free", { free: formatBytes(usage.free_bytes, "iec", 1), total: formatBytes(usage.total_bytes, "iec", 0) })}
        </p>
      )}
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--cf-border)]" role="img" aria-label={t("storage.title")}>
        {rows.map((row, at) => (
          <span key={row.id} title={`${t(`storage.cat.${row.id}` as TranslationKey)} · ${formatBytes(row.bytes, "iec", 1)}`} style={{ width: `${widths[at]}%`, background: TONES[at % TONES.length] }} />
        ))}
      </div>
      <ul className="space-y-1">
        {rows.map((row, at) => (
          <li key={row.id} className="flex items-center gap-2 text-[12px]">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TONES[at % TONES.length] }} />
            <span className="min-w-0 flex-1 truncate" title={row.path}>
              {t(`storage.cat.${row.id}` as TranslationKey)}
            </span>
            <span className="tabular-nums text-[var(--cf-text-muted)]">{formatBytes(row.bytes, "iec", 1)}</span>
            {row.clearable && (
              <button type="button" disabled={clearing !== null} onClick={() => void clear(row.id)} className={buttonClass({ variant: "ghost", size: "sm" })}>
                {clearing === row.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {t("storage.clear")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {reclaimable(usage) > 0 && <p className="text-[11px] text-[var(--cf-text-faint)]">{t("storage.reclaimable", { size: formatBytes(reclaimable(usage), "iec", 1) })}</p>}
    </div>
  );
}
