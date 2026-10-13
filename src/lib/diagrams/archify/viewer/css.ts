/**
 * The viewer's stylesheet.
 *
 * Colour is two layers. The page's own — background, panel, lines, text — is a handful of variables
 * that the app overrides inline while the diagram is framed in it, so it looks like CodeFlow; and
 * the kinds' — one stroke and one tint for each of archify's seven types and the lifecycle's states —
 * which keep archify's hues because the hue is what the legend means. A preset (`data-preset`) is a
 * third layer over both: a different set of the same variables, nothing more.
 */

/** `[dark stroke, dark tint, light stroke, light tint]` per kind. */
const KINDS: Record<string, [string, string, string, string]> = {
  frontend: ["#22d3ee", "rgba(8,51,68,.55)", "#0891b2", "rgba(34,211,238,.16)"],
  backend: ["#34d399", "rgba(6,78,59,.5)", "#059669", "rgba(52,211,153,.18)"],
  database: ["#a78bfa", "rgba(76,29,149,.5)", "#7c3aed", "rgba(167,139,250,.2)"],
  cloud: ["#fbbf24", "rgba(120,53,15,.42)", "#d97706", "rgba(251,191,36,.18)"],
  security: ["#fb7185", "rgba(136,19,55,.5)", "#e11d48", "rgba(251,113,133,.15)"],
  messagebus: ["#fb923c", "rgba(124,45,18,.45)", "#ea580c", "rgba(251,146,60,.15)"],
  external: ["#94a3b8", "rgba(30,41,59,.65)", "#64748b", "rgba(148,163,184,.18)"],
  start: ["#2dd4bf", "rgba(19,78,74,.5)", "#0d9488", "rgba(45,212,191,.16)"],
  active: ["#60a5fa", "rgba(30,58,138,.5)", "#2563eb", "rgba(96,165,250,.16)"],
  waiting: ["#fbbf24", "rgba(120,53,15,.42)", "#d97706", "rgba(251,191,36,.18)"],
  decision: ["#c084fc", "rgba(88,28,135,.5)", "#9333ea", "rgba(192,132,252,.17)"],
  success: ["#4ade80", "rgba(20,83,45,.5)", "#16a34a", "rgba(74,222,128,.17)"],
  failure: ["#fb7185", "rgba(136,19,55,.5)", "#e11d48", "rgba(251,113,133,.15)"],
  neutral: ["#94a3b8", "rgba(30,41,59,.65)", "#64748b", "rgba(148,163,184,.18)"],
};

const palette = (scheme: 0 | 2) =>
  Object.entries(KINDS)
    .map(([k, v]) => `--ks-${k}:${v[scheme]};--kf-${k}:${v[scheme + 1]};`)
    .join("");

const kindRules = Object.keys(KINDS)
  .map((k) => `.k-${k}{--ks:var(--ks-${k});--kf:var(--kf-${k})}`)
  .join("");

export const VIEWER_CSS = String.raw`
.app{
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --name-font:var(--font);
}
.app[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0a111e;--panel:#0e1727;--panel2:#131f33;--line:#223149;--line2:#19273d;--lane:rgba(255,255,255,.022);
  --text:#e8eefc;--muted:#8fa1bc;--faint:#5f7089;--accent:#5eead4;--accent2:rgba(94,234,212,.12);--hover:#17243a;
  --edge:#5d7392;--match:#fbbf24;--shadow:0 14px 40px rgba(0,0,0,.45);--grid:#16233a;
  ${palette(0)}
}
.app[data-theme="light"]{
  color-scheme:light;
  --bg:#f5f6f8;--panel:#ffffff;--panel2:#f3f5f9;--line:#d8dee8;--line2:#e7ebf2;--lane:rgba(15,23,42,.028);
  --text:#0f172a;--muted:#566277;--faint:#8793a6;--accent:#0d9488;--accent2:rgba(13,148,136,.1);--hover:#eef2f7;
  --edge:#7f90aa;--match:#d97706;--shadow:0 14px 40px rgba(15,23,42,.14);--grid:#e4e8ef;
  ${palette(2)}
}
${kindRules}

*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0}
body{background:var(--bg);overflow:hidden}
.app{height:100%;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;background:var(--bg);color:var(--text);font:13px/1.45 var(--font)}
.app button,.app input,.app select{font:inherit;color:inherit}
.app button{cursor:pointer}
.app button:focus-visible,.app select:focus-visible,.app input:focus-visible,.app a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* The title block: only in a page opened on its own — inside the app the title is the app's. */
.head{padding:14px 20px 12px;border-bottom:1px solid var(--line);background:var(--panel)}
.embed .head{display:none}
/* The rows are named by what is left: with the title block gone, the stretching row must still be the
   canvas — as a grid of four rows it would be the foot's, and the drawing would collapse. */
.app.embed{grid-template-rows:auto minmax(0,1fr) auto}
.eyebrow{margin:0 0 2px;color:var(--accent);font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}
.head h1{margin:0;font-size:20px;line-height:1.25;letter-spacing:-.02em}
.subtitle{max-width:880px;margin:4px 0 0;color:var(--muted);font-size:12.5px}
.subtitle:empty{display:none}

/* The bar of controls: above the canvas, never over it. */
.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;padding:7px 10px;border-bottom:1px solid var(--line);background:var(--panel)}
.spacer{flex:1 1 8px}
.group{display:inline-flex;align-items:center;gap:2px}
.tb{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;min-width:30px;padding:0 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);font-weight:600;font-size:12px;white-space:nowrap}
.tb:hover{background:var(--hover);color:var(--text)}
.tb[aria-pressed="true"]{background:var(--accent2);border-color:var(--accent);color:var(--accent)}
.tb[hidden]{display:none}
.tb svg{flex:none}
.pct{min-width:42px;text-align:center;color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums}
.sep-v{width:1px;height:18px;background:var(--line);margin:0 4px}
.seg{display:inline-flex;padding:2px;border:1px solid var(--line);border-radius:9px;background:var(--panel2)}
.seg button{height:24px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-weight:600;font-size:12px}
.seg button:hover{color:var(--text)}
.seg button[aria-pressed="true"]{background:var(--accent2);color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.search{position:relative;display:flex;align-items:center}
.search .ic{position:absolute;left:8px;display:flex;color:var(--faint);pointer-events:none}
.search input{width:190px;height:30px;padding:0 34px 0 30px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);outline:none}
.search input:focus{border-color:var(--accent)}
.search .count{position:absolute;right:8px;color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums}
.select{height:30px;padding:0 8px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);font-size:12px;font-weight:600;color:var(--muted)}
.select[hidden]{display:none}
.menu-wrap{position:relative}
.menu{position:absolute;right:0;top:34px;z-index:10;min-width:110px;padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--panel);box-shadow:var(--shadow)}
.menu[hidden]{display:none}
.menu button{display:block;width:100%;padding:6px 10px;border:0;border-radius:7px;background:transparent;text-align:left;font-weight:600}
.menu button:hover{background:var(--hover)}

/* The canvas, and the panel docked beside it. */
.body{display:grid;grid-template-columns:minmax(0,1fr) auto;min-height:0}
.stage{position:relative;min-width:0;min-height:0;overflow:hidden;background-color:var(--bg);background-image:radial-gradient(var(--grid) 1px,transparent 1px);background-size:22px 22px}
#map{display:block;width:100%;height:100%;touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none;text-rendering:geometricPrecision}
#map.panning{cursor:grabbing}
.panel{display:none;flex-direction:column;width:340px;min-height:0;border-left:1px solid var(--line);background:var(--panel)}
.has-panel .panel{display:flex}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:14px 14px 10px 16px}
.panel-head .eyebrow{margin-bottom:3px}
.panel h2{margin:0;font-size:16px;line-height:1.3;overflow-wrap:anywhere}
.close{width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--muted);display:inline-flex;align-items:center;justify-content:center;flex:none}
.close:hover{background:var(--hover);color:var(--text)}
.panel-body{flex:1;min-height:0;overflow:auto;padding:0 16px 16px}
.lead{margin:10px 0 0;color:var(--muted);font-size:12.5px;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.kchip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px 2px 7px;border:1px solid var(--ks);border-radius:999px;color:var(--ks);font-size:11px;font-weight:700}
.kchip i{width:7px;height:7px;border-radius:50%;background:var(--ks)}
.tagchip,.dchip{padding:2px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:11px;font-weight:600}
.sec{margin-top:16px;padding-top:12px;border-top:1px solid var(--line2)}
.sec-title{margin:0 0 6px;color:var(--faint);font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
.none{margin:0;color:var(--faint);font-size:12px}
.reach-note{margin:10px 0 0;padding:6px 9px;border-radius:8px;background:var(--accent2);color:var(--accent);font-size:12px;font-weight:600}
.list{display:grid;gap:3px}
.row{display:flex;align-items:center;gap:9px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;text-align:left;font-size:12.5px}
.row:hover{background:var(--hover)}
.row .dot{width:8px;height:8px;border-radius:50%;background:var(--ks);flex:none}
.row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row small{max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--faint);font-size:11px}
.row.end{padding:8px}
.row.end .lead-in{width:34px;color:var(--faint)}
.arrow-down{display:block;padding:0 0 0 51px;color:var(--faint)}
.src{display:block;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--text);text-decoration:none;overflow-wrap:anywhere}
a.src:hover{border-color:var(--accent)}
.src-ic{display:inline-flex;vertical-align:-3px;margin-right:6px;color:var(--faint)}
.src-path{font:11px/1.45 var(--mono)}
.src-label{display:block;margin-top:2px;color:var(--muted);font-size:11.5px}
.card-block{margin-top:14px}
.card-title{display:flex;align-items:center;gap:7px;margin:0 0 4px;font-size:12.5px;font-weight:700}
.cdot{width:8px;height:8px;border-radius:50%}
.card-block ul{margin:0;padding-left:18px;color:var(--muted);font-size:12.5px}
.dot-cyan{background:#22d3ee}.dot-emerald{background:#34d399}.dot-violet{background:#a78bfa}.dot-amber{background:#fbbf24}
.dot-rose{background:#fb7185}.dot-orange{background:#fb923c}.dot-slate{background:#94a3b8}
.delta{display:flex;gap:6px;flex-wrap:wrap}
.dchip b{margin-right:5px}
.d-added{color:#34d399;border-color:#34d399}.d-removed{color:#fb7185;border-color:#fb7185}.d-changed{color:#fbbf24;border-color:#fbbf24}
.d-class{color:var(--accent);border-color:var(--accent)}

/* The foot: what the colours mean, and what is happening. */
.foot{display:flex;align-items:center;gap:12px;min-height:34px;padding:5px 12px;border-top:1px solid var(--line);background:var(--panel);color:var(--muted);font-size:11.5px}
.legend{display:flex;align-items:center;flex-wrap:wrap;gap:2px 4px;min-width:0}
.chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--muted);font-size:11.5px;font-weight:600}
.chip:hover{background:var(--hover);color:var(--text)}
.chip i{width:10px;height:10px;border-radius:3px;border:1.5px solid var(--ks);background:var(--kf)}
.chip[aria-pressed="true"]{border-color:var(--ks);color:var(--text)}
.status{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}

.exit-present{display:none}
.present .head,.present .toolbar,.present .foot,.present .panel{display:none}
.app.present{grid-template-rows:minmax(0,1fr)}
.present .exit-present{display:inline-flex;position:fixed;top:12px;right:12px;z-index:5}
.present .body{grid-template-columns:minmax(0,1fr)}

/* ---- the drawing ---- */
.frame .fr{stroke-width:1.2}
.frame .ftitle{font-size:10px;font-weight:800;letter-spacing:.11em;fill:var(--muted)}
.f-region .fr{fill:rgba(251,191,36,.055);stroke:var(--ks-cloud);stroke-dasharray:8 5;stroke-opacity:.8}
.f-region .ftitle{fill:var(--ks-cloud)}
.f-security-group .fr{fill:rgba(251,113,133,.045);stroke:var(--ks-security);stroke-dasharray:4 4;stroke-opacity:.85}
.f-security-group .ftitle{fill:var(--ks-security)}
.f-lane .fr{fill:var(--lane);stroke:var(--line)}
.f-lane .sep{stroke:var(--line)}
.f-lane-exception .fr{fill:rgba(251,113,133,.06);stroke:var(--ks-security);stroke-dasharray:6 4;stroke-opacity:.7}
.f-lane-exception .sep{stroke:var(--ks-security);stroke-opacity:.35}
.f-lane-exception .ftitle{fill:var(--ks-security)}
.f-phase .fr{fill:var(--accent2);stroke:var(--accent);stroke-opacity:.5}
.f-phase .ftitle{fill:var(--accent);font-size:11px;letter-spacing:.02em}
.f-group .fr{fill:none;stroke:var(--muted);stroke-dasharray:5 4;stroke-opacity:.7}
.f-group .tab{fill:var(--panel);stroke:var(--line)}
.f-group .ftitle{letter-spacing:.02em;font-size:10.5px;fill:var(--muted)}
.f-stage .fr{fill:var(--lane);stroke:none}
.f-stage.st-odd .fr{fill:transparent;stroke:var(--line2)}
.f-stage .ftitle{fill:var(--muted)}
.band .fr{fill:var(--accent2);stroke:none;opacity:.55}
.band .ftitle{fill:var(--accent);letter-spacing:.02em;font-size:10.5px}

.edge{fill:none;stroke:var(--edge);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;transition:opacity .15s,stroke-width .15s}
.edge.s-emphasis{stroke:var(--accent);stroke-width:2.4}
.edge.s-security{stroke:var(--ks-security);stroke-dasharray:6 4}
.edge.s-dashed{stroke-dasharray:6 5}
.edge.s-return{stroke:var(--faint);stroke-dasharray:3 4}
.edge.s-error{stroke:var(--ks-security);stroke-width:1.8}
.arrow{fill:var(--edge)}
.arrow.s-emphasis{fill:var(--accent)}.arrow.s-security,.arrow.s-error{fill:var(--ks-security)}.arrow.s-return{fill:var(--faint)}
.hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}
.on .edge,.edge.on,.rel.on .edge,.msg.on .edge{stroke-width:2.8}
.rel.on .edge:not(.s-security):not(.s-error),.msg.on .edge:not(.s-security):not(.s-error){stroke:var(--accent)}
.rel:hover .edge,.msg:hover .edge{stroke-width:2.6}

.elabel{cursor:pointer}
.elabel .pill{fill:var(--panel);stroke:var(--line);stroke-width:1}
.elabel .ptext{font-size:10.5px;font-weight:650;fill:var(--muted)}
.elabel .cls{fill:var(--accent2);stroke:var(--accent);stroke-width:.8}
.elabel .clstext{font-size:9px;font-weight:800;fill:var(--accent)}
.elabel.on .pill{stroke:var(--accent)}
.elabel.on .ptext{fill:var(--text)}

.node{cursor:pointer;outline:none;transition:opacity .15s}
.node .base{fill:var(--panel)}
.node .card{fill:var(--kf);stroke:var(--ks);stroke-width:1.3;transition:stroke-width .12s}
.node .dot{fill:var(--ks)}
.node .bar{fill:var(--ks)}
.node .cap{font-size:9px;font-weight:700;letter-spacing:.1em;fill:var(--muted)}
.node .tag{font-size:9px;font-weight:700;fill:var(--faint)}
.node .name{font-size:13.5px;font-weight:650;fill:var(--text)}
.node .name.small{font-size:12.5px}
.node .sub{font-size:11px;fill:var(--muted)}
.node:hover .card{stroke-width:2}
.node:focus-visible .card{stroke:var(--accent);stroke-width:2.6}
.node.rel .card{stroke-width:2.1}
.node.hit .card{stroke:var(--match);stroke-width:2.6}
.node.sel .card{stroke:var(--accent);stroke-width:2.8;filter:drop-shadow(0 0 6px var(--accent))}
.node.sh-diamond .card,.node.sh-diamond .base{stroke-linejoin:round}
.src-badge circle{fill:var(--panel);stroke:var(--accent);stroke-width:1.2}
.src-badge text{font-size:9.5px;font-weight:800;fill:var(--accent)}
.status-tag rect{fill:var(--panel);stroke:currentColor}
.status-tag text{font-size:9px;font-weight:800;fill:currentColor}
.status-added{color:#34d399}.status-removed{color:#fb7185}.status-changed{color:#fbbf24}
.node.status-added .card{stroke:#34d399;stroke-width:2.2}
.node.status-removed .card{stroke:#fb7185;stroke-dasharray:6 4;stroke-width:2}
.node.status-removed{opacity:.8}
.node.status-changed .card{stroke:#fbbf24;stroke-width:2.2}
.rel.status-added .edge{stroke:#34d399}.rel.status-removed .edge{stroke:#fb7185;stroke-dasharray:6 4}

.life .line{stroke:var(--line);stroke-width:1.4;stroke-dasharray:4 5}
.life .hit{stroke-width:16}
.act{fill:var(--kf);stroke:var(--ks);stroke-width:1.3}
.dim{opacity:.13}
.exporting .dim{opacity:1}

.motion .edge.on,.motion:not(.following) .edge{stroke-dasharray:7 7;animation:ax-flow 1s linear infinite}
@keyframes ax-flow{to{stroke-dashoffset:-28}}
@media (prefers-reduced-motion:reduce){.motion .edge{animation:none!important}}

/* ---- presets: the same variables, set differently ---- */
.app[data-preset="signal-flow"]{
  color-scheme:dark;--bg:#04070d;--panel:#0a1120;--panel2:#0f1a2e;--line:#1b2b47;--line2:#142039;--grid:#101a2d;
  --accent:#38f9d7;--accent2:rgba(56,249,215,.1);--edge:#4b6b97;--text:#f2f7ff;
}
.app[data-preset="signal-flow"] .edge.s-emphasis,.app[data-preset="signal-flow"] .rel.on .edge,.app[data-preset="signal-flow"] .msg.on .edge{filter:drop-shadow(0 0 5px var(--accent))}
.app[data-preset="signal-flow"] .node .card{stroke-width:1.6;filter:drop-shadow(0 0 5px var(--ks))}
.app[data-preset="blueprint"]{
  color-scheme:dark;--bg:#0a2342;--panel:#0d2c52;--panel2:#103459;--line:#2c5f93;--line2:#1f4a78;--lane:rgba(125,211,252,.05);--grid:#12396a;
  --text:#e6f1ff;--muted:#9cc3e6;--faint:#6f9ac4;--accent:#7dd3fc;--accent2:rgba(125,211,252,.13);--edge:#8cc4ee;--hover:#144070;
  --name-font:var(--mono);
  ${Object.keys(KINDS).map((k) => `--ks-${k}:#9ad1ff;--kf-${k}:rgba(125,211,252,.07);`).join("")}
}
.app[data-preset="blueprint"] .node .name,.app[data-preset="blueprint"] .node .sub,.app[data-preset="blueprint"] .elabel .ptext{font-family:var(--mono)}
.app[data-preset="blueprint"] .node .card{stroke-width:1.5}
.app[data-preset="editorial"]{
  color-scheme:light;--bg:#f4efe6;--panel:#fffaf0;--panel2:#f8f1e2;--line:#d9cdb8;--line2:#e8dfcc;--lane:rgba(120,90,40,.045);--grid:#e6dcc8;
  --text:#2a2118;--muted:#7a6a55;--faint:#a39580;--accent:#9a3412;--accent2:rgba(154,52,18,.09);--edge:#9d8f78;--hover:#f1e8d4;--match:#b45309;
  --name-font:Georgia,"Iowan Old Style","Times New Roman",serif;
  --ks-frontend:#3b6e8f;--kf-frontend:rgba(59,110,143,.13);--ks-backend:#5b7f4a;--kf-backend:rgba(91,127,74,.14);
  --ks-database:#7a5c8f;--kf-database:rgba(122,92,143,.13);--ks-cloud:#b07d2b;--kf-cloud:rgba(176,125,43,.14);
  --ks-security:#a8433a;--kf-security:rgba(168,67,58,.12);--ks-messagebus:#c26a2e;--kf-messagebus:rgba(194,106,46,.13);
  --ks-external:#7d7468;--kf-external:rgba(125,116,104,.13);--ks-start:#4f8a73;--kf-start:rgba(79,138,115,.14);
  --ks-active:#3b6e8f;--kf-active:rgba(59,110,143,.13);--ks-waiting:#b07d2b;--kf-waiting:rgba(176,125,43,.14);
  --ks-decision:#7a5c8f;--kf-decision:rgba(122,92,143,.13);--ks-success:#5b7f4a;--kf-success:rgba(91,127,74,.14);
  --ks-failure:#a8433a;--kf-failure:rgba(168,67,58,.12);--ks-neutral:#7d7468;--kf-neutral:rgba(125,116,104,.13);
}
.app[data-preset="editorial"] .node .name,.app[data-preset="editorial"] .head h1,.app[data-preset="editorial"] .panel h2{font-family:var(--name-font)}
.app[data-preset="editorial"] .node .card{stroke-width:1.1}
.node .name{font-family:var(--name-font)}

@media (max-width:860px){
  .search input{width:140px}
  .tb span{display:none}
  .panel{position:absolute;right:0;left:0;bottom:34px;width:auto;max-height:58%;border-left:0;border-top:1px solid var(--line);box-shadow:var(--shadow)}
  .body{position:relative}
  .legend{display:none}
}
`;
