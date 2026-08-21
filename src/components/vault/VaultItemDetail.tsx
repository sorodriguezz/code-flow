/**
 * One entry — read, or being edited.
 *
 * **Two modes, and the split is the point.** The panel used to be permanently editable and wrote on
 * every blur, which made "did that save?" a question with no answer on screen: a write could happen
 * at any keystroke and nothing announced one. Reading and changing are different acts, so they get
 * different screens — the read view changes nothing and says nothing, and the edit view has a Save
 * button that says what it is doing and a Cancel that means it.
 *
 * Two rules run through both:
 *
 * **Secret fields are masked until asked for, one at a time.** Not a single "reveal everything"
 * switch — the reason to look at a password is to use *that* password, and a panel that uncovers
 * six of them at once is six things on screen for whoever walks past.
 *
 * **Copy is the primary action, reveal is the secondary one.** Copying takes the value without ever
 * drawing it, and `vaultStore.copySecret` takes it back off the clipboard afterwards. Revealing is
 * for the times it has to be read out or typed somewhere else.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Paperclip,
  Pencil,
  RefreshCw,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useVaultStore } from "../../state/vaultStore";
import {
  KIND_FIELDS,
  SECRET_FIELDS,
  type TotpCode,
  type VaultItem,
  type VaultSecret,
} from "../../types/vault";
import { VaultAttachments } from "./VaultAttachments";
import { VaultGenerator } from "./VaultGenerator";
import { BUTTON, BUTTON_QUIET, ICON_BUTTON, INPUT, MASK, kindIcon } from "./vaultChrome";

/** How long a field's value stays on screen once revealed, before it hides itself again.
 *
 *  Named in the tour copy as a literal — a tour body only substitutes `{key}` for a keyboard chord
 *  and has no way to take a parameter, so change the sentence in both languages if this moves. */
const REVEAL_SECONDS = 30;

/** How long the "Saved" confirmation stays up before the panel stops mentioning it. */
const SAVED_NOTICE_MS = 2500;

/** Fields wide enough to need a box rather than a line. */
const MULTILINE: (keyof VaultSecret)[] = ["notes", "privateKey", "recoveryCodes"];

/** The i18n key for a field's label. One place, so a new field is one entry rather than three.
 *
 *  The cast is the honest one: `KIND_FIELDS` and the `vault.field.*` keys are two lists that have to
 *  agree, and TypeScript cannot check a template literal against 5000 union members. A missing key
 *  shows up as the key itself on screen, which is visible immediately. */
function fieldLabel(field: keyof VaultSecret): TranslationKey {
  return `vault.field.${field}` as TranslationKey;
}

export function VaultItemDetail({ item }: { item: VaultItem }) {
  const secret = useVaultStore((s) => s.secret);
  const editing = useVaultStore((s) => s.editing);
  const saving = useVaultStore((s) => s.saving);
  const savedAt = useVaultStore((s) => s.savedAt);
  const totp = useVaultStore((s) => s.totp);
  const t = useT();

  /** The form's copy of the entry. Only ever written in edit mode; Cancel throws it away. */
  const [draft, setDraft] = useState<VaultSecret>({});
  const [title, setTitle] = useState(item.title);
  const [site, setSite] = useState(item.site);
  const [generatorFor, setGeneratorFor] = useState<keyof VaultSecret | null>(null);
  // In the store, not here: `openItem` has to be able to ask before it throws the form away.
  const dirty = useVaultStore((s) => s.dirty);
  const setDirty = useVaultStore((s) => s.setDirty);

  /** Re-seeds the form from what is stored. Used on open, on entry change, and by Cancel.
   *
   *  Through a ref so `cancel` can call it without the effect below depending on `cancel` — the two
   *  would otherwise re-create each other on every render. */
  const reseed = useRef(() => {});
  reseed.current = () => {
    setDraft(secret ?? {});
    setTitle(item.title);
    setSite(item.site);
    setDirty(false);
  };

  useEffect(() => {
    reseed.current();
  }, [item.id, secret]);

  // The 2FA code expires; the countdown beside it has to keep up. One small call per period rather
  // than a local timer reimplementing the algorithm — the secret is deliberately not here to do
  // that with. See `keyvault_totp_code`.
  useEffect(() => {
    if (!totp) return;
    const timer = window.setTimeout(
      () => void useVaultStore.getState().refreshTotp(),
      Math.max(1, totp.seconds_remaining) * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [totp]);

  // "Saved" is a confirmation, not a status: it says the write landed and then gets out of the way.
  useEffect(() => {
    if (savedAt === null) return;
    const timer = window.setTimeout(
      () => useVaultStore.setState({ savedAt: null }),
      SAVED_NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [savedAt]);

  const fields = useMemo(() => KIND_FIELDS[item.kind] ?? [], [item.kind]);
  const secretFields = useMemo(() => new Set(SECRET_FIELDS[item.kind] ?? []), [item.kind]);

  const patch = (next: Partial<VaultSecret>) => {
    setDraft((current) => ({ ...current, ...next }));
    setDirty(true);
  };

  const save = () => {
    // `dirty` is cleared by `saveItem` on success and left alone on failure, deliberately: clearing
    // it here would mean a save that did not land leaves a form full of unsaved work that nothing
    // will warn about when the user navigates away.
    void useVaultStore.getState().saveItem({
      id: item.id,
      title,
      site,
      tags: item.tags,
      secret: draft,
    });
  };

  const cancel = async () => {
    // Only asked when there is something to lose. A confirmation on an untouched form is a dialog
    // that teaches people to dismiss dialogs.
    if (dirty && !(await confirmAction(t("vault.discardChanges"), true, t("vault.discard")))) {
      return;
    }
    reseed.current();
    useVaultStore.getState().setEditing(false);
  };

  const Glyph = kindIcon(item.kind);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <Glyph size={15} className="shrink-0 text-[var(--cf-text-muted)]" />

        {editing ? (
          <input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setDirty(true);
            }}
            className="min-w-0 flex-1 rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5 py-0.5 text-[13px] font-medium text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--cf-text)]">
            {item.title}
          </span>
        )}

        {/* The save state, and only while there is something to say about it. */}
        {saving && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
            <Loader2 size={11} className="animate-spin" />
            {t("vault.saving")}
          </span>
        )}
        {!saving && savedAt !== null && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-accent)]">
            <Check size={11} />
            {t("vault.saved")}
          </span>
        )}

        {editing ? (
          <>
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={saving}
              className={BUTTON_QUIET}
            >
              {t("vault.cancel")}
            </button>
            <button type="button" onClick={save} disabled={saving} className={BUTTON}>
              {saving ? t("vault.saving") : t("vault.save")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              title={t(item.favorite ? "vault.unpin" : "vault.pin")}
              aria-label={t(item.favorite ? "vault.unpin" : "vault.pin")}
              onClick={() => void useVaultStore.getState().toggleFavorite(item.id)}
              className={ICON_BUTTON}
            >
              <Star size={13} fill={item.favorite ? "currentColor" : "none"} />
            </button>
            <button
              type="button"
              title={t("vault.delete")}
              aria-label={t("vault.delete")}
              onClick={() => void useVaultStore.getState().deleteItem(item.id)}
              className={ICON_BUTTON}
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              onClick={() => useVaultStore.getState().setEditing(true)}
              className={BUTTON_QUIET}
            >
              <Pencil size={11} className="mr-1 inline" />
              {t("vault.edit")}
            </button>
            <button
              type="button"
              aria-label={t("vault.close")}
              onClick={() => useVaultStore.getState().closeItem()}
              className={ICON_BUTTON}
            >
              <X size={14} />
            </button>
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {editing ? (
          <EditView
            item={item}
            fields={fields}
            secretFields={secretFields}
            draft={draft}
            site={site}
            onPatch={patch}
            onSite={(next) => {
              setSite(next);
              setDirty(true);
            }}
            onGenerate={setGeneratorFor}
          />
        ) : (
          <ReadView
            item={item}
            fields={fields}
            secretFields={secretFields}
            secret={secret}
            totp={totp}
          />
        )}
      </div>

      {generatorFor && (
        <VaultGenerator
          onUse={(password) => {
            patch({ [generatorFor]: password });
            setGeneratorFor(null);
          }}
          onClose={() => setGeneratorFor(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The entry as it is stored.
 *
 * **Empty fields are not drawn.** A login with no 2FA secret shows no 2FA row — an entry padded out
 * with blanks reads as a form waiting to be filled, which is what the edit view is for. An entry
 * with nothing in it at all says so instead.
 */
function ReadView({
  item,
  fields,
  secretFields,
  secret,
  totp,
}: {
  item: VaultItem;
  fields: (keyof VaultSecret)[];
  secretFields: Set<keyof VaultSecret>;
  secret: VaultSecret | null;
  totp: TotpCode | null;
}) {
  const t = useT();
  const revealed = useVaultStore((s) => s.revealed);

  const toggleReveal = (field: string) => {
    const on = !revealed[field];
    useVaultStore.getState().reveal(field, on);
    if (on) {
      // Hides itself again. A value left uncovered because the user walked away is the failure this
      // panel exists to avoid, and a timer is the only thing that catches it.
      window.setTimeout(() => useVaultStore.getState().reveal(field, false), REVEAL_SECONDS * 1000);
    }
  };

  const filled = fields.filter((field) => {
    const raw = secret?.[field];
    return typeof raw === "string" && raw.trim().length > 0;
  });
  const custom = secret?.custom?.filter((entry) => entry.value.trim().length > 0) ?? [];
  const bare = filled.length === 0 && custom.length === 0 && !item.site;

  return (
    <div className="flex flex-col gap-3">
      {/* No row for `item.subtitle`: it is derived from one of the fields below (see
          `SUBTITLE_FIELD`), so drawing it here would print the same value twice. */}
      {item.site && <ReadRow label={t("vault.field.site")} value={item.site} />}

      {filled.map((field) =>
        field === "totp" ? (
          <TotpRow key={field} code={totp} />
        ) : (
          <ReadRow
            key={field}
            label={t(fieldLabel(field))}
            value={(secret?.[field] as string) ?? ""}
            secret={secretFields.has(field)}
            shown={revealed[field] ?? false}
            multiline={MULTILINE.includes(field)}
            onToggle={() => toggleReveal(field)}
          />
        ),
      )}

      {custom.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("vault.customFields")}
          </h3>
          <div className="flex flex-col gap-3">
            {custom.map((entry, at) => (
              <ReadRow
                key={`${entry.name}-${at}`}
                label={entry.name}
                value={entry.value}
                secret={entry.secret === true}
                shown={revealed[`custom:${at}`] ?? false}
                onToggle={() => toggleReveal(`custom:${at}`)}
              />
            ))}
          </div>
        </section>
      )}

      {bare && (
        <p className="text-[11.5px] italic text-[var(--cf-text-muted)]">{t("vault.entryEmpty")}</p>
      )}

      <VaultAttachments itemId={item.id} />
    </div>
  );
}

/** One stored value: its label, the value (masked when secret), and what can be done with it. */
function ReadRow({
  label,
  value,
  secret = false,
  shown = false,
  multiline = false,
  onToggle,
}: {
  label: string;
  value: string;
  secret?: boolean;
  shown?: boolean;
  multiline?: boolean;
  onToggle?: () => void;
}) {
  const t = useT();
  const hidden = secret && !shown;

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
        {label}
      </span>
      <div className="flex items-start gap-1">
        <span
          className={`min-w-0 flex-1 text-[12.5px] text-[var(--cf-text)] ${
            secret ? "font-mono" : ""
          } ${multiline && !hidden ? "whitespace-pre-wrap break-words" : "truncate"}`}
        >
          {hidden ? MASK : value}
        </span>
        {secret && onToggle && (
          <button
            type="button"
            title={t(shown ? "vault.hide" : "vault.reveal")}
            aria-label={t(shown ? "vault.hide" : "vault.reveal")}
            onClick={onToggle}
            className={ICON_BUTTON}
          >
            {shown ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
        <button
          type="button"
          title={t("vault.copy")}
          aria-label={t("vault.copy")}
          onClick={() => void useVaultStore.getState().copySecret(value)}
          className={ICON_BUTTON}
        >
          <Copy size={13} />
        </button>
      </div>
    </div>
  );
}

/** The live 2FA code, with the seconds it has left. */
function TotpRow({ code }: { code: TotpCode | null }) {
  const t = useT();
  if (!code) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("vault.totpCode")}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void useVaultStore.getState().copySecret(code.code)}
          className="rounded-md bg-[var(--cf-accent-soft)] px-2 py-1 font-mono text-[15px] tracking-[0.2em] text-[var(--cf-accent)]"
        >
          {code.code}
        </button>
        <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">
          {t("vault.totpSeconds", { n: code.seconds_remaining })}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** Every field the kind has, empty or not — this is the form, and a form shows what can be filled. */
function EditView({
  item,
  fields,
  secretFields,
  draft,
  site,
  onPatch,
  onSite,
  onGenerate,
}: {
  item: VaultItem;
  fields: (keyof VaultSecret)[];
  secretFields: Set<keyof VaultSecret>;
  draft: VaultSecret;
  site: string;
  onPatch: (next: Partial<VaultSecret>) => void;
  onSite: (next: string) => void;
  onGenerate: (field: keyof VaultSecret) => void;
}) {
  const t = useT();

  return (
    <div className="flex flex-col gap-3">
      {(item.kind === "login" || item.kind === "key") && (
        <Field label={t("vault.field.site")}>
          <input value={site} onChange={(event) => onSite(event.target.value)} className={INPUT} />
        </Field>
      )}

      {fields.map((field) => {
        const raw = typeof draft[field] === "string" ? (draft[field] as string) : "";
        const multiline = MULTILINE.includes(field);
        return (
          <Field key={field} label={t(fieldLabel(field))}>
            <div className="flex items-start gap-1">
              {multiline ? (
                <textarea
                  value={raw}
                  onChange={(event) => onPatch({ [field]: event.target.value })}
                  rows={field === "notes" ? 4 : 3}
                  className={`${INPUT} resize-y font-mono`}
                />
              ) : (
                <input
                  // Plain text even for a secret: this is the form where it is being *typed*, and a
                  // masked box is where a typo hides. The read view is what keeps it covered.
                  type="text"
                  value={raw}
                  onChange={(event) => onPatch({ [field]: event.target.value })}
                  className={`${INPUT} ${secretFields.has(field) ? "font-mono" : ""}`}
                />
              )}
              {(field === "password" || field === "passphrase") && (
                <button
                  type="button"
                  title={t("vault.generate")}
                  aria-label={t("vault.generate")}
                  onClick={() => onGenerate(field)}
                  className={ICON_BUTTON}
                >
                  <RefreshCw size={13} />
                </button>
              )}
            </div>
            {field === "totp" && (
              <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
                {t("vault.field.totpHint")}
              </p>
            )}
          </Field>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

/** The empty state — the panel with nothing open. */
export function VaultGallery() {
  const items = useVaultStore((s) => s.items);
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <Paperclip size={22} className="text-[var(--cf-text-muted)]" />
      <p className="text-[13px] font-medium text-[var(--cf-text)]">
        {items.length === 0 ? t("vault.empty") : t("vault.entriesN", { n: items.length })}
      </p>
      <p className="max-w-xs text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]">
        {t("vault.emptyBody")}
      </p>
    </div>
  );
}
