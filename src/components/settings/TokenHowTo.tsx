import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { openExternalUrl } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";

/**
 * Where the token comes from, folded away under the form that asks for one.
 *
 * Below and collapsed rather than above and open, which is the whole point of it being a component:
 * every one of these hosts files its token somewhere unobvious and every one of them has its own
 * scope decision, so the instructions have to be *there* — but they are read once and then never
 * again, and four steps standing permanently between the card's hint and its first field is four
 * steps in the way of the ninety-nine per cent of visits that are "check what is connected".
 *
 * The link is deep where the host allows it. For Azure, GitHub and GitLab that means the
 * organisation or host already typed into the field above, which is the difference between four
 * steps you follow and one link you click.
 */
export function TokenHowTo({
  title,
  steps,
  linkLabel,
  url,
}: {
  title: string;
  steps: string[];
  linkLabel: string;
  url: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3 rounded-lg border border-[var(--cf-border)] bg-black/[0.02] dark:bg-white/[0.03]">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] font-medium text-[var(--cf-text)]"
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        )}
        {title}
      </button>

      {open && (
        <div className="px-3 pb-3">
          <ol className="ml-3.5 list-decimal space-y-1 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => void openExternalUrl(url).catch((e: unknown) => pushErrorToast(String(e)))}
            className="mt-2 flex items-center gap-1 text-[11.5px] font-medium text-[var(--cf-accent)] hover:underline"
          >
            <ExternalLink size={11} />
            {linkLabel}
          </button>
        </div>
      )}
    </div>
  );
}
