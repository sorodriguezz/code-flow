/** One place the app keeps things, as `storage_usage` reports it. */
export interface StorageCategory {
  id: string;
  path: string;
  bytes: number;
  files: number;
  clearable: boolean;
}

export interface StorageUsage {
  categories: StorageCategory[];
  free_bytes: number;
  total_bytes: number;
}

/** Places that hold nothing are not worth a row. */
export function visibleCategories(usage: StorageUsage): StorageCategory[] {
  return usage.categories.filter((category) => category.bytes > 0).sort((a, b) => b.bytes - a.bytes);
}

/** The bar's widths: each place's share of what the app holds, in whole percents that add to what they are. */
export function shares(categories: StorageCategory[]): number[] {
  const total = categories.reduce((sum, category) => sum + category.bytes, 0);
  return total === 0 ? categories.map(() => 0) : categories.map((category) => Math.max(1, Math.round((category.bytes / total) * 100)));
}

/** Whether the disk is tight enough to say so: under 5 GB or 5% free. `false` when it could not be told. */
export function diskIsTight(usage: StorageUsage): boolean {
  if (usage.total_bytes <= 0) return false;
  return usage.free_bytes < 5 * 1024 ** 3 || usage.free_bytes / usage.total_bytes < 0.05;
}

/** What clearing can give back: the sum of the places that can be cleared. */
export function reclaimable(usage: StorageUsage): number {
  return usage.categories.filter((category) => category.clearable).reduce((sum, category) => sum + category.bytes, 0);
}
