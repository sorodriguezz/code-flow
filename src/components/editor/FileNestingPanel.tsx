import { useState } from "react";
import { Eye, EyeOff, ListTree, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { EmptyState } from "../common/EmptyState";
import {
  formatChildren,
  newNestingPatternId,
  parseChildren,
  previewOf,
  type NestingPattern,
} from "../../lib/fileNesting";
import { useFileNestingStore } from "../../state/fileNestingStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

/**
 * One pattern: what takes in, and what gets taken in.
 *
 * Two plain fields and no dropdowns, because the whole grammar is "a name, optionally with a `*`"
 * on the left and "a comma-separated list of templates" on the right — the same call
 * `IconRulesPanel` makes about writing `*.spec.ts` instead of picking it out of two selects.
 *
 * The sentence underneath is what pays for that compression: it is `previewOf` reading the pattern
 * back with a neutral capture, so `*.ts → ${capture}.spec.ts` says "example.ts takes in
 * example.spec.ts" while it is being typed. A pattern that means something other than what was
 * intended — the classic being a literal parent with a `${capture}` child, where the capture is
 * empty and the template collapses to `.spec.ts` — announces itself there rather than by nesting
 * nothing and offering no way to find out why.
 */
function PatternRow({
  pattern,
  onChange,
  onRemove,
}: {
  pattern: NestingPattern;
  onChange: (next: NestingPattern) => void;
  onRemove: () => void;
}) {
  const t = useT();
  /**
   * The children field is uncontrolled *while it is being edited*, exactly as `RuleRow`'s pattern
   * field is, and for a sharper version of the same reason. `parseChildren` drops empty entries, so
   * a value round-tripped through parse-and-format deletes the comma the moment it is typed: `a,`
   * formats back to `a`, and the separator can never be entered at all. The parsed list is still
   * committed on every keystroke — this only governs what the input *shows* — and the stored
   * pattern takes the field back when focus leaves.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const preview = previewOf(pattern);
  const field =
    "min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-1.5 py-1 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]";

  return (
    <div
      className={`rounded-md border border-[var(--cf-border)] px-1.5 py-1.5 ${
        pattern.enabled ? "" : "opacity-50"
      }`}
    >
      <div className="flex items-center gap-1">
        <input
          value={pattern.parent}
          onChange={(e) => onChange({ ...pattern, parent: e.target.value })}
          placeholder={t("nesting.parentPlaceholder")}
          spellCheck={false}
          className={`${field} max-w-[38%]`}
        />
        <input
          value={draft ?? formatChildren(pattern.children)}
          onChange={(e) => {
            setDraft(e.target.value);
            onChange({ ...pattern, children: parseChildren(e.target.value) });
          }}
          onBlur={() => setDraft(null)}
          placeholder={t("nesting.childrenPlaceholder")}
          spellCheck={false}
          className={field}
        />
        <button
          onClick={() => onChange({ ...pattern, enabled: !pattern.enabled })}
          title={t(pattern.enabled ? "nesting.disableRow" : "nesting.enableRow")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
        >
          {pattern.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        {/* No confirm, unlike the reset above: this is one row, it is visible while it is being
            deleted, and it takes ten seconds to write again. A dialog on every row would train
            people to dismiss the one that guards the whole list. */}
        <button
          onClick={onRemove}
          title={t("nesting.removePattern")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <p className="mt-1 px-0.5 text-[10.5px] leading-tight text-[var(--cf-text-muted)]">
        {preview.parent && preview.children.length > 0
          ? t("nesting.preview", { parent: preview.parent, children: preview.children.join(", ") })
          : t("nesting.previewNothing")}
      </p>
    </div>
  );
}

/**
 * File nesting, configured from the rail beside the tree it rearranges.
 *
 * In the rail and not in Settings for the same reason `IconRulesPanel` is: this is edited *while
 * looking at the explorer* — you see a spec sitting where you did not expect it, or a family that
 * should be grouped and is not — and every save repaints the tree behind the panel, so the panel is
 * its own preview.
 */
export function FileNestingPanel() {
  const t = useT();
  const enabled = useFileNestingStore((s) => s.enabled);
  const patterns = useFileNestingStore((s) => s.patterns);
  const setEnabled = useFileNestingStore((s) => s.setEnabled);
  const save = useFileNestingStore((s) => s.save);
  const reset = useFileNestingStore((s) => s.reset);
  /** Only so the reset button can be pressed without the confirm dialog re-entering. */
  const [resetting, setResetting] = useState(false);

  const confirmReset = async () => {
    if (resetting) return;
    setResetting(true);
    try {
      if (await confirmAction(t("nesting.resetConfirm"), true, t("nesting.resetConfirmAction"))) {
        reset();
      }
    } finally {
      setResetting(false);
    }
  };

  /** Refuses a second blank pattern, the same guard `IconRulesPanel.add` makes and for the same
   *  reason: the `+` sits above a list whose top row may already be an empty one waiting to be
   *  typed into, and three of those stacked up is the fastest way to make this panel look broken. */
  const add = () => {
    if (patterns.some((pattern) => !pattern.parent.trim())) return;
    save([{ id: newNestingPatternId(), parent: "", children: [], enabled: true }, ...patterns]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1.5">
        <span className="flex-1 truncate text-[12px] font-medium text-[var(--cf-text)]">
          {t("nesting.title")}
        </span>
        <button
          onClick={add}
          title={t("nesting.addPattern")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
        >
          <Plus size={13} />
        </button>
        <button
          onClick={() => void confirmReset()}
          title={t("nesting.reset")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
        >
          <RotateCcw size={12} />
        </button>
      </div>

      {/* The switch, and directly under it the one sentence that decides whether this feature reads
          as helpful or as a bug: nothing has moved. */}
      <div className="flex shrink-0 items-start gap-2 border-b border-[var(--cf-border)] px-2 py-2">
        <Checkbox checked={enabled} onChange={setEnabled} className="mt-0.5" />
        <span className="flex min-w-0 flex-1 flex-col">
          <button
            onClick={() => setEnabled(!enabled)}
            className="truncate text-left text-[12px] text-[var(--cf-text)]"
          >
            {t("nesting.enabledLabel")}
          </button>
          <span className="text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
            {t("nesting.hint")}
          </span>
        </span>
      </div>

      {/* Dimmed but fully editable while the feature is off. Writing the patterns and *then*
          switching it on is the natural order to do this in, and a list that locked itself until
          the switch was flipped would force everyone to turn on a rearrangement they have not
          configured yet just to configure it. */}
      <div className={`min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2 ${enabled ? "" : "opacity-60"}`}>
        {!enabled && (
          <p className="px-1 pt-2 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
            {t("nesting.offNote")}
          </p>
        )}
        {patterns.length === 0 ? (
          <EmptyState icon={ListTree} title={t("nesting.empty")} subtitle={t("nesting.emptyHint")} />
        ) : (
          patterns.map((pattern, index) => (
            <PatternRow
              key={pattern.id}
              pattern={pattern}
              onChange={(next) => save(patterns.map((row, i) => (i === index ? next : row)))}
              onRemove={() => save(patterns.filter((_, i) => i !== index))}
            />
          ))
        )}
      </div>
    </div>
  );
}
