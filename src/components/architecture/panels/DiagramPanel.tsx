/**
 * The Diagram lens's side panel: the inspector for what is selected, the numbered flow, the notes and
 * the legend. Every field edits the JSON in place (see `edits.ts`), so what you change here is what
 * you see appear in the text.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Link2, Plus, Trash2 } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import { CATEGORY_COLOR, mix } from "../../../lib/architecture/svg";
import { loadArchIcons, searchArchIcons, type IconHit } from "../../../lib/architecture/icons";
import { ArchIconGlyph } from "../ArchIconGlyph";
import { Evidence } from "../sources/SourcesBar";
import type { ArchDoc, Category, ConnectionKind, ResolvedComponents, ZoneStyle } from "../../../lib/architecture/types";
import { isZone, type LayoutNode, type Zone } from "../../../lib/architecture/types";
import { useArchitectureViewStore, type DiagramTab } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { confirmAction } from "../../../state/confirmStore";
import { buttonClass } from "../../common/Button";
import { fieldClass, popoverClass } from "../../common/recipes";
import { addComponent, addConnection, removeComponent, removeConnection, setComponentField, setSimField, setValue, zonePathOf } from "../edits";
import { EntityHead, Ref, SectionTitle, panelBodyClass } from "./bits";

const CATEGORIES: Category[] = ["actor", "compute", "data", "messaging", "network", "identity", "security", "observability", "external"];
const ZONE_STYLES: ZoneStyle[] = ["cloud", "group", "cluster", "tier", "logical", "providers"];

function findZone(nodes: LayoutNode[] | undefined, id: string): Zone | null {
  for (const n of nodes ?? []) {
    if (isZone(n)) { if (n.id === id) return n; const inner = findZone(n.children, id); if (inner) return inner; }
    else if (typeof n === "object" && n) { const inner = findZone((n as { row?: LayoutNode[]; column?: LayoutNode[] }).row ?? (n as { column?: LayoutNode[] }).column, id); if (inner) return inner; }
  }
  return null;
}

/** A text field that commits as you type, but only re-reads its value when the selection changes. */
function Field({ label, value, onCommit, mono, multiline, type = "text", placeholder }: { label: string; value: string; onCommit: (v: string) => void; mono?: boolean; multiline?: boolean; type?: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(value); }, [value]);
  const common = {
    value: draft,
    placeholder,
    onFocus: () => { editing.current = true; },
    onBlur: () => { editing.current = false; },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(e.target.value); onCommit(e.target.value); },
  };
  return (
    <label className="grid gap-1 text-[11px] font-medium text-[var(--cf-text-muted)]">
      {label}
      {multiline ? (
        <textarea {...common} rows={3} className="min-h-[54px] resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12.5px] leading-[1.4] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]" />
      ) : (
        <input {...common} type={type} className={fieldClass({ size: "sm", className: `w-full ${mono ? "font-mono text-[11.5px]" : ""}` })} />
      )}
    </label>
  );
}

function IconPicker({ label, value, onPick }: { label: string; value: string; onPick: (id: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<IconHit[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => void searchArchIcons(query, 48).then(async (h) => { await loadArchIcons(h.map((x) => x.id)); if (live) setHits(h); }), 120);
    return () => { live = false; clearTimeout(timer); };
  }, [open, query]);
  const glyph = (id: string, size = 18) => <ArchIconGlyph id={id} size={size} />;
  return (
    <div className="relative grid gap-1 text-[11px] font-medium text-[var(--cf-text-muted)]">
      {label}
      <button type="button" onClick={() => setOpen(!open)} className={`${fieldClass({ size: "sm", className: "flex w-full items-center gap-2 text-left" })}`}>
        <span className="text-[var(--cf-text-muted)]">{value ? glyph(value, 16) : null}</span>
        <span className="truncate font-mono text-[11px]">{value || t("arch.insp.noIcon")}</span>
      </button>
      {open ? (
        <div className={`${popoverClass} absolute left-0 right-0 top-full z-30 mt-1 grid gap-1.5`}>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("arch.insp.iconSearch")} className={fieldClass({ size: "sm", className: "w-full" })} />
          <div className="grid max-h-[220px] grid-cols-6 gap-1 overflow-y-auto">
            {hits.map((h) => (
              <button key={h.id} type="button" title={`${h.label} · ${h.id}`} onClick={() => { onPick(h.id); setOpen(false); }} className="grid h-9 place-items-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
                {glyph(h.id, 22)}
              </button>
            ))}
          </div>
          <p className="m-0 text-[10.5px] font-normal text-[var(--cf-text-faint)]">{t("arch.insp.iconHelp")}</p>
        </div>
      ) : null}
    </div>
  );
}

export function DiagramPanel({ doc, comps, tab }: { doc: ArchDoc; comps: ResolvedComponents; tab: DiagramTab }) {
  const t = useT();
  const selection = useArchitectureViewStore((s) => s.selection);
  const select = useArchitectureViewStore((s) => s.select);
  const setHover = useArchitectureViewStore((s) => s.setHover);
  const [connectTo, setConnectTo] = useState("");
  const conns = doc.connections ?? [];

  if (tab === "flow") {
    const flow = doc.flow ?? [];
    return (
      <div className={panelBodyClass}>
        {flow.length ? null : <p className="m-0 text-[12px] leading-[1.5] text-[var(--cf-text-faint)]">{t("arch.flow.empty")}</p>}
        <ol className="m-0 grid gap-0.5 p-0">
          {flow.map((text, i) => {
            const hops = conns.filter((e) => e.step === i + 1).map((e) => `${comps[e.from]?.name ?? e.from} → ${comps[e.to]?.name ?? e.to}`);
            return (
              <li key={i} className="grid list-none grid-cols-[20px_minmax(0,1fr)] gap-2 rounded-md p-1.5 hover:bg-[var(--cf-hover)]" onMouseEnter={() => setHover({ kind: "step", step: i + 1 })} onMouseLeave={() => setHover(null)} onClick={() => select({ kind: "step", step: i + 1 })}>
                <span className="mt-[1px] grid h-[18px] w-[18px] place-items-center rounded-full bg-[#2563eb] text-[10px] font-bold text-white">{i + 1}</span>
                <span className="grid gap-0.5 text-[12px] leading-[1.45]">
                  {text}
                  {hops.length ? <small className="font-mono text-[10.5px] text-[var(--cf-text-faint)]">{hops.join(" · ")}</small> : null}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }
  if (tab === "notes") {
    const notes = doc.notes ?? [];
    return (
      <div className={panelBodyClass}>
        {notes.length ? null : <p className="m-0 text-[12px] leading-[1.5] text-[var(--cf-text-faint)]">{t("arch.notes.empty")}</p>}
        {notes.map((n) => (
          <button key={n.id} type="button" className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-md p-1.5 text-left hover:bg-[var(--cf-hover)]" onClick={() => select(comps[n.on] ? { kind: "card", id: n.on } : { kind: "zone", id: n.on }, { reveal: true })}>
            <span className="mt-[1px] h-[17px] rounded-[4px] border border-[#f59e0b] bg-[#fef3c7] px-1 text-[10px] font-bold leading-[15px] text-[#92400e]">{n.id}</span>
            <span className="grid gap-0.5 text-[12px] leading-[1.45]"><b className="text-[12.5px]">{n.title}</b><span className="text-[var(--cf-text-muted)]">{n.text}</span></span>
          </button>
        ))}
      </div>
    );
  }
  if (tab === "legend") {
    const used = [...new Set(Object.values(comps).map((c) => c.category ?? "external"))];
    return (
      <div className={panelBodyClass}>
        <SectionTitle>{t("arch.legend.lines")}</SectionTitle>
        <div className="grid gap-1.5 text-[12px]">
          <div className="flex items-center gap-2.5"><svg width="30" height="10"><path d="M1 5h24" stroke="var(--cf-text-muted)" strokeWidth="1.5" /><path d="M22 1.6 29 5l-7 3.4 1.8-3.4z" fill="var(--cf-text-muted)" /></svg>{t("arch.legend.sync")}</div>
          <div className="flex items-center gap-2.5"><svg width="30" height="10"><path d="M1 5h24" stroke="var(--cf-text-faint)" strokeWidth="1.5" strokeDasharray="5 4" /><path d="M22 1.6 29 5l-7 3.4 1.8-3.4z" fill="var(--cf-text-faint)" /></svg>{t("arch.legend.async")}</div>
          <div className="flex items-center gap-2.5"><span className="grid h-[15px] w-[15px] place-items-center rounded-full bg-[#2563eb] text-[9px] font-bold text-white">1</span>{t("arch.legend.step")}</div>
        </div>
        <SectionTitle>{t("arch.legend.categories")}</SectionTitle>
        <div className="grid gap-1.5 text-[12px]">
          {CATEGORIES.filter((c) => used.includes(c)).map((c) => (
            <div key={c} className="flex items-center gap-2.5"><span className="h-3.5 w-[22px] rounded-[3px]" style={{ background: mix(CATEGORY_COLOR[c], "#ffffff", 0.14), borderLeft: `3px solid ${CATEGORY_COLOR[c]}` }} />{t(`arch.cat.${c}` as TranslationKey)}</div>
          ))}
        </div>
      </div>
    );
  }

  // Inspector
  if (selection?.kind === "edge" && conns[selection.index]) {
    const i = selection.index, e = conns[i];
    return (
      <div className={panelBodyClass}>
        <EntityHead
          icon={<Link2 size={16} />}
          title={t("arch.insp.connection")}
          subtitle={<><Ref id={e.from} comps={comps} /> → <Ref id={e.to} comps={comps} /></>}
        />
        <Field label={t("arch.insp.protocol")} value={e.protocol ?? ""} onCommit={(v) => setValue(["connections", i, "protocol"], v)} placeholder="https" />
        <label className="grid gap-1 text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("arch.insp.kind")}
          <select value={e.kind ?? "sync"} onChange={(ev) => setValue(["connections", i, "kind"], ev.target.value === "sync" ? undefined : (ev.target.value as ConnectionKind))} className={fieldClass({ size: "sm", className: "w-full" })}>
            <option value="sync">{t("arch.legend.sync")}</option>
            <option value="async">{t("arch.legend.async")}</option>
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("arch.insp.step")} type="number" value={e.step != null ? String(e.step) : ""} onCommit={(v) => setValue(["connections", i, "step"], v ? Number(v) : undefined)} />
          <Field label={t("arch.insp.share")} type="number" value={e.share != null ? String(e.share) : ""} onCommit={(v) => setValue(["connections", i, "share"], v ? Number(v) : undefined)} placeholder="1" />
        </div>
        <Evidence lines={e.evidence} />
        <button type="button" className={buttonClass({ size: "sm", variant: "danger-ghost", className: "justify-self-start" })} onClick={() => { removeConnection(i); select(null); }}>
          <Trash2 size={13} />{t("arch.insp.removeConnection")}
        </button>
      </div>
    );
  }
  if (selection?.kind === "zone") {
    const zone = findZone(doc.layout, selection.id);
    const path = zone ? zonePathOf(doc, zone.id) : null;
    if (zone && path) {
      return (
        <div className={panelBodyClass}>
          <EntityHead icon={<ArchIconGlyph id={zone.icon || "group"} size={18} />} title={zone.title || t("arch.insp.zone")} subtitle={`${t("arch.insp.zone")} · ${t(`arch.zoneStyle.${zone.style ?? "cluster"}` as TranslationKey)}`} />
          <Field label={t("arch.insp.title")} value={zone.title ?? ""} onCommit={(v) => setValue([...path, "title"], v)} />
          <Field label={t("arch.insp.subtitle")} value={zone.subtitle ?? ""} onCommit={(v) => setValue([...path, "subtitle"], v)} />
          <label className="grid gap-1 text-[11px] font-medium text-[var(--cf-text-muted)]">
            {t("arch.insp.style")}
            <select value={zone.style ?? "cluster"} onChange={(ev) => setValue([...path, "style"], ev.target.value)} className={fieldClass({ size: "sm", className: "w-full" })}>
              {ZONE_STYLES.map((s) => <option key={s} value={s}>{t(`arch.zoneStyle.${s}` as TranslationKey)}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] font-medium text-[var(--cf-text-muted)]">
            {t("arch.insp.direction")}
            <select value={zone.direction ?? "column"} onChange={(ev) => setValue([...path, "direction"], ev.target.value === "column" ? undefined : ev.target.value)} className={fieldClass({ size: "sm", className: "w-full" })}>
              <option value="column">{t("arch.insp.column")}</option>
              <option value="row">{t("arch.insp.row")}</option>
            </select>
          </label>
          <IconPicker label={t("arch.insp.icon")} value={zone.icon ?? ""} onPick={(id) => setValue([...path, "icon"], id)} />
          <button type="button" className={buttonClass({ size: "sm", className: "justify-self-start" })} onClick={() => { const id = addComponent({ name: t("arch.insp.newComponent"), category: "compute", icon: "container" }, zone.id); if (id) select({ kind: "card", id }, { reveal: true }); }}>
            <Plus size={13} />{t("arch.insp.addHere")}
          </button>
        </div>
      );
    }
  }
  if (selection?.kind === "card" && comps[selection.id]) {
    const id = selection.id, c = comps[id];
    if (c.sharedFrom) {
      return (
        <div className={panelBodyClass}>
          <EntityHead icon={c.icon ? <ArchIconGlyph id={c.icon} size={18} /> : null} title={c.name ?? id} subtitle={c.type} />
          <p className="m-0 rounded-lg border border-dashed border-[var(--cf-border-strong)] p-2.5 text-[12px] text-[var(--cf-text-muted)]">{t("arch.insp.shared", { from: c.sharedFrom })}</p>
        </div>
      );
    }
    const ins = conns.map((e, i) => ({ e, i })).filter(({ e }) => e.to === id);
    const outs = conns.map((e, i) => ({ e, i })).filter(({ e }) => e.from === id);
    const resource = typeof c.resource === "object" ? JSON.stringify(c.resource) : c.resource ?? "";
    return (
      <div className={panelBodyClass}>
        <EntityHead icon={c.icon ? <ArchIconGlyph id={c.icon} size={18} /> : null} title={c.name || t("arch.insp.component")} subtitle={[c.type, c.category ? t(`arch.cat.${c.category}` as TranslationKey) : ""].filter(Boolean).join(" · ") || t("arch.insp.component")} />
        <SectionTitle>{t("arch.insp.general")}</SectionTitle>
        <Field label={t("arch.insp.name")} value={c.name ?? ""} onCommit={(v) => setComponentField(id, "name", v)} />
        <Field label={t("arch.insp.type")} value={c.type ?? ""} onCommit={(v) => setComponentField(id, "type", v)} />
        <label className="grid gap-1 text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("arch.insp.category")}
          <select value={c.category ?? "external"} onChange={(ev) => setComponentField(id, "category", ev.target.value)} className={fieldClass({ size: "sm", className: "w-full" })}>
            {CATEGORIES.map((cat) => <option key={cat} value={cat}>{t(`arch.cat.${cat}` as TranslationKey)}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <IconPicker label={t("arch.insp.icon")} value={c.icon ?? ""} onPick={(v) => setComponentField(id, "icon", v)} />
          <IconPicker label={t("arch.insp.badge")} value={c.badge ?? ""} onPick={(v) => setComponentField(id, "badge", v)} />
        </div>
        <Field label={t("arch.insp.resource")} mono value={resource} onCommit={(v) => setComponentField(id, "resource", v)} placeholder="api-{env}" />
        <Field label={t("arch.insp.description")} multiline value={c.description ?? ""} onCommit={(v) => setComponentField(id, "description", v)} />
        <SectionTitle>{t("arch.insp.simulation")}</SectionTitle>
        {c.category === "actor" ? (
          <Field label={t("arch.insp.rps")} type="number" value={c.sim?.rps != null ? String(c.sim.rps) : ""} onCommit={(v) => setSimField(id, "rps", v ? Number(v) : undefined)} />
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <Field label={t("arch.insp.replicas")} type="number" value={c.sim?.replicas != null ? String(c.sim.replicas) : ""} onCommit={(v) => setSimField(id, "replicas", v ? Number(v) : undefined)} placeholder="1" />
            <Field label={t("arch.insp.capacity")} type="number" value={c.sim?.capacity != null ? String(c.sim.capacity) : ""} onCommit={(v) => setSimField(id, "capacity", v ? Number(v) : undefined)} placeholder="rps" />
            <Field label={t("arch.insp.latency")} type="number" value={c.sim?.latency != null ? String(c.sim.latency) : ""} onCommit={(v) => setSimField(id, "latency", v ? Number(v) : undefined)} placeholder="ms" />
          </div>
        )}
        <label className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
          <input type="checkbox" checked={!!c.sim?.managed} onChange={(ev) => setSimField(id, "managed", ev.target.checked || undefined)} className="accent-[var(--cf-accent)]" />
          {t("arch.insp.managed")}
        </label>
        {c.sim ? (
          <label className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
            <input type="checkbox" checked={!!c.sim.estimated} onChange={(ev) => setSimField(id, "estimated", ev.target.checked || undefined)} className="accent-[var(--cf-accent)]" />
            {t("arch.insp.estimated")}
          </label>
        ) : null}
        <Evidence lines={c.evidence} />
        <SectionTitle aside={String(ins.length + outs.length)}>{t("arch.insp.connections")}</SectionTitle>
        <div className="grid gap-1 text-[12px]">
          {outs.map(({ e, i }) => (
            <button key={`o${i}`} type="button" className="flex items-center gap-1.5 text-left text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]" onClick={() => select({ kind: "edge", index: i })}>→ <b className="font-medium text-[var(--cf-text)]">{comps[e.to]?.name ?? e.to}</b>{e.protocol ? <span className="rounded-full border border-[var(--cf-border)] px-1.5 text-[10.5px]">{e.protocol}</span> : null}</button>
          ))}
          {ins.map(({ e, i }) => (
            <button key={`i${i}`} type="button" className="flex items-center gap-1.5 text-left text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]" onClick={() => select({ kind: "edge", index: i })}>← <b className="font-medium text-[var(--cf-text)]">{comps[e.from]?.name ?? e.from}</b>{e.protocol ? <span className="rounded-full border border-[var(--cf-border)] px-1.5 text-[10.5px]">{e.protocol}</span> : null}</button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <select value={connectTo} onChange={(ev) => setConnectTo(ev.target.value)} className={fieldClass({ size: "sm", className: "min-w-0 flex-1" })}>
            <option value="">{t("arch.insp.connectTo")}</option>
            {Object.values(comps).filter((x) => x.id !== id).map((x) => <option key={x.id} value={x.id}>{x.name ?? x.id}</option>)}
          </select>
          <button type="button" disabled={!connectTo} className={buttonClass({ size: "sm" })} onClick={() => { addConnection({ from: id, to: connectTo, protocol: "https" }); setConnectTo(""); }}>
            <Link2 size={13} />{t("arch.insp.connect")}
          </button>
        </div>
        <button type="button" className={buttonClass({ size: "sm", variant: "danger-ghost", className: "justify-self-start" })} onClick={() => void confirmAction(t("arch.insp.removeConfirm", { name: c.name ?? id })).then((ok) => { if (ok) { removeComponent(id); select(null); } })}>
          <Trash2 size={13} />{t("arch.insp.remove")}
        </button>
      </div>
    );
  }
  return <DocInspector doc={doc} comps={comps} />;
}

function DocInspector({ doc, comps }: { doc: ArchDoc; comps: ResolvedComponents }) {
  const t = useT();
  const select = useArchitectureViewStore((s) => s.select);
  const m = doc.meta ?? {};
  const counts = useMemo(() => ({ components: Object.keys(comps).length, connections: (doc.connections ?? []).length }), [doc, comps]);
  return (
    <div className={panelBodyClass}>
      <EntityHead icon={<FileText size={16} />} title={t("arch.insp.document")} subtitle={t("arch.insp.documentCounts", counts)} />
      <p className="m-0 text-[12px] leading-[1.5] text-[var(--cf-text-faint)]">{t("arch.insp.documentHint")}</p>
      <Field label={t("arch.insp.title")} value={m.title ?? ""} onCommit={(v) => setValue(["meta", "title"], v)} />
      <Field label={t("arch.insp.description")} multiline value={m.description ?? ""} onCommit={(v) => setValue(["meta", "description"], v)} />
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("arch.meta.version")} value={m.version ?? ""} onCommit={(v) => setValue(["meta", "version"], v)} />
        <Field label={t("arch.meta.date")} value={m.date ?? ""} onCommit={(v) => setValue(["meta", "date"], v)} />
      </div>
      <Field label={t("arch.meta.owner")} value={m.owner ?? ""} onCommit={(v) => setValue(["meta", "owner"], v)} />
      <button type="button" className={buttonClass({ size: "sm", className: "justify-self-start" })} onClick={() => { const id = addComponent({ name: t("arch.insp.newComponent"), category: "compute", icon: "container" }, null); if (id) select({ kind: "card", id }, { reveal: true }); }}>
        <Plus size={13} />{t("arch.insp.addComponent")}
      </button>
    </div>
  );
}
