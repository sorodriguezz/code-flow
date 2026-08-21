/**
 * The password generator.
 *
 * Every byte comes from the OS random number generator, in Rust — see `keyvault::crypto`. Nothing
 * here calls `Math.random`, which is what `lib/api/variables.ts`'s `$randomPassword` uses and says
 * so in its own comment: that one is a test fixture and this is a password someone will rely on.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";

import { useT } from "../../state/languageStore";
import { useVaultStore } from "../../state/vaultStore";
import { DEFAULT_RECIPE, type PasswordRecipe } from "../../types/vault";
import { BUTTON, BUTTON_QUIET, ICON_BUTTON } from "./vaultChrome";

export function VaultGenerator({
  onUse,
  onClose,
}: {
  onUse: (password: string) => void;
  onClose: () => void;
}) {
  const [recipe, setRecipe] = useState<PasswordRecipe>(DEFAULT_RECIPE);
  const [password, setPassword] = useState("");
  const t = useT();

  const generate = useCallback(async (next: PasswordRecipe) => {
    const made = await useVaultStore.getState().generatePassword(next);
    if (made) setPassword(made);
  }, []);

  useEffect(() => {
    void generate(recipe);
  }, [recipe, generate]);

  const toggle = (key: keyof PasswordRecipe) => () =>
    setRecipe((current) => ({ ...current, [key]: !current[key] }));

  return (
    <div className="absolute inset-x-0 bottom-0 z-10 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("vault.generator")}
        </span>
        <button type="button" aria-label={t("vault.hide")} onClick={onClose} className={ICON_BUTTON}>
          <X size={13} />
        </button>
      </div>

      <div className="mb-2 flex items-center gap-1">
        <code className="min-w-0 flex-1 truncate rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1.5 font-mono text-[12.5px] text-[var(--cf-text)]">
          {password}
        </code>
        <button
          type="button"
          title={t("vault.generate")}
          aria-label={t("vault.generate")}
          onClick={() => void generate(recipe)}
          className={ICON_BUTTON}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <label className="mb-2 flex items-center gap-2 text-[11.5px] text-[var(--cf-text-muted)]">
        <span className="w-16 shrink-0">{t("vault.length")}</span>
        <input
          type="range"
          min={8}
          max={64}
          value={recipe.length}
          onChange={(event) => setRecipe({ ...recipe, length: Number(event.target.value) })}
          className="flex-1 accent-[var(--cf-accent)]"
        />
        <span className="w-6 shrink-0 text-right tabular-nums text-[var(--cf-text)]">
          {recipe.length}
        </span>
      </label>

      <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1">
        {(
          [
            ["uppercase", "vault.useUppercase"],
            ["digits", "vault.useDigits"],
            ["symbols", "vault.useSymbols"],
            ["ambiguous", "vault.useAmbiguous"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text)]">
            <input
              type="checkbox"
              checked={recipe[key] as boolean}
              onChange={toggle(key)}
              className="accent-[var(--cf-accent)]"
            />
            {t(label)}
          </label>
        ))}
      </div>
      <p className="mb-2 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
        {t("vault.useAmbiguousHint")}
      </p>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={BUTTON_QUIET}>
          {t("vault.hide")}
        </button>
        <button type="button" onClick={() => onUse(password)} className={BUTTON} disabled={!password}>
          {t("vault.use")}
        </button>
      </div>
    </div>
  );
}
