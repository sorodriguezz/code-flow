import { useState } from "react";
import { ChevronLeft, CircleDot, Loader2, PauseCircle, TriangleAlert } from "lucide-react";
import { t, type MobileKey } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
import type { AgentChain, ChainStatus } from "../../types/domain";

/**
 * Chains, and the gate.
 *
 * This is the screen the whole remote-control feature exists for. A chain that reaches a gate stops
 * and stays stopped until a person answers it — so being able to answer from wherever you are is
 * the difference between a plan finishing over lunch and a plan finishing when you get back to the
 * desk. Everything else in this client is convenience; this is the part that changes an outcome.
 */

const STATUS_KEY: Record<ChainStatus, MobileKey> = {
  queued: "chainStatus.queued",
  running: "chainStatus.running",
  gated: "chainStatus.gated",
  paused: "chainStatus.paused",
  failed: "chainStatus.failed",
  done: "chainStatus.done",
  aborted: "chainStatus.aborted",
};

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

function statusTone(status: ChainStatus): string {
  switch (status) {
    case "gated":
      // The one status that is a request rather than a report, so it is the one that gets the
      // accent. A screen of grey rows with one indigo badge answers "does anything need me?"
      // before the user has read a word.
      return "text-[var(--cf-accent)] bg-[var(--cf-accent)]/15";
    case "running":
      return "text-[var(--cf-success)] bg-[var(--cf-success)]/15";
    case "failed":
      return "text-[var(--cf-danger)] bg-[var(--cf-danger)]/15";
    case "done":
      return "text-[var(--cf-text-muted)] bg-[var(--cf-border)]/50";
    default:
      return "text-[var(--cf-warning)] bg-[var(--cf-warning)]/15";
  }
}

function StatusIcon({ status }: { status: ChainStatus }) {
  if (status === "running") return <Loader2 size={13} className="animate-spin" />;
  if (status === "gated") return <CircleDot size={13} />;
  if (status === "failed") return <TriangleAlert size={13} />;
  if (status === "paused" || status === "queued") return <PauseCircle size={13} />;
  return null;
}

function ChainRow({ chain, onOpen }: { chain: AgentChain; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="cf-tap flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{chain.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-[var(--cf-text-muted)]">
          {t("chains.step", { current: chain.current_step + 1, total: chain.step_count })}
        </span>
      </span>
      <span
        className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(chain.status)}`}
      >
        <StatusIcon status={chain.status} />
        {t(STATUS_KEY[chain.status])}
      </span>
    </button>
  );
}

/** The open chain: its steps, and — when it is waiting — the box that answers the gate. */
function ChainDetailView({ onBack }: { onBack: () => void }) {
  const { openChain, run } = useMobileStore();
  const busy = useBusy("chains");
  const [answer, setAnswer] = useState("");
  const [confirmAbort, setConfirmAbort] = useState(false);

  if (!openChain) return null;
  const { chain, steps } = openChain;
  const gated = chain.status === "gated";
  /** The step the gate above is drawn from — the backend's own "next pending step". */
  const waiting = steps.find((step) => step.status === "pending");

  const act = (cmd: string, extra: Record<string, unknown> = {}) =>
    void run(async () => {
      try {
        await rpc<unknown>(cmd, { chainId: chain.id, ...extra });
      } catch (e) {
        // A refused precondition comes back as a translation key rather than a sentence — the same
        // convention `last_reason` follows, and for the same reason: the language belongs to the
        // reader. `run` files what it catches straight into the banner, so it is turned into words
        // here, where the table that knows the keys already is.
        if (e instanceof Error && e.message === GATE_MOVED) throw new Error(t("chain.gateMoved"));
        throw e;
      }
      setAnswer("");
      setConfirmAbort(false);
    }, "chains");

  return (
    <div className="cf-scroll flex-1 pb-6">
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-[var(--cf-border)] bg-[var(--cf-bg)] px-1 py-1.5">
        <button type="button" onClick={onBack} className="cf-tap flex items-center px-2 text-[13px]">
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{chain.title}</span>
        <span
          className={`mr-2 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(chain.status)}`}
        >
          {t(STATUS_KEY[chain.status])}
        </span>
      </div>

      {/* The gate, first and unmissable when it is open — before the step list, because the step
          list is context and this is the thing being asked. */}
      {gated && (
        <div className="mx-3 mt-3 rounded-lg border border-[var(--cf-accent)]/40 bg-[var(--cf-accent)]/8 p-3">
          <p className="text-[13px] font-medium text-[var(--cf-accent)]">{t("chains.gateWaiting")}</p>
          {/* The handoff the chain froze at the gate. This is what the next step will be sent, so
              it is what the user is actually approving — showing the step list without it would be
              asking somebody to sign something they cannot read.

              Read off `waiting` rather than off `steps[chain.current_step]`, so the text shown and
              the step named in the approval below are the same row by construction. Two independent
              ways of finding "the step the gate is on" is how a screen ends up displaying one and
              approving another. */}
          {waiting?.pending_input && (
            <p className="cf-log mt-2 max-h-48 overflow-y-auto rounded border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2 text-[var(--cf-text-muted)]">
              {waiting.pending_input}
            </p>
          )}
          <label className="mt-2.5 block text-[11px] text-[var(--cf-text-muted)]">
            {t("chains.gateAnswer")}
          </label>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={t("chains.gatePlaceholder")}
            rows={3}
            className="mt-1 w-full resize-none rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2 outline-none focus:border-[var(--cf-accent)]"
          />
          <button
            type="button"
            disabled={busy}
            // An empty answer is allowed and means "carry on unchanged" — the backend treats a
            // blank input as the handoff standing as it is. Requiring text would make the common
            // case (approve as-is) the one that needs typing on a phone keyboard.
            //
            // `stepId` is a precondition and not a target. A phone screen is a photograph: this
            // gate may have been answered at the desk minutes ago, the chain may have run two more
            // steps and parked on a *different* gate, and without this the tap would clear that one
            // — approving something nobody read and pulling a chain mid-run back to `queued`. A
            // mismatch comes back as `chain.gateMoved`, and the invalidation that follows redraws
            // the screen with the gate that is actually open.
            onClick={() => act("approve_chain_gate", { input: answer, stepId: waiting?.id ?? null })}
            className="cf-tap mt-2 w-full rounded-lg bg-[var(--cf-accent)] text-[15px] font-medium text-white disabled:opacity-40"
          >
            {t("chains.approve")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => act("skip_chain_step")}
            className="cf-tap mt-1.5 w-full rounded-lg border border-[var(--cf-border)] text-[13px] disabled:opacity-40"
          >
            {t("chains.skip")}
          </button>
        </div>
      )}

      {/* Recovery actions, for a chain that stopped rather than one that is asking */}
      {(chain.status === "failed" || chain.status === "paused") && (
        <div className="mx-3 mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => act(chain.status === "failed" ? "retry_chain_step" : "resume_chain")}
            className="cf-tap flex-1 rounded-lg bg-[var(--cf-accent)] text-[13px] font-medium text-white disabled:opacity-40"
          >
            {chain.status === "failed" ? t("chains.retry") : t("chains.resume")}
          </button>
        </div>
      )}

      {reasonText(chain.last_reason) && (
        <p className="mx-3 mt-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {reasonText(chain.last_reason)}
        </p>
      )}

      {/* Steps */}
      <ul className="mx-3 mt-3 divide-y divide-[var(--cf-border)] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-2 px-3 py-2">
            <span className="mt-0.5 w-5 shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
              {step.step_index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px]">{step.agent_name || step.prompt}</span>
              <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                {step.project_name}
                {reasonText(step.last_error) ? ` · ${reasonText(step.last_error)}` : ""}
              </span>
            </span>
            <span className="shrink-0 text-[10px] text-[var(--cf-text-muted)]">{step.status}</span>
          </li>
        ))}
      </ul>

      {/* Abort last, behind a confirmation, and never the first thing a thumb finds. It is the one
          irreversible action this client has. */}
      {chain.status !== "done" && chain.status !== "aborted" && (
        <div className="mx-3 mt-4">
          {confirmAbort ? (
            <div className="rounded-lg border border-[var(--cf-danger)]/40 p-3">
              <p className="text-[12.5px] text-[var(--cf-text)]">{t("chains.abortConfirm")}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmAbort(false)}
                  className="cf-tap flex-1 rounded-lg border border-[var(--cf-border)] text-[13px]"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act("abort_chain")}
                  className="cf-tap flex-1 rounded-lg bg-[var(--cf-danger)] text-[13px] font-medium text-white disabled:opacity-40"
                >
                  {t("chains.abort")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmAbort(true)}
              className="cf-tap w-full text-[12px] text-[var(--cf-text-muted)]"
            >
              {t("chains.abort")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ChainsScreen() {
  const { chains, openChain, openChainDetail } = useMobileStore();

  if (openChain) return <ChainDetailView onBack={() => void openChainDetail(null)} />;

  if (chains.length === 0) {
    return <p className="p-6 text-center text-[13px] text-[var(--cf-text-muted)]">{t("chains.none")}</p>;
  }

  // Gated chains first: they are the only rows that are a question, and a question belongs above
  // the answers. Within each group the backend's order is kept.
  const sorted = [...chains].sort((a, b) => {
    const rank = (c: AgentChain) => (c.status === "gated" ? 0 : c.status === "running" ? 1 : 2);
    return rank(a) - rank(b);
  });

  return (
    <div className="cf-scroll flex-1 px-3 pb-6">
      <div className="mt-3 divide-y divide-[var(--cf-border)] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
        {sorted.map((chain) => (
          <ChainRow key={chain.id} chain={chain} onOpen={() => void openChainDetail(chain.id)} />
        ))}
      </div>
    </div>
  );
}
