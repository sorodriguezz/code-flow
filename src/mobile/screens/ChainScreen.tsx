import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, CircleAlert, FolderGit2 } from "lucide-react";
import { t, type MobileKey } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
import { useNav } from "../nav";
import { onInvalidate } from "../invalidate";
import { clearDraft, readDraft, writeDraft } from "../drafts";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Button } from "../ui/Button";
import { Card, Divider, Section } from "../ui/List";
import { Badge, ErrorState, SkeletonList } from "../ui/Feedback";
import { ChainBadge, STATUS_KEY, stepLabel } from "./AgentsScreen";
import type { AgentChainStep, ChainDetail } from "../../types/domain";

/**
 * One chain: what it is waiting for, what it has done, and the three ways to unstick it.
 *
 * # Why this screen owns its own data
 *
 * It used to be `openChain` in the global store, refetched by `refreshChains`. Two things followed
 * from that and both were bugs. The chain survived every tab switch, so the Agents tab had no list
 * to come back to — tapping the tab re-entered the chain, forever, while the badge on that same tab
 * counted gates the user could not reach. And a `get_chain_detail` that answered `null`, which is
 * what a chain deleted at the desk looks like, silently replaced the screen somebody was reading
 * with the list, mid-scroll, with no message.
 *
 * Owned here, the chain is exactly as alive as the screen showing it, and "this chain is gone" is a
 * sentence rather than a disappearance.
 */

/**
 * The reasons the backend writes as keys rather than as prose, ported from
 * `src/components/agents/chainStatus.ts`.
 *
 * Both columns this reads — `chain.last_reason` and `step.last_error` — hold *either* one of these
 * keys or a raw engine error, and nothing marks which. So anything not listed falls through
 * verbatim; that passthrough is not a fallback, it is half the contract. Without it a chain that
 * died on a real error would show nothing, and without the table the phone showed the literal string
 * `chain.repoBusy` where the desktop showed a sentence.
 *
 * The twelve keys the desktop knows minus the two that only ever come back from *creating* a chain
 * (`noSteps`, `tooManySteps`) — a phone cannot create one, so they can never land in these columns.
 */
const REASON_KEYS: Record<string, MobileKey> = {
  "chain.interrupted": "chain.interrupted",
  "chain.repoBusy": "chain.repoBusy",
  "chain.projectGone": "chain.projectGone",
  "chain.agentNotRoutable": "chain.agentNotRoutable",
  "chain.attemptsExhausted": "chain.attemptsExhausted",
  "chain.checkFailed": "chain.checkFailed",
  "chain.dispatchesExhausted": "chain.dispatchesExhausted",
  "chain.emptyOutput": "chain.emptyOutput",
  "chain.stopped": "chain.stopped",
  "chain.timedOut": "chain.timedOut",
};

/**
 * What `approve_chain_gate` answers when the step named in the request is not the one the chain is
 * parked at. Must match `queries::GATE_MOVED`.
 *
 * Kept out of [`REASON_KEYS`] on purpose: that table is for the two *columns* that hold keys, and
 * this one is never written to either — it is refused before anything is written at all.
 */
const GATE_MOVED = "chain.gateMoved";

function reasonText(reason: string | null | undefined): string {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) return "";
  const key = REASON_KEYS[trimmed];
  return key ? t(key) : trimmed;
}

function stepTone(status: string): "success" | "danger" | "accent" | "neutral" | "warning" {
  if (status === "done") return "success";
  if (status === "failed") return "danger";
  if (status === "running") return "accent";
  if (status === "pending") return "warning";
  return "neutral";
}

/**
 * One step, with its output behind a tap.
 *
 * `output_text` has always been on the wire and was never drawn. It is the single most useful thing
 * on this screen for the decision the screen exists to support: approving a gate means saying yes to
 * what the *previous* step produced, and until now that could only be read at the desk.
 */
function StepRow({ step }: { step: AgentChainStep }) {
  const [open, setOpen] = useState(false);
  const output = step.output_text?.trim();
  const error = reasonText(step.last_error);

  return (
    <div>
      <button
        type="button"
        disabled={!output && !error}
        aria-expanded={output || error ? open : undefined}
        onClick={() => setOpen((v) => !v)}
        className="cf-tap cf-press-row flex w-full items-start gap-2 px-3 py-2.5 text-left disabled:opacity-100"
      >
        <span className="mt-0.5 w-5 shrink-0 text-xs tabular-nums text-[var(--cf-text-faint)]">
          {step.step_index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base">{step.agent_name || step.prompt}</span>
          <span className="block truncate text-xs text-[var(--cf-text-muted)]">
            {step.project_name}
            {error ? ` · ${error}` : ""}
          </span>
        </span>
        <Badge tone={stepTone(step.status)}>{step.status}</Badge>
        {(output || error) &&
          (open ? (
            <ChevronDown size={14} className="mt-0.5 shrink-0 text-[var(--cf-text-faint)]" aria-hidden />
          ) : (
            <ChevronRight size={14} className="mt-0.5 shrink-0 text-[var(--cf-text-faint)]" aria-hidden />
          ))}
      </button>
      {open && output && (
        <div className="px-3 pb-2.5">
          <p className="cf-prose cf-scroll max-h-72 rounded-md bg-[var(--cf-sunken)] p-2.5 text-[var(--cf-text-muted)]">
            {output}
          </p>
        </div>
      )}
    </div>
  );
}

export function ChainScreen({ chainId, title }: { chainId: string; title: string }) {
  const run = useMobileStore((s) => s.run);
  const refreshChains = useMobileStore((s) => s.refreshChains);
  const busy = useBusy("chains");
  const back = useNav((s) => s.back);
  const [detail, setDetail] = useState<ChainDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone" | "error">("loading");
  const [failure, setFailure] = useState<string | null>(null);
  const [answer, setAnswer] = useState(() => readDraft("gate", chainId));
  const [confirmAbort, setConfirmAbort] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await rpc<ChainDetail | null>("get_chain_detail", { chainId });
      if (!result) {
        // The chain was deleted or archived at the desk. Said, with the back control still there,
        // rather than replacing the screen under somebody who may be mid-sentence in the gate box.
        setState("gone");
        return;
      }
      setDetail(result);
      setState("ready");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, [chainId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A gate answered at the desk, a step that finished, the chain aborted from another device.
  useEffect(() => onInvalidate("chains", null, () => void load()), [load]);

  /**
   * Runs one chain command.
   *
   * `consumesAnswer` is not a detail: this is the single entry point for five commands and only two
   * of them read the gate box. It used to clear the draft for all five, so somebody halfway through
   * a long answer whose chain flipped to `failed` under them — which happens on any `ai:done` — lost
   * every word they had typed by tapping "Reintentar", and the retry parked on the same gate again
   * with an empty box.
   */
  const act = (
    cmd: string,
    success: string,
    extra: Record<string, unknown> = {},
    consumesAnswer = false,
  ) =>
    void run(
      async () => {
        try {
          await rpc<unknown>(cmd, { chainId, ...extra });
        } catch (e) {
          // A refused precondition comes back as a translation key rather than a sentence — the same
          // convention `last_reason` follows, and for the same reason: the language belongs to the
          // reader.
          if (e instanceof Error && e.message === GATE_MOVED) throw new Error(t("chain.gateMoved"));
          throw e;
        }
        if (consumesAnswer) {
          setAnswer("");
          clearDraft("gate", chainId);
        }
        setConfirmAbort(false);
        // Both, and both explicitly.
        //
        // `store.run` documents itself as not refetching, because every mutating command makes the
        // desktop emit and the frame comes back down this client's own socket. That holds for
        // somebody else's change and not for this one: the frame router drops an invalidation whose
        // `origin` is this device, precisely so a tap does not cost the same read twice — so a chain
        // acted on *from here* is the one case where nothing arrives to trigger the refresh. Without
        // these two lines, approving a gate left the step list and the tab badge exactly as they
        // were until something unrelated happened to fire.
        await load();
        await refreshChains();
      },
      "chains",
      success,
    );

  if (state === "loading") {
    return (
      <Screen bar={<PushBar title={title} subtitle={t("common.loading")} />}>
        <Section title={t("chains.steps")}>
          <SkeletonList rows={4} />
        </Section>
      </Screen>
    );
  }

  if (state === "gone") {
    return (
      <Screen bar={<PushBar title={title} />}>
        <div className="flex flex-col items-center px-8 pb-10 pt-16 text-center">
          <CircleAlert size={26} className="text-[var(--cf-text-muted)]" aria-hidden />
          <p className="mt-3 text-md font-medium">{t("chains.gone")}</p>
          <Button className="mt-4" onClick={back}>
            {t("common.back")}
          </Button>
        </div>
      </Screen>
    );
  }

  if (state === "error" || !detail) {
    return (
      <Screen bar={<PushBar title={title} />}>
        <ErrorState title={t("chains.failed")} detail={failure} onRetry={() => void load()} />
      </Screen>
    );
  }

  const { chain, steps, repos } = detail;
  const gated = chain.status === "gated";
  /** The step the gate above is drawn from — the backend's own "next pending step". */
  const waiting = steps.find((step) => step.status === "pending");
  const reason = reasonText(chain.last_reason);

  return (
    <Screen
      onRefresh={() => load()}
      bar={
        <PushBar
          title={chain.title}
          subtitle={t("chains.step", { current: stepLabel(chain), total: chain.step_count })}
          actions={<ChainBadge status={chain.status} />}
        />
      }
    >
      {/* The gate, first and unmissable when it is open — before the step list, because the step
          list is context and this is the thing being asked. */}
      {gated && (
        <Card raised padded className="mt-3 border-[var(--cf-accent)]/40 bg-[var(--cf-accent-soft)]">
          <p className="text-base font-semibold text-[var(--cf-accent-text)]">
            {t("chains.gateWaiting")}
          </p>
          {/* The handoff the chain froze at the gate. This is what the next step will be sent, so
              it is what the user is actually approving — showing the step list without it would be
              asking somebody to sign something they cannot read.

              Read off `waiting` rather than off `steps[chain.current_step]`, so the text shown and
              the step named in the approval below are the same row by construction. Two independent
              ways of finding "the step the gate is on" is how a screen ends up displaying one and
              approving another. */}
          {waiting?.pending_input && (
            <>
              <p className="mt-2 text-xs font-semibold text-[var(--cf-text-faint)]">
                {t("chains.handoff")}
              </p>
              <p className="cf-prose cf-scroll mt-1 max-h-56 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2.5 text-[var(--cf-text-muted)]">
                {waiting.pending_input}
              </p>
            </>
          )}
          <label
            htmlFor="cf-gate-answer"
            className="mt-3 block text-xs font-semibold text-[var(--cf-text-faint)]"
          >
            {t("chains.gateAnswer")}
          </label>
          <textarea
            id="cf-gate-answer"
            value={answer}
            onChange={(e) => {
              setAnswer(e.target.value);
              writeDraft("gate", chainId, e.target.value);
            }}
            placeholder={t("chains.gatePlaceholder")}
            rows={3}
            className="mt-1 w-full resize-none rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2 outline-none focus:border-[var(--cf-accent)]"
          />
          <Button
            full
            size="lg"
            variant="primary"
            className="mt-2"
            loading={busy}
            // An empty answer is allowed and means "carry on unchanged" — the backend treats a
            // blank input as the handoff standing as it is. Requiring text would make the common
            // case (approve as-is) the one that needs typing on a phone keyboard.
            //
            // `stepId` is a precondition and not a target. A phone screen is a photograph: this
            // gate may have been answered at the desk minutes ago, the chain may have run two more
            // steps and parked on a *different* gate, and without this the tap would clear that one
            // — approving something nobody read and pulling a chain mid-run back to `queued`.
            onClick={() =>
              act(
                "approve_chain_gate",
                t("toast.gateApproved"),
                { input: answer, stepId: waiting?.id ?? null },
                true,
              )
            }
          >
            {t("chains.approve")}
          </Button>
          <Button
            full
            size="sm"
            className="mt-1.5"
            disabled={busy}
            onClick={() => act("skip_chain_step", t("toast.stepSkipped"), {}, true)}
          >
            {t("chains.skip")}
          </Button>
        </Card>
      )}

      {/* Recovery actions, for a chain that stopped rather than one that is asking. */}
      {(chain.status === "failed" || chain.status === "paused") && (
        <Card raised padded className="mt-3">
          {reason && <p className="mb-2 text-base text-[var(--cf-text-muted)]">{reason}</p>}
          <Button
            full
            size="lg"
            variant="primary"
            loading={busy}
            onClick={() =>
              chain.status === "failed"
                ? act("retry_chain_step", t("toast.stepRetried"))
                : act("resume_chain", t("toast.chainResumed"))
            }
          >
            {chain.status === "failed" ? t("chains.retry") : t("chains.resume")}
          </Button>
        </Card>
      )}

      {reason && chain.status !== "failed" && chain.status !== "paused" && (
        <p className="mt-3 px-1 text-xs leading-snug text-[var(--cf-text-muted)]">{reason}</p>
      )}

      {/* Which repositories this chain works across. `repos` has always been on the wire and was
          never drawn, so a chain touching three checkouts looked exactly like one touching this
          project — which matters, because approving its gate lets it write to all of them. */}
      {repos.length > 1 && (
        <Section title={t("chains.repos")}>
          <Card>
            {repos.map((repo, index) => (
              <div key={repo.project_id}>
                {index > 0 && <Divider inset />}
                <div className="flex items-center gap-2.5 px-3 py-2">
                  <FolderGit2 size={15} className="text-[var(--cf-text-muted)]" aria-hidden />
                  <span className="truncate text-base">{repo.name}</span>
                </div>
              </div>
            ))}
          </Card>
        </Section>
      )}

      <Section title={t("chains.steps")}>
        <Card>
          {steps.map((step, index) => (
            <div key={step.id}>
              {index > 0 && <Divider />}
              <StepRow step={step} />
            </div>
          ))}
        </Card>
      </Section>

      {/* Abort last, behind a confirmation, and never the first thing a thumb finds. It is the one
          irreversible action this client has. */}
      {chain.status !== "done" && chain.status !== "aborted" && (
        <div className="mt-6">
          {confirmAbort ? (
            <Card padded className="border-[var(--cf-danger)]/40">
              <p className="text-base">{t("chains.abortConfirm")}</p>
              <div className="mt-2 flex gap-2">
                <Button full size="sm" onClick={() => setConfirmAbort(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  full
                  size="sm"
                  variant="danger"
                  loading={busy}
                  onClick={() => act("abort_chain", t("toast.chainAborted"))}
                >
                  {t("chains.abort")}
                </Button>
              </div>
            </Card>
          ) : (
            <Button full variant="ghost" size="sm" onClick={() => setConfirmAbort(true)}>
              {t("chains.abort")}
            </Button>
          )}
        </div>
      )}

      {/* The status in words, once, at the very bottom — the badge in the bar is a glance and this
          is the sentence for anybody who needs one. */}
      <p className="mt-6 px-1 text-center text-xs text-[var(--cf-text-faint)]">
        {t(STATUS_KEY[chain.status])}
      </p>
    </Screen>
  );
}
