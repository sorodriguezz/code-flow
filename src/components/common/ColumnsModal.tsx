import { useState } from "react";
import { ChevronDown, ChevronUp, Columns3, Plus, RotateCcw } from "lucide-react";
import { ApiModal, Field, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Checkbox } from "./Checkbox";
import { useT } from "../../state/languageStore";

/**
 * Which columns a grid draws, and in what order — Storage Explorer's "Customize columns".
 *
 * **Hiding is the ordinary half**: a table with forty properties, or a blob listing with seven
 * columns in a pane that has room for four, is a listing whose interesting three are off the
 * right-hand edge. Ordering is the other, and both are per-grid decisions the caller stores; this
 * modal only collects them.
 *
 * **`addable` is the schemaless half, and it is off by default.** Where the column list is a *guess*
 * — an Azure Table, whose columns are the union of whatever the returned page happened to carry —
 * naming a column pins one the data has not produced, which is the only way to see a property that
 * every loaded entity currently leaves unset. Where the fields are fixed by the service, that same
 * field would offer to pin a column that can never hold a value, so those callers leave it out.
 *
 * The key/label split matters for exactly that reason too: a listing's columns are labelled with a
 * translation and identified by a wire name, and a modal that reordered by label would write an
 * order that stops matching the moment the language changes. Labels are drawn mono only when
 * `addable` is present, because then the label *is* the wire name and the user is typing another.
 */
export function ColumnsModal({
  columns,
  hidden,
  onApply,
  onClose,
  addable,
}: {
  /** Every column the grid knows about — including ones nothing has filled — in display order. */
  columns: { key: string; label: string }[];
  /** The subset currently not drawn, by key. */
  hidden: Set<string>;
  /** The new order and the new hidden set. `null` for the order means "leave it as the data says" —
   *  which is how Reset gets back to a column list that follows the query again. */
  onApply: (order: string[] | null, hidden: Set<string>) => void;
  onClose: () => void;
  /** The add-a-column row, for the one caller whose column list is a guess. */
  addable?: { placeholder: string; hint: string };
}) {
  const t = useT();
  const [order, setOrder] = useState<string[]>(columns.map((column) => column.key));
  const [off, setOff] = useState<Set<string>>(new Set(hidden));
  const [extra, setExtra] = useState("");

  /** A column the user has just invented has no label yet, and its key is the name they typed —
   *  which is the right thing to show, because that is what the grid will look for. */
  const labelOf = (key: string) => columns.find((column) => column.key === key)?.label ?? key;

  const move = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [taken] = next.splice(index, 1);
    next.splice(to, 0, taken);
    setOrder(next);
  };

  const toggle = (key: string, on: boolean) =>
    setOff((current) => {
      const next = new Set(current);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });

  const addColumn = () => {
    const name = extra.trim();
    if (!name || order.includes(name)) return setExtra("");
    setOrder((current) => [...current, name]);
    setOff((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    setExtra("");
  };

  const visible = order.filter((key) => !off.has(key)).length;

  return (
    <ApiModal
      icon={Columns3}
      title={t("remote.gridColumns")}
      subtitle={t("remote.gridColumnsSubtitle")}
      width="max-w-md"
      onClose={onClose}
      footer={
        <>
          <GhostButton
            onClick={() => {
              // Back to the data's own answer: no pinned order, nothing hidden. The next query
              // decides the columns again.
              onApply(null, new Set());
              onClose();
            }}
            title={t("remote.gridColumnsResetHint")}
          >
            <RotateCcw size={12} />
            {t("remote.gridColumnsReset")}
          </GhostButton>
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton
            onClick={() => {
              onApply(order, off);
              onClose();
            }}
            disabled={visible === 0}
          >
            {t("remote.gridColumnsApply")}
          </PrimaryButton>
        </>
      }
    >
      {/* `ApiModal`'s body brings no padding or scroll of its own, so this takes the house body:
          inset to the same `px-4` the header and footer are, and scrolling rather than clipping.
          The column list below caps itself at 46vh and scrolls on its own — that is the list's
          scroll, not the panel's, and it is what keeps the add-a-column row and its hint on screen
          instead of pushing them past the footer. The body's scroll is for everything else. */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        <div className="max-h-[46vh] overflow-y-auto rounded-md border border-[var(--cf-border)] p-1">
          {order.map((key, index) => (
            <div
              key={key}
              className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <Checkbox checked={!off.has(key)} onChange={(on) => toggle(key, on)} />
              <span
                className={`min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)] ${
                  addable ? "font-mono" : ""
                }`}
              >
                {labelOf(key)}
              </span>
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={t("remote.gridColumnUp")}
                title={t("remote.gridColumnUp")}
                className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-25 dark:hover:bg-white/[0.08]"
              >
                <ChevronUp size={12} />
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === order.length - 1}
                aria-label={t("remote.gridColumnDown")}
                title={t("remote.gridColumnDown")}
                className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-25 dark:hover:bg-white/[0.08]"
              >
                <ChevronDown size={12} />
              </button>
            </div>
          ))}
        </div>

        {addable && (
          <>
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <Field value={extra} onChange={setExtra} placeholder={addable.placeholder} mono />
              </div>
              <GhostButton onClick={addColumn} disabled={!extra.trim()}>
                <Plus size={12} />
                {t("remote.tableColumnAdd")}
              </GhostButton>
            </div>
            <p className="text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{addable.hint}</p>
          </>
        )}
      </div>
    </ApiModal>
  );
}
