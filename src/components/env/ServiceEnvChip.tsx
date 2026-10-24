/**
 * The env files a service gets, in its console's info strip — the Services half of «Entorno»
 * (2026-10-23: «y en Servicios»). Names and counts only: which files it reads, how many variables,
 * how many come from the Llavero at start (`repo_env::inject`). A click opens «Entorno» on the
 * service's repository.
 */

import { useEffect, useState } from "react";
import { KeyRound, SquareAsterisk } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { repoEnvServiceFiles, type EnvServiceFiles } from "../../lib/tauri/envCommands";
import type { ServiceRow } from "../../types/services";

export function ServiceEnvChip({ service }: { service: ServiceRow }) {
  const t = useT();
  const [info, setInfo] = useState<EnvServiceFiles | null>(null);

  // Read again whenever the definition changes (its folder, its env files, its command).
  useEffect(() => {
    let live = true;
    repoEnvServiceFiles(service.id)
      .then((result) => live && setInfo(result))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [service.id, service.updated_at, service.cwd, service.env_files, service.command]);

  if (!info || info.files.length === 0) return null;
  const references = info.files.reduce((sum, f) => sum + f.references.length, 0);
  const names = info.files.map((f) => f.path.split(/[\\/]/).pop()).join(", ");
  const detail = info.files
    .map((f) =>
      t(f.loads ? "env.service.fileLoads" : "env.service.fileRefs", { file: f.path, count: f.variables, refs: f.references.length }),
    )
    .join("\n");

  const open = () => {
    if (info.projectId) useWorkspaceStore.getState().setActiveProject(info.projectId);
    useUiStore.getState().setActiveView("env");
  };

  return (
    <Tooltip label={<span className="whitespace-pre-line">{`${detail}\n${t("env.service.open")}`}</span>}>
      <button type="button" onClick={open} className="flex min-w-0 shrink-[2] items-center gap-1.5 hover:text-[var(--cf-text)]">
        <SquareAsterisk size={11} className="shrink-0" />
        <span className="truncate">{names}</span>
        {references > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-[var(--cf-accent)]">
            <KeyRound size={10} />
            {references}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
