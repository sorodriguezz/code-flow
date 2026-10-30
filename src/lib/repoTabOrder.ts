/** Unknown saved ids are ignored; new tabs keep their default order at the end. */
export function orderedRepoTabs<T extends { id: string }>(tabs: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return tabs.slice().sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
}

/** Reorder the visible slots without losing the positions of disabled or unavailable tabs. */
export function moveVisibleRepoTab<T extends { id: string }>(
  all: readonly T[], visible: readonly T[], from: number, to: number,
): string[] {
  const moved = visible.slice();
  if (from < 0 || to < 0 || from >= moved.length || to >= moved.length) return all.map((tab) => tab.id);
  const [lifted] = moved.splice(from, 1);
  moved.splice(to, 0, lifted);
  const visibleIds = new Set(visible.map((tab) => tab.id));
  let index = 0;
  return all.map((tab) => visibleIds.has(tab.id) ? moved[index++].id : tab.id);
}
