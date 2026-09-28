import { create } from "zustand";
import { Boxes, FileCode2, Folder, Info, ShieldAlert, ShieldCheck } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "./ApiModal";
import { buttonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import { useCollabStore } from "../../state/collabStore";
import { useT } from "../../state/languageStore";
import type { GateDecision, ScriptLevel, ScriptRef, UntrustedScript } from "../../lib/api/scriptTrust";

/**
 * The trust gate's question — see `lib/api/scriptTrust.ts` for when it is asked and what the three
 * answers do.
 *
 * Asked through a promise rather than by rendering the dialog where the send starts: a send and a
 * runner run are async functions that must stop at this point and continue with the answer, and a
 * store-held request is the shape `confirmStore` already uses for that. Mounted once, in `ApiView`.
 */

export type TrustMode = "send" | "run";

interface PromptRequest {
  scripts: UntrustedScript[];
  mode: TrustMode;
  settle: (decision: GateDecision) => void;
}

interface PromptState {
  request: PromptRequest | null;
  ask: (scripts: UntrustedScript[], mode: TrustMode) => Promise<GateDecision>;
  answer: (decision: GateDecision) => void;
}

export const useScriptTrustPrompt = create<PromptState>((set, get) => ({
  request: null,
  ask: (scripts, mode) =>
    new Promise<GateDecision>((resolve) => {
      // A second question while one is up would strand the first caller's await, so the pending one
      // is answered "cancel" before being replaced — the same rule `confirmStore` follows.
      get().request?.settle("cancel");
      set({ request: { scripts, mode, settle: resolve } });
    }),
  answer: (decision) => {
    const request = get().request;
    if (!request) return;
    set({ request: null });
    request.settle(decision);
  },
}));

export const askScriptTrust = (scripts: UntrustedScript[], mode: TrustMode) =>
  useScriptTrustPrompt.getState().ask(scripts, mode);

export function ScriptTrustHost() {
  const request = useScriptTrustPrompt((s) => s.request);
  if (!request) return null;
  return <ScriptTrustModal request={request} />;
}

const LEVEL_ICONS: Record<ScriptLevel, typeof Boxes> = {
  collection: Boxes,
  folder: Folder,
  request: FileCode2,
};

/** Product names, not copy — they read the same in every language (as in `ImportModal`). */
const FORMAT_NAMES: Record<string, string> = {
  postman: "Postman",
  openapi: "OpenAPI",
  curl: "cURL",
  har: "HAR",
  insomnia: "Insomnia",
  bruno: "Bruno",
  codeflow: "CodeFlow",
};

function ScriptTrustModal({ request }: { request: PromptRequest }) {
  const t = useT();
  const answer = useScriptTrustPrompt((s) => s.answer);
  const shares = useCollabStore((s) => s.shares);

  const phaseLabel = (ref: ScriptRef) =>
    t(ref.phase === "pre" ? "api.entity.preRequest" : "api.entity.postResponse");

  const originLabel = (script: UntrustedScript): string => {
    const origin = script.origin ?? "";
    if (origin.startsWith("import:")) {
      const format = origin.slice("import:".length);
      return t("api.trust.originImport", { format: FORMAT_NAMES[format] ?? format });
    }
    const shared =
      origin === "shared" ||
      script.refs.some(
        (ref) => ref.collectionId !== null && shares.some((share) => share.collection_id === ref.collectionId),
      );
    return shared ? t("api.trust.originShared") : t("api.trust.originUnknown");
  };

  // Short lists open, long ones stay a list of names: a runner over an imported collection can bring
  // dozens, and a wall of code nobody scrolls is not a review.
  const expanded = request.scripts.length <= 3;

  return (
    <ApiModal
      icon={ShieldAlert}
      title={t("api.trust.title")}
      subtitle={t("api.trust.subtitle")}
      width="max-w-2xl"
      raised
      dismissOnBackdrop={false}
      onClose={() => answer("cancel")}
      toolbar={
        <Tooltip label={t("api.trust.title")} description={t("api.trust.why")} side="bottom">
          <span className="flex h-7 w-7 items-center justify-center text-[var(--cf-text-muted)]">
            <Info size={14} />
          </span>
        </Tooltip>
      }
      footer={
        <>
          <span className="mr-auto" />
          <GhostButton onClick={() => answer("cancel")}>{t("common.cancel")}</GhostButton>
          <Tooltip label={t("api.trust.withoutHint")}>
            <button
              type="button"
              onClick={() => answer("skip")}
              className={buttonClass({ variant: "secondary" })}
            >
              {t(request.mode === "run" ? "api.trust.runWithout" : "api.trust.sendWithout")}
            </button>
          </Tooltip>
          <PrimaryButton onClick={() => answer("trust")}>
            <ShieldCheck size={13} />
            {t("api.trust.trustRun")}
          </PrimaryButton>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {request.scripts.map((script) => {
          const [first, ...others] = script.refs;
          const Icon = LEVEL_ICONS[first.level];
          const lines = script.code.split("\n").length;
          return (
            <details
              key={script.hash}
              open={expanded}
              className="overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]"
            >
              <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-[12px]">
                <Icon size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="min-w-0 truncate font-medium text-[var(--cf-text)]">{first.owner}</span>
                <span className="shrink-0 text-[var(--cf-text-muted)]">· {phaseLabel(first)}</span>
                {others.length > 0 && (
                  <Tooltip
                    label={
                      <span className="whitespace-pre-line">
                        {others.map((ref) => `${ref.owner} · ${phaseLabel(ref)}`).join("\n")}
                      </span>
                    }
                  >
                    <span className={chipClass("neutral")}>
                      {t("api.trust.alsoIn", { n: others.length })}
                    </span>
                  </Tooltip>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  <span className="text-[11px] text-[var(--cf-text-faint)]">
                    {t("api.trust.lines", { n: lines })}
                  </span>
                  <span className={chipClass("warn")}>{originLabel(script)}</span>
                </span>
              </summary>
              {/* Read-only text, never markup: React escapes it, and nothing here evaluates it. */}
              <pre className="max-h-64 select-text overflow-auto border-t border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2 font-mono text-[12px] leading-[1.55] text-[var(--cf-text)]">
                {script.code}
              </pre>
            </details>
          );
        })}
      </div>
    </ApiModal>
  );
}
