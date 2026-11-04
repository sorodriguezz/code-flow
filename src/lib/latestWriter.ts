/**
 * Writes the newest of a stream of values, as soon as possible and never out of order: one write in
 * flight at a time, and whatever arrived meanwhile goes next as a single write of the latest value.
 * No timer — a value is on its way the moment it is pushed — so `flush()` (awaited before a window
 * closes) only has to wait for what is already moving.
 *
 * Used for a chat island's draft (`lib/chatIslands`): every keystroke reaches disk without a
 * settings write per keystroke piling up behind a slow one.
 */
export interface LatestWriter<T> {
  push: (value: T) => void;
  /** Resolves once the latest pushed value has been written (or the write failed). */
  flush: () => Promise<void>;
}

export function createLatestWriter<T>(write: (value: T) => Promise<unknown>): LatestWriter<T> {
  let pending: { value: T } | null = null;
  let running: Promise<void> | null = null;

  const pump = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      while (pending) {
        const { value } = pending;
        pending = null;
        try {
          await write(value);
        } catch {
          // A failed write is retried by the next push, or by nothing — never by a loop here.
        }
      }
      running = null;
    })();
    return running;
  };

  return {
    push: (value) => {
      pending = { value };
      void pump();
    },
    flush: async () => {
      while (running || pending) await pump();
    },
  };
}
