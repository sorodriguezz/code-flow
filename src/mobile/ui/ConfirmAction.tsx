import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { t } from "../i18n";
import { Button, IconButton } from "./Button";

/**
 * A button that asks once before doing something that cannot be taken back from here.
 *
 * Press, then confirm: the treatment every public or disruptive act in this client gets — voting on
 * a pull request, re-running a pipeline, stopping a service somebody at the desk may be using —
 * because a pocket is a place where one tap happens by accident. Shared since the pipelines and the
 * stash needed the same thing the review screen already had.
 */
export function ConfirmAction({
  label,
  confirmLabel,
  icon,
  variant,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  icon: ReactNode;
  variant: "primary" | "danger" | "success" | "secondary";
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  // Disarms itself. A confirmation left armed becomes a one-tap button again by the time the user
  // comes back to the screen, which is exactly what the confirmation was for.
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(id);
  }, [armed]);

  if (!armed) {
    return (
      <Button full size="sm" disabled={disabled} icon={icon} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }

  return (
    <span className="flex flex-1 gap-1">
      <IconButton
        icon={<X size={15} />}
        label={t("common.cancel")}
        onClick={() => setArmed(false)}
        className="w-11 border border-[var(--cf-border)]"
      />
      <Button
        full
        size="sm"
        variant={variant}
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
    </span>
  );
}
