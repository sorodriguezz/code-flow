import { useCallback, useEffect, useState } from "react";
import {
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ScanText,
  Send,
  ThumbsUp,
  X,
  XCircle,
} from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Button, IconButton } from "../ui/Button";
import { Card, Section } from "../ui/List";
import { Badge, EmptyState, ErrorState, Skeleton } from "../ui/Feedback";
import { UnifiedDiffText } from "./DiffView";
import type { ReviewRunDetail, SavedFinding } from "../../types/domain";

/**
 * One saved review, with the things you actually do to it.
 *
 * # Why this is not a read-only list
 *
 * Reading a review on a phone and then walking to the desk to act on it is half a feature. The
 * three acts that finish a review — vote on the pull request, publish the findings as comments,
 * and dismiss the ones that are wrong — are all here.
 *
 * # The confirmation, and why only these
 *
 * Every other mutating thing a paired device can do is either local (a commit, a stage) or spends
 * the user's own money (an engine run). These three are **public**: they appear on GitHub, Azure or
 * GitLab under the user's name, and other people get notified. So each one is a two-tap action —
 * press, then confirm — which is the same treatment aborting a chain gets, and for the same
 * reason: a pocket is a place where one tap happens by accident.
 *
 * # The app bar is outside every conditional
 *
 * It used to be inside the final `return`, below three early ones — a spinner, and two paths that
 * rendered the sentence *"Nada por aquí."* — so a review that failed to load, which a single dropped
 * packet was enough to cause, put the user on a screen with no header, no back control, no retry and
 * no explanation. The bar is now the first thing rendered and the states go underneath it.
 *
 * # The project comes from the route, not from the store
 *
 * `act`, `publish` and `discard` all name a project, and the scope picker is reachable from every
 * screen. Reading the *current* project here meant that changing it while this was open pointed
 * "approve" at a pull request with the same number in a different repository. The route carries the
 * project it was opened for; if the two disagree the actions are replaced by a sentence saying so.
 */

/**
 * Where a finding says it is, as `post_pr_review_comment` wants it.
 *
 * The stored finding carries `lineas` as the text the engine wrote — `"50"` or `"42-50"` — and the
 * command wants `{file, startLine, endLine}`. Parsing it here is what makes a published comment
 * *anchored to the line it is about* instead of a general comment at the bottom of the pull request.
 *
 * `null` whenever anything is missing or unreadable, which is the honest answer and also the safe
 * one: the backend falls back to an unanchored comment for a `location: null`, so a finding with no
 * file still gets published, just without a line to hang from. Nothing here invents a line number.
 */
function locationOf(
  finding: SavedFinding,
): { file: string; startLine: number; endLine: number } | null {
  if (!finding.archivo || !finding.lineas) return null;
  const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(finding.lineas);
  if (!match) return null;
  const start = Number(match[1]);
  // A range written backwards, or one bound only. `end` never ends up before `start`, because the
  // hosts reject a thread whose range runs the wrong way and reject the whole batch with it.
  const end = match[2] ? Number(match[2]) : start;
  if (!Number.isFinite(start) || start < 1) return null;
  return { file: finding.archivo, startLine: start, endLine: Math.max(start, end) };
}

/**
 * Whether this finding can be published from here.
 *
 * `comentario_md` is the finding rendered as a comment, written when the run was saved. Runs
 * recorded before that field existed do not have one — and there is no way to rebuild it here,
 * because the stored projection deliberately drops `por_que`, `sugerencia` and `ejemplo_*`.
 *
 * The tempting fallback, posting `subtitulo` on its own, is the bug this replaced: it produced a
 * bare one-line comment with no anchor, and `apply_post_outcome` then wrote that thread's id back
 * onto the finding — so every *future* publish from the desktop, with the full body, would reply
 * into the canned thread instead of opening a proper one. One tap from a phone permanently
 * downgraded the finding. So an old run offers no publish button at all, and says why.
 */
function publishable(finding: SavedFinding): boolean {
  return Boolean(finding.comentario_md && finding.comentario_md.trim().length > 0);
}

function severityTone(severity: string): "danger" | "warning" | "neutral" {
  const key = severity.toLowerCase();
  if (key.startsWith("crit") || key.startsWith("alt") || key.startsWith("high")) return "danger";
  if (key.startsWith("med") || key.startsWith("warn")) return "warning";
  return "neutral";
}

const SEVERITY_EDGE: Record<"danger" | "warning" | "neutral", string> = {
  danger: "border-l-[var(--cf-danger)]",
  warning: "border-l-[var(--cf-warning)]",
  neutral: "border-l-[var(--cf-border)]",
};

/** A button that asks once before doing something other people will see. */
function ConfirmAction({
  label,
  confirmLabel,
  icon,
  variant,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  icon: React.ReactNode;
  variant: "primary" | "danger" | "success" | "secondary";
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  // Disarms itself. A confirmation left armed becomes a one-tap button again by the time the user
  // comes back to the screen, which is exactly what the confirmation was for.
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(id);
  }, [armed]);

  if (!armed) {
    return (
      <Button full size="sm" disabled={disabled} icon={icon} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }

  return (
    <span className="flex flex-1 gap-1">
      <IconButton
        icon={<X size={15} />}
        label={t("common.cancel")}
        onClick={() => setArmed(false)}
        className="w-11 border border-[var(--cf-border)]"
      />
      <Button
        full
        size="sm"
        variant={variant}
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
    </span>
  );
}

/** The pull request's diff, behind one tap. */
function PrDiff({ diff }: { diff: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="cf-tap cf-press flex w-full items-center gap-1.5 rounded-md px-1 text-left text-xs font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]"
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        {t("pr.diff")}
      </button>
      {open && (
        <Card className="mt-1 py-1">
          <UnifiedDiffText text={diff} />
        </Card>
      )}
    </Section>
  );
}

export function ReviewScreen({
  id,
  prId,
  iter,
  projectId,
}: {
  id: string;
  prId: number;
  iter: number;
  projectId: string;
}) {
  const run = useMobileStore((s) => s.run);
  const currentProject = useMobileStore((s) => s.projectId);
  // The same group `PrScreen` starts a review under: approving a PR, publishing findings and
  // discarding one are all about the same review run, and none of them should be reachable while
  // another is in flight.
  const busy = useBusy("review");
  const [detail, setDetail] = useState<ReviewRunDetail | null>(null);
  const [findings, setFindings] = useState<SavedFinding[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<string | null>(null);
  const [decision, setDecision] = useState<string | null>(null);
  /** Which findings the user has ticked for publishing. Nothing is ticked by default — publishing
   *  is opt-in per finding, exactly as the desktop's own list is. */
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setState("loading");
    setFailure(null);
    let result: ReviewRunDetail | null;
    try {
      result = await rpc<ReviewRunDetail | null>("get_review_run", { id });
    } catch (e) {
      // Was `.catch(() => null)`, which turned a dropped packet into the same "Nada por aquí" a
      // deleted run shows — and did it on a screen that had no back control in that state.
      setFailure(e instanceof Error ? e.message : String(e));
      setState("error");
      return;
    }
    setDetail(result);
    // The findings arrive as a JSON string on the row, exactly as the desktop reads them. Parsed
    // defensively: a run written by a newer version must degrade to "nothing to show" rather than
    // taking the screen down.
    try {
      setFindings(result?.findings ? (JSON.parse(result.findings) as SavedFinding[]) : []);
    } catch {
      setFindings([]);
    }
    setState("ready");
    if (result) {
      // What the signed-in user has already voted, so the screen does not offer to approve
      // something that is already approved.
      setDecision(
        await rpc<string>("pr_review_decision", { projectId, prId: result.pr_id }).catch(() => null),
      );
    }
  }, [id, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const bar = (
    <PushBar
      title={`#${prId} · ${t("pr.iteration", { n: iter })}`}
      subtitle={detail ? undefined : t("common.loading")}
      actions={
        decision && decision !== "none" ? (
          <Badge tone={decision === "approved" ? "success" : "warning"}>
            {decision === "approved" ? t("pr.approved") : t("pr.changesRequested")}
          </Badge>
        ) : undefined
      }
    />
  );

  if (state === "loading") {
    return (
      <Screen bar={bar}>
        <div className="mt-4 space-y-2" role="status" aria-label={t("common.loading")}>
          {[70, 90, 55, 80].map((width, index) => (
            <Skeleton key={index} className="h-4" style={{ width: `${width}%` }} />
          ))}
        </div>
      </Screen>
    );
  }

  if (state === "error") {
    return (
      <Screen bar={bar}>
        <ErrorState title={t("pr.detailFailed")} detail={failure} onRetry={() => void load()} />
      </Screen>
    );
  }

  if (!detail) {
    return (
      <Screen bar={bar}>
        <EmptyState icon={<ScanText size={26} aria-hidden />} title={t("common.empty")} />
      </Screen>
    );
  }

  // The scope moved under this screen. The stack pops on a project change, but a pop is a frame or
  // two away and this screen's buttons write to somebody else's pull request — so they are replaced
  // rather than merely disabled, which would read as "loading".
  const sameProject = currentProject === projectId;

  /**
   * The findings this screen is about — `abierto` **and** `posteado`.
   *
   * Which is the backend's own definition of active (`MemoryFinding::is_active`), and this used to
   * hold a second, narrower one. The cost was not academic: publishing every finding flips them all
   * to `posteado`, so the screen you were standing on emptied itself and announced *"Esta revisión
   * no encontró hallazgos"* about the five findings it had just published.
   */
  const active = findings.filter(
    (f) => f.estado === "abierto" || f.estado === "posteado" || !f.estado,
  );
  const chosen = active.filter((f) => picked.has(f.id));

  const act = (action: string, success: string) =>
    void run(
      async () => {
        await rpc<unknown>("act_on_pull_request", { projectId, prId: detail.pr_id, action });
        await load();
      },
      "review",
      success,
    );

  const publish = () =>
    void run(
      async () => {
        const items = chosen.map((f) => ({
          // Non-optional on the wire, so an unknown file is sent as `null` rather than as an empty
          // string — the backend matches a finding back to its stored thread on `file + category`,
          // and `""` is a file name that matches nothing.
          file: f.archivo ?? null,
          category: f.categoria,
          // The body the desktop would have posted, rendered when the run was saved. See
          // `publishable`: a finding without one is never in this list.
          content: f.comentario_md ?? "",
          location: locationOf(f),
        }));
        await rpc<void>("post_pr_review_comment", {
          projectId,
          prId: detail.pr_id,
          runId: detail.id,
          items,
          postSummary: false,
          summary: null,
        });
        setPicked(new Set());
        await load();
      },
      "review",
      t("toast.published"),
    );

  const discard = (finding: SavedFinding) =>
    void run(
      async () => {
        await rpc<unknown>("discard_pr_finding", {
          projectId,
          prId: detail.pr_id,
          runId: detail.id,
          findingId: finding.id,
          estado: "falso_positivo",
          motivo: null,
          // Neither of these is offered on a phone, and both default to the quiet answer. A
          // repository-wide suppression rule silences this finding in *every future review* of the
          // repo, and notifying the host posts a public reply — two decisions that deserve the
          // desktop's fuller UI rather than a phone's yes/no.
          scopeRepo: false,
          notifyHost: false,
        });
        await load();
      },
      "review",
      t("toast.discarded"),
    );

  return (
    <Screen bar={bar} onRefresh={load}>
      {!sameProject ? (
        <Card padded className="mt-3 border-[var(--cf-warning)]/40 bg-[var(--cf-warning-soft)]">
          <p className="text-base text-[var(--cf-warning-text)]">{t("pr.otherProject")}</p>
        </Card>
      ) : (
        /* The vote. First, because it is what you came to do. */
        <div className="mt-3 flex gap-2">
          <ConfirmAction
            label={t("pr.approve")}
            confirmLabel={t("pr.approveConfirm")}
            icon={<ThumbsUp size={13} />}
            variant="success"
            disabled={busy}
            onConfirm={() => act("approve", t("toast.prApproved"))}
          />
          <ConfirmAction
            label={t("pr.requestChanges")}
            confirmLabel={t("pr.requestChangesConfirm")}
            icon={<XCircle size={13} />}
            variant="primary"
            disabled={busy}
            onConfirm={() => act("request_changes", t("toast.prChangesRequested"))}
          />
        </div>
      )}

      {/* Findings, each with a tick for publishing and a way to dismiss it.
          The two empty states are different sentences: a review that found nothing, and a review
          whose findings have all been answered. Collapsing them told somebody who had just closed
          five findings that the engine had never found any. */}
      {active.length === 0 ? (
        <EmptyState
          icon={<CheckCheck size={26} aria-hidden />}
          title={findings.length === 0 ? t("pr.noFindings") : t("pr.allResolved", { n: findings.length })}
        />
      ) : (
        <Section title={`${t("pr.findings")} · ${active.length}`}>
          <ul className="space-y-1.5">
            {active.map((finding) => {
              const posted = finding.estado === "posteado";
              const canPublish = publishable(finding);
              const tone = severityTone(finding.severity);
              return (
                <li
                  key={finding.id}
                  className={`overflow-hidden rounded-lg border border-l-[3px] border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2 shadow-card ${SEVERITY_EDGE[tone]}`}
                >
                  <div className="flex items-start gap-2">
                    {canPublish ? (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={picked.has(finding.id)}
                        aria-label={posted ? t("pr.reply") : t("pr.publish")}
                        onClick={() =>
                          setPicked((current) => {
                            const next = new Set(current);
                            if (next.has(finding.id)) next.delete(finding.id);
                            else next.add(finding.id);
                            return next;
                          })
                        }
                        className="cf-tap cf-press flex shrink-0 items-center justify-center pr-1"
                      >
                        <span
                          className={`flex h-[1.15rem] w-[1.15rem] items-center justify-center rounded-[0.3rem] border-2 ${
                            picked.has(finding.id)
                              ? "border-[var(--cf-accent-strong)] bg-[var(--cf-accent-strong)] text-[var(--cf-accent-contrast)]"
                              : "border-[var(--cf-field-border)]"
                          }`}
                        >
                          {picked.has(finding.id) && <CheckCheck size={11} aria-hidden />}
                        </span>
                      </button>
                    ) : (
                      // No tick at all rather than a disabled one: there is nothing to opt into.
                      // The row keeps the same indent so the list does not comb.
                      <span className="w-6 shrink-0" aria-hidden />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-base leading-snug">{finding.subtitulo}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs uppercase tracking-wide text-[var(--cf-text-muted)]">
                        <Badge tone={tone}>{finding.severity}</Badge>
                        <span>{finding.categoria}</span>
                        {finding.archivo && <span className="truncate normal-case">{finding.archivo}</span>}
                        {/* Says which thread it lives on, so "publish" reading as "reply" below has
                            a reason on screen rather than only in the code. */}
                        {posted && <Badge tone="accent">{t("pr.posted")}</Badge>}
                      </p>
                      {!canPublish && (
                        <p className="mt-1 text-2xs leading-snug text-[var(--cf-text-faint)]">
                          {t("pr.publishUnavailable")}
                        </p>
                      )}
                    </div>
                    <IconButton
                      icon={<X size={15} />}
                      label={t("pr.discard")}
                      disabled={busy || !sameProject}
                      onClick={() => discard(finding)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>

          {/* `chosen`, not `picked`: a reload can retire a finding that was ticked — somebody at the
              desk dismissed it — and counting the ticks would then offer to publish more than would
              actually be sent. */}
          {chosen.length > 0 && sameProject && (
            <div className="mt-3 flex">
              {/* "Responder" once anything picked is already posted: the backend replies on the
                  existing thread and marks it, it does not open a second one. Calling that
                  "publicar" would promise a new comment that never appears. */}
              <ConfirmAction
                label={
                  chosen.some((f) => f.estado === "posteado")
                    ? t("pr.replyCount", { n: chosen.length })
                    : t("pr.publishCount", { n: chosen.length })
                }
                confirmLabel={t("pr.publishConfirm")}
                icon={<Send size={13} />}
                variant="primary"
                disabled={busy}
                onConfirm={publish}
              />
            </div>
          )}
        </Section>
      )}

      {/* What the review was *about*. Downloaded on every load of this screen and, until recently,
          drawn nowhere — while the two buttons at the top of the same screen offered to approve it.
          Voting on a change you have not been shown is the sharpest version of not being able to see
          what a change is. */}
      {detail.diff && <PrDiff diff={detail.diff} />}

      {/* The prose the engine wrote, last — it is the long read, not the thing you act on.
          Preformatted rather than through a markdown renderer: the desktop pulls in `marked` plus
          `dompurify` for this, and shipping both to a phone to make headings bold is a poor trade. */}
      {detail.review_md && (
        <Section title={t("pr.reviewText")}>
          <Card padded>
            <p className="cf-prose text-[var(--cf-text-muted)]">{detail.review_md}</p>
          </Card>
        </Section>
      )}
    </Screen>
  );
}
