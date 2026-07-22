import { useEffect, useRef } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useToastStore, type Toast as ToastData } from "../../state/toastStore";

const DURATION_MS = 5000;

const ICONS = {
  error: AlertTriangle,
  success: CheckCircle2,
  info: Info,
};

const COLORS = {
  error: "var(--cf-danger)",
  success: "var(--cf-success)",
  info: "var(--cf-accent)",
};

function ToastItem({ toast }: { toast: ToastData }) {
  const dismiss = useToastStore((s) => s.dismissToast);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(DURATION_MS);
  const startRef = useRef(Date.now());

  const clear = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const start = (ms: number) => {
    clear();
    startRef.current = Date.now();
    remainingRef.current = ms;
    timerRef.current = setTimeout(() => dismiss(toast.id), ms);
  };

  useEffect(() => {
    start(DURATION_MS);
    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  const pause = () => {
    const elapsed = Date.now() - startRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    clear();
  };

  const resume = () => start(remainingRef.current || 300);

  const Icon = ICONS[toast.type];
  const color = COLORS[toast.type];

  return (
    <div
      onMouseEnter={pause}
      onMouseLeave={resume}
      className="cf-fade-in flex w-96 max-w-[calc(100vw-1.5rem)] items-start gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 shadow-[var(--cf-shadow)]"
      style={{ borderLeftColor: color, borderLeftWidth: 3 }}
    >
      <Icon size={15} className="mt-0.5 shrink-0" style={{ color }} />
      <p className="min-w-0 flex-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-snug text-[var(--cf-text)]">
        {toast.message}
      </p>
      <button
        onClick={() => dismiss(toast.id)}
        className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-3 top-14 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastItem toast={toast} />
        </div>
      ))}
    </div>
  );
}
