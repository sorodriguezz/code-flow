import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, Package, Search } from "lucide-react";
import { ApiModal, Field, GhostButton, PrimaryButton } from "../api/ApiModal";
import { useNpmInstallStore } from "../../state/npmInstallStore";
import { useTerminalStore } from "../../state/terminalStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { Tooltip } from "../common/Tooltip";
import { openExternalUrl } from "../../lib/tauri/commands";
import { npmPackageUrl, npmSearch, type SearchHit } from "../../lib/npm";
import { addCommandLine } from "../../lib/packageScripts";

/**
 * Searching the npm registry and installing what you pick.
 *
 * # It runs the install, it does not write the file
 *
 * Pressing install types `pnpm add …` into a terminal in the dock rather than editing
 * `dependencies` directly. Three reasons, in order of weight: the lockfile and `node_modules` have
 * to move together with the manifest, and only the package manager can do that; the resolved version
 * is the manager's answer, not ours, so writing `^1.2.3` ourselves would be a guess that the next
 * install silently corrects; and an install is slow, occasionally fails, and asks questions — all of
 * which a terminal shows and a spinner in a dialog hides.
 *
 * # Why the search box waits
 *
 * Every keystroke is an outbound request to a service nobody is paying for, so the query settles
 * before it is sent. The request in flight is also tracked, because answers come back out of order:
 * typing `re` then `react` can have `re`'s larger result land second and overwrite the one that was
 * asked for. The sequence check is what stops the list flickering back to the wrong search.
 */
const DEBOUNCE_MS = 300;

export function AddDependencyModal() {
  const target = useNpmInstallStore((s) => s.target);
  const close = useNpmInstallStore((s) => s.close);
  const t = useT();

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  /** Which request the newest answer must belong to for it to be drawn. */
  const sequence = useRef(0);

  // A fresh dialog every time it opens: the previous search belonged to another question. The name
  // the caller already knows is the one exception — see `NpmInstallTarget.query`.
  useEffect(() => {
    if (!target) return;
    setQuery(target.query ?? "");
    setHits([]);
    // Pre-picked as well, so a quick fix that named the package is one press from installing it.
    // The row still has to come back from the registry for the button to mean anything, and the
    // search below runs on the same tick.
    setPicked(target.query ?? null);
  }, [target]);

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mine = ++sequence.current;
    const timer = setTimeout(() => {
      void npmSearch(text, 25)
        .then((found) => {
          // A stale answer is dropped rather than drawn. Without this the list shows the results of
          // a query the box no longer contains.
          if (mine !== sequence.current) return;
          setHits(found);
        })
        .catch(() => mine === sequence.current && setHits([]))
        .finally(() => mine === sequence.current && setSearching(false));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const dev = target?.block === "devDependencies";
  const chosen = useMemo(() => hits.find((hit) => hit.name === picked) ?? null, [hits, picked]);

  if (!target) return null;

  const install = () => {
    if (!chosen) return;
    const command = addCommandLine(target.manager, chosen.name, dev);
    // The name came back from the registry already filtered by `valid_package_name` in Rust, and
    // `addCommandLine` refuses anything that would not survive a shell. Both locks stay: this is the
    // one path that turns a name off the network into a line typed at a prompt.
    if (!command) {
      pushErrorToast(t("npm.installRefused", { name: chosen.name }));
      return;
    }
    const cwd = target.dir ? `${target.repoPath}/${target.dir}` : target.repoPath;
    void useTerminalStore
      .getState()
      .runCommand(target.projectId, {
        cwd,
        command,
        // Per manifest rather than per package: installs into one project queue in one shell, which
        // is what you want — two managers writing the same lockfile at once is how it gets corrupted.
        reuseKey: `npm-install:${target.manifestPath}`,
        title: t("npm.installTitle"),
      })
      .catch((e: unknown) => pushErrorToast(String(e)));
    close();
  };

  return (
    <ApiModal
      icon={Package}
      title={t(dev ? "npm.addDevTitle" : "npm.addTitle")}
      subtitle={t("npm.addSubtitle", { manager: target.manager, dir: target.dir || "/" })}
      width="max-w-xl"
      height="h-[32rem]"
      onClose={close}
      footer={
        <>
          <GhostButton onClick={close}>{t("common.cancel")}</GhostButton>
          <PrimaryButton onClick={install} disabled={!chosen}>
            {chosen ? t("npm.installNamed", { name: chosen.name }) : t("npm.install")}
          </PrimaryButton>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="relative shrink-0">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
          />
          <Field
            value={query}
            onChange={setQuery}
            placeholder={t("npm.searchPlaceholder")}
            className="pl-7"
          />
        </div>

        {/* `overflow-y-auto` and not `cf-scroll`: that class is defined in `mobile/mobile.css`, which
            the desktop bundle never loads — so the list was clipped at whatever the panel
            height allowed and the rest of the results were unreachable. */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[var(--cf-border)]">
          {searching && hits.length === 0 ? (
            <p className="flex items-center justify-center gap-2 py-10 text-[12px] text-[var(--cf-text-muted)]">
              <Loader2 size={13} className="animate-spin" />
              {t("npm.searching")}
            </p>
          ) : hits.length === 0 ? (
            <p className="py-10 text-center text-[12px] text-[var(--cf-text-muted)]">
              {query.trim() ? t("npm.noResults") : t("npm.searchHint")}
            </p>
          ) : (
            hits.map((hit) => (
              /* A wrapper so the row and the link to the registry can both be real buttons: one
                 cannot be nested inside the other, so the link sits over the row in a strip of
                 padding the row reserves for it. */
              <div key={hit.name} className="group/hit relative border-b border-[var(--cf-border)] last:border-b-0">
                <button
                  type="button"
                  onClick={() => setPicked(hit.name)}
                  onDoubleClick={() => {
                    setPicked(hit.name);
                    install();
                  }}
                  className={`flex w-full flex-col items-start gap-0.5 py-2 pl-3 pr-9 text-left ${
                    picked === hit.name
                      ? "bg-[color-mix(in_oklab,var(--cf-accent)_14%,transparent)]"
                      : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  }`}
                >
                  <span className="flex w-full items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--cf-text)]">
                      {hit.name}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                      {hit.version}
                    </span>
                  </span>
                  {hit.description && (
                    <span className="line-clamp-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                      {hit.description}
                    </span>
                  )}
                </button>

                {/* The registry's own page, for the decision this dialog cannot help with.
                    A one-line description and a version number are enough to recognise a package
                    you already know and not nearly enough to choose between four you do not — that
                    needs the README, the weekly downloads and when it was last published, and all
                    three are one click away rather than something to reproduce here. */}
                <Tooltip label={t("npm.openRegistry", { name: hit.name })}>
                  <button
                    type="button"
                    onClick={() => void openExternalUrl(npmPackageUrl(hit.name))}
                    className={`absolute right-1.5 top-2 flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] transition-opacity hover:bg-black/[0.06] hover:text-[var(--cf-text)] focus-visible:opacity-100 dark:hover:bg-white/[0.10] ${
                      picked === hit.name ? "opacity-100" : "opacity-0 group-hover/hit:opacity-100"
                    }`}
                  >
                    <ExternalLink size={13} />
                  </button>
                </Tooltip>
              </div>
            ))
          )}
        </div>
      </div>
    </ApiModal>
  );
}
