import { useEffect, useRef, useState } from "react";
import { Check, History, Loader2, Radio, Square, Trash2, X } from "lucide-react";
import { t } from "../i18n";
import { rpc, Unpaired } from "../transport";
import { useMobileStore } from "../store";
import { useNav } from "../nav";
import { navigated } from "../haptics";
import { since, sinceIso } from "../time";
import { toastError, toastSuccess } from "../toast";
import { Button, IconButton } from "../ui/Button";
import { Card, Divider, Row, Section } from "../ui/List";
import { Badge, EmptyState, Spinner } from "../ui/Feedback";
import type { JobHistoryEntry } from "../../types/domain";

/**
 * What the engines are printing, right now — and what they printed earlier.
 *
 * The live half lists the runs this session has *heard from*: an `ai:output-batch` or an `ai:engine`
 * frame arrived carrying their id. That is deliberately not the same as "every run the desktop knows
 * about": a phone that connects mid-run has missed the earlier frames and will show the run from the
 * moment it joined, not from the beginning. That is the honest behaviour for a live tail, and the
 * alternative — fetching a transcript over wifi that nobody scrolls back through — is worse.
 *
 * # Why there is now a history under it
 *
 * Because the honest behaviour above answers the wrong question when the phone was asleep. *"Did the
 * thing I left running finish?"* is most of why this app exists, and a phone that was in a pocket
 * heard none of the frames, so the live list was empty and said "ninguna corrida activa" — which is
 * true and reads as "nothing happened". `list_job_history` has been in the server's allowlist since
 * this feature shipped and no client ever called it.
 */

function RunCard({ runId }: { runId: string }) {
  const log = useMobileStore((s) => s.logs[runId]);
  const markRunFinished = useMobileStore((s) => s.markRunFinished);
  const dismissRun = useMobileStore((s) => s.dismissRun);
  const body = useRef<HTMLDivElement>(null);
  // Whether the user has scrolled away from the tail. Following blindly would yank the view out
  // from under somebody reading back three lines, which on a phone is most of the screen.
  const pinned = useRef(true);

  useEffect(() => {
    // `scrollTop`, not `scrollIntoView`. The latter scrolls every scrollable ancestor to bring the
    // element into view, so a run printing fast dragged the *whole tab* down on every batch while
    // the user was trying to read something else on the page.
    if (pinned.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [log?.lines.length]);

  if (!log) return null;

  return (
    <Card className="mt-2.5">
      <div className="flex items-center gap-2 border-b border-[var(--cf-divider)] px-3 py-2">
        {log.finished ? (
          <Check size={14} className="shrink-0 text-[var(--cf-text-muted)]" aria-hidden />
        ) : (
          <Radio size={14} className="cf-pulse shrink-0 rounded-full text-[var(--cf-success-text)]" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium">{log.engine || t("runs.live")}</span>
          <span className="block text-2xs text-[var(--cf-text-faint)]">
            {log.finished ? t("runs.finished") : t("runs.live")} · {since(log.firstSeen / 1000)}
          </span>
        </span>
        {log.finished ? (
          <IconButton
            icon={<X size={15} />}
            label={t("runs.dismiss")}
            onClick={() => dismissRun(runId)}
          />
        ) : (
          <IconButton
            icon={<Square size={14} />}
            label={t("runs.cancel")}
            tone="danger"
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
                  if (stopped) toastSuccess(t("toast.runCancelled"));
                  else markRunFinished(runId);
                })
                // Unpaired is left to the transport, which publishes it to the whole client;
                // anything else is worth saying, because a stop that did nothing and said nothing
                // reads as the run refusing to die.
                .catch((e: unknown) => {
                  if (!(e instanceof Unpaired)) {
                    toastError(t("error.actionFailed"), e instanceof Error ? e.message : String(e));
                  }
                });
            }}
          />
        )}
      </div>
      <div
        ref={body}
        className="cf-scroll max-h-64 bg-[var(--cf-sunken)] px-3 py-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          // A 24px tolerance rather than an exact bottom: momentum scrolling on iOS rarely lands
          // on the last pixel, and an exact test would unpin the view on every flick.
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {log.lines.length ? (
          <p className="cf-log text-[var(--cf-text-muted)]">{log.lines.join("\n")}</p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-[var(--cf-text-muted)]">
            <Loader2 size={12} className="animate-spin" aria-hidden />
            {t("runs.waiting")}
          </p>
        )}
      </div>
    </Card>
  );
}

/** What the desktop has finished for this project, whether or not this phone was awake for it. */
function HistoryList() {
  const projectId = useMobileStore((s) => s.projectId);
  const push = useNav((s) => s.push);
  const [entries, setEntries] = useState<JobHistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setEntries(null);
    setFailed(false);
    // `withResult: false` — the result of an agent run is the whole transcript, and this is a list
    // of twenty rows. It is fetched per row, by `get_job_result`, when one is opened.
    void rpc<JobHistoryEntry[]>("list_job_history", { projectId, limit: 20, withResult: false })
      .then((rows) => alive && setEntries(rows))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [projectId]);

  if (!projectId) return null;

  return (
    <Section title={t("runs.history")}>
      {failed ? (
        <p className="px-1 text-base text-[var(--cf-text-muted)]">{t("runs.historyFailed")}</p>
      ) : entries === null ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : entries.length === 0 ? (
        <p className="px-1 text-base text-[var(--cf-text-muted)]">{t("runs.historyNone")}</p>
      ) : (
        <Card>
          {entries.map((entry, index) => (
            <div key={entry.id}>
              {index > 0 && <Divider inset />}
              <Row
                leading={
                  <History size={15} className="text-[var(--cf-text-faint)]" aria-hidden />
                }
                title={entry.custom_label || entry.label}
                subtitle={`${entry.kind} · ${sinceIso(entry.created_at)}`}
                trailing={
                  <Badge tone={entry.status === "error" ? "danger" : "neutral"}>
                    {entry.status}
                  </Badge>
                }
                onClick={() => {
                  navigated();
                  push({
                    k: "job",
                    projectId,
                    id: entry.id,
                    label: entry.custom_label || entry.label,
                  });
                }}
              />
            </div>
          ))}
        </Card>
      )}
    </Section>
  );
}

export function RunsView() {
  const logs = useMobileStore((s) => s.logs);
  const clearFinished = useMobileStore((s) => s.clearFinishedRuns);
  const runIds = Object.keys(logs);
  const finished = runIds.filter((id) => logs[id].finished).length;

  return (
    <>
      {runIds.length === 0 ? (
        <EmptyState
          icon={<Radio size={26} aria-hidden />}
          title={t("runs.none")}
          hint={t("runs.noneHint")}
        />
      ) : (
        <Section
          action={
            finished > 0 ? (
              <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={clearFinished}>
                {t("runs.clearFinished")}
              </Button>
            ) : undefined
          }
        >
          {runIds.map((runId) => (
            <RunCard key={runId} runId={runId} />
          ))}
        </Section>
      )}

      <HistoryList />
    </>
  );
}
