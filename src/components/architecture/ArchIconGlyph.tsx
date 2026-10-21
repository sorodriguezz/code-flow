/**
 * One architecture icon in the app's chrome (a picker cell, a template row) — the provider's own
 * colours for an official icon, `currentColor` for a generic glyph. Loads the icon's pack the first
 * time it is asked for and draws an empty square of the same size until then.
 */
import { useEffect, useState } from "react";
import { archIconNow, loadArchIcons } from "../../lib/architecture/icons";

export function ArchIconGlyph({ id, size = 18 }: { id: string; size?: number }) {
  const [, bump] = useState(0);
  const icon = archIconNow(id);
  useEffect(() => {
    if (icon) return;
    let live = true;
    void loadArchIcons([id]).then(() => { if (live) bump((n) => n + 1); });
    return () => { live = false; };
  }, [id, icon]);
  if (!icon) return <span aria-hidden className="inline-block shrink-0" style={{ width: size, height: size }} />;
  return icon.mono ? (
    <svg aria-hidden width={size} height={size} viewBox={icon.viewBox} className="shrink-0" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: icon.body }} />
  ) : (
    <svg aria-hidden width={size} height={size} viewBox={icon.viewBox} className="shrink-0" dangerouslySetInnerHTML={{ __html: icon.body }} />
  );
}
