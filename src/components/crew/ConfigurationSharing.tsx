import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useAgentsStore } from "../../state/agentsStore";
import { useTeamStore } from "../../state/teamStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { configurationName, exportConfiguration, importConfiguration, openConfiguration } from "../../lib/agents/configurationFiles";
import { CONFIGURATION_ERRORS, EMPTY_TEXT, ZERO, prepareConfigurationImport, type ConfigurationFile, type SharingProject } from "../../lib/agents/shareConfiguration";
import type { WorkspaceAgent } from "../../types/domain";
import type { Team } from "../../types/team";
import { Btn, IconBtn, Modal, field } from "./kit/ui";
import { useL } from "./state";

const COPY = {
  import: ["Importar", "Import"],
  export: ["Exportar", "Export"],
  exported: ["Configuración exportada.", "Configuration exported."],
  imported: ["Configuración importada. Usa tus cuentas locales para los motores incluidos.", "Configuration imported. It uses your local accounts for the included engines."],
  preview: ["Revisar importación", "Review import"],
  description: ["Se crearán copias nuevas con nombres únicos. No se incluyen cuentas ni credenciales. Revisa las instrucciones, los permisos y los comandos antes de importar; nada se ejecutará al importarlos.", "New copies with unique names will be created. Accounts and credentials are excluded. Review instructions, permissions and commands before importing; importing runs nothing."],
  cancel: ["Cancelar", "Cancel"],
  importing: ["Importando…", "Importing…"],
  repositories: ["Vincula los repositorios de origen con los de este workspace", "Map the source repositories to this workspace"],
  chooseRepository: ["Elige un repositorio", "Choose a repository"],
  instructions: ["Instrucciones y permisos", "Instructions and permissions"],
  canEdit: ["Puede editar archivos", "Can edit files"],
  readOnly: ["Solo lectura", "Read only"],
  disabled: ["Desactivado", "Disabled"],
  checks: ["Comandos de verificación", "Verification commands"],
  members: ["Miembros", "Members"],
  workflow: ["Flujo fijo", "Fixed workflow"],
  behavior: ["Cómo trabaja", "How it works"],
  approvePlan: ["Aprobar el plan", "Approve the plan"],
  approveMerge: ["Aprobar la integración", "Approve integration"],
  push: ["Push automático", "Automatic push"],
  yes: ["Sí", "Yes"],
  no: ["No", "No"],
  permissions: ["Permisos", "Permissions"],
  none: ["Ninguno", "None"],
  invalid: ["Elige un archivo de configuración de CodeFlow del tipo que estás importando.", "Choose a CodeFlow configuration file of the type you are importing."],
  version: ["Esta versión del archivo no es compatible con tu versión de CodeFlow.", "This file version is not supported by your version of CodeFlow."],
  reference: ["La configuración contiene referencias incompletas o una jerarquía inválida.", "The configuration contains incomplete references or an invalid hierarchy."],
  repository: ["Vincula todos los repositorios con el workspace de destino.", "Map every repository to the destination workspace."],
  size: ["El archivo supera el tamaño máximo de 5 MB.", "The file exceeds the maximum size of 5 MB."],
  changedWorkspace: ["El workspace cambió. Vuelve a abrir la importación en el destino.", "The workspace changed. Open the import again in the destination."],
} as const;
const ERROR_COPY = {
  [CONFIGURATION_ERRORS.invalid]: COPY.invalid,
  [CONFIGURATION_ERRORS.version]: COPY.version,
  [CONFIGURATION_ERRORS.reference]: COPY.reference,
  [CONFIGURATION_ERRORS.repository]: COPY.repository,
  [CONFIGURATION_ERRORS.size]: COPY.size,
};
const PERMISSION_SEPARATOR = ", ";
const SUMMARY_SEPARATOR = " · ";
const LABEL_SEPARATOR = ": ";
const PROMPT_CLASS = "m-0 mt-2 whitespace-pre-wrap break-words text-[12px] text-[var(--cf-text-muted)]";
const LABEL_CLASS = "text-[12px] font-semibold";
const BLOCK_CLASS = "rounded-[10px] border border-[var(--cf-border)] p-3";
const STACK_CLASS = "flex flex-col gap-2";
const REPOSITORY_ROW_CLASS = "flex items-center gap-3 text-[12px]";
const REPOSITORY_NAME_CLASS = "min-w-0 flex-1 truncate";
const REPOSITORY_SELECT_CLASS = `${field} max-w-[300px]`;
const DETAILS_CLASS = "mt-2 text-[12px]";
const DETAILS_SUMMARY_CLASS = "cursor-pointer";
const ALERT_ROLE = "alert";
const PRIMARY_BUTTON = "primary";

function errorMessage(error: unknown, l: ReturnType<typeof useL>): string {
  const message = error instanceof Error ? error.message : String(error);
  const copy = ERROR_COPY[message as keyof typeof ERROR_COPY];
  if (!copy) return message;
  const [spanish, english] = copy;
  return l(spanish, english);
}

function initialRepositoryMapping(file: ConfigurationFile, projects: SharingProject[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const repository of file.repositories) {
    const normalizedName = repository.name.toLocaleLowerCase();
    const matches = projects.filter((project) => {
      const candidate = project.name.toLocaleLowerCase();
      return candidate === normalizedName;
    });
    mapping[repository.key] = matches.length === SINGLE_MATCH ? matches[ZERO].id : EMPTY_TEXT;
  }
  return mapping;
}

const SINGLE_MATCH = 1;

export function ConfigurationExportButton({ source, compact = false }: { source: WorkspaceAgent | Team; compact?: boolean }) {
  const l = useL();
  const [busy, setBusy] = useState(false);
  const title = l(...COPY.export);
  const exportFile = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const workspace = useWorkspaceStore.getState();
      const projects = workspace.projectsByWorkspace[source.workspace_id] ?? [];
      const roster = useAgentsStore.getState().roster;
      const saved = await exportConfiguration(source, roster, projects);
      if (saved) {
        const message = l(...COPY.exported);
        pushSuccessToast(message);
      }
    } catch (error) {
      const message = errorMessage(error, l);
      pushErrorToast(message);
    } finally { setBusy(false); }
  };
  if (compact) return <IconBtn title={title} icon={Download} onClick={() => void exportFile()} />;
  return <Btn small icon={Download} title={title} disabled={busy} onClick={() => void exportFile()}>{title}</Btn>;
}

export function ConfigurationImportButton({ kind }: { kind: ConfigurationFile["kind"] }) {
  const l = useL();
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [pending, setPending] = useState<{ file: ConfigurationFile; workspaceId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const title = l(...COPY.import);
  const pickFile = async () => {
    if (!workspaceId || busy) return;
    setBusy(true);
    try {
      const file = await openConfiguration(kind);
      if (file) setPending({ file, workspaceId });
    } catch (error) {
      const message = errorMessage(error, l);
      pushErrorToast(message);
    } finally { setBusy(false); }
  };
  return <>
    <Btn small icon={Upload} title={title} disabled={!workspaceId || busy} onClick={() => void pickFile()}>{title}</Btn>
    {pending && <ConfigurationImportDialog file={pending.file} workspaceId={pending.workspaceId} onClose={() => setPending(null)} />}
  </>;
}

function ConfigurationImportDialog({ file, workspaceId, onClose }: { file: ConfigurationFile; workspaceId: string; onClose: () => void }) {
  const l = useL();
  const currentWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const allProjects = useWorkspaceStore((state) => state.projectsByWorkspace);
  const projects = allProjects[workspaceId] ?? [];
  const [mapping, setMapping] = useState(() => initialRepositoryMapping(file, projects));
  const [busy, setBusy] = useState(false);
  const changedWorkspace = currentWorkspaceId !== workspaceId;
  const missingRepository = file.repositories.some((repository) => {
    const target = mapping[repository.key];
    const exists = projects.some((project) => project.id === target);
    return !exists;
  });
  const title = l(...COPY.preview);
  const description = l(...COPY.description);
  const cancelText = l(...COPY.cancel);
  const importText = busy ? l(...COPY.importing) : l(...COPY.import);
  const repositoryLabel = l(...COPY.repositories);
  const chooseRepository = l(...COPY.chooseRepository);
  const instructions = l(...COPY.instructions);
  const membersLabel = l(...COPY.members);
  const checksLabel = l(...COPY.checks);
  const name = configurationName(file);
  const dismiss = () => { if (!busy) onClose(); };
  const apply = async () => {
    const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (busy || activeWorkspaceId !== workspaceId) return;
    setBusy(true);
    try {
      const roster = useAgentsStore.getState().roster;
      const teams = useTeamStore.getState().teams;
      const agentNames = roster.map((agent) => agent.name);
      const teamNames = teams.map((team) => team.name);
      const prepared = prepareConfigurationImport(file, workspaceId, mapping, projects, agentNames, teamNames);
      const imported = await importConfiguration(workspaceId, prepared);
      useAgentsStore.setState((state) => {
        if (state.workspaceId !== workspaceId) return state;
        const ids = imported.agents.map((agent) => agent.id);
        const importedIds = new Set(ids);
        const existing = state.roster.filter((agent) => !importedIds.has(agent.id));
        return { roster: [...existing, ...imported.agents] };
      });
      if (imported.team) {
        const team = imported.team;
        useTeamStore.setState((state) => {
          if (state.workspaceId !== workspaceId) return state;
          const existing = state.teams.filter((entry) => entry.id !== team.id);
          return { teams: [...existing, team] };
        });
      }
      const message = l(...COPY.imported);
      pushSuccessToast(message);
      onClose();
    } catch (error) {
      const message = errorMessage(error, l);
      pushErrorToast(message);
    } finally { setBusy(false); }
  };
  return <Modal title={title} subtitle={description} onClose={dismiss} footer={<>
    <Btn disabled={busy} onClick={dismiss}>{cancelText}</Btn>
    <Btn kind={PRIMARY_BUTTON} icon={Upload} disabled={busy || missingRepository || changedWorkspace} onClick={() => void apply()}>{importText}</Btn>
  </>}>
    <b>{name}</b>
    {changedWorkspace && <p role={ALERT_ROLE}>{l(...COPY.changedWorkspace)}</p>}
    {file.repositories.length > ZERO && <div className={STACK_CLASS}>
      <span className={LABEL_CLASS}>{repositoryLabel}</span>
      {file.repositories.map((repository) => <label key={repository.key} className={REPOSITORY_ROW_CLASS}>
        <span className={REPOSITORY_NAME_CLASS}>{repository.name}</span>
        <select className={REPOSITORY_SELECT_CLASS} value={mapping[repository.key] ?? EMPTY_TEXT} disabled={busy} onChange={(event) => setMapping({ ...mapping, [repository.key]: event.target.value })}>
          <option value={EMPTY_TEXT}>{chooseRepository}</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>)}
    </div>}
    <div className={STACK_CLASS}>
      {file.agents.map(({ key, configuration }) => {
        const summary = [configuration.provider, configuration.model, configuration.effort].filter(Boolean);
        const route = summary.join(SUMMARY_SEPARATOR);
        const editing = configuration.edits ? l(...COPY.canEdit) : l(...COPY.readOnly);
        const permissions = configuration.perms.join(PERMISSION_SEPARATOR) || l(...COPY.none);
        return <div key={key} className={BLOCK_CLASS}>
          <b>{configuration.name}</b>
          <p className={PROMPT_CLASS}>{route}{SUMMARY_SEPARATOR}{editing}{!configuration.enabled && <>{SUMMARY_SEPARATOR}{l(...COPY.disabled)}</>}</p>
          <details className={DETAILS_CLASS}>
            <summary className={DETAILS_SUMMARY_CLASS}>{instructions}</summary>
            <p className={PROMPT_CLASS}>{configuration.role}</p>
            <p className={PROMPT_CLASS}>{configuration.prompt}</p>
            <p className={PROMPT_CLASS}>{l(...COPY.permissions)}{LABEL_SEPARATOR}{permissions}</p>
          </details>
        </div>;
      })}
    </div>
    {file.team && <div className={BLOCK_CLASS}>
      <p className={PROMPT_CLASS}>{file.team.description}</p>
      <span className={LABEL_CLASS}>{membersLabel}</span>
      {file.team.members.map((member) => <p key={member.id} className={PROMPT_CLASS}>{member.name}{SUMMARY_SEPARATOR}{member.role}</p>)}
      {file.team.policy.checks.length > ZERO && <>
        <p className={LABEL_CLASS}>{checksLabel}</p>
        {file.team.policy.checks.map((check, index) => <pre key={index} className={PROMPT_CLASS}>{check.command}</pre>)}
      </>}
      {file.team.plan.length > ZERO && <details className={DETAILS_CLASS}>
        <summary className={DETAILS_SUMMARY_CLASS}>{l(...COPY.workflow)}</summary>
        {file.team.plan.map((step) => <div key={step.key}>
          <b>{step.title}</b>
          <p className={PROMPT_CLASS}>{step.instruction}</p>
        </div>)}
      </details>}
      <details className={DETAILS_CLASS}>
        <summary className={DETAILS_SUMMARY_CLASS}>{l(...COPY.behavior)}</summary>
        <p className={PROMPT_CLASS}>{l(...COPY.approvePlan)}{LABEL_SEPARATOR}{file.team.policy.approve_plan ? l(...COPY.yes) : l(...COPY.no)}</p>
        <p className={PROMPT_CLASS}>{l(...COPY.approveMerge)}{LABEL_SEPARATOR}{file.team.policy.approve_merge ? l(...COPY.yes) : l(...COPY.no)}</p>
        <p className={PROMPT_CLASS}>{l(...COPY.push)}{LABEL_SEPARATOR}{file.team.policy.push ? l(...COPY.yes) : l(...COPY.no)}</p>
      </details>
    </div>}
  </Modal>;
}
