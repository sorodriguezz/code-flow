/**
 * The multi-line twin of `fieldClass` (`common/recipes.ts`): the same fill, hairline and focus halo,
 * without the fixed height. A `<textarea>` is sized by its `rows`, and a height baked into the class
 * would fight them — which is why the agents and stories screens cannot simply reuse `fieldClass`
 * for their goal, instruction and criterion boxes.
 *
 * Kept beside the screens that use it until `recipes.ts` grows one of its own.
 */
export function areaClass({
  size = "md",
  mono = false,
  resize = "y",
  className = "",
}: {
  size?: "sm" | "md";
  mono?: boolean;
  resize?: "y" | "none";
  className?: string;
} = {}): string {
  return `block w-full min-w-0 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-2 ${
    size === "sm" ? "text-[12px]" : "text-[13px]"
  } leading-relaxed text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)] disabled:opacity-50 ${
    mono ? "font-mono" : ""
  } ${resize === "none" ? "resize-none" : "resize-y"} ${className}`;
}
