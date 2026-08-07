import { Cpu } from "lucide-react";
import { AI_PROVIDERS, modelDisplayLabel } from "../../lib/aiProviders";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/** The engine's own name, as the picker in Settings shows it. */
function engineLabel(providerId: string, t: (key: TranslationKey) => string): string {
  const provider = AI_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return providerId;
  return provider.label ?? (provider.labelKey ? t(provider.labelKey) : providerId);
}

/** "Claude Code · Opus 5" — engine and model as one line, which is what every tooltip that has to
 * name a route says. The pure form, for the callers that already know the pair. */
export function modelRouteLabel(
  providerId: string,
  model: string,
  t: (key: TranslationKey) => string,
): string {
  return `${engineLabel(providerId, t)} · ${modelDisplayLabel(providerId, model, t)}`;
}

/**
 * The same line for whatever `task` is routed to *right now* — the one thing that answers "what is
 * about to run this".
 *
 * A hook rather than a helper because it has to *subscribe*: routing is changed in Settings, on a
 * screen that isn't this one, and a label read once at mount would keep naming the old model until
 * something else happened to re-render. It is also the same string the chip puts in its own
 * tooltip, so a button that shows the chip and a button that only has room for a `title` agree.
 */
export function useTaskModelLabel(task: string): string {
  const taskProviders = useAiProviderStore((s) => s.taskProviders);
  const taskModels = useAiProviderStore((s) => s.taskModels);
  const defaultProvider = useAiProviderStore((s) => s.providerId);
  const t = useT();

  const providerId = taskProviders[task]?.trim() || defaultProvider;
  return modelRouteLabel(providerId, taskModels[task] ?? "", t);
}

/**
 * Which engine and model a run used, or is about to use, as one small chip.
 *
 * There are two questions this answers and they are not the same one: *what will run* (routing,
 * which lives three screens away in Settings and is invisible from the screen that starts the run)
 * and *what did run* (frozen on the record, and the only explanation for why one set of stories
 * reads like a backlog and the next reads like a greeting). Both get the same chip on purpose —
 * they are the same fact at two moments — with the tooltip saying which moment this one is.
 */
export function ModelTag({
  providerId,
  model,
  title,
}: {
  providerId: string;
  /** Raw model id as stored/reported. Empty means the engine picked its own default. */
  model: string;
  title?: string;
}) {
  const t = useT();
  const engine = engineLabel(providerId, t);

  // The model id and nothing else — a chip sitting next to a button has room for one fact, and the
  // sentence around it ("will run on…") was longer than the fact it introduced. The exception is a
  // run with no model pinned, where the id is not a name but the word "Default": there the engine
  // is the only thing that identifies what answers, so it takes the slot instead.
  const modelLabel = modelDisplayLabel(providerId, model, t);
  // A gateway route is `vendor/model` (`opencode/deepseek-v4-flash-free`), and it is the half
  // after the slash that answers "which model" — the half before it is the same for every route
  // the user has. Truncating left to right would keep exactly the uninformative half, so the chip
  // shows the last segment. The whole route stays in the tooltip.
  const label = model.trim() ? modelLabel.split("/").pop() || modelLabel : engine;

  return (
    <span
      // Everything the chip dropped stays one hover away, with the routing note under it.
      title={[`${engine} · ${modelLabel}`, title].filter(Boolean).join("\n")}
      // Capped, because a model id has no length limit — uncapped, a long one pushed the Generate
      // button it sits next to onto a second row. It truncates instead; the tooltip has it whole.
      className="inline-flex min-w-0 max-w-[10rem] shrink items-center gap-1 rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface)] px-1.5 py-px text-[10px] text-[var(--cf-text-muted)]"
    >
      <Cpu size={9} className="shrink-0" />
      <span className="min-w-0 truncate font-mono">{label}</span>
    </span>
  );
}

/**
 * The chip for a run that hasn't happened yet: it reads the routing table for `task` rather than a
 * record, so it always names the engine the next click will actually reach.
 *
 * `task` is the settings-key fragment from `AI_TASKS` — the same string Rust's `AiTask::key()`
 * returns. It has to be the task the button really routes to: a chip naming a task that does not
 * run here would be worse than no chip, because it would be believed.
 */
export function TaskModelTag({ task, title }: { task: string; title?: string }) {
  const taskProviders = useAiProviderStore((s) => s.taskProviders);
  const taskModels = useAiProviderStore((s) => s.taskModels);
  const defaultProvider = useAiProviderStore((s) => s.providerId);

  const providerId = taskProviders[task]?.trim() || defaultProvider;
  return <ModelTag providerId={providerId} model={taskModels[task] ?? ""} title={title} />;
}
