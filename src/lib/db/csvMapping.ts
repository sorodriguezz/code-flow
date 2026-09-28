/**
 * Which column of a CSV file goes into which column of the table — the import dialog's first guess.
 *
 * With a header, by name: compared the way people actually vary them (`Customer ID`, `customer_id`
 * and `customerId` are one column). Without one, by position, which is what a headerless export of
 * the same table means. Every guess is only a starting point — the dialog shows each as a picker —
 * and a table column is never offered twice.
 */

/** A name as the matcher sees it: lower case, without `_`, `-` or spaces. Mirrors `normalize` in
 *  `datasource/csv_import.rs`, which makes the header guess with the same comparison. */
export function normalizeColumnName(name: string): string {
  return name.trim().toLowerCase().replace(/[_\s-]/g, "");
}

export function autoMapColumns(
  first: (string | null)[],
  width: number,
  tableColumns: string[],
  hasHeader: boolean,
): (string | null)[] {
  const taken = new Set<string>();
  return Array.from({ length: width }, (_, index) => {
    const pick = hasHeader
      ? tableColumns.find(
          (column) =>
            !taken.has(column) && normalizeColumnName(column) === normalizeColumnName(first[index] ?? ""),
        )
      : tableColumns[index];
    if (!pick || taken.has(pick)) return null;
    taken.add(pick);
    return pick;
  });
}
