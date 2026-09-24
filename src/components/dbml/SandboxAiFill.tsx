import { useMemo, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { diagramsFillRowsWithAi } from "../../lib/tauri/diagramsCommands";
import {
  AI_FILL_BATCH,
  batchTables,
  emptyPlan,
  keyHint,
  mergePlans,
  parseAiRows,
  schemaOutline,
  type AiDropReason,
  type AiFillPlan,
} from "../../lib/dbml/aiFill";
import { orderTables } from "../../lib/dbml/sqlite";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { useSandboxStore } from "../../state/sandboxStore";
import { useDiagramsStore } from "../../state/diagramsStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { DbmlSchema } from "../../lib/dbml/types";

/**
 * **Rellenar con IA** — the second way to put rows in the scratch database.
 *
 * Next to the generated fill and not instead of it. `fill.ts` writes twenty rows from the column
 * types: reproducible, always accepted, and content-free. This one asks an engine for rows that
 * *mean* something, which is the only version worth having the moment the query you are testing is
 * `WHERE ciudad = 'Valparaíso'` or the screenshot has to look like a product.
 *
 * # In passes, because one answer does not fit
 *
 * The first version asked for the whole schema at once and a fifteen-table document came back with
 * eight tables in it — not an error, just a reply that ran out of room and stopped. So the tables
 * are sent in batches of [`BATCH`], in the parents-first order the foreign keys imply, and **each
 * batch is written before the next is asked for**. Three things fall out of that, and they are the
 * reason it is worth the loop:
 *
 * - Every batch is short enough to be answered whole.
 * - A batch is planned against the database *as it now is*, so its foreign keys are checked against
 *   rows that already exist rather than against rows in the same reply.
 * - The engine is told which keys those are, so it copies ids instead of inventing them.
 *
 * The whole schema still travels every time. A pass that saw only its own tables could not tell
 * `cliente_id` from any other integer.
 *
 * # Nothing it says is trusted
 *
 * `planAiFill` checks every value against the schema before a statement is built, and what does not
 * fit is dropped and **counted**. The panel reports that count, and the tables that came back
 * empty, because "48 rows, 3 tables untouched" is a fact about the answer and a silent 48 is a fill
 * that looks complete.
 */

export function SandboxAiFill({
  diagramId,
  schema,
  disabled,
}: {
  diagramId: string;
  schema: DbmlSchema;
  disabled: boolean;
}) {
  const t = useT();
  const defaultProvider = useAiProviderStore((state) => state.providerId);
  const routedProvider = useAiProviderStore((state) => state.taskProviders["sample_rows"]);
  const routedModel = useAiProviderStore((state) => state.taskModels["sample_rows"]);
  const provider = routedProvider?.trim() || defaultProvider;
  const option = AI_PROVIDERS.find((entry) => entry.id === provider);
  // `label` for the engines that carry a fixed name, the translated one otherwise, and the raw id
  // as the last resort — a provider added by a newer build than this window's strings still reads
  // as something rather than as a blank line where the engine's name should be.
  const providerName = option?.label ?? (option ? t(option.labelKey!) : provider);

  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [rows, setRows] = useState(20);
  /** The run in flight, so it can be cancelled and a second press cannot start a second one. */
  const [runId, setRunId] = useState<string | null>(null);
  /** Which pass is in flight, for the line under the button. `null` when nothing is running. */
  const [pass, setPass] = useState<{ done: number; total: number } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  /** Set when the user cancels, so the loop stops between passes as well as during one. */
  const stopped = useRef(false);

  /** Parents first — the order the passes go in, and the order the foreign keys need. */
  const ordered = useMemo(
    () => orderTables(schema).order.filter((id) => schema.tables.some((t) => t.id === id)),
    [schema],
  );
  /**
   * What the engine is shown: names, types, keys and references, and none of the prose.
   *
   * Not the document. A schema whose `note` blocks are four fifths of its 17 000 characters — which
   * is an ordinary schema, not a pathological one — got cut by the context cap at the eighth table,
   * and every pass after that was asked about tables it had never seen. See `schemaOutline`.
   */
  const outline = useMemo(() => schemaOutline(schema), [schema]);

  const generate = async () => {
    if (runId || ordered.length === 0) return;
    const id = newRunId("dbml-rows");
    // Both stamps taken before the first await, like every other run in this app: the answer must
    // be filed against the diagram it was asked for and the workspace it was asked in, not against
    // whichever pair happens to be open when it lands minutes later.
    const target = diagramId;
    const workspaceId = useDiagramsStore.getState().workspaceId;
    const batches = batchTables(ordered);
    stopped.current = false;
    setRunId(id);
    setPass({ done: 0, total: batches.length });
    useAiRunStore.getState().start(id, {
      kindKey: "dbml.sandbox.aiRunKind",
      detail: "",
      workspaceId,
      target: { view: "diagrams", select: { kind: "diagram", id: diagramId } },
    });

    const toast = useToastStore.getState().pushToast;
    const store = useSandboxStore.getState;
    /** Everything written, across every pass — one message at the end, not one per batch. */
    const total: AiFillPlan = emptyPlan();
    let answered = false;
    /** Passes whose reply could not be read at all. */
    let unusable = 0;

    try {
      for (const [index, only] of batches.entries()) {
        if (stopped.current) break;
        setPass({ done: index, total: batches.length });
        // Re-read every pass, not once: the previous batch's rows are exactly what this one's
        // foreign keys have to point at, and they did not exist when the loop started.
        const keys = keyHint(await store().availableKeys(target, schema), schema);
        const raw = await diagramsFillRowsWithAi({
          schema: outline,
          instruction: instruction.trim(),
          rows,
          only,
          keys,
          runId: id,
          workspaceId,
        });
        const parsed = parseAiRows(raw);
        // A pass that answered with nothing usable is *counted*, not skipped. Silently carrying on
        // is how "it only ever fills the same eight tables" went unexplained: two passes worked,
        // two answered with prose, and the message at the end talked only about the rows that made
        // it. Whatever else this feature gets wrong, it has to be able to say what happened.
        if (!parsed) {
          unusable += 1;
          continue;
        }
        answered = true;
        mergePlans(total, await store().fillWithAi(target, schema, parsed));
      }
    } catch (error) {
      // Stopping it yourself is not a failure worth a red bar.
      if (!isCancellation(error)) pushErrorToast(String(error));
    } finally {
      useAiRunStore.getState().finish(id);
      setRunId(null);
      setPass(null);
    }

    if (!answered) {
      toast(t("dbml.sandbox.aiNoRows"), "info");
      return;
    }
    // The tables that were asked for and came back with nothing. Reported because it is the failure
    // this loop exists to prevent and the one nobody would otherwise notice.
    const empty = ordered.filter((id) => !total.written[id]).length;
    report(total, empty, unusable, t, toast);
    if (total.statements.length > 0) setOpen(false);
  };

  const cancel = () => {
    stopped.current = true;
    if (runId) void useAiRunStore.getState().cancel(runId);
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen((was) => !was);
          // `preventScroll`, and it is not a nicety. Focusing an element the browser thinks is out
          // of view makes it scroll the nearest scrollable ancestor to bring it in — which, for a
          // panel anchored to a bar at the bottom of the surface, dragged the whole of Datos
          // upward the instant it opened. The panel is placed by CSS; nothing else may move it.
          window.setTimeout(() => box.current?.focus({ preventScroll: true }), 0);
        }}
        aria-expanded={open}
        title={t("dbml.sandbox.aiFillHow")}
        className={`inline-flex h-[26px] items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${
          open || runId
            ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            : "border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        }`}
      >
        {runId ? <ThinkingOrb size="sm" /> : <Sparkles size={12} />}
        {t("dbml.sandbox.aiFillShort")}
        {pass && (
          <span className="font-mono tabular-nums opacity-70">
            {pass.done + 1}/{pass.total}
          </span>
        )}
      </button>

      {open && (
        <div
          /* **Upward.** This button sits in the bar along the *bottom* of the Datos surface, so a
             panel hanging below it opens into the status bar and off the window — which is what it
             did, and what made the whole surface scroll up to reveal it. `bottom-full` puts it over
             the grid instead, which is the empty half of the screen and where a reader is already
             looking. Right-aligned to the button for the same reason every other popover here is:
             the toolbar wraps, so the button's own edge is the only stable anchor. */
          className="absolute bottom-full right-0 z-30 mb-1.5 w-[340px] overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
        >
          {/* The header carries the one fact the old panel left out: *which engine and which
              model* is about to write your data. A generation whose cost and quality depend
              entirely on that, with no way to see it from where you press the button, is the
              complaint this whole row answers — and the hint under it says where to change it,
              because "you can route this" is not discoverable from a provider name alone. */}
          <div className="flex items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2">
            <ProviderGlyph providerId={provider} size={14} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-semibold text-[var(--cf-text)]">
                {t("dbml.sandbox.aiFillTitle")}
              </p>
              <p className="truncate text-[10.5px] text-[var(--cf-text-muted)]">
                {providerName}
                {routedModel?.trim() ? ` · ${routedModel.trim()}` : ` · ${t("dbml.sandbox.aiFillDefaultModel")}`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              title={t("common.close")}
              className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-field)] hover:text-[var(--cf-text)]"
            >
              <X size={12} />
            </button>
          </div>

          <div className="p-3">
            <label className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[var(--cf-text-muted)]">
              {t("dbml.sandbox.aiFillLabel")}
            </label>
            <textarea
              ref={box}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                // ⌘/Ctrl+Enter sends; Enter is a newline, because the field is prose and routinely
                // two lines long.
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void generate();
                }
              }}
              rows={3}
              placeholder={t("dbml.sandbox.aiFillPlaceholder")}
              className="w-full resize-none rounded-lg border border-[var(--cf-border)] bg-[var(--cf-field)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
            />

            <div className="mt-2.5 flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
                {t("dbml.sandbox.aiFillRows")}
                <select
                  value={rows}
                  onChange={(event) => setRows(Number(event.target.value))}
                  className="rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] px-1.5 py-[3px] font-mono text-[10.5px] tabular-nums text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
                >
                  {[5, 10, 20, 50].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </label>

              <span className="flex-1" />

              {runId ? (
                <button
                  type="button"
                  onClick={cancel}
                  className="inline-flex h-[26px] items-center rounded-lg border border-[var(--cf-border)] px-2.5 text-[11px] text-[var(--cf-text)] transition-colors hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
                >
                  {t("common.cancel")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void generate()}
                  className="inline-flex h-[26px] items-center gap-1.5 rounded-lg border border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] px-3 text-[11px] font-semibold text-[var(--cf-accent)] transition-colors hover:brightness-110"
                >
                  <Sparkles size={11} />
                  {t("dbml.sandbox.aiFillGo")}
                </button>
              )}
            </div>

            {/* What it is about to do, in numbers, before it is asked to do it. Fifteen tables in
                four passes is the difference between "it is thinking" and "it is a third of the
                way through", and it is also what explains the several calls on the bill. */}
            <p className="mt-2 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
              {runId && pass
                ? t("dbml.sandbox.aiFillProgress", {
                    done: String(pass.done + 1),
                    total: String(pass.total),
                  })
                : t("dbml.sandbox.aiFillPlan", {
                    tables: String(ordered.length),
                    passes: String(Math.max(1, Math.ceil(ordered.length / AI_FILL_BATCH))),
                  })}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What happened, in one message.
 *
 * The dropped rows are named by their commonest *reason* rather than summed, because the five say
 * different things to whoever pressed the button: a foreign key or a duplicate key means the model
 * was not consistent with itself and pressing again will probably do better, while a type or an
 * enum means it ignored the schema and the instruction is what needs changing.
 */
function report(
  plan: AiFillPlan,
  empty: number,
  unusable: number,
  t: ReturnType<typeof useT>,
  toast: ReturnType<typeof useToastStore.getState>["pushToast"],
): void {
  const rows = Object.values(plan.written).reduce((total, count) => total + count, 0);
  const lost = plan.dropped.reduce((total, entry) => total + entry.rows, 0);
  if (rows === 0) {
    toast(t("dbml.sandbox.aiFillNone"), "info");
    return;
  }
  const mended = Object.values(plan.repaired).reduce((total, count) => total + count, 0);
  const tail = [
    // Said out loud, because a repaired row is not quite the row the model wrote: its link was
    // chosen by the app from the parents that actually exist. See `planAiFill`.
    mended > 0 ? t("dbml.sandbox.aiFillRepaired", { count: String(mended) }) : "",
    empty > 0 ? t("dbml.sandbox.aiFillEmpty", { count: String(empty) }) : "",
    unusable > 0 ? t("dbml.sandbox.aiFillUnusable", { count: String(unusable) }) : "",
  ]
    .filter(Boolean)
    .map((part) => ` · ${part}`)
    .join("");
  if (lost === 0) {
    toast(
      `${t("dbml.sandbox.aiFilled", { count: String(rows) })}${tail}`,
      tail ? "info" : "success",
    );
    return;
  }
  const worst = [...plan.dropped].sort((a, b) => b.rows - a.rows)[0];
  toast(
    `${t("dbml.sandbox.aiFilledPartly", {
      count: String(rows),
      dropped: String(lost),
      reason: t(`dbml.sandbox.aiDrop.${worst.reason}` as "dbml.sandbox.aiDrop.type"),
    })}${tail}`,
    "info",
  );
}

export type { AiDropReason };
