import { useEffect, useMemo, useState } from "react";
import { ClipboardCopy, FolderInput, Link2, Settings, Users } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "./ApiModal";
import { Note, Status } from "./settingsChrome";
import { Select } from "../common/Select";
import { ActivePill } from "../common/ActivePill";
import { useImportCollaborative } from "./CollaborationPanel";
import { useApiStore } from "../../state/apiStore";
import { useCollabStore } from "../../state/collabStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { supabaseAnonKey } from "../../lib/tauri/apiCommands";
import { encodeInvite, syncCollection } from "../../lib/api/sync";

/**
 * Sharing a collection, and accepting someone else's — the two halves of collaboration that happen
 * *inside* the API client rather than in its settings.
 *
 * Both live here because they are the same conversation from either end, and because the person who
 * was handed an invitation code looks for somewhere to paste it in the client, not three tabs deep
 * in a settings modal. The project credentials stay in settings: that is set up once, this is done
 * every time.
 */
export function CollabModal({
  collectionId,
  onClose,
}: {
  collectionId?: string;
  onClose: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<"share" | "import">(collectionId ? "share" : "import");
  const openModal = useApiModalStore((s) => s.openApiModal);

  return (
    <ApiModal
      icon={Users}
      title={t("api.collab.modalTitle")}
      subtitle={t("api.collab.modalSubtitle")}
      width="max-w-xl"
      onClose={onClose}
      toolbar={
        <GhostButton onClick={() => openModal({ kind: "settings" })} title={t("api.collab.openSettings")}>
          <Settings size={12} />
        </GhostButton>
      }
    >
      <div className="flex shrink-0 gap-0.5 border-b border-[var(--cf-border)] px-3 pt-2">
        {(["share", "import"] as const).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`relative min-w-0 rounded-md px-3 py-1.5 text-[12px] font-medium ${
              tab === id
                ? "text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {tab === id && <ActivePill layoutId="cf-collab-modal-pill" />}
            <span className="relative">
              {id === "share" ? t("api.collab.tabShare") : t("api.collab.tabImport")}
            </span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {tab === "share" ? <SharePane preselected={collectionId} /> : <ImportPane onDone={onClose} />}
      </div>
    </ApiModal>
  );
}

// ---------------------------------------------------------------------------

function SharePane({ preselected }: { preselected?: string }) {
  const t = useT();
  const collections = useApiStore((s) => s.collections);
  const settings = useApiStore((s) => s.settings);
  const shares = useCollabStore((s) => s.shares);
  const hasKey = useCollabStore((s) => s.hasKey);
  const startSharing = useCollabStore((s) => s.startSharing);
  const tokenFor = useCollabStore((s) => s.tokenFor);
  const openModal = useApiModalStore((s) => s.openApiModal);
  const pushToast = useToastStore((s) => s.pushToast);

  const [choice, setChoice] = useState(preselected ?? "");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [anonKey, setAnonKey] = useState("");

  useEffect(() => {
    void supabaseAnonKey().then((key) => setAnonKey(key ?? "")).catch(() => {});
  }, []);

  const sharedIds = useMemo(() => new Set(shares.map((s) => s.collection_id)), [shares]);
  const selected = collections.find((c) => c.id === choice) ?? null;
  const alreadyShared = choice !== "" && sharedIds.has(choice);
  const ready = settings.supabaseUrl.trim() !== "" && hasKey && settings.supabaseReady;

  // Selecting a collection that is already shared should show its code, not offer to mint a second
  // one — the answer to "how do I invite one more person" is the same code.
  useEffect(() => {
    setCode("");
    if (!alreadyShared || choice === "") return;
    void (async () => {
      const token = await tokenFor(choice);
      const collection = collections.find((c) => c.id === choice);
      if (token === null || !collection) return;
      setCode(encodeInvite({ url: settings.supabaseUrl, key: anonKey, token, name: collection.name }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, alreadyShared, anonKey]);

  const share = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const token = await startSharing(selected.id, selected.name);
      if (token === null) return;
      await syncCollection(selected.id).catch((e: unknown) => pushErrorToast(String(e)));
      setCode(encodeInvite({ url: settings.supabaseUrl, key: anonKey, token, name: selected.name }));
      pushToast(t("api.collab.sharingStarted", { name: selected.name }), "success");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    pushToast(t("api.collab.inviteCopied"), "success");
  };

  if (!ready) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Note tone="warning">{t("api.collab.setUpFirst")}</Note>
        <PrimaryButton onClick={() => openModal({ kind: "settings" })}>
          <Settings size={13} />
          {t("api.collab.openSettings")}
        </PrimaryButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Note>{t("api.collab.shareHint")}</Note>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("api.collab.pickCollection")}
        </span>
        <Select
          value={choice}
          onChange={setChoice}
          placeholder={t("api.collab.pickCollection")}
          options={collections.map((collection) => ({
            value: collection.id,
            label: sharedIds.has(collection.id)
              ? `${collection.name} · ${t("api.collab.alreadyShared")}`
              : collection.name,
          }))}
        />
      </label>

      {code === "" ? (
        <div>
          <PrimaryButton onClick={() => void share()} disabled={busy || choice === ""}>
            <Link2 size={13} />
            {t("api.collab.share")}
          </PrimaryButton>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Status tone="success">{t("api.collab.codeReady")}</Status>
          {/* Selectable rather than hidden behind the button alone: someone reading this over a
              call needs to be able to see what they are about to paste. */}
          <textarea
            readOnly
            value={code}
            onFocus={(e) => e.currentTarget.select()}
            rows={3}
            className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-black/[0.02] px-2 py-1.5 font-mono text-[11px] text-[var(--cf-text-muted)] outline-none focus:border-[var(--cf-accent)] dark:bg-white/[0.03]"
          />
          <div className="flex items-center gap-1.5">
            <PrimaryButton onClick={() => void copy()}>
              <ClipboardCopy size={13} />
              {t("api.collab.copyInvite")}
            </PrimaryButton>
          </div>
          <Note tone="warning">{t("api.collab.tokenIsACredential")}</Note>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ImportPane({ onDone }: { onDone: () => void }) {
  const t = useT();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const importCollaborative = useImportCollaborative();

  const [code, setCode] = useState("");
  const [target, setTarget] = useState(activeWorkspaceId ?? "");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      if (await importCollaborative(code, target)) onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Note>{t("api.collab.joinHint")}</Note>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("api.collab.invitationCode")}
        </span>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("api.collab.joinPlaceholder")}
          rows={3}
          className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)]"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("api.collab.pickWorkspace")}
        </span>
        <Select
          value={target}
          onChange={setTarget}
          placeholder={t("api.collab.pickWorkspace")}
          options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
        />
      </label>

      <div>
        <PrimaryButton onClick={() => void run()} disabled={busy || code.trim() === "" || target === ""}>
          <FolderInput size={13} />
          {busy ? t("api.collab.importing") : t("api.collab.join")}
        </PrimaryButton>
      </div>
    </div>
  );
}
