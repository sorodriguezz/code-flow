import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { buttonClass } from "../common/Button";
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
 *
 * A ghost toggle under a hairline rather than a tinted box: it is help, read once, and a box of its
 * own under the form read as a second form.
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
    <div className="mt-3 border-t border-[var(--cf-border)] pt-2">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        // `-ml-2` takes back the button's own padding, so the chevron sits on the form's left edge.
        className={buttonClass({ variant: "ghost", size: "sm", className: "-ml-2" })}
      >
        {open ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
        {title}
      </button>

      {open && (
        // `pl-5` is the toggle's label edge (14px chevron + 6px gap), so the steps read as its body
        // and their numbers hang under the chevron.
        <div className="pb-1 pl-5">
          <ol className="mt-1 list-decimal space-y-1 text-[12px] leading-snug text-[var(--cf-text-muted)] marker:text-[var(--cf-text-faint)]">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => void openExternalUrl(url).catch((e: unknown) => pushErrorToast(String(e)))}
            className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-[var(--cf-accent)] hover:underline"
          >
            <ExternalLink size={12} className="shrink-0" />
            {linkLabel}
          </button>
        </div>
      )}
    </div>
  );
}
