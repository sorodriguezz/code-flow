import { useEffect, useState } from "react";
import { architectureScanSystem, architectureSequenceFrom, type SystemMap } from "../../../lib/tauri/commands";
import { useT } from "../../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../../state/toastStore";
import { chipClass } from "../../common/recipes";
import { buttonClass } from "../../common/Button";

/**
 * How the chosen repositories connect, read from their code before any model is asked: each link with
 * how sure it is, the calls that could not be placed, and — per repository — a sequence of what happens
 * from it outward, copied as Mermaid to paste into a diagram.
 */
export function ConnectionsPreview({ repos }: { repos: string[] }) {
  const t = useT();
  const [map, setMap] = useState<SystemMap | "loading" | { error: string }>("loading");
  const key = repos.join("\n");

  useEffect(() => {
    let live = true;
    setMap("loading");
    // Debounced: ticking three repositories in a row is one read, not three.
    const timer = window.setTimeout(() => {
      void architectureScanSystem(repos)
        .then((found) => live && setMap(found))
        .catch((error) => live && setMap({ error: String(error) }));
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const copySequence = async (start: string) => {
    try {
      const text = await architectureSequenceFrom(repos, start);
      if (!text) {
        useToastStore.getState().pushToast(t("arch.gen.noSequence", { name: start }), "info");
        return;
      }
      await navigator.clipboard.writeText(text);
      useToastStore.getState().pushToast(t("arch.gen.sequenceCopied", { name: start }), "success");
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  if (map === "loading") return <p className="m-0 text-[12px] text-[var(--cf-text-faint)]">{t("arch.gen.scanning")}</p>;
  if ("error" in map) return <p className="m-0 text-[12px] text-[var(--cf-danger)]">{map.error}</p>;

  const origins = Array.from(new Set(map.links.map((link) => link.from)));
  return (
    <div className="mt-1 rounded-lg border border-[var(--cf-border)] p-3 text-[12px]">
      <p className="m-0 mb-2 font-medium text-[var(--cf-text)]">{t("arch.gen.connections", { n: map.links.length })}</p>
      {map.links.length === 0 ? (
        <p className="m-0 text-[var(--cf-text-faint)]">{t("arch.gen.noConnections")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {map.links.map((link, i) => (
            <li key={i} className="flex min-w-0 flex-wrap items-center gap-1.5 text-[var(--cf-text-muted)]">
              <span className="font-medium text-[var(--cf-text)]">{link.from}</span>
              <span>→</span>
              <span className="font-medium text-[var(--cf-text)]">{link.to}</span>
              <span className="min-w-0 truncate font-mono text-[11px]">{link.via}</span>
              <span className={chipClass(link.confidence === "verified" ? "ok" : "neutral")}>{t(link.confidence === "verified" ? "arch.gen.verified" : "arch.gen.inferred")}</span>
            </li>
          ))}
        </ul>
      )}
      {map.unresolved.length > 0 && <p className="m-0 mt-2 text-[var(--cf-warning)]">{t("arch.gen.unresolved", { n: map.unresolved.length })}</p>}
      {origins.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {origins.map((name) => (
            <button key={name} type="button" className={buttonClass({ size: "sm", variant: "ghost" })} onClick={() => void copySequence(name)}>
              {t("arch.gen.copySequence", { name })}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
