/**
 * Files and images that go with a goal handed to agents, a team or a board card. They are copied
 * once (`crewAttach*`) and named in the goal text the way a chat turn names its attachments, so
 * every member that reads the goal can open them with its own file tool.
 */
import { useRef, useState, type RefObject } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Paperclip } from "lucide-react";
import { AttachmentBar } from "../../chat/AttachmentBar";
import { crewAttachBytes, crewAttachFile, type ChatAttachment } from "../../../lib/tauri/chatCommands";
import { useImageDrop } from "../../../lib/useImageDrop";
import { pushErrorToast } from "../../../state/toastStore";
import { useL } from "../state";

const NOTE = "Archivos adjuntos a este mensaje (léelos con tu herramienta de lectura de archivos):";

/** `goal` with the files named under it — the same note `ai::attachment_note` writes. */
export function withFiles(goal: string, files: readonly ChatAttachment[]): string {
  if (files.length === 0) return goal;
  return `${goal.trimEnd()}\n\n${NOTE}\n${files.map((f) => `- ${f.name} (${f.path})`).join("\n")}`;
}

export function useGoalFiles(dropTarget: RefObject<HTMLElement | null>, initialFiles: ChatAttachment[] = []) {
  const [files, setFiles] = useState<ChatAttachment[]>(initialFiles);
  const add = async (job: Promise<ChatAttachment>) => {
    try {
      const file = await job;
      setFiles((current) => [...current, file]);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };
  const addPaths = async (paths: string[]) => {
    for (const path of paths) await add(crewAttachFile(path));
  };
  const over = useImageDrop(dropTarget, (paths) => void addPaths(paths), () => true);
  return {
    files,
    over,
    clear: () => setFiles([]),
    remove: (id: string) => setFiles((current) => current.filter((f) => f.id !== id)),
    pick: async () => {
      const picked = await openDialog({ multiple: true });
      await addPaths(typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : []);
    },
    /** A screenshot pasted into the goal's box becomes a file; text pastes are left alone. */
    onPaste: (event: React.ClipboardEvent) => {
      const file = Array.from(event.clipboardData.items).find((entry) => entry.type.startsWith("image/"))?.getAsFile();
      if (!file) return;
      event.preventDefault();
      const extension = (file.type.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
      void file.arrayBuffer().then((buffer) => add(crewAttachBytes(`pegado.${extension}`, Array.from(new Uint8Array(buffer)))));
    },
  };
}

/** The chips and the attach button under a goal's box. */
export function GoalFilesBar({ goalFiles }: { goalFiles: ReturnType<typeof useGoalFiles> }) {
  const l = useL();
  return (
    <div className="flex flex-col gap-1.5">
      {goalFiles.files.length > 0 && <AttachmentBar files={goalFiles.files} canSeeImages onRemove={goalFiles.remove} />}
      <button
        type="button"
        onClick={() => void goalFiles.pick()}
        title={l("Adjunta archivos o imágenes; también puedes pegar una captura o arrastrarla aquí", "Attach files or images; you can also paste a screenshot or drop it here")}
        className="flex h-[26px] w-fit items-center gap-1.5 rounded-md px-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      >
        <Paperclip className="h-3.5 w-3.5" />
        {l("Adjuntar", "Attach")}
      </button>
    </div>
  );
}

/** `text` with `files` added to its attachment note — made if missing, extended if there. */
export function addFilesTo(text: string, files: readonly ChatAttachment[]): string {
  if (files.length === 0) return text;
  const lines = files.map((f) => `- ${f.name} (${f.path})`).join("\n");
  return text.includes(NOTE) ? `${text.trimEnd()}\n${lines}` : withFiles(text, files);
}

/** A card's description takes files the same way: they land in its text, so the card carries them
 *  whole to whoever is assigned. */
export function CardFilesButton({ onAdd, dropTarget }: { onAdd: (files: ChatAttachment[]) => void; dropTarget: RefObject<HTMLElement | null> }) {
  const l = useL();
  const take = async (paths: string[]) => {
    const out: ChatAttachment[] = [];
    for (const path of paths) {
      try {
        out.push(await crewAttachFile(path));
      } catch (e) {
        pushErrorToast(String(e));
      }
    }
    if (out.length) onAdd(out);
  };
  useImageDrop(dropTarget, (paths) => void take(paths), () => true);
  return (
    <button
      type="button"
      onClick={() => void openDialog({ multiple: true }).then((picked) => take(typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : []))}
      title={l("Adjunta archivos o imágenes a la tarjeta; quien la tome los recibe. También puedes pegar una captura en la descripción", "Attach files or images to the card; whoever takes it gets them. You can also paste a screenshot into the description")}
      className="flex h-[24px] items-center gap-1 rounded-md px-1.5 text-[11.5px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
    >
      <Paperclip className="h-3.5 w-3.5" />
      {l("Adjuntar", "Attach")}
    </button>
  );
}

/** A screenshot pasted into a card's description, as a file. */
export function pastedImage(event: React.ClipboardEvent, onAdd: (files: ChatAttachment[]) => void): void {
  const file = Array.from(event.clipboardData.items).find((entry) => entry.type.startsWith("image/"))?.getAsFile();
  if (!file) return;
  event.preventDefault();
  const extension = (file.type.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
  void file
    .arrayBuffer()
    .then((buffer) => crewAttachBytes(`pegado.${extension}`, Array.from(new Uint8Array(buffer))))
    .then((f) => onAdd([f]))
    .catch((e: unknown) => pushErrorToast(String(e)));
}

export function useDropRef() {
  return useRef<HTMLDivElement>(null);
}
