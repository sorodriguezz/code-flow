import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronsUpDown, LoaderCircle } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { flowsConnectorOptions, type FlowChoice } from "../../lib/tauri/flowsCommands";
import { useT } from "../../state/languageStore";

/**
 * A connector field picked from what the service has — Linear's teams, a board's lists, the
 * channels of a Teams team — instead of an id copied from somewhere (`connectors::Lookup`).
 *
 * Asked when opened, with the node's credential and the fields the list `needs`; the field still
 * holds the id (or an expression), so nothing about how the node runs changes. What a list
 * answered is kept for the session, so a field shows the name behind its id (`labelFor`).
 */

const lists = new Map<string, FlowChoice[]>();

const listKey = (connector: string, operation: string, field: string, credential: string, needs: string[]) =>
  [connector, operation, field, credential, ...needs].join("\u0001");

/** The name behind a field's id, from any list fetched this session for that field. */
export function labelFor(connector: string, field: string, value: string): string | undefined {
  if (!value) return undefined;
  const prefix = `${connector}\u0001`;
  for (const [key, choices] of lists) {
    if (!key.startsWith(prefix) || key.split("\u0001")[2] !== field) continue;
    const found = choices.find((choice) => choice.value === value);
    if (found) return found.label;
  }
  return undefined;
}

export function LookupButton({
  connector,
  operation,
  field,
  credential,
  fields,
  needs,
  blocked,
  onPick,
}: {
  connector: string;
  operation: string;
  field: string;
  credential: string;
  /** The node's fields as written — only fixed values travel; an expression cannot be asked about. */
  fields: Record<string, unknown>;
  needs: string[];
  /** Why it cannot list yet (no credential, a field it needs is empty); `null` when it can. */
  blocked: string | null;
  onPick: (choice: FlowChoice) => void;
}) {
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ loading: true } | { error: string } | { choices: FlowChoice[] } | null>(null);
  const fixed = useMemo(
    () => Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value !== "string" || !value.startsWith("="))),
    [fields],
  );
  const key = listKey(connector, operation, field, credential, needs.map((name) => String(fixed[name] ?? "")));

  const load = (force: boolean) => {
    const known = lists.get(key);
    if (known && !force) {
      setState({ choices: known });
      return;
    }
    setState({ loading: true });
    void flowsConnectorOptions(connector, operation, field, credential || null, fixed).then(
      (choices) => {
        lists.set(key, choices);
        setState({ choices });
      },
      (error: unknown) => setState({ error: String(error) }),
    );
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={iconButtonClass({ size: "sm" })}
        title={blocked ?? t("flows.lookup.pick")}
        aria-label={t("flows.lookup.pick")}
        aria-expanded={open}
        disabled={blocked !== null}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setOpen(true);
          load(false);
        }}
      >
        <ChevronsUpDown size={14} />
      </button>
      {open && (
        <ChoicePopover
          anchor={button.current}
          state={state}
          onRetry={() => load(true)}
          onClose={() => setOpen(false)}
          onPick={(choice) => {
            setOpen(false);
            onPick(choice);
          }}
        />
      )}
    </>
  );
}

function ChoicePopover({
  anchor,
  state,
  onRetry,
  onClose,
  onPick,
}: {
  anchor: HTMLElement | null;
  state: { loading: true } | { error: string } | { choices: FlowChoice[] } | null;
  onRetry: () => void;
  onClose: () => void;
  onPick: (choice: FlowChoice) => void;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [, relayout] = useState(0);
  const choices = state && "choices" in state ? state.choices : [];
  const needle = query.trim().toLowerCase();
  const shown = needle ? choices.filter((c) => c.label.toLowerCase().includes(needle) || c.value.toLowerCase().includes(needle)) : choices;

  useEffect(() => setActive(0), [query, state]);
  useLayoutEffect(() => relayout((n) => n + 1), []);
  useEffect(() => {
    box.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  // A press anywhere else, or the panel scrolling under it, closes it.
  useEffect(() => {
    const away = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (box.current?.contains(target) || anchor?.contains(target))) return;
      onClose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", away, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", away, true);
    };
  }, [anchor, onClose]);

  const rect = anchor?.getBoundingClientRect();
  if (!rect) return null;
  const width = 320;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  const below = window.innerHeight - rect.bottom;
  const style: CSSProperties = below < 260 && rect.top > below ? { left, width, bottom: window.innerHeight - rect.top + 4 } : { left, width, top: rect.bottom + 4 };

  return createPortal(
    <div
      ref={box}
      className="fixed z-[10000] flex max-h-[300px] flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      style={style}
    >
      <div className="shrink-0 border-b border-[var(--cf-border)] p-1.5">
        <input
          autoFocus
          className={fieldClass({ size: "sm", className: "w-full" })}
          value={query}
          placeholder={t("flows.lookup.search")}
          role="combobox"
          aria-expanded="true"
          aria-label={t("flows.lookup.search")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (shown.length) setActive((a) => (a + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (shown[active]) onPick(shown[active]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox">
        {state === null || "loading" in state ? (
          <div className="flex items-center gap-1.5 px-2.5 py-2 text-[12px] text-[var(--cf-text-muted)]">
            <LoaderCircle size={12} className="animate-spin" />
            {t("flows.lookup.loading")}
          </div>
        ) : "error" in state ? (
          <div className="flex flex-col items-start gap-1.5 px-2.5 py-2 text-[11.5px] text-[var(--cf-danger)]">
            <span className="whitespace-pre-wrap break-words">{state.error}</span>
            <button type="button" className="text-[var(--cf-accent)] hover:underline" onClick={onRetry}>
              {t("flows.connect.retry")}
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div className="px-2.5 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("flows.lookup.empty")}</div>
        ) : (
          shown.map((choice, index) => (
            <div
              key={`${choice.value}-${index}`}
              role="option"
              aria-selected={index === active}
              className={`mx-1 flex h-[26px] cursor-pointer items-center gap-2 rounded-[5px] px-2 text-[12px] ${
                index === active ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
              }`}
              title={choice.value}
              onMouseEnter={() => setActive(index)}
              onClick={() => onPick(choice)}
            >
              <span className="min-w-0 flex-1 truncate text-[var(--cf-text)]">{choice.label}</span>
              {choice.label !== choice.value && <span className="max-w-[40%] shrink-0 truncate font-mono text-[10.5px] text-[var(--cf-text-faint)]">{choice.value}</span>}
            </div>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
