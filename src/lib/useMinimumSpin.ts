import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long a spinner stays up once it has appeared at all.
 *
 * Long enough to register as motion rather than as a flicker, short enough that it never becomes
 * the thing you are waiting for. Two frames is not a spinner; half a second reads as "it did
 * something" and is over before you could have acted on the result anyway.
 */
const MIN_SPIN_MS = 450;

/**
 * A busy flag that stays up long enough to be read.
 *
 * The problem it solves is specific: the explorer's Refresh re-lists a handful of directories over
 * local IPC and is routinely done inside one frame, so `setBusy(true)` and `setBusy(false)` landed
 * in the same React batch and the icon **never moved**. Pressing it looked identical to pressing
 * nothing — which is exactly how a working button gets reported as broken. The Changes panel's
 * Refresh only looked better because `refreshAll` is seven git invocations and happens to be slow.
 *
 * A floor rather than a fixed delay: work that genuinely takes two seconds spins for two seconds,
 * and only the too-fast case is padded. So the two buttons behave identically without either of
 * them being made artificially slow.
 *
 * Returns the flag and a runner. The runner re-throws whatever `work` threw, *after* clearing the
 * flag — a refresh that failed still owes the caller its error, and every caller here already
 * raises a toast from it.
 */
export function useMinimumSpin(minMs: number = MIN_SPIN_MS) {
  const [spinning, setSpinning] = useState(false);
  /** A refresh can outlive the panel that started it; writing state then is a React warning and a
   *  leak, and the flag it would set belongs to a component nobody is looking at. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (work: () => unknown) => {
      setSpinning(true);
      const startedAt = Date.now();
      try {
        await work();
      } finally {
        const remaining = minMs - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        if (mounted.current) setSpinning(false);
      }
    },
    [minMs],
  );

  return [spinning, run] as const;
}
