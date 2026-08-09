/**
 * A collection's or folder's settings, opened as a tab beside the requests.
 *
 * This is the only place the parent levels of the auth chain, the collection variable scope and
 * the folder/collection scripts can be edited: every one of those has had a column since the
 * schema was written, but until now the only thing that ever filled them was an import — so a
 * request set to "inherit" had nothing to inherit from unless its collection came from Postman.
 *
 * Edits live in the tab's draft and reach SQLite on Save, not per keystroke. That is deliberate
 * for the variables in particular: a collection variable is read by every *other* request, so a
 * half-typed key going live the moment it is typed would change what those requests send.
 */

import { useState } from "react";
import { Boxes, FileText, Folder, Play, Save, Share2 } from "lucide-react";
import { AuthEditor, ROOT_AUTH_TYPES, authAncestors } from "./AuthPanel";
import { ScriptEditor } from "./ScriptsPanel";
import { VariableTable } from "./VariableTable";
import { useApiStore, type ApiEntityTab } from "../../state/apiStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

type PanelId = "overview" | "auth" | "variables" | "scripts";

const PANEL_LABELS: Record<PanelId, TranslationKey> = {
  overview: "api.entity.overview",
  auth: "api.tab.authorization",
  variables: "api.entity.variables",
  scripts: "api.entity.scripts",
};

export function EntitySettingsView({ tabId }: { tabId: string }) {
  const t = useT();
  const tab = useApiStore((s) => s.entityTabs.find((entry) => entry.id === tabId));
  const [panel, setPanel] = useState<PanelId>("overview");

  if (!tab) return <div className="h-full" />;

  // A folder has no variable scope of its own — `variableContext` reads the collection's blob and
  // there is no folder equivalent, so offering the tab would promise a scope that never resolves.
  const panels: PanelId[] =
    tab.kind === "collection"
      ? ["overview", "auth", "variables", "scripts"]
      : ["overview", "auth", "scripts"];
  const active = panels.includes(panel) ? panel : "overview";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header tab={tab} />

      <div className="cf-tab-strip flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-[var(--cf-border)] px-3">
        {panels.map((id) => (
          <button
            key={id}
            onClick={() => setPanel(id)}
            className={`relative flex shrink-0 items-center gap-1 whitespace-nowrap px-2 py-2 text-[12px] transition-colors ${
              active === id
                ? "text-[var(--cf-text)]"
                : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {t(PANEL_LABELS[id])}
            {active === id && <span className="absolute inset-x-1 bottom-0 h-[2px] bg-[var(--cf-accent)]" />}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {active === "overview" && <OverviewPanel tab={tab} />}
        {active === "auth" && <AuthTab tab={tab} />}
        {active === "variables" && <VariablesPanel tab={tab} />}
        {active === "scripts" && <ScriptsTab tab={tab} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ tab }: { tab: ApiEntityTab }) {
  const t = useT();
  const saveEntityTab = useApiStore((s) => s.saveEntityTab);
  const openModal = useApiModalStore((s) => s.openApiModal);
  const pushToast = useToastStore((s) => s.pushToast);
  const Icon = tab.kind === "collection" ? Boxes : Folder;

  const save = async () => {
    await saveEntityTab(tab.id);
    pushToast(t("api.entity.saved", { name: tab.name }), "success");
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
      <Icon size={14} className="shrink-0 text-[var(--cf-accent)]" />
      <span className="truncate text-[13px] font-semibold text-[var(--cf-text)]">{tab.name}</span>
      <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">
        {t(tab.kind === "collection" ? "api.scope.collection" : "api.folder")}
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          onClick={() =>
            openModal({
              kind: "runner",
              collectionId: tab.kind === "collection" ? tab.entityId : tab.collectionId,
              folderId: tab.kind === "folder" ? tab.entityId : null,
            })
          }
          title={t("api.runner.title")}
          className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        >
          <Play size={12} />
          {t("api.runner.run")}
        </button>

        {tab.kind === "collection" && (
          <>
            <button
              onClick={() => openModal({ kind: "export", collectionId: tab.entityId })}
              title={t("api.export.title")}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <Share2 size={12} />
              {t("api.export.title")}
            </button>
            {/* Next to Export because the two are asked in the same breath, and this is the screen
                where the descriptions the document is made of are actually written. */}
            <button
              onClick={() => openModal({ kind: "docs", collectionId: tab.entityId })}
              title={t("api.docs.generate")}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <FileText size={12} />
              {t("api.docs.generate")}
            </button>
          </>
        )}

        {/* Disabled while clean rather than hidden: the button is where the ⌘S it mirrors is
            discoverable, and a control that appears only once you have already typed teaches
            nothing about when the edits actually land. */}
        <button
          onClick={() => void save()}
          disabled={!tab.dirty}
          title={tab.dirty ? t("api.unsaved") : t("api.saved")}
          className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100"
        >
          <Save size={12} />
          {t("api.save")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function OverviewPanel({ tab }: { tab: ApiEntityTab }) {
  const t = useT();
  const updateEntityDraft = useApiStore((s) => s.updateEntityDraft);
  const folders = useApiStore((s) => s.folders);
  const requests = useApiStore((s) => s.requests);

  const inside =
    tab.kind === "collection"
      ? {
          folders: folders.filter((f) => f.collection_id === tab.entityId).length,
          requests: requests.filter((r) => r.collection_id === tab.entityId).length,
        }
      : {
          folders: folders.filter((f) => f.parent_id === tab.entityId).length,
          requests: requests.filter((r) => r.folder_id === tab.entityId).length,
        };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      <p className="text-[11px] text-[var(--cf-text-muted)]">
        {t("api.entity.contents", { folders: String(inside.folders), requests: String(inside.requests) })}
      </p>
      <p className="text-[11px] text-[var(--cf-text-muted)]">{t("api.entity.renameHint")}</p>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("api.description")}
        </span>
        <textarea
          value={tab.draft.description}
          onChange={(e) => updateEntityDraft(tab.id, { description: e.target.value })}
          placeholder={t("api.entity.descriptionPlaceholder")}
          className="min-h-[160px] flex-1 resize-none rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1.5 text-[12px] leading-5 text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
        />
      </label>
    </div>
  );
}

function AuthTab({ tab }: { tab: ApiEntityTab }) {
  const t = useT();
  const updateEntityDraft = useApiStore((s) => s.updateEntityDraft);
  const collections = useApiStore((s) => s.collections);
  const folders = useApiStore((s) => s.folders);

  // What sits *above* this level. A collection is the top of the chain, so nothing does; a folder
  // starts the walk at its parent, because a folder inheriting from itself is not a question.
  const ancestors =
    tab.kind === "collection"
      ? []
      : authAncestors(
          folders,
          collections,
          tab.collectionId,
          folders.find((f) => f.id === tab.entityId)?.parent_id ?? null,
        );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="shrink-0 px-3 pt-3 text-[11px] text-[var(--cf-text-muted)]">
        {t(tab.kind === "collection" ? "api.entity.authIntro" : "api.entity.authIntroFolder")}
      </p>
      <div className="min-h-0 flex-1">
        <AuthEditor
          auth={tab.draft.auth}
          onChange={(auth) => updateEntityDraft(tab.id, { auth })}
          ancestors={ancestors}
          collectionId={tab.collectionId}
          bufferKey={tab.id}
          types={tab.kind === "collection" ? ROOT_AUTH_TYPES : undefined}
        />
      </div>
    </div>
  );
}

function VariablesPanel({ tab }: { tab: ApiEntityTab }) {
  const t = useT();
  const updateEntityDraft = useApiStore((s) => s.updateEntityDraft);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-3">
      <p className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{t("api.entity.variablesIntro")}</p>
      <VariableTable
        rows={tab.draft.variables}
        onChange={(variables) => updateEntityDraft(tab.id, { variables })}
        emptyLabel={t("api.env.noVariables")}
      />
    </div>
  );
}

function ScriptsTab({ tab }: { tab: ApiEntityTab }) {
  const t = useT();
  const updateEntityDraft = useApiStore((s) => s.updateEntityDraft);
  const [kind, setKind] = useState<"pre" | "post">("pre");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-3 py-1.5">
        {(["pre", "post"] as const).map((id) => (
          <button
            key={id}
            onClick={() => setKind(id)}
            className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
              kind === id
                ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {t(id === "pre" ? "api.entity.preRequest" : "api.entity.postResponse")}
          </button>
        ))}
        <span className="ml-2 truncate text-[11px] text-[var(--cf-text-muted)]">
          {t(tab.kind === "collection" ? "api.entity.scriptsIntro" : "api.entity.scriptsIntroFolder")}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {/* Not keyed: the two scripts already have different buffer paths, so switching swaps the
            Monaco model — and each one keeps its own cursor and undo stack — while the snippet
            filter beside it survives, which a remount would clear. */}
        <ScriptEditor
          kind={kind}
          bufferKey={tab.id}
          value={kind === "pre" ? tab.draft.preScript : tab.draft.postScript}
          onChange={(next) =>
            updateEntityDraft(tab.id, kind === "pre" ? { preScript: next } : { postScript: next })
          }
        />
      </div>
    </div>
  );
}
