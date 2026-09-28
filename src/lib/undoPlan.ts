import type { TranslationKey } from "./i18n/translations";
import type { ReflogOp, UndoPlan } from "./tauri/gitCommands";

type Translate = (key: TranslationKey, params?: Record<string, string>) => string;

/**
 * The sentence an undo is confirmed with — what moves, where to, and what happens to uncommitted
 * work — built from the plan the backend made (`git/reflog.rs`), so the confirmation can only ever
 * describe the undo that will actually run.
 */

/** The reflog entry's own subject: `commit: Fix the header` → `Fix the header`. */
export function reflogSubject(message: string): string {
  const at = message.indexOf(": ");
  return at === -1 ? message : message.slice(at + 2);
}

/** The label a reflog entry wears in the list and in the undo button's tooltip. */
export function reflogOpKey(op: ReflogOp): TranslationKey {
  return `reflog.op.${op}` as TranslationKey;
}

export interface UndoConfirmation {
  message: string;
  confirmLabel: string;
  danger: boolean;
}

export function describeUndo(plan: UndoPlan, t: Translate, detachedLabel: string): UndoConfirmation {
  const branch = plan.branch ?? detachedLabel;
  const sha = plan.target_oid.slice(0, 7);
  const params = { branch, sha, subject: reflogSubject(plan.message) };
  const confirmLabel = t("undo.confirmButton");

  switch (plan.strategy) {
    case "checkout": {
      const target = plan.checkout_to && /^[0-9a-f]{40}$/.test(plan.checkout_to) ? plan.checkout_to.slice(0, 7) : (plan.checkout_to ?? sha);
      return { message: t("undo.confirm.checkout", { target }), confirmLabel, danger: false };
    }
    case "soft":
      return {
        message: t(plan.op === "amend" ? "undo.confirm.amend" : "undo.confirm.commit", params),
        confirmLabel,
        danger: true,
      };
    case "mixed":
      return { message: t("undo.confirm.resetMixed", params), confirmLabel, danger: true };
    case "keep": {
      const key: TranslationKey =
        plan.op === "rebase" ? "undo.confirm.rebase" : plan.op === "reset" ? "undo.confirm.resetKeep" : "undo.confirm.merge";
      return { message: t(key, params), confirmLabel, danger: true };
    }
  }
}
