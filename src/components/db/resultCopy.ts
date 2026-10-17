import { Copy, FileSpreadsheet } from "lucide-react";
import type { MenuItem } from "../common/ContextMenu";
import { formatResult, type ExportFormat } from "../../lib/db/resultExport";
import { dbSaveXlsx } from "../../lib/tauri/dbCommands";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { translate } from "../../state/languageStore";
import type { DbStatementResult } from "../../types/database";

/**
 * "Copy as …" for a result: the same formats the export writes to a file, straight to the clipboard
 * — a result pasted into a ticket or a chat is the commoner trip than one saved to disk. CSV stays
 * first and separate (it is the oldest entry, and the one muscle memory reaches for).
 */
export function copyFormats(result: DbStatementResult, table: string): MenuItem[] {
  const formats: { format: ExportFormat; label: string }[] = [
    { format: "tsv", label: "TSV" },
    { format: "json", label: "JSON" },
    { format: "sql", label: "INSERT" },
    { format: "markdown", label: "Markdown" },
  ];
  return formats.map(({ format, label }) => ({
    label: translate("db.copyAs", { format: label }),
    icon: Copy,
    onClick: () => {
      void navigator.clipboard
        .writeText(formatResult(result, format, table))
        .then(() => useToastStore.getState().pushToast(translate("db.copied"), "success"))
        .catch(() => pushErrorToast(translate("db.cellCopyFailed")));
    },
  }));
}

/** The result as an `.xlsx`, through a save dialog. */
export async function exportXlsx(result: DbStatementResult, name: string): Promise<void> {
  try {
    const saved = await dbSaveXlsx(`${name}.xlsx`, result.columns, result.rows);
    if (saved) useToastStore.getState().pushToast(translate("db.exported", { path: saved }), "success");
  } catch (e) {
    pushErrorToast(String(e));
  }
}

/** The Excel entry for an export menu. */
export function xlsxItem(result: DbStatementResult, name: string): MenuItem {
  return {
    label: translate("db.exportAs", { format: "Excel" }),
    icon: FileSpreadsheet,
    onClick: () => void exportXlsx(result, name),
  };
}
