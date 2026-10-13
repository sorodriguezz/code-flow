import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, History, LoaderCircle, Repeat, Waypoints, Workflow } from "lucide-react";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { recentTopics, rememberTopic } from "../../lib/diagrams/archify/recent";
import { useDialog } from "../../lib/useFocusTrap";
import {
  diagramsArchifySuggestions,
  type ArchifyKind,
  type ArchifySuggestion,
} from "../../lib/tauri/diagramsCommands";
import { useT } from "../../state/languageStore";

const ICONS = { workflow: Workflow, sequence: ArrowRightLeft, dataflow: Waypoints, lifecycle: Repeat } as const;

/** The kinds that need a subject — an architecture is one click and never opens this. */
export type TopicKind = Exclude<ArchifyKind, "architecture">;

/**
 * "What should the diagram be about?" — asked with the answers on the table.
 *
 * A sequence of "the API" is not a diagram; a sequence of `POST /orders` is, and nobody should have to
 * remember the route to ask for it. So the repository is read for what each type can be *about* — its
 * routes, its status types, its processes, its entities — and offered as chips: one click starts it. The
 * field is still there for anything else, and may be left empty, in which case the engine picks the
 * repository's most important one. What was asked before is offered first, per repository and type.
 *
 * The list is read when the dialog opens and arrives a moment later; the dialog does not wait for it.
 */
export function ArchifyTopicDialog({
  kind,
  projectId,
  onStart,
  onClose,
}: {
  kind: TopicKind;
  projectId: string;
  /** The subject — empty when the user left it to the engine. */
  onStart: (topic: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const [found, setFound] = useState<ArchifySuggestion[] | null>(null);
  const recent = useMemo(() => recentTopics(projectId, kind), [projectId, kind]);
  useDialog(panel, true, onClose);

  useEffect(() => {
    let alive = true;
    setFound(null);
    diagramsArchifySuggestions({ projectId, kind })
      .then((list) => alive && setFound(list))
      // A repository that cannot be read still gets the dialog: the field works without a list.
      .catch(() => alive && setFound([]));
    return () => {
      alive = false;
    };
  }, [projectId, kind]);

  const start = (topic: string) => {
    rememberTopic(projectId, kind, topic);
    onStart(topic.trim());
  };
  const Icon = ICONS[kind];
  const chip =
    "max-w-full truncate rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1 text-left text-[11.5px] text-[var(--cf-text)] transition-colors hover:border-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)]";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        ref={panel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="cf-fade-in max-h-[calc(100vh-2rem)] w-[540px] max-w-[92vw] overflow-y-auto rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]"
      >
        <div className="mb-3 flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            <Icon size={15} />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-[13.5px] font-medium leading-snug text-[var(--cf-text)]">
              {t(`codemap.archify.prompt.${kind}`)}
            </p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
              {t(`codemap.archify.kindHint.${kind}`)}
            </p>
          </div>
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(value);
          }}
        >
          <input
            autoFocus
            value={value}
            spellCheck={false}
            placeholder={t(`codemap.archify.placeholder.${kind}`)}
            onChange={(e) => setValue(e.target.value)}
            className={fieldClass({ className: "min-w-0 flex-1" })}
          />
          <button type="submit" className={buttonClass({ variant: "primary" })}>
            {t("codemap.archify.start")}
          </button>
        </form>
        <p className="mt-1.5 text-[11px] text-[var(--cf-text-faint)]">{t("archify.topic.emptyOk")}</p>

        {recent.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--cf-text-faint)]">
              <History size={11} />
              {t("archify.topic.recent")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {recent.map((topic) => (
                <button key={topic} type="button" className={chip} title={topic} onClick={() => start(topic)}>
                  {topic}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4">
          <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--cf-text-faint)]">
            {t("archify.topic.suggested")}
          </p>
          {found === null ? (
            <p className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
              <LoaderCircle size={13} className="animate-spin" />
              {t("archify.topic.searching")}
            </p>
          ) : found.length === 0 ? (
            <p className="text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{t("archify.topic.none")}</p>
          ) : (
            <div className="flex max-h-[176px] flex-wrap gap-1.5 overflow-y-auto pr-1">
              {found.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className={chip}
                  title={item.hint}
                  onClick={() => start(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <ChatModelPicker
            task="diagram"
            variant="tag"
            liveModel={null}
            chatActive={false}
            title={t("codemap.archify.modelHint")}
          />
          <button type="button" onClick={onClose} className={buttonClass({ variant: "ghost" })}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
