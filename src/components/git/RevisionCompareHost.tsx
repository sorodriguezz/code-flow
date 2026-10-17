import { lazy, Suspense } from "react";
import { useRevisionCompareStore } from "../../state/revisionCompareStore";

// Monaco's diff editor is a large chunk: loaded the first time a comparison is asked for.
const RevisionCompareModal = lazy(() => import("./RevisionCompareModal").then((m) => ({ default: m.RevisionCompareModal })));

/** The window's one «Comparar con…» dialog — see `revisionCompareStore`. Mounted once, in `App`. */
export function RevisionCompareHost() {
  const request = useRevisionCompareStore((s) => s.request);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <RevisionCompareModal repoPath={request.repoPath} path={request.path} revision={request.revision} />
    </Suspense>
  );
}
