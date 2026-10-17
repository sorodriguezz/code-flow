import { useMemo } from "react";
import { parseSpec, useDbStore } from "../../state/dbStore";
import { useT } from "../../state/languageStore";
import { ENVIRONMENT_COLOR, type DbEnvironment } from "../../types/database";

/** A connection's environment label, `""` when it has none (or the connection is gone). */
export function useConnectionEnvironment(connectionId: string): DbEnvironment {
  const spec = useDbStore((s) => s.connections.find((c) => c.id === connectionId)?.spec);
  const kind = useDbStore((s) => s.connections.find((c) => c.id === connectionId)?.kind);
  return useMemo(() => {
    if (!spec || !kind) return "";
    const config = parseSpec({ spec, kind, id: connectionId } as Parameters<typeof parseSpec>[0]);
    const env = config?.environment ?? "";
    return env === "dev" || env === "test" || env === "prod" ? env : "";
  }, [spec, kind, connectionId]);
}

/**
 * The environment, said where statements are about to run: a small filled pill in its colour. Prod
 * is the loud one on purpose — the point is noticing which server this tab is on before ⌘↵.
 */
export function EnvironmentChip({ environment }: { environment: DbEnvironment }) {
  const t = useT();
  if (!environment) return null;
  const color = ENVIRONMENT_COLOR[environment];
  return (
    <span
      title={t("db.environment")}
      className="shrink-0 rounded px-1.5 py-[1px] text-[10px] font-bold uppercase tracking-wide"
      style={{
        color: environment === "prod" ? "var(--cf-on-accent)" : color,
        background: environment === "prod" ? color : `color-mix(in oklab, ${color} 16%, transparent)`,
      }}
    >
      {t(`db.env.${environment}`)}
    </span>
  );
}

/** A 2px bar in the environment's colour along the top of a panel — `null` for none. */
export function EnvironmentStripe({ environment }: { environment: DbEnvironment }) {
  if (!environment) return null;
  return <div aria-hidden className="h-[2px] w-full shrink-0" style={{ background: ENVIRONMENT_COLOR[environment] }} />;
}
