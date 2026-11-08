/** Keep inline SVG definitions and their references local to one rendered instance. */
export function scopeIds(body: string, suffix: string): string {
  const declared = [...body.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  return declared.reduce(
    (markup, id) =>
      markup
        .split(`id="${id}"`)
        .join(`id="${id}-${suffix}"`)
        .split(`url(#${id})`)
        .join(`url(#${id}-${suffix})`)
        .split(`href="#${id}"`)
        .join(`href="#${id}-${suffix}"`),
    body,
  );
}
