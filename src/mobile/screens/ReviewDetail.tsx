import { useEffect, useState } from "react";
import {
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Send,
  ThumbsUp,
  X,
  XCircle,
} from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
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
 * Not a second settings switch, though, unlike terminals. A shell is unbounded; approving a pull
 * request is a specific, reversible act on something somebody already published, and it is one of
 * the main reasons to want a control surface at all.
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
function locationOf(finding: SavedFinding): { file: string; startLine: number; endLine: number } | null {
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

function severityTone(severity: string): string {
  const key = severity.toLowerCase();
  if (key.startsWith("crit") || key.startsWith("alt") || key.startsWith("high")) {
    return "text-[var(--cf-danger)] border-[var(--cf-danger)]/40";
  }
  if (key.startsWith("med") || key.startsWith("warn")) {
    return "text-[var(--cf-warning)] border-[var(--cf-warning)]/40";
  }
  return "text-[var(--cf-text-muted)] border-[var(--cf-border)]";
}

/** A button that asks once before doing something other people will see. */
function ConfirmAction({
  label,
  confirmLabel,
  icon,
  tone,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  icon: React.ReactNode;
  tone: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  // Disarms itself. A confirmation left armed becomes a one-tap button again by the time the user
  // comes back to the screen, which is exactly what the confirmation was for.
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(id);
  }, [armed]);

  if (!armed) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setArmed(true)}
        className={`cf-tap flex flex-1 items-center justify-center gap-1.5 rounded-lg border text-[12px] disabled:opacity-40 ${tone}`}
      >
        {icon} {label}
      </button>
    );
  }

  return (
    <span className="flex flex-1 gap-1">
      <button
        type="button"
        onClick={() => setArmed(false)}
        aria-label={t("common.cancel")}
        className="cf-tap flex w-11 items-center justify-center rounded-lg border border-[var(--cf-border)]"
      >
        <X size={13} />
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
        className={`cf-tap flex flex-1 items-center justify-center gap-1.5 rounded-lg text-[12px] font-medium text-white disabled:opacity-40 ${tone.includes("danger") ? "bg-[var(--cf-danger)]" : "bg-[var(--cf-accent)]"}`}
      >
        {confirmLabel}
      </button>
    </span>
  );
}

/** The pull request's diff, behind one tap. */
function PrDiff({ diff }: { diff: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-3 mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="cf-tap flex w-full items-center gap-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {t("pr.diff")}
      </button>
      {open && (
        <div className="mt-1 overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] py-1">
          <UnifiedDiffText text={diff} />
        </div>
      )}
    </div>
  );
}

export function ReviewDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { projectId, run } = useMobileStore();
  // The same group `PrScreen` starts a review under: approving a PR, publishing findings and
  // discarding one are all about the same review run, and none of them should be reachable while
  // another is in flight.
  const busy = useBusy("review");
  const [detail, setDetail] = useState<ReviewRunDetail | null>(null);
  const [findings, setFindings] = useState<SavedFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState<string | null>(null);
  /** Which findings the user has ticked for publishing. Nothing is ticked by default — publishing
   *  is opt-in per finding, exactly as the desktop's own list is. */
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    const result = await rpc<ReviewRunDetail | null>("get_review_run", { id }).catch(() => null);
    setDetail(result);
    // The findings arrive as a JSON string on the row, exactly as the desktop reads them. Parsed
    // defensively: a run written by a newer version must degrade to "nothing to show" rather than
    // taking the screen down.
    try {
      setFindings(result?.findings ? (JSON.parse(result.findings) as SavedFinding[]) : []);
    } catch {
      setFindings([]);
    }
    setLoading(false);
    if (result && projectId) {
      // What the signed-in user has already voted, so the screen does not offer to approve
      // something that is already approved.
      setDecision(
        await rpc<string>("pr_review_decision", { projectId, prId: result.pr_id }).catch(() => null),
      );
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, projectId]);

  if (loading) {
    return <Loader2 size={16} className="mx-auto mt-8 animate-spin text-[var(--cf-text-muted)]" />;
  }
  if (!detail || !projectId) {
    return <p className="p-6 text-center text-[13px] text-[var(--cf-text-muted)]">{t("common.empty")}</p>;
  }

  /**
   * The findings this screen is about — `abierto` **and** `posteado`.
   *
   * Which is the backend's own definition of active (`MemoryFinding::is_active`), and this used to
   * hold a second, narrower one. The cost was not academic: publishing every finding flips them all
   * to `posteado`, so the screen you were standing on emptied itself and announced *"Esta revisión
   * no encontró hallazgos"* about the five findings it had just published. Meanwhile the row in
   * `PrScreen` counts every state, so the list said 5 and the detail said nothing.
   */
  const active = findings.filter(
    (f) => f.estado === "abierto" || f.estado === "posteado" || !f.estado,
  );
  const chosen = active.filter((f) => picked.has(f.id));

  const act = (action: string) =>
    void run(async () => {
      await rpc<unknown>("act_on_pull_request", { projectId, prId: detail.pr_id, action });
      await load();
    }, "review");

  const publish = () =>
    void run(async () => {
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
    }, "review");

  const discard = (finding: SavedFinding) =>
    void run(async () => {
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
    }, "review");

  return (
    <div className="cf-scroll flex-1 pb-6">
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-[var(--cf-border)] bg-[var(--cf-bg)] px-1 py-1.5">
        <button type="button" onClick={onBack} className="cf-tap flex items-center px-2">
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
          #{detail.pr_id} · {t("pr.iteration", { n: detail.iter })}
        </span>
        {decision && decision !== "none" && (
          <span className="mr-2 shrink-0 rounded-full bg-[var(--cf-border)]/50 px-2 py-0.5 text-[10px]">
            {decision === "approved" ? t("pr.approved") : t("pr.changesRequested")}
          </span>
        )}
      </div>

      {/* The vote. First, because it is what you came to do. */}
      <div className="mx-3 mt-3 flex gap-2">
        <ConfirmAction
          label={t("pr.approve")}
          confirmLabel={t("pr.approveConfirm")}
          icon={<ThumbsUp size={13} />}
          tone="border-[var(--cf-border)] text-[var(--cf-success)]"
          disabled={busy}
          onConfirm={() => act("approve")}
        />
        <ConfirmAction
          label={t("pr.requestChanges")}
          confirmLabel={t("pr.requestChangesConfirm")}
          icon={<XCircle size={13} />}
          tone="border-[var(--cf-border)] text-[var(--cf-warning)]"
          disabled={busy}
          onConfirm={() => act("request_changes")}
        />
      </div>

      {/* Findings, each with a tick for publishing and a way to dismiss it.
          The two empty states are different sentences: a review that found nothing, and a review
          whose findings have all been answered. Collapsing them told somebody who had just closed
          five findings that the engine had never found any. */}
      {active.length === 0 ? (
        <p className="mt-6 px-6 text-center text-[13px] text-[var(--cf-text-muted)]">
          {findings.length === 0 ? t("pr.noFindings") : t("pr.allResolved", { n: findings.length })}
        </p>
      ) : (
        <>
          <p className="mx-3 mt-4 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("pr.findings")} · {active.length}
          </p>
          <ul className="mx-3 mt-1 space-y-1.5">
            {active.map((finding) => {
              const posted = finding.estado === "posteado";
              const canPublish = publishable(finding);
              return (
                <li
                  key={finding.id}
                  className={`rounded-lg border px-2.5 py-2 ${severityTone(finding.severity)}`}
                >
                  <div className="flex items-start gap-2">
                    {canPublish ? (
                      <button
                        type="button"
                        aria-label={posted ? t("pr.reply") : t("pr.publish")}
                        onClick={() =>
                          setPicked((current) => {
                            const next = new Set(current);
                            if (next.has(finding.id)) next.delete(finding.id);
                            else next.add(finding.id);
                            return next;
                          })
                        }
                        className="cf-tap flex shrink-0 items-center justify-center pr-1"
                      >
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded border ${
                            picked.has(finding.id)
                              ? "border-[var(--cf-accent)] bg-[var(--cf-accent)] text-white"
                              : "border-[var(--cf-field-border)]"
                          }`}
                        >
                          {picked.has(finding.id) && <CheckCheck size={10} />}
                        </span>
                      </button>
                    ) : (
                      // No tick at all rather than a disabled one: there is nothing to opt into.
                      // The row keeps the same indent so the list does not comb.
                      <span className="w-5 shrink-0" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] leading-snug">{finding.subtitulo}</span>
                      <span className="mt-0.5 block truncate text-[10px] uppercase tracking-wide opacity-70">
                        {finding.severity} · {finding.categoria}
                        {finding.archivo ? ` · ${finding.archivo}` : ""}
                      </span>
                      {/* Says which thread it lives on, so "publish" reading as "reply" below has a
                          reason on screen rather than only in the code. */}
                      {posted && (
                        <span className="mt-1 inline-block rounded-full bg-[var(--cf-border)]/50 px-2 py-0.5 text-[10px] text-[var(--cf-text-muted)]">
                          {t("pr.posted")}
                        </span>
                      )}
                      {!canPublish && (
                        <span className="mt-1 block text-[10.5px] leading-snug opacity-70">
                          {t("pr.publishUnavailable")}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      title={t("pr.discard")}
                      onClick={() => discard(finding)}
                      className="cf-tap flex shrink-0 items-center justify-center text-[var(--cf-text-muted)]"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* `chosen`, not `picked`: a reload can retire a finding that was ticked — somebody at the
              desk dismissed it — and counting the ticks would then offer to publish more than would
              actually be sent. */}
          {chosen.length > 0 && (
            <div className="mx-3 mt-3">
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
                tone="border-[var(--cf-accent)] text-[var(--cf-accent)]"
                disabled={busy}
                onConfirm={publish}
              />
            </div>
          )}
        </>
      )}

      {/* What the review was *about*. Downloaded on every load of this screen and, until now, drawn
          nowhere — while the two buttons at the top of the same screen offered to approve it. Voting
          on a change you have not been shown is the sharpest version of not being able to see what a
          change is. Collapsed by default because the vote and the findings are what this screen is
          for and a PR diff is thousands of lines; `UnifiedDiffText` caps it again once open. */}
      {detail.diff && <PrDiff diff={detail.diff} />}

      {/* The prose the engine wrote, last — it is the long read, not the thing you act on.
          Preformatted rather than through a markdown renderer: the desktop pulls in `marked` plus
          `dompurify` for this, and shipping both to a phone to make headings bold is a poor trade. */}
      {detail.review_md && (
        <div className="mx-3 mt-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("pr.reviewText")}
          </p>
          <p className="cf-log mt-1 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2 text-[var(--cf-text-muted)]">
            {detail.review_md}
          </p>
        </div>
      )}
    </div>
  );
}
