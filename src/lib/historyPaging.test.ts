import { describe, expect, it } from "vitest";
import { advancePage, MAX_REPEATS } from "./historyPaging";

const PAGE = 50;

/** One page, with the defaults a healthy walk has. */
const page = (over: Partial<Parameters<typeof advancePage>[0]> = {}) =>
  advancePage({ pageSize: PAGE, returned: PAGE, fresh: PAGE, offset: 0, repeats: 0, ...over });

describe("advancePage", () => {
  it("keeps going after a full page of new rows", () => {
    expect(page()).toEqual({ hasMore: true, repeats: 0, offset: 50 });
  });

  it("stops on a short page", () => {
    expect(page({ returned: 12, fresh: 12 })).toEqual({ hasMore: false, repeats: 0, offset: 12 });
  });

  it("stops on an empty page", () => {
    expect(page({ returned: 0, fresh: 0 })).toEqual({ hasMore: false, repeats: 0, offset: 0 });
  });

  it("treats an exactly-full last page as more, then stops on the empty one after it", () => {
    // A history that is an exact multiple of the page size: the last real page looks like any
    // other, so the walk can only learn it was the last by asking once more.
    const first = page({ offset: 0 });
    expect(first.hasMore).toBe(true);
    const second = advancePage({ pageSize: PAGE, returned: 0, fresh: 0, offset: first.offset, repeats: first.repeats });
    expect(second.hasMore).toBe(false);
  });

  it("keeps walking through a full page that was all duplicates", () => {
    // The bug this function exists for. Fifty rows deleted above the cursor shifts the window, so
    // the next page *is* the previous one — and reading that as "the end" is how everything older
    // silently disappears for the rest of the session.
    const outcome = page({ fresh: 0 });
    expect(outcome.hasMore).toBe(true);
    expect(outcome.repeats).toBe(1);
    expect(outcome.offset).toBe(50);
  });

  it("advances the offset even when nothing was fresh, so it cannot re-read the same window", () => {
    expect(page({ fresh: 0, offset: 100 }).offset).toBe(150);
  });

  it("gives up after enough consecutive duplicate pages", () => {
    let state = { hasMore: true, repeats: 0, offset: 0 };
    for (let i = 0; i < MAX_REPEATS; i++) {
      expect(state.hasMore, `should still be walking at repeat ${i}`).toBe(true);
      state = advancePage({ pageSize: PAGE, returned: PAGE, fresh: 0, offset: state.offset, repeats: state.repeats });
    }
    // A backend that really does keep serving one page cannot spin this for ever.
    expect(state.hasMore).toBe(false);
    expect(state.repeats).toBe(MAX_REPEATS);
  });

  it("forgives an isolated duplicate page once real rows arrive again", () => {
    const stalled = page({ fresh: 0 });
    expect(stalled.repeats).toBe(1);
    const recovered = advancePage({
      pageSize: PAGE,
      returned: PAGE,
      fresh: 4,
      offset: stalled.offset,
      repeats: stalled.repeats,
    });
    expect(recovered.repeats).toBe(0);
    expect(recovered.hasMore).toBe(true);
  });

  it("walks a whole history to the end", () => {
    // 127 rows in pages of 50: two full pages, then a short one.
    const total = 127;
    let state = { hasMore: true, repeats: 0, offset: 0 };
    let pages = 0;
    while (state.hasMore && pages < 10) {
      const returned = Math.min(PAGE, Math.max(0, total - state.offset));
      state = advancePage({ pageSize: PAGE, returned, fresh: returned, offset: state.offset, repeats: state.repeats });
      pages++;
    }
    expect(pages).toBe(3);
    expect(state.offset).toBe(total);
  });
});
