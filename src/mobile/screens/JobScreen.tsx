import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Card } from "../ui/List";
import { ErrorState, Skeleton } from "../ui/Feedback";

/**
 * What one finished run actually produced.
 *
 * `get_job_result` answers the stored output as a single string, or `null` for a row that recorded
 * no result — a run that failed before it printed anything, or one from before results were kept.
 * `null` is not a failure and is not drawn as one.
 *
 * # Why this is a separate call from the list
 *
 * `list_job_history` takes a `withResult` flag and this client passes `false`. An agent run's result
 * is its whole transcript; twenty of them in one response is a listing that costs megabytes to draw
 * twenty rows of forty characters. The transcript is fetched here, for the one row that was opened.
 */
export function JobScreen({ id, label }: { id: string; label: string }) {
  const [result, setResult] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      setResult(await rpc<string | null>("get_job_result", { id }));
      setState("ready");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen bar={<PushBar title={label} subtitle={t("runs.jobResult")} />}>
      {state === "loading" ? (
        <div className="mt-3 space-y-2" role="status" aria-label={t("common.loading")}>
          {[92, 70, 84, 45, 76].map((width, index) => (
            <Skeleton key={index} className="h-3" style={{ width: `${width}%` }} />
          ))}
        </div>
      ) : state === "error" ? (
        <ErrorState title={t("runs.jobFailed")} detail={failure} onRetry={() => void load()} />
      ) : !result ? (
        <p className="px-6 pt-10 text-center text-base text-[var(--cf-text-muted)]">
          {t("common.empty")}
        </p>
      ) : (
        <Card padded className="mt-3">
          <p className="cf-prose text-[var(--cf-text)]">{result}</p>
        </Card>
      )}
    </Screen>
  );
}
