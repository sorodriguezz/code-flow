/**
 * An entry's files.
 *
 * Images are drawn from a `data:` URI, which is the only way a picture reaches the screen in this
 * app — there is no asset protocol, and writing a decrypted copy to disk to serve one would undo
 * the point of the vault. The bytes are fetched on demand, one file at a time, so opening an entry
 * with six photos does not decrypt six photos.
 */

import { useEffect, useState } from "react";
import { FileText, Image as ImageIcon, Paperclip, Plus, Trash2 } from "lucide-react";

import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { useVaultStore } from "../../state/vaultStore";
import { ICON_BUTTON, humanBytes } from "./vaultChrome";

export function VaultAttachments({ itemId }: { itemId: string }) {
  const blobs = useVaultStore((s) => s.blobs);
  const t = useT();
  const [preview, setPreview] = useState<{ id: string; uri: string } | null>(null);

  // Dropped when the entry changes, so a photo from the previous one cannot linger on screen under
  // the new one's title.
  useEffect(() => setPreview(null), [itemId]);

  const show = async (id: string, mime: string) => {
    if (!mime.startsWith("image/")) return;
    const base64 = await useVaultStore.getState().readBlob(id);
    if (base64) setPreview({ id, uri: `data:${mime};base64,${base64}` });
  };

  return (
    <section className="mt-2 border-t border-[var(--cf-border)] pt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("vault.attachments")}
        </span>
        <label className={`${ICON_BUTTON} cursor-pointer`} title={t("vault.addFile")}>
          <Plus size={13} />
          <input
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void useVaultStore.getState().addBlob(itemId, file);
              event.target.value = "";
            }}
          />
        </label>
      </div>

      {blobs.length === 0 ? (
        <p className="text-[11px] italic text-[var(--cf-text-muted)]">{t("vault.noAttachments")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {blobs.map((blob) => {
            const isImage = blob.mime.startsWith("image/");
            return (
              <li key={blob.id} className="flex items-center gap-2 text-[11.5px]">
                {isImage ? (
                  <ImageIcon size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                ) : (
                  <FileText size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                )}
                <button
                  type="button"
                  onClick={() => void show(blob.id, blob.mime)}
                  className="min-w-0 flex-1 truncate text-left text-[var(--cf-text)] hover:underline"
                >
                  {blob.name}
                </button>
                <span className="shrink-0 tabular-nums text-[var(--cf-text-muted)]">
                  {humanBytes(blob.size_bytes)}
                </span>
                <button
                  type="button"
                  title={t("vault.deleteFile")}
                  aria-label={t("vault.deleteFile")}
                  onClick={() => {
                    void confirmAction(t("vault.deleteFileConfirm", { name: blob.name }), true).then(
                      (ok) => ok && void useVaultStore.getState().deleteBlob(blob.id),
                    );
                  }}
                  className={ICON_BUTTON}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {preview && (
        // A replaced element: an `<img>` cannot run a script whatever the bytes turn out to be,
        // which is the same reason `DiagramGallery` renders its thumbnails this way.
        <img
          src={preview.uri}
          alt=""
          className="mt-2 max-h-64 w-full rounded-md border border-[var(--cf-border)] object-contain"
        />
      )}

      <p className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
        <Paperclip size={11} className="mt-[1px] shrink-0" />
        {t("vault.attachmentsHint")}
      </p>
    </section>
  );
}
