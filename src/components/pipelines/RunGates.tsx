import { useState } from "react";
import { ExternalLink, Hand, Hourglass, Info, Play, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { openExternalUrl, playPipelineJob, reviewPipelineGate } from "../../lib/tauri/commands";
import { useCiStore } from "../../state/ciStore";
import { useConfirmStore } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { VariablesEditor, type EditorRow } from "./VariablesEditor";
import { orderGates } from "./gates";
import { confirmationLines, validateVariables, variablesToSend } from "./runInputs";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { PipelineGate, PipelineGateKind, PipelineRun, PipelineRunDetail } from "../../types/domain";

const KIND_LABEL: Record<PipelineGateKind, TranslationKey> = {
  approval: "pipelines.gateApproval",
  manual: "pipelines.gateManual",
  check: "pipelines.gateCheck",
};

const KIND_ICON: Record<PipelineGateKind, LucideIcon> = {
  approval: ShieldCheck,
  manual: Hand,
  check: Hourglass,
};

/**
 * What the open run is waiting on a person for, above its graph, in amber.
 *
 * Prominent on purpose. Every other thing on this screen resolves itself — a running job finishes,
 * a queued one starts — and a gate is the one state that does not: an approval nobody notices is a
 * deploy that never happens, and the host's own page is where people least often are when it
 * matters. So the gate says what it is, whose it is, and has its answer right there.
 *
 * Answering is outward and irreversible — an approval can ship to production — so it goes through
 * the app's prompt (the confirmation's one-field twin), which names the gate and the branch and
 * takes the comment every host keeps with the decision.
 */
export function RunGates({ projectId, detail }: { projectId: string; detail: PipelineRunDetail }) {
  const t = useT();
  const load = useCiStore((s) => s.load);
  const selectRun = useCiStore((s) => s.selectRun);
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<PipelineGate | null>(null);

  const run = detail.run;
  const gates = orderGates(detail.gates);
  // A run the host says is waiting, whose gates could not be read (a token that can read runs but
  // not deployments): still shown, with the host's page as the way to answer it.
  if (gates.length === 0 && !run.gated) return null;

  /** After an answer: the list for the row's status, and the run for its gates. Forced, because a
   *  run held at a gate is often not "live" and its cached detail would otherwise be trusted. */
  const settle = async () => {
    await load(projectId, { quiet: true });
    await selectRun(projectId, run, { refresh: true }).catch(() => {});
  };

  const review = async (gate: PipelineGate, approve: boolean) => {
    const comment = await promptAction(
      t(approve ? "pipelines.gateApproveAsk" : "pipelines.gateRejectAsk", { name: gate.name, branch: run.branch }),
      {
        placeholder: t("pipelines.gateComment"),
        confirmLabel: t(approve ? "pipelines.gateApprove" : "pipelines.gateReject"),
      },
    );
    if (comment === null) return;
    setBusy(gate.id);
    try {
      await reviewPipelineGate(projectId, run.id, gate.id, approve, comment);
      pushSuccessToast(t(approve ? "pipelines.gateApproved" : "pipelines.gateRejected", { name: gate.name }));
      await settle();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div
        data-tour="pipelines-gates"
        className="flex shrink-0 flex-col border-b border-[color-mix(in_oklab,var(--cf-warning)_35%,var(--cf-border))] bg-[color-mix(in_oklab,var(--cf-warning)_8%,var(--cf-surface))]"
      >
        {gates.length === 0 ? (
          <GateLine kind="approval" name="" webUrl={run.web_url} />
        ) : (
          gates.map((gate) => (
            <GateLine key={`${gate.kind}:${gate.id}`} kind={gate.kind} name={gate.name} gate={gate} webUrl={gate.web_url}>
              {gate.kind === "approval" && (
                <Tooltip label={t("pipelines.gateNotReviewer")} disabled={gate.can_act !== false}>
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy !== null || gate.can_act === false}
                      onClick={() => void review(gate, false)}
                      className={buttonClass({ variant: "danger-ghost", size: "sm" })}
                    >
                      {t("pipelines.gateReject")}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null || gate.can_act === false}
                      onClick={() => void review(gate, true)}
                      className={buttonClass({ variant: "primary", size: "sm" })}
                    >
                      {t("pipelines.gateApprove")}
                    </button>
                  </span>
                </Tooltip>
              )}
              {gate.kind === "manual" && (
                // A gate the host says can't be answered from here — Bitbucket's manual step, which
                // its API has no verb for — keeps its button, disabled, and the link beside it.
                <Tooltip label={t("pipelines.gateOnHostOnly")} disabled={gate.can_act !== false}>
                  <span className="flex">
                    <button
                      type="button"
                      disabled={busy !== null || gate.can_act === false}
                      onClick={() => setPlaying(gate)}
                      className={buttonClass({ variant: "primary", size: "sm" })}
                    >
                      <Play size={11} />
                      {t("pipelines.gatePlay")}
                    </button>
                  </span>
                </Tooltip>
              )}
            </GateLine>
          ))
        )}
      </div>
      {playing && (
        <PlayJobModal
          projectId={projectId}
          run={run}
          gate={playing}
          onClose={() => setPlaying(null)}
          onPlayed={() => void settle()}
        />
      )}
    </>
  );
}

/** One gate: what kind, what is waiting, who may answer, and the answer. */
function GateLine({
  kind,
  name,
  gate,
  webUrl,
  children,
}: {
  kind: PipelineGateKind;
  name: string;
  gate?: PipelineGate;
  webUrl: string;
  children?: React.ReactNode;
}) {
  const t = useT();
  const Icon = KIND_ICON[kind];
  const since = gate?.since ? new Date(gate.since) : null;
  return (
    <div className="flex min-h-[34px] items-center gap-2 px-3 py-1">
      <Icon size={14} className="shrink-0 text-[var(--cf-warning)]" />
      <Tooltip
        label={t(KIND_LABEL[kind])}
        description={
          kind === "check"
            ? t("pipelines.gateCheckHint")
            : since && !Number.isNaN(since.getTime())
              ? t("pipelines.gateSince", { when: since.toLocaleString() })
              : undefined
        }
      >
        <span className="shrink-0 text-[12px] text-[var(--cf-text-muted)]">{t(KIND_LABEL[kind])}</span>
      </Tooltip>
      {name && <span className="min-w-0 truncate text-[12px] font-semibold">{name}</span>}
      {gate && gate.reviewers.length > 0 && (
        <Tooltip label={t("pipelines.gateReviewers")} description={gate.reviewers.join(", ")}>
          <Users size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        </Tooltip>
      )}
      {gate?.instructions && (
        <Tooltip label={t("pipelines.gateInstructions")} description={gate.instructions}>
          <Info size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        </Tooltip>
      )}
      <span className="min-w-0 flex-1" />
      {children}
      {webUrl && (
        <Tooltip label={t("pipelines.openOnHost")}>
          <button
            type="button"
            aria-label={t("pipelines.openOnHost")}
            onClick={() => void openExternalUrl(webUrl).catch((e: unknown) => pushErrorToast(String(e)))}
            className={iconButtonClass({ size: "xs" })}
          >
            <ExternalLink size={11} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * Starts a GitLab manual job, optionally with job variables — the same thing GitLab's job page
 * offers before its play button. Confirmed like a run is, naming the job and the branch.
 */
function PlayJobModal({
  projectId,
  run,
  gate,
  onClose,
  onPlayed,
}: {
  projectId: string;
  run: PipelineRun;
  gate: PipelineGate;
  onClose: () => void;
  onPlayed: () => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<EditorRow[]>([]);
  const [busy, setBusy] = useState(false);
  const ready = Object.keys(validateVariables(rows, run.provider)).length === 0 && !busy;

  const play = async () => {
    if (!ready) return;
    const variables = variablesToSend(rows);
    const lines = confirmationLines([], {}, variables);
    const confirmed = await useConfirmStore.getState().ask({
      message: t("pipelines.playConfirm", { name: gate.name, branch: run.branch }),
      danger: false,
      confirmLabel: t("pipelines.gatePlay"),
      items: lines.length > 0 ? lines : undefined,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await playPipelineJob(projectId, gate.id, variables);
      pushSuccessToast(t("pipelines.playStarted", { name: gate.name }));
      onPlayed();
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={Play}
      title={t("pipelines.playTitle", { name: gate.name })}
      subtitle={run.branch}
      width="max-w-md"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <span className="min-w-0 flex-1" />
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton onClick={() => void play()} disabled={!ready}>
            {t("pipelines.gatePlay")}
          </PrimaryButton>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-3">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("pipelines.runVariables")}
        </span>
        <VariablesEditor rows={rows} onChange={setRows} provider={run.provider} />
      </div>
    </ApiModal>
  );
}
