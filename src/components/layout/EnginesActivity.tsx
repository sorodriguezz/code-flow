import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Server, Square } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { iconButtonClass } from "../common/Button";
import { useBackgroundStore } from "../../state/backgroundStore";
import { formatBytes } from "../../state/systemLoadStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

const PANEL_WIDTH = 340;

const ROLE: Record<string, TranslationKey> = {
  completion: "engines.role.completion",
  executor: "engines.role.executor",
  embeddings: "engines.role.embeddings",
  adapter: "engines.role.adapter",
  training: "engines.role.training",
  other: "engines.role.other",
};

const KIND: Record<string, TranslationKey> = {
  whisper: "engines.kind.whisper",
  recognizer: "engines.kind.recognizer",
  piper: "engines.kind.piper",
  kokoro: "engines.kind.kokoro",
};

const BY: Record<string, TranslationKey> = {
  dictation: "engines.by.dictation",
  meetings: "engines.by.meetings",
  flows: "engines.by.flows",
  codi: "engines.by.codi",
  voice: "engines.by.voice",
};

/** `1 h 5 min`, `12 min`, `40 s`. */
export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * The status bar's «motores»: how many of CodeFlow's model servers are running — every
 * `llama-server` (completion, the local model's tasks, embeddings) and the fine-tuning pane's —
 * and, behind a click, everything else working in the background: a vectorizing pass, the models
 * held in memory for dictation, meetings, Codi or reading aloud, Codi's open microphone (the user,
 * 2026-10-23: «alguna manera de reconocer si algo está corriendo en segundo plano»).
 *
 * Always on the bar, a `0` included: with the battery low, «nothing is running» is the answer being
 * looked for. Its count dims at zero and takes the accent while something works.
 */
export function EnginesActivity() {
  const t = useT();
  const status = useBackgroundStore((s) => s.status);
  const watch = useBackgroundStore((s) => s.watch);
  const watchDetail = useBackgroundStore((s) => s.watchDetail);
  const stop = useBackgroundStore((s) => s.stop);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => watch(), [watch]);
  useEffect(() => (open ? watchDetail() : undefined), [open, watchDetail]);

  const reposition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPos({ bottom: window.innerHeight - rect.top + 6, right: Math.max(8, window.innerWidth - rect.right) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("resize", reposition);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", escape);
    };
  }, [open, reposition]);

  if (!status) return null;

  const count = status.processes.length;
  const vectorizing = status.vectorizing;
  const busy = count > 0 || !!vectorizing || status.loaded.length > 0 || status.codiListening;
  const percent = vectorizing && vectorizing.total > 0 ? Math.floor((vectorizing.done / vectorizing.total) * 100) : null;
  const now = Date.now() / 1000;

  return (
    <>
      <Tooltip label={t("engines.tooltip", { n: count })}>
        <button
          ref={buttonRef}
          type="button"
          data-tour="engines-activity"
          aria-expanded={open}
          aria-label={t("engines.tooltip", { n: count })}
          onClick={() => setOpen(!open)}
          className={`flex h-[22px] shrink-0 items-center gap-[5px] rounded-md px-1.5 text-[12px] tabular-nums hover:bg-[var(--cf-hover)] ${
            count > 0 ? "text-[var(--cf-accent)]" : busy ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text-faint)]"
          }`}
        >
          <Server size={14} className="shrink-0" />
          <span>{count}</span>
          {percent !== null && <span className="text-[11px] text-[var(--cf-text-muted)]">· {percent}%</span>}
        </button>
      </Tooltip>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ bottom: pos.bottom, right: pos.right, width: PANEL_WIDTH }}
            className="cf-fade-in fixed z-[60] max-h-[70vh] overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-2.5 shadow-[var(--cf-shadow)]"
          >
            <p className="text-[12px] font-semibold">{t("engines.servers", { n: count })}</p>
            {count === 0 ? (
              <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">{t("engines.noServers")}</p>
            ) : (
              <ul className="mt-1.5 space-y-1.5">
                {status.processes.map((process) => (
                  <li key={process.pid} className="flex items-start gap-2 text-[11px]">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="font-medium text-[var(--cf-text)]">{t(ROLE[process.role] ?? "engines.role.other")}</span>
                        <span className="truncate text-[var(--cf-text-muted)]" title={process.model}>
                          {process.model}
                        </span>
                      </div>
                      <div className="tabular-nums text-[10.5px] text-[var(--cf-text-muted)]">
                        {[
                          process.cpu !== null ? `CPU ${process.cpu.toFixed(process.cpu < 10 ? 1 : 0)}%` : null,
                          process.memory !== null ? formatBytes(process.memory) : null,
                          t("engines.since", { time: elapsed(now - process.since) }),
                          `pid ${process.pid}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <Tooltip label={t("engines.stop")}>
                      <button type="button" className={iconButtonClass({ size: "sm" })} aria-label={t("engines.stop")} onClick={() => void stop(process.pid)}>
                        <Square size={11} />
                      </button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}

            {vectorizing && (
              <>
                <p className="mt-2 border-t border-[var(--cf-border)] pt-2 text-[12px] font-semibold">{t("engines.vectorizing")}</p>
                <VectorizingLine done={vectorizing.done} total={vectorizing.total} etaSecs={vectorizing.etaSecs} />
              </>
            )}

            {(status.loaded.length > 0 || status.codiListening) && (
              <>
                <p className="mt-2 border-t border-[var(--cf-border)] pt-2 text-[12px] font-semibold">{t("engines.inApp")}</p>
                <ul className="mt-1 space-y-0.5 text-[11px]">
                  {status.codiListening && <li className="text-[var(--cf-text)]">{t("engines.codiListening")}</li>}
                  {status.loaded.map((loaded) => (
                    <li key={`${loaded.kind}-${loaded.by}`} className="flex gap-1.5">
                      <span className="text-[var(--cf-text)]">{t(KIND[loaded.kind])}</span>
                      <span className="text-[var(--cf-text-muted)]">· {t(BY[loaded.by])}</span>
                      <span className="truncate text-[var(--cf-text-faint)]" title={loaded.model}>
                        {loaded.model}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">{t("engines.inAppHint")}</p>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A vectorizing pass: a bar, «1.240 / 8.709», and the time left. Shared with the knowledge pane. */
export function VectorizingLine({ done, total, etaSecs }: { done: number; total: number; etaSecs: number | null }) {
  const t = useT();
  const locale = useLanguageStore((s) => s.language) === "es" ? "es-CL" : "en-US";
  const share = total > 0 ? done / total : 0;
  return (
    <div className="mt-1 flex items-center gap-2 text-[11px]">
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--cf-press)]">
        <span className="block h-full origin-left rounded-full bg-[var(--cf-accent-fill)] transition-transform duration-300" style={{ transform: `scaleX(${Math.max(0.02, share)})` }} />
      </span>
      <span className="shrink-0 tabular-nums text-[var(--cf-text)]">
        {done.toLocaleString(locale)} / {total.toLocaleString(locale)}
      </span>
      <span className="shrink-0 text-[10.5px] text-[var(--cf-text-muted)]">
        {etaSecs === null ? t("engines.etaStarting") : t("engines.eta", { time: elapsed(etaSecs) })}
      </span>
    </div>
  );
}
