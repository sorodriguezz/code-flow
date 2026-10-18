import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { FileCode2, Loader2 } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { languageForPath } from "../../lib/monacoLanguage";
import { remoteListFiles, remoteReadText, remoteWriteText } from "../../lib/tauri/remoteCommands";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { parentRemote } from "./remoteChrome";
import type { RemoteFile } from "../../types/remote";

/**
 * A remote file, open for editing: read over the host's own transport (SFTP, FTP, SMB, a bucket),
 * edited here, written back on save.
 *
 * A dialog rather than an editor tab, because the editor's tabs are files of the open repository —
 * every command there resolves a path against it — and a file on another machine is not one.
 *
 * **Someone else may change it meanwhile.** The size and modification time it was opened at are
 * kept, and a save first lists the folder again: if the file moved on, the user is asked before it
 * is overwritten.
 */
export function RemoteFileEditor({
  hostId,
  entry,
  onClose,
}: {
  hostId: string;
  entry: RemoteFile;
  onClose: () => void;
}) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  /** What the file looked like on the host when it was read, or last written from here. */
  const seen = useRef({ size: entry.size, modified: entry.modified });
  // The parent hands a fresh closure on every render; read through a ref so the file is read once.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let alive = true;
    remoteReadText(hostId, entry.path)
      .then((content) => {
        if (!alive) return;
        setText(content);
        setSaved(content);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        pushErrorToast(String(error));
        closeRef.current();
      });
    return () => {
      alive = false;
    };
  }, [hostId, entry.path]);

  const dirty = text !== null && text !== saved;

  const lookup = useCallback(async (): Promise<RemoteFile | null> => {
    const listing = await remoteListFiles(hostId, parentRemote(entry.path)).catch(() => null);
    return listing?.entries.find((candidate) => candidate.path === entry.path) ?? null;
  }, [hostId, entry.path]);

  const save = useCallback(async () => {
    if (text === null || saving || !dirty) return;
    setSaving(true);
    try {
      const now = await lookup();
      const moved =
        now !== null &&
        (now.size !== seen.current.size || (now.modified !== 0 && now.modified !== seen.current.modified));
      if (moved && !(await confirmAction(t("remote.editChangedRemotely", { name: entry.name }), true, t("remote.editOverwrite")))) {
        return;
      }
      await remoteWriteText(hostId, entry.path, text);
      setSaved(text);
      const after = await lookup();
      if (after) seen.current = { size: after.size, modified: after.modified };
      pushSuccessToast(t("remote.editSaved", { name: entry.name }));
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setSaving(false);
    }
  }, [text, saving, dirty, lookup, hostId, entry.path, entry.name, t]);

  const close = useCallback(() => {
    if (!dirty) {
      onClose();
      return;
    }
    void confirmAction(t("remote.editDiscard", { name: entry.name }), true, t("remote.editDiscardConfirm")).then(
      (ok) => ok && onClose(),
    );
  }, [dirty, onClose, entry.name, t]);

  // ⌘S / Ctrl+S saves while the dialog is up.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [save]);

  return (
    <ApiModal
      icon={FileCode2}
      title={dirty ? `${entry.name} •` : entry.name}
      subtitle={entry.path}
      width="max-w-5xl"
      height="h-[80vh]"
      dismissOnBackdrop={false}
      busy={saving}
      onClose={close}
      footer={
        <div className="ml-auto flex items-center gap-2">
          <GhostButton onClick={close}>{t("common.close")}</GhostButton>
          <PrimaryButton disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? t("remote.editSaving") : t("common.save")}
          </PrimaryButton>
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <div className="h-full overflow-hidden rounded-md border border-[var(--cf-border)]">
          {text === null ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={16} className="animate-spin text-[var(--cf-text-muted)]" />
            </div>
          ) : (
            <Editor
              height="100%"
              // Its own scheme, so the model never meets the repository's file models.
              path={`cf-remote:/${hostId}${entry.path.startsWith("/") ? "" : "/"}${entry.path}`}
              language={languageForPath(entry.name)}
              value={text}
              onChange={(value) => setText(value ?? "")}
              theme={monacoTheme}
              options={{
                ...OVERFLOW_SAFE_OPTIONS,
                minimap: { enabled: false },
                fontSize: 12,
                automaticLayout: true,
                scrollBeyondLastLine: false,
                tabSize: 2,
                padding: { top: 8, bottom: 8 },
                scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
              }}
            />
          )}
        </div>
      </div>
    </ApiModal>
  );
}
