import { createContext, useContext, useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Braces, SquareFunction, Variable, Workflow } from "lucide-react";
import type { AssistData, Completion, Suggestion } from "../../lib/flows/exprAssist";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useT } from "../../state/languageStore";

/**
 * What a node's fields can suggest — its input, the other nodes, the variables — handed down by the
 * inspector to every field of the node, the text boxes and the code editors alike (`exprAssist`).
 */
export interface FlowAssist {
  data: AssistData;
  /** Asks for a node's output, so `$('Nodo').item.json.` can list its fields. Once per node. */
  want: (name: string) => void;
}

export const AssistContext = createContext<FlowAssist | null>(null);

export const useFlowAssist = (): FlowAssist | null => useContext(AssistContext);

function KindMark({ suggestion }: { suggestion: Suggestion }) {
  const { kind, detail } = suggestion;
  if ((kind === "field" || kind === "variable") && detail && detail.length <= 2) {
    return <span className="w-4 shrink-0 text-center font-mono text-[10px] text-[var(--cf-text-faint)]">{detail}</span>;
  }
  const Icon = kind === "node" ? Workflow : kind === "method" || kind === "function" ? SquareFunction : kind === "variable" ? Variable : Braces;
  return (
    <span className="flex w-4 shrink-0 justify-center text-[var(--cf-text-faint)]">
      <Icon size={11} />
    </span>
  );
}

/**
 * The suggestions under a text field: what fits where the caret is, the type of each field and a
 * sample of it, and one line on the highlighted one. Mouse presses never take the focus from the
 * field, so typing carries on after a click.
 */
export function AssistList({
  anchor,
  completion,
  active,
  onPick,
  onHover,
}: {
  anchor: HTMLElement | null;
  completion: Completion;
  active: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const box = anchor?.getBoundingClientRect();
  if (!box) return null;
  const width = Math.min(Math.max(box.width, 280), 440);
  const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
  const below = window.innerHeight - box.bottom;
  const style: CSSProperties = below < 220 && box.top > below ? { left, width, bottom: window.innerHeight - box.top + 4 } : { left, width, top: box.bottom + 4 };
  const current = completion.items[active];
  return createPortal(
    <div
      className="fixed z-[10000] flex max-h-[264px] flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      style={style}
      onMouseDown={(event) => event.preventDefault()}
    >
      {completion.noInput && <div className="shrink-0 px-2.5 pb-1 pt-1.5 text-[11.5px] text-[var(--cf-text-muted)]">{t("flows.assist.noInput")}</div>}
      <div ref={list} role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
        {completion.items.map((suggestion, index) => (
          <div
            key={`${suggestion.label}-${index}`}
            role="option"
            aria-selected={index === active}
            className={`mx-1 flex h-[24px] cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-[12px] ${
              index === active ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
            }`}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(index)}
          >
            <KindMark suggestion={suggestion} />
            <span className="shrink-0 font-mono text-[11.5px] text-[var(--cf-text)]">{suggestion.label}</span>
            <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-[var(--cf-text-faint)]">
              {suggestion.sample ?? (suggestion.detail && suggestion.detail.length > 2 ? suggestion.detail : "")}
            </span>
          </div>
        ))}
      </div>
      {current?.doc && (
        <div className="shrink-0 truncate border-t border-[var(--cf-border)] px-2.5 py-1 text-[11px] text-[var(--cf-text-muted)]">
          {t(current.doc as TranslationKey, current.docArgs)}
        </div>
      )}
    </div>,
    document.body,
  );
}
