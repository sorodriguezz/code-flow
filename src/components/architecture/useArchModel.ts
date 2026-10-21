/**
 * Everything the editor derives from the open document's text, memoised in the order each step
 * depends on the last: text → parse (keeping the last good document while the JSON is broken) →
 * components with includes resolved → warnings, layout, review, patterns, simulation.
 *
 * Icons load asynchronously (the provider packs are fetched on first use), so the layout is made
 * at once and `iconsReady` flips when every icon the scene names has landed — the SVG is rendered
 * again then, with the real icons in place of the fallback glyph.
 */
import { createContext, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { layoutDoc, type Scene } from "../../lib/architecture/layout";
import { loadArchIcons } from "../../lib/architecture/icons";
import { parseArchText, validateDoc, type ArchWarning, type ParseError } from "../../lib/architecture/parse";
import { detectPatterns, type PatternHit } from "../../lib/architecture/patterns";
import { review, type Finding } from "../../lib/architecture/rules";
import { simulate, type SimResult } from "../../lib/architecture/sim";
import { sceneIcons } from "../../lib/architecture/svg";
import { pickEnvironment, resolveComponents, type ArchDoc, type ResolvedComponents } from "../../lib/architecture/types";
import { useArchitectureStore } from "../../state/architectureStore";
import { useArchitectureViewStore } from "../../state/architectureViewStore";
import { useT } from "../../state/languageStore";

export interface ArchModel {
  /** The document the rest of the model was derived from — the deferred one, which lags the store
   *  by a render when another document opens. */
  docId: string;
  text: string;
  doc: ArchDoc;
  error: ParseError | null;
  comps: ResolvedComponents;
  warnings: ArchWarning[];
  env: string;
  scene: Scene;
  findings: Finding[];
  patterns: PatternHit[];
  sim: SimResult;
  iconsReady: number;
}

const EMPTY: ArchDoc = {};

export function useArchModel(): ArchModel | null {
  const t = useT();
  const draft = useArchitectureStore((s) => s.draft);
  const included = useArchitectureStore((s) => s.included);
  const wantedEnv = useArchitectureViewStore((s) => s.env);
  const scale = useArchitectureViewStore((s) => s.scale);
  const down = useArchitectureViewStore((s) => s.down);
  const lastGood = useRef<{ id: string; doc: ArchDoc } | null>(null);
  const [iconsReady, setIconsReady] = useState(0);

  // Edits re-derive at the deferred pace: parse, layout and routing never block a gesture. The id
  // travels with the text, so a document switch is seen only once its own text has arrived.
  const current = useMemo(() => (draft ? { id: draft.id, text: draft.text } : null), [draft?.id, draft?.text]); // eslint-disable-line react-hooks/exhaustive-deps
  const deferred = useDeferredValue(current);
  const text = deferred?.text ?? "";
  const docId = deferred?.id ?? "";
  const parsed = useMemo(() => (deferred ? parseArchText(deferred.text) : null), [deferred]);
  if (deferred && parsed?.ok) lastGood.current = { id: deferred.id, doc: parsed.doc };
  const doc = parsed?.ok ? parsed.doc : lastGood.current && lastGood.current.id === docId ? lastGood.current.doc : EMPTY;
  const error = parsed && !parsed.ok ? parsed.error : null;

  const comps = useMemo(() => resolveComponents(doc, included), [doc, included]);
  const env = pickEnvironment(doc, wantedEnv);
  const warnings = useMemo(() => validateDoc(doc, comps), [doc, comps]);
  const metaLabels = useMemo(
    () => ({ version: t("arch.meta.version"), date: t("arch.meta.date"), environment: t("arch.meta.environment"), owner: t("arch.meta.owner"), author: t("arch.meta.author") }),
    [t],
  );
  const scene = useMemo(() => layoutDoc(doc, comps, { env, metaLabels }), [doc, comps, env, metaLabels]);
  const findings = useMemo(() => review(doc, comps), [doc, comps]);
  const patterns = useMemo(() => detectPatterns(doc, comps, t("arch.and")), [doc, comps, t]);
  const downSet = useMemo(() => new Set(down), [down]);
  const sim = useMemo(() => simulate(doc, comps, scale, downSet), [doc, comps, scale, downSet]);

  const iconKey = useMemo(() => sceneIcons(scene).sort().join("|"), [scene]);
  useEffect(() => {
    let live = true;
    void loadArchIcons(iconKey.split("|")).then(() => { if (live) setIconsReady((n) => n + 1); });
    return () => { live = false; };
  }, [iconKey]);

  if (!draft || !deferred) return null;
  return { docId, text, doc, error, comps, warnings, env, scene, findings, patterns, sim, iconsReady };
}

/** The open document's model, for the panels deep in the editor (the AI actions need all of it). */
export const ArchModelContext = createContext<ArchModel | null>(null);
export const useArchModelContext = () => useContext(ArchModelContext);
