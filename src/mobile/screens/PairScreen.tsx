import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Smartphone, TriangleAlert } from "lucide-react";
import { t } from "../i18n";
import { hello, pair, storedName } from "../transport";
import { Button } from "../ui/Button";

/**
 * The first and only screen an unpaired device sees.
 *
 * It asks whether the desktop is offering a pairing *before* the user types, because the two
 * failure modes look identical from here and have completely different fixes: "nobody pressed the
 * button on the desktop" and "you typed it wrong" both come back as one refusal from the server,
 * which by design says nothing about which. Checking `/api/hello` first is how this screen can
 * still tell them apart.
 *
 * # Three states, not two
 *
 * The probe used to start at `null` and draw `null` as *"No se puede alcanzar CodeFlow"* — so the
 * first thing every phone saw, for the second or so before the first request landed, was an alarming
 * red box saying the desktop was unreachable. "Not asked yet" is now its own state and says it is
 * looking.
 */
export function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(storedName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** `undefined` while the first probe is in flight, `null` when the desktop cannot be reached, and
   *  a boolean for whether a pairing window is open. */
  const [windowOpen, setWindowOpen] = useState<boolean | null | undefined>(undefined);

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
    const id = window.setInterval(() => void check(), 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
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

  const probe =
    windowOpen === undefined
      ? { tone: "muted", icon: <Loader2 size={14} className="animate-spin" />, text: t("pair.checking") }
      : windowOpen === null
        ? { tone: "danger", icon: <TriangleAlert size={14} />, text: t("pair.unreachable") }
        : windowOpen
          ? { tone: "success", icon: <CheckCircle2 size={14} />, text: t("pair.ready") }
          : { tone: "warning", icon: <TriangleAlert size={14} />, text: t("pair.waiting") };

  const probeTone: Record<string, string> = {
    muted: "border-[var(--cf-border)] text-[var(--cf-text-muted)]",
    danger: "border-[var(--cf-danger)]/40 bg-[var(--cf-danger-soft)] text-[var(--cf-danger-text)]",
    success: "border-[var(--cf-success)]/40 bg-[var(--cf-success-soft)] text-[var(--cf-success-text)]",
    warning: "border-[var(--cf-warning)]/40 bg-[var(--cf-warning-soft)] text-[var(--cf-warning-text)]",
  };

  return (
    <div className="cf-brand-wash cf-scroll cf-safe-top cf-safe-bottom cf-safe-x flex h-full flex-col justify-center px-6 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-card">
          <Smartphone size={24} className="text-[var(--cf-accent-text)]" aria-hidden />
        </div>
        <h1 className="mt-4 text-xl font-semibold">{t("pair.title")}</h1>
        <p className="mt-2 text-base leading-relaxed text-[var(--cf-text-muted)]">
          {t("pair.intro")}
        </p>

        {/* One line that always says where the handshake is up to, rather than a red box that only
            appears when something is wrong and is indistinguishable from the initial state. */}
        <p
          role="status"
          aria-live="polite"
          className={`mt-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${probeTone[probe.tone]}`}
        >
          <span className="shrink-0" aria-hidden>
            {probe.icon}
          </span>
          {probe.text}
        </p>

        <label htmlFor="cf-pair-code" className="mt-6 block text-xs font-semibold text-[var(--cf-text-faint)]">
          {t("pair.code")}
        </label>
        <input
          id="cf-pair-code"
          value={code}
          // Digits only, six of them, and a numeric keypad: the value has exactly one shape and
          // every character of typing that is not a digit is a mistake this can simply refuse.
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          // 28px, and it took a CSS fix to be so: the unlayered `input { font-size: 16px }` in
          // `mobile.css` used to beat this utility outright, so the code box rendered at 16px on
          // every device. See the note on `@layer base` there.
          className="mt-1.5 w-full rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-3 text-center font-mono text-2xl tracking-[0.3em] outline-none focus:border-[var(--cf-accent)]"
        />

        <label htmlFor="cf-pair-name" className="mt-4 block text-xs font-semibold text-[var(--cf-text-faint)]">
          {t("pair.name")}
        </label>
        <input
          id="cf-pair-name"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 64))}
          placeholder={t("pair.namePlaceholder")}
          className="mt-1.5 w-full rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2.5 outline-none focus:border-[var(--cf-accent)]"
        />

        {error && (
          <p role="alert" className="mt-3 text-base text-[var(--cf-danger-text)]">
            {error}
          </p>
        )}

        <Button
          full
          size="lg"
          variant="primary"
          className="mt-6"
          loading={busy}
          disabled={code.length !== 6}
          onClick={() => void submit()}
        >
          {t("pair.submit")}
        </Button>
      </div>
    </div>
  );
}
