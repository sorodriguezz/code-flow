import { useEffect, useState } from "react";
import { t } from "../i18n";
import { hello, pair, storedName } from "../transport";

/**
 * The first and only screen an unpaired device sees.
 *
 * It asks whether the desktop is offering a pairing *before* the user types, because the two
 * failure modes look identical from here and have completely different fixes: "nobody pressed the
 * button on the desktop" and "you typed it wrong" both come back as one refusal from the server,
 * which by design says nothing about which. Checking `/api/hello` first is how this screen can
 * still tell them apart.
 */
export function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(storedName());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [windowOpen, setWindowOpen] = useState<boolean | null>(null);

  // Polled, because the state being watched is on another screen in another room: the user is
  // meant to walk to the desktop, press a button, and come back. Five seconds is well inside the
  // three-minute window and is the difference between the code box enabling itself and the user
  // wondering whether to reload.
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const info = await hello();
      if (alive) setWindowOpen(info ? info.pairing : null);
    };
    void check();
    const id = setInterval(() => void check(), 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await pair(code, name.trim() || "Dispositivo");
      onPaired();
    } catch {
      setError(windowOpen === false ? t("pair.noWindow") : t("pair.rejected"));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cf-safe-top flex min-h-full flex-col justify-center px-6 py-10">
      <h1 className="text-[22px] font-semibold">{t("pair.title")}</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-[var(--cf-text-muted)]">{t("pair.intro")}</p>

      {windowOpen === null && (
        <p className="mt-4 rounded-lg border border-[var(--cf-danger)]/40 px-3 py-2 text-[13px] text-[var(--cf-danger)]">
          {t("pair.unreachable")}
        </p>
      )}

      <label className="mt-6 block text-[12px] text-[var(--cf-text-muted)]">{t("pair.code")}</label>
      <input
        value={code}
        // Digits only, six of them, and a numeric keypad: the value has exactly one shape and
        // every character of typing that is not a digit is a mistake this can simply refuse.
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
        className="cf-tap mt-1 w-full rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2.5 text-center font-mono text-[28px] tracking-[0.3em] outline-none focus:border-[var(--cf-accent)]"
      />

      <label className="mt-4 block text-[12px] text-[var(--cf-text-muted)]">{t("pair.name")}</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value.slice(0, 64))}
        placeholder={t("pair.namePlaceholder")}
        className="cf-tap mt-1 w-full rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2.5 outline-none focus:border-[var(--cf-accent)]"
      />

      {error && <p className="mt-3 text-[13px] text-[var(--cf-danger)]">{error}</p>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={code.length !== 6 || busy}
        className="cf-tap mt-6 w-full rounded-lg bg-[var(--cf-accent)] px-4 py-3 text-[15px] font-medium text-white disabled:opacity-40"
      >
        {t("pair.submit")}
      </button>
    </div>
  );
}
