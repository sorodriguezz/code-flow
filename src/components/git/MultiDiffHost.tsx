import { Suspense, lazy } from "react";
import { useMultiDiffStore } from "../../state/multiDiffStore";

const MultiDiffModal = lazy(() => import("./MultiDiffModal").then((m) => ({ default: m.MultiDiffModal })));

/** Mounts «Ver todos los cambios» while one is asked for — Monaco's diff stays out of the first paint. */
export function MultiDiffHost() {
  const open = useMultiDiffStore((s) => s.request !== null);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <MultiDiffModal />
    </Suspense>
  );
}
