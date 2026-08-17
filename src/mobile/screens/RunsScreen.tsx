import { useEffect, useRef } from "react";
import { Check, Loader2, Square } from "lucide-react";
import { t } from "../i18n";
import { rpc, Unpaired } from "../transport";
import { useMobileStore } from "../store";

/**
 * What the engines are printing, right now.
 *
 * The runs listed here are the ones this session has *heard from* — an `ai:output-batch` or an
 * `ai:engine` frame arrived carrying their id. That is deliberately not the same as "every run the
 * desktop knows about": a phone that connects mid-run has missed the earlier frames and will show
 * the run from the moment it joined, not from the beginning.
 *
 * That is the honest behaviour for a live tail and the alternative is worse. Fetching the backlog
 * would mean either a new command that returns a transcript (megabytes, over wifi, for something
 * nobody scrolls back through) or pretending the earlier output never existed. Showing the tail
 * from where you joined is what a person watching over your shoulder would see.
 */
function RunCard({ runId }: { runId: string }) {
  const log = useMobileStore((s) => s.logs[runId]);
  const markRunFinished = useMobileStore((s) => s.markRunFinished);
  const setError = useMobileStore((s) => s.setError);
  const bottom = useRef<HTMLDivElement>(null);
  // Whether the user has scrolled away from the tail. Following blindly would yank the view out
  // from under somebody reading back three lines, which on a phone is most of the screen.
  const pinned = useRef(true);

  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [log?.lines.length]);

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        {log?.finished ? (
          <Check size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <Loader2 size={13} className="shrink-0 animate-spin text-[var(--cf-success)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          {log?.engine || t("runs.live")}
        </span>
        {/* Only while it is actually running. Offering to stop something that already ended is an
            action that can only fail, and the backend answering `false` for it would read here as
            an error rather than as "too late". */}
        {!log?.finished && (
          <button
            type="button"
            // **No busy flag, and it does not go through `store.run`.** This is the one button whose
            // entire purpose is to work *while a long command is in flight* — the run it stops is
            // very often the review or the chat turn that is holding a flag right now, and a stop
            // button disabled by the thing it stops is not a stop button. Routing it through `run`
            // would be worse than useless besides: its `finally` would clear a flag the still-running
            // command is holding, re-enabling every other action mid-request.
            //
            // `cancel_ai_run` is safe to fire without one. It writes nothing, takes no repository
            // lease, and answers the same way however many times it is pressed.
            onClick={() => {
              void rpc<boolean>("cancel_ai_run", { runId })
                .then((stopped) => {
                  // `false` means the registry had no such run — it had already finished, and the
                  // `ai:done` that would have said so was lost with a socket this phone dropped.
                  // That is a reliable finality signal, and acting on it is what stops the card
                  // spinning under a button that can now only ever answer `false` again.
                  if (!stopped) markRunFinished(runId);
                })
                // Unpaired is left to the transport, which publishes it to the whole client; anything
                // else is worth a line, because a stop that did nothing and said nothing reads as the
                // run refusing to die.
                .catch((e: unknown) => {
                  if (!(e instanceof Unpaired)) setError(String(e));
                });
            }}
            title={t("runs.cancel")}
            className="cf-tap flex shrink-0 items-center justify-center text-[var(--cf-text-muted)]"
          >
            <Square size={13} />
          </button>
        )}
      </div>
      <div
        className="cf-scroll max-h-64 px-3 py-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          // A 24px tolerance rather than an exact bottom: momentum scrolling on iOS rarely lands
          // on the last pixel, and an exact test would unpin the view on every flick.
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {log?.lines.length ? (
          <p className="cf-log text-[var(--cf-text-muted)]">{log.lines.join("\n")}</p>
        ) : (
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("runs.waiting")}</p>
        )}
        <div ref={bottom} />
      </div>
    </div>
  );
}

export function RunsScreen() {
  const logs = useMobileStore((s) => s.logs);
  const runIds = Object.keys(logs);

  if (runIds.length === 0) {
    return <p className="p-6 text-center text-[13px] text-[var(--cf-text-muted)]">{t("runs.none")}</p>;
  }

  return (
    <div className="cf-scroll flex-1 px-3 pb-6">
      {runIds.map((runId) => (
        <RunCard key={runId} runId={runId} />
      ))}
    </div>
  );
}
