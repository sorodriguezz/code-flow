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
import { Boxes, ChevronRight, FileText, Folder, Play, Save, Share2 } from "lucide-react";
import { AuthEditor, ROOT_AUTH_TYPES, authAncestors } from "./AuthPanel";
import { ScriptEditor } from "./ScriptsPanel";
import { VariableTable } from "./VariableTable";
import { buttonClass, Kbd } from "../common/Button";
import { ActiveUnderline } from "../common/ActivePill";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import { underlineStripClass, underlineTabClass } from "../common/recipes";
import { useApiStore, type ApiEntityTab } from "../../state/apiStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { useShortcutChord } from "../../lib/useShortcutHint";
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

      <div role="tablist" className={underlineStripClass}>
        {panels.map((id) => {
          const selected = active === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setPanel(id)}
              className={underlineTabClass(selected)}
            >
              {t(PANEL_LABELS[id])}
              {selected && <ActiveUnderline layoutId="cf-api-entity-panel" />}
            </button>
          );
        })}
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
  const chord = useShortcutChord();
  const saveEntityTab = useApiStore((s) => s.saveEntityTab);
  const openModal = useApiModalStore((s) => s.openApiModal);
  const pushToast = useToastStore((s) => s.pushToast);
  const Icon = tab.kind === "collection" ? Boxes : Folder;
  // ⌘S reaches a settings tab through the same "save" command a request's does (see `ApiView`),
  // and that command is bound under the editor's id — so the key cap is read from there.
  const saveChord = chord("editor.save");

  const save = async () => {
    await saveEntityTab(tab.id);
    pushToast(t("api.entity.saved", { name: tab.name }), "success");
  };

  return (
    // The builder's name row, so switching between a request and its collection's settings keeps
    // the page still: the glyph, what kind of thing this is where the builder puts the path, then
    // the name — here not editable, since renaming happens in the sidebar.
    <div className="flex h-[46px] shrink-0 items-center gap-2 pl-3.5 pr-3">
      <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center">
        <Icon size={15} className="text-[var(--cf-accent)]" />
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[12px] text-[var(--cf-text-muted)]">
        {t(tab.kind === "collection" ? "api.scope.collection" : "api.folder")}
        <ChevronRight size={12} className="shrink-0 opacity-60" />
      </span>
      <span className="min-w-0 truncate text-[14px] font-semibold text-[var(--cf-text)]" title={tab.name}>
        {tab.name}
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Tooltip label={t("api.runner.title")}>
          <button
            type="button"
            onClick={() =>
              openModal({
                kind: "runner",
                collectionId: tab.kind === "collection" ? tab.entityId : tab.collectionId,
                folderId: tab.kind === "folder" ? tab.entityId : null,
              })
            }
            className={buttonClass({ variant: "ghost" })}
          >
            <Play size={14} />
            {t("api.runner.run")}
          </button>
        </Tooltip>

        {tab.kind === "collection" && (
          <>
            <button
              type="button"
              onClick={() => openModal({ kind: "export", collectionId: tab.entityId })}
              className={buttonClass({ variant: "ghost" })}
            >
              <Share2 size={14} />
              {t("api.export.title")}
            </button>
            {/* Next to Export because the two are asked in the same breath, and this is the screen
                where the descriptions the document is made of are actually written. */}
            <button
              type="button"
              onClick={() => openModal({ kind: "docs", collectionId: tab.entityId })}
              className={buttonClass({ variant: "ghost" })}
            >
              <FileText size={14} />
              {t("api.docs.generate")}
            </button>
          </>
        )}

        {/* Disabled while clean rather than hidden: the button is where the ⌘S it mirrors is
            discoverable, and a control that appears only once you have already typed teaches
            nothing about when the edits actually land. */}
        <Tooltip
          label={tab.dirty ? t("api.unsaved") : t("api.saved")}
          trailing={saveChord ? <Kbd>{saveChord}</Kbd> : undefined}
        >
          <button
            type="button"
            onClick={() => void save()}
            disabled={!tab.dirty}
            className={buttonClass({ variant: "secondary", className: "ml-1" })}
          >
            <Save size={14} />
            {t("api.save")}
          </button>
        </Tooltip>
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
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto px-3.5 py-3">
      <div className="flex flex-col gap-1">
        <p className="text-[12px] tabular-nums text-[var(--cf-text-muted)]">
          {t("api.entity.contents", { folders: String(inside.folders), requests: String(inside.requests) })}
        </p>
        <p className="text-[12px] text-[var(--cf-text-faint)]">{t("api.entity.renameHint")}</p>
      </div>

      <label className="flex min-h-0 flex-1 flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
          {t("api.description")}
        </span>
        <textarea
          value={tab.draft.description}
          onChange={(e) => updateEntityDraft(tab.id, { description: e.target.value })}
          placeholder={t("api.entity.descriptionPlaceholder")}
          className="min-h-[160px] flex-1 resize-none rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-2 text-[13px] leading-5 text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
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
      <p className="shrink-0 px-3.5 pt-3 text-[12px] text-[var(--cf-text-muted)]">
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
    <div className="flex h-full min-h-0 flex-col gap-2.5 overflow-auto px-3.5 py-3">
      <p className="shrink-0 text-[12px] text-[var(--cf-text-muted)]">{t("api.entity.variablesIntro")}</p>
      <VariableTable
        rows={tab.draft.variables}
        onChange={(variables) => updateEntityDraft(tab.id, { variables })}
      />
    </div>
  );
}

function ScriptsTab({ tab }: { tab: ApiEntityTab }) {
  const t = useT();
  const updateEntityDraft = useApiStore((s) => s.updateEntityDraft);
  const [kind, setKind] = useState<"pre" | "post">("pre");

  const intro = t(tab.kind === "collection" ? "api.entity.scriptsIntro" : "api.entity.scriptsIntroFolder");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-[var(--cf-border)] px-3.5">
        <Segmented
          size="sm"
          layoutId="cf-api-entity-script"
          ariaLabel={t("api.entity.scripts")}
          value={kind}
          onChange={setKind}
          options={[
            { value: "pre", label: t("api.entity.preRequest") },
            { value: "post", label: t("api.entity.postResponse") },
          ]}
        />
        <span className="min-w-0 truncate text-[12px] text-[var(--cf-text-muted)]" title={intro}>
          {intro}
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
