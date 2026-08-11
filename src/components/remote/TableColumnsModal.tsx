import { useState } from "react";
import { ChevronDown, ChevronUp, Columns3, Plus, RotateCcw } from "lucide-react";
import { ApiModal, Field, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { useT } from "../../state/languageStore";

/**
 * Which columns the entity grid draws, and in what order — Storage Explorer's "Customize columns".
 *
 * **It exists because a schemaless table's column list is a guess, and this is where the user
 * corrects it.** The grid's columns are the union of the properties the *returned page* happened to
 * carry, which is the most the service will say: Azure does not store nulls, so a property every
 * loaded entity leaves unset does not come back at all and no amount of asking will produce it. A
 * lock table whose `owner`, `acquiredAt` and `expiresAt` are only set while a lock is held therefore
 * shows three columns when something holds one and none when nothing does — the columns blink in and
 * out with the data. Naming a property here pins it: it becomes a column that stays, drawn as `null`
 * on every entity that hasn't got it, which is exactly what the portal shows and what makes the
 * table readable between locks.
 *
 * Hiding is the other half, and the more ordinary one: a table with forty properties is a table
 * whose interesting three are off the right-hand edge.
 */
export function TableColumnsModal({
  columns,
  hidden,
  onApply,
  onClose,
}: {
  /** Every column the grid knows about, in its current display order. */
  columns: string[];
  /** The subset currently not drawn. */
  hidden: Set<string>;
  /** The new order and the new hidden set. `null` for either means "leave it as the data says" —
   *  which is how Reset gets back to a column list that follows the query again. */
  onApply: (order: string[] | null, hidden: Set<string>) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [order, setOrder] = useState<string[]>(columns);
  const [off, setOff] = useState<Set<string>>(new Set(hidden));
  const [extra, setExtra] = useState("");

  const move = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [taken] = next.splice(index, 1);
    next.splice(to, 0, taken);
    setOrder(next);
  };

  const toggle = (column: string, on: boolean) =>
    setOff((current) => {
      const next = new Set(current);
      if (on) next.delete(column);
      else next.add(column);
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

  const visible = order.filter((column) => !off.has(column)).length;

  return (
    <ApiModal
      icon={Columns3}
      title={t("remote.tableColumns")}
      subtitle={t("remote.tableColumnsSubtitle")}
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
            title={t("remote.tableColumnsResetHint")}
          >
            <RotateCcw size={12} />
            {t("remote.tableColumnsReset")}
          </GhostButton>
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton
            onClick={() => {
              onApply(order, off);
              onClose();
            }}
            disabled={visible === 0}
          >
            {t("remote.tableColumnsApply")}
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
          {order.map((column, index) => (
            <div
              key={column}
              className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <Checkbox checked={!off.has(column)} onChange={(on) => toggle(column, on)} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--cf-text)]">
                {column}
              </span>
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={t("remote.tableColumnUp")}
                title={t("remote.tableColumnUp")}
                className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-25 dark:hover:bg-white/[0.08]"
              >
                <ChevronUp size={12} />
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === order.length - 1}
                aria-label={t("remote.tableColumnDown")}
                title={t("remote.tableColumnDown")}
                className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-25 dark:hover:bg-white/[0.08]"
              >
                <ChevronDown size={12} />
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <Field
              value={extra}
              onChange={setExtra}
              placeholder={t("remote.tableColumnAddPlaceholder")}
              mono
            />
          </div>
          <GhostButton onClick={addColumn} disabled={!extra.trim()}>
            <Plus size={12} />
            {t("remote.tableColumnAdd")}
          </GhostButton>
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
          {t("remote.tableColumnAddHint")}
        </p>
      </div>
    </ApiModal>
  );
}
