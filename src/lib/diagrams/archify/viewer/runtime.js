/* The viewer of an archify diagram: one classic script, no dependencies, for all five types.
 *
 * It is embedded verbatim in the page `viewerHtml.ts` writes, which is the same page whether it is
 * framed inside CodeFlow or downloaded and opened by itself. It computes no geometry — it draws the
 * scene it is given (see `scene.ts`) and moves a camera over it — so everything below is about
 * looking: selecting, following connections, searching, tracing a route, exporting.
 *
 * Nothing here ever touches the document as markup: every string from the scene reaches the page
 * through textContent or an attribute, which is what makes it safe to draw what a model wrote.
 */
(function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var data = JSON.parse(document.getElementById("data").textContent || "{}");
  var S = data.scene;
  var L = data.labels || {};
  var KT = L.types || {};
  var app = document.getElementById("app");
  var svg = document.getElementById("map");
  var SEQ = S.mode === "sequence";

  // ---- small helpers ----------------------------------------------------------------------
  function sv(name, attrs, parent) {
    var node = document.createElementNS(NS, name);
    if (attrs) for (var k in attrs) node.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(node);
    return node;
  }
  function h(name, cls, text, parent) {
    var node = document.createElement(name);
    if (cls) node.className = cls;
    if (text != null && text !== "") node.textContent = String(text);
    if (parent) parent.appendChild(node);
    return node;
  }
  function $(id) { return document.getElementById(id); }
  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s; }
  function kindName(k) { return KT[k] || k; }
  function fmt(template, values) {
    return String(template || "").replace(/\{(\w+)\}/g, function (_, k) { return values[k] != null ? values[k] : ""; });
  }
  function label(key, fallback) { return L[key] != null ? L[key] : fallback; }

  var ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
    route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    download: '<path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/>',
    present: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
  }
  function iconButton(id, name, text) {
    var b = $(id);
    if (!b) return null;
    b.innerHTML = icon(name);
    b.setAttribute("aria-label", text);
    b.setAttribute("title", text);
    return b;
  }

  // ---- model ------------------------------------------------------------------------------
  var nodes = S.nodes;
  var byId = {};
  nodes.forEach(function (n, i) { byId[n.id] = n; n.index = i; });
  var rels = SEQ
    ? S.messages.map(function (m) { return { from: m.from, to: m.to, label: m.label, style: m.style, note: m.note, classification: "", id: m.id, msg: m }; })
    : S.edges.map(function (e) { return { from: e.from, to: e.to, label: e.label, style: e.style, note: e.note, classification: e.classification, id: e.id, edge: e }; });
  var outs = {}, ins = {};
  nodes.forEach(function (n) { outs[n.id] = []; ins[n.id] = []; });
  rels.forEach(function (r, i) {
    if (outs[r.from]) outs[r.from].push(i);
    if (ins[r.to]) ins[r.to].push(i);
  });

  var state = {
    sel: null,       // an entity id
    selRel: -1,      // or a relation index
    reach: "direct", // direct | up | down
    route: { on: false, from: null, to: null },
    query: "",
    kind: null,      // a legend filter
    panel: null,     // null | overview | entity | rel | route
    pinOverview: false,
    auto: true,      // keep fitting until the user moves the camera
    view: { x: 0, y: 0, w: 800, h: 600 },
    drag: null,
    motion: false,
    present: false,
  };

  // ---- chrome -----------------------------------------------------------------------------
  document.title = data.title || S.title || "Archify";
  if (data.embed) app.classList.add("embed");
  app.setAttribute("data-theme", data.theme === "light" ? "light" : "dark");
  app.setAttribute("data-preset", data.preset || "classic");
  if (data.host && (data.preset || "classic") === "classic") applyHost(data.host);
  function applyHost(host) {
    var map = { bg: "--bg", panel: "--panel", panel2: "--panel2", line: "--line", line2: "--line2", text: "--text", muted: "--muted", faint: "--faint", accent: "--accent", accent2: "--accent2", hover: "--hover" };
    for (var k in map) if (host[k]) app.style.setProperty(map[k], host[k]);
    if (host.line2) app.style.setProperty("--grid", host.line2);
    if (host.scheme) app.setAttribute("data-theme", host.scheme === "light" ? "light" : "dark");
  }
  function clearHost() {
    ["--bg", "--panel", "--panel2", "--line", "--line2", "--text", "--muted", "--faint", "--accent", "--accent2", "--hover", "--grid"].forEach(function (p) { app.style.removeProperty(p); });
  }

  $("eyebrow").textContent = label("eyebrow", "");
  $("title").textContent = S.title || "";
  $("subtitle").textContent = S.subtitle || "";
  iconButton("zoomIn", "plus", label("zoomIn", "Zoom in"));
  iconButton("zoomOut", "minus", label("zoomOut", "Zoom out"));
  iconButton("fit", "fit", label("fit", "Fit"));
  iconButton("panelBtn", "panel", label("panel", "Panel"));
  iconButton("motionBtn", "play", label("motion", "Motion"));
  iconButton("presentBtn", "present", label("present", "Present"));
  iconButton("themeBtn", "sun", label("theme", "Theme"));
  iconButton("exportBtn", "download", label("export", "Export"));
  iconButton("searchIcon", "search", "");
  $("searchIcon").removeAttribute("title");
  $("searchIcon").removeAttribute("aria-label");
  $("search").placeholder = label("search", "Search");
  $("search").setAttribute("aria-label", label("search", "Search"));
  $("exitPresent").textContent = label("exitPresent", "Esc");
  $("closePanel").innerHTML = icon("close");
  $("closePanel").setAttribute("aria-label", label("close", "Close"));
  $("routeBtn").innerHTML = icon("route") + "<span></span>";
  $("routeBtn").lastChild.textContent = label("route", "Route");
  var reachButtons = { direct: label("reachDirect", "Direct"), up: label("reachUp", "Upstream"), down: label("reachDown", "Downstream") };
  var reachHints = { direct: label("reachDirectHint", ""), up: label("reachUpHint", ""), down: label("reachDownHint", "") };
  Array.prototype.forEach.call(document.querySelectorAll("#reach button"), function (b) {
    var which = b.getAttribute("data-reach");
    b.textContent = reachButtons[which];
    b.title = reachHints[which];
  });
  $("routeBtn").title = label("routeHint", "");
  $("motionBtn").title = label("motionHint", label("motion", ""));
  $("panelBtn").title = label("panelHint", label("panel", ""));
  $("presentBtn").title = label("presentHint", label("present", ""));
  $("reach").setAttribute("aria-label", label("reachLabel", "Follow connections"));
  if (data.embed) {
    $("themeBtn").hidden = true;
    $("exportBtn").hidden = true;
    $("exportMenu").hidden = true;
  }
  var presetSel = $("preset");
  (data.presets || []).forEach(function (p) {
    var o = h("option", "", p.label, presetSel);
    o.value = p.id;
  });
  presetSel.value = data.preset || "classic";
  presetSel.setAttribute("aria-label", label("style", "Style"));
  // In the app the app owns the theme (the host's colours are applied only to the classic look), so a
  // second picker of looks would only undo that: the choice exists in the file, not in the frame.
  if (data.embed || !(data.presets || []).length) presetSel.hidden = true;

  // ---- drawing ----------------------------------------------------------------------------
  var STYLES = ["default", "emphasis", "security", "dashed", "return", "error"];
  var defs = sv("defs", null, svg);
  STYLES.forEach(function (st) {
    var m = sv("marker", { id: "arr-" + st, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto" }, defs);
    sv("path", { d: "M0,0.5 L10,5 L0,9.5 z", "class": "arrow s-" + st }, m);
  });
  var gFrames = sv("g", { "class": "frames" }, svg);
  var gLife = sv("g", { "class": "lives" }, svg);
  var gEdges = sv("g", { "class": "edges" }, svg);
  var gNodes = sv("g", { "class": "nodes" }, svg);
  var gLabels = sv("g", { "class": "labels" }, svg);

  function words(s, n) {
    var parts = String(s || "").split(/\s+/), lines = [], line = "";
    parts.forEach(function (w) {
      if (line && (line + " " + w).length > n) { lines.push(line); line = w; }
      else line = line ? line + " " + w : w;
    });
    if (line) lines.push(line);
    return lines.slice(0, 3);
  }

  S.frames.forEach(function (f) {
    var g = sv("g", { "class": "frame f-" + f.kind + " st-" + f.style }, gFrames);
    var b = f.box;
    if (f.kind === "lane" || f.kind === "lane-exception") {
      sv("rect", { x: b[0], y: b[1], width: b[2], height: b[3], rx: 12, "class": "fr" }, g);
      sv("line", { x1: b[0] + 148, y1: b[1] + 10, x2: b[0] + 148, y2: b[1] + b[3] - 10, "class": "sep" }, g);
      var lines = words(f.label, 15);
      lines.forEach(function (ln, i) {
        sv("text", { x: b[0] + 16, y: b[1] + b[3] / 2 + (i - (lines.length - 1) / 2) * 15 + 4, "class": "ftitle" }, g).textContent = ln.toUpperCase();
      });
    } else if (f.kind === "phase") {
      sv("rect", { x: b[0], y: b[1], width: b[2], height: b[3], rx: 9, "class": "fr" }, g);
      sv("text", { x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 + 4, "text-anchor": "middle", "class": "ftitle" }, g).textContent = clip(f.label, Math.floor(b[2] / 7));
    } else if (f.kind === "stage") {
      sv("rect", { x: b[0], y: b[1], width: b[2], height: b[3], rx: 14, "class": "fr" }, g);
      sv("text", { x: b[0] + b[2] / 2, y: 26, "text-anchor": "middle", "class": "ftitle" }, g).textContent = clip(f.label, Math.floor(b[2] / 7.5)).toUpperCase();
    } else {
      sv("rect", { x: b[0], y: b[1], width: b[2], height: b[3], rx: 14, "class": "fr" }, g);
      var title = clip(f.label, Math.floor(b[2] / 7));
      if (f.kind !== "group") title = title.toUpperCase();
      var tw = title.length * 6.6 + 18;
      if (f.kind === "group") {
        sv("rect", { x: b[0] + 10, y: b[1] - 1, width: tw, height: 20, rx: 6, "class": "tab" }, g);
        sv("text", { x: b[0] + 19, y: b[1] + 13, "class": "ftitle" }, g).textContent = title;
      } else {
        sv("text", { x: b[0] + 14, y: b[1] + 19, "class": "ftitle" }, g).textContent = title;
      }
    }
  });

  var nodeEls = {};
  function drawNode(n) {
    var b = n.box, w = b[2], hgt = b[3];
    var g = sv("g", { "class": "node k-" + n.kind + " sh-" + n.shape + (n.status ? " status-" + n.status : ""), transform: "translate(" + b[0] + " " + b[1] + ")", tabindex: "0", role: "button", "data-id": n.id, "aria-label": n.lines.join(" ") + " · " + kindName(n.kind) }, gNodes);
    sv("title", null, g).textContent = n.lines.join(" ") + (n.sublabel ? " — " + n.sublabel : "");
    if (n.shape === "diamond") {
      var pts = w / 2 + ",0 " + w + "," + hgt / 2 + " " + w / 2 + "," + hgt + " 0," + hgt / 2;
      sv("polygon", { points: pts, "class": "base" }, g);
      sv("polygon", { points: pts, "class": "card" }, g);
      n.lines.forEach(function (ln, i) {
        sv("text", { x: w / 2, y: hgt / 2 + (i - (n.lines.length - 1) / 2) * 15 + 4.5, "text-anchor": "middle", "class": "name small" }, g).textContent = ln;
      });
    } else if (n.shape === "pill") {
      sv("rect", { width: w, height: hgt, rx: hgt / 2, "class": "base" }, g);
      sv("rect", { width: w, height: hgt, rx: hgt / 2, "class": "card" }, g);
      sv("circle", { cx: 22, cy: hgt / 2, r: 4.5, "class": "dot" }, g);
      sv("text", { x: 36, y: hgt / 2 + 5, "class": "name" }, g).textContent = n.lines[0];
    } else if (n.shape === "head") {
      sv("rect", { width: w, height: hgt, rx: 11, "class": "base" }, g);
      sv("rect", { width: w, height: hgt, rx: 11, "class": "card" }, g);
      sv("rect", { x: 0, y: 0, width: w, height: 4, rx: 2, "class": "bar" }, g);
      sv("text", { x: w / 2, y: n.sublabel ? 25 : 31, "text-anchor": "middle", "class": "name" }, g).textContent = n.lines[0];
      if (n.sublabel) sv("text", { x: w / 2, y: 42, "text-anchor": "middle", "class": "sub" }, g).textContent = n.sublabel;
    } else {
      sv("rect", { width: w, height: hgt, rx: 11, "class": "base" }, g);
      sv("rect", { width: w, height: hgt, rx: 11, "class": "card" }, g);
      var tall = n.lines.length;
      sv("circle", { cx: 15, cy: 11 + 8.5, r: 3.6, "class": "dot" }, g);
      n.lines.forEach(function (ln, i) { sv("text", { x: 27, y: 11 + 13 + i * 17, "class": "name" }, g).textContent = ln; });
      if (n.sublabel || n.tag) {
        var base = 11 + 17 * tall + 12;
        if (n.sublabel) sv("text", { x: 27, y: base, "class": "sub" }, g).textContent = n.sublabel;
        if (n.step) sv("text", { x: w - 12, y: base, "text-anchor": "end", "class": "tag" }, g).textContent = "#" + n.step;
        else if (n.tag && (n.tagFit || !n.sublabel)) sv("text", { x: n.sublabel ? w - 12 : 27, y: base, "text-anchor": n.sublabel ? "end" : "start", "class": n.sublabel ? "tag" : "sub" }, g).textContent = clip(n.tag, 28);
      } else if (n.step) {
        sv("text", { x: w - 12, y: 11 + 13, "text-anchor": "end", "class": "tag" }, g).textContent = "#" + n.step;
      }
    }
    if (n.sources.length) {
      var badge = sv("g", { "class": "src-badge", transform: "translate(" + (w - 3) + " 3)" }, g);
      sv("circle", { r: 9.5 }, badge);
      sv("text", { y: 3.6, "text-anchor": "middle" }, badge).textContent = n.sources.length;
    }
    if (n.status) {
      var tag = sv("g", { "class": "status-tag", transform: "translate(8 -9)" }, g);
      sv("rect", { width: 52, height: 16, rx: 8 }, tag);
      sv("text", { x: 26, y: 11.6, "text-anchor": "middle" }, tag).textContent = label("status_" + n.status, n.status);
    }
    g.addEventListener("click", function (ev) { ev.stopPropagation(); onNode(n.id); });
    g.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onNode(n.id); }
    });
    nodeEls[n.id] = g;
    if (n.life) {
      var lg = sv("g", { "class": "life k-" + n.kind, "data-id": n.id }, gLife);
      sv("line", { x1: n.life[0], y1: n.life[1], x2: n.life[0], y2: n.life[2], "class": "line" }, lg);
      sv("line", { x1: n.life[0], y1: n.life[1], x2: n.life[0], y2: n.life[2], "class": "hit" }, lg).addEventListener("click", function (ev) { ev.stopPropagation(); onNode(n.id); });
      n.lifeEl = lg;
    }
  }
  nodes.forEach(drawNode);

  var relEls = [];
  function pill(parent, r, at, cls) {
    var g = sv("g", { "class": "elabel " + (cls || "") }, parent);
    var cl = r.classification || "";
    sv("rect", { x: at[0], y: at[1], width: at[2], height: at[3], rx: at[3] / 2, "class": "pill" }, g);
    var textW = at[2];
    if (cl) {
      var bw = cl.length * 5.6 + 14;
      textW = at[2] - bw - 2;
      sv("rect", { x: at[0] + at[2] - bw - 4, y: at[1] + 3, width: bw, height: at[3] - 6, rx: (at[3] - 6) / 2, "class": "cls" }, g);
      sv("text", { x: at[0] + at[2] - bw / 2 - 4, y: at[1] + at[3] / 2 + 3.2, "text-anchor": "middle", "class": "clstext" }, g).textContent = cl;
    }
    sv("text", { x: at[0] + 9 + (textW - 18) / 2, y: at[1] + at[3] / 2 + 3.8, "text-anchor": "middle", "class": "ptext" }, g).textContent = clip(r.label, 38);
    return g;
  }
  rels.forEach(function (r, i) {
    var item = { r: r, els: [] };
    if (SEQ) {
      var m = r.msg, g = sv("g", { "class": "msg s-" + m.style, "data-i": i }, gEdges);
      var d;
      if (m.self) d = "M " + m.x1 + " " + m.y + " h 30 v 20 h -30";
      else d = "M " + m.x1 + " " + m.y + " L " + m.x2 + " " + m.y;
      sv("path", { d: d, "class": "edge s-" + m.style, "marker-end": "url(#arr-" + m.style + ")" }, g);
      var hit = sv("path", { d: d, "class": "hit" }, g);
      hit.addEventListener("click", function (ev) { ev.stopPropagation(); onRel(i); });
      var pl = pill(gLabels, r, m.at, "");
      pl.addEventListener("click", function (ev) { ev.stopPropagation(); onRel(i); });
      item.els = [g, pl];
    } else {
      var e = r.edge, g2 = sv("g", { "class": "rel s-" + e.style + (e.status ? " status-" + e.status : ""), "data-i": i }, gEdges);
      sv("path", { d: e.d, "class": "edge s-" + e.style, "marker-end": "url(#arr-" + e.style + ")" }, g2);
      sv("path", { d: e.d, "class": "hit" }, g2).addEventListener("click", function (ev) { ev.stopPropagation(); onRel(i); });
      item.els = [g2];
      if (e.at) {
        var pl2 = pill(gLabels, r, e.at, "");
        pl2.addEventListener("click", function (ev) { ev.stopPropagation(); onRel(i); });
        item.els.push(pl2);
      }
    }
    relEls.push(item);
  });

  if (SEQ) {
    var xs = nodes.map(function (n) { return n.life[0]; });
    var left = Math.min.apply(null, xs) - 90, right = Math.max.apply(null, xs) + 90;
    S.bands.forEach(function (bd) {
      var g = sv("g", { "class": "band" }, gFrames);
      sv("rect", { x: left, y: bd.y1, width: right - left, height: bd.y2 - bd.y1, rx: 10, "class": "fr" }, g);
      sv("text", { x: left + 12, y: bd.y1 + 17, "class": "ftitle" }, g).textContent = clip(bd.label, 40);
    });
    S.activations.forEach(function (a) {
      var kind = byId[a.participant] ? byId[a.participant].kind : "backend";
      sv("rect", { x: a.x - 5, y: a.y1, width: 10, height: a.y2 - a.y1, rx: 2, "class": "act k-" + kind }, gLife);
    });
  }

  // ---- highlight --------------------------------------------------------------------------
  function closure(start, forward) {
    var seen = {}; seen[start] = true;
    var queue = [start];
    while (queue.length) {
      var cur = queue.shift();
      (forward ? outs : ins)[cur].forEach(function (i) {
        var next = forward ? rels[i].to : rels[i].from;
        if (!seen[next]) { seen[next] = true; queue.push(next); }
      });
    }
    return seen;
  }
  function focusOf(id, mode) {
    var set = {}, edges = {};
    if (mode === "up" || mode === "down") {
      set = closure(id, mode === "down");
      rels.forEach(function (r, i) { if (set[mode === "down" ? r.from : r.to] && set[mode === "down" ? r.to : r.from]) edges[i] = true; });
    } else {
      set[id] = true;
      outs[id].concat(ins[id]).forEach(function (i) { edges[i] = true; set[rels[i].from] = true; set[rels[i].to] = true; });
    }
    return { nodes: set, rels: edges };
  }
  function routeOf(from, to) {
    function bfs(a, b, forward) {
      var dist = {}; dist[a] = 0;
      var preds = {};
      var queue = [a];
      while (queue.length) {
        var cur = queue.shift();
        if (cur === b) break;
        (forward ? outs : ins)[cur].forEach(function (i) {
          var next = forward ? rels[i].to : rels[i].from;
          if (dist[next] == null) { dist[next] = dist[cur] + 1; preds[next] = [[cur, i]]; queue.push(next); }
          else if (dist[next] === dist[cur] + 1) preds[next].push([cur, i]);
        });
      }
      if (dist[b] == null) return null;
      var paths = [];
      (function walk(at, acc) {
        if (paths.length >= 40) return;
        if (at === a) { paths.push(acc.slice().reverse()); return; }
        preds[at].forEach(function (p) { acc.push(p); walk(p[0], acc); acc.pop(); });
      })(b, []);
      return { paths: paths, forward: forward };
    }
    var found = bfs(from, to, true);
    if (found) return { steps: found.paths, from: from, to: to, reversed: false };
    found = bfs(to, from, true);
    if (found) return { steps: found.paths, from: to, to: from, reversed: true };
    return null;
  }

  var route = null;
  var current = { nodes: null, rels: null, count: 0 };
  function matches(n, q) {
    var hay = [n.lines.join(" "), n.sublabel, n.tag, kindName(n.kind)].concat(n.sources.map(function (s) { return s.path + " " + s.label; })).join(" ").toLowerCase();
    return hay.indexOf(q) !== -1;
  }
  function refresh() {
    var q = state.query.trim().toLowerCase();
    var focus = null, focusRels = null;
    if (state.route.on && state.route.from && route) {
      focus = {}; focusRels = {};
      route.steps.forEach(function (path) {
        focus[route.from] = true;
        path.forEach(function (st) { focus[st[0]] = true; focus[rels[st[1]].from] = true; focus[rels[st[1]].to] = true; focusRels[st[1]] = true; });
      });
      focus[route.to] = true;
    } else if (state.route.on && state.route.from) {
      focus = {}; focus[state.route.from] = true; focusRels = {};
    } else if (state.selRel >= 0) {
      focus = {}; focus[rels[state.selRel].from] = true; focus[rels[state.selRel].to] = true;
      focusRels = {}; focusRels[state.selRel] = true;
    } else if (state.sel) {
      var f = focusOf(state.sel, state.reach);
      focus = f.nodes; focusRels = f.rels;
    }
    var hits = 0;
    nodes.forEach(function (n) {
      var el = nodeEls[n.id];
      var hit = q ? matches(n, q) : false;
      if (hit) hits++;
      var inFocus = !focus || focus[n.id];
      var passes = (!q || hit) && (!state.kind || n.kind === state.kind);
      var visible = n.id === state.sel || (inFocus && passes);
      var on = !!focus || !!q || !!state.kind;
      el.classList.toggle("sel", n.id === state.sel);
      el.classList.toggle("rel", !!focus && !!focus[n.id] && n.id !== state.sel);
      el.classList.toggle("hit", !!q && hit);
      el.classList.toggle("dim", on && !visible);
      if (n.lifeEl) n.lifeEl.classList.toggle("dim", on && !visible);
    });
    var shown = 0;
    relEls.forEach(function (item, i) {
      var r = item.r;
      var active = focusRels ? !!focusRels[i] : false;
      var visible = !focusRels ? true : active;
      var filtered = (q || state.kind) && !(nodeEls[r.from] && !nodeEls[r.from].classList.contains("dim") && nodeEls[r.to] && !nodeEls[r.to].classList.contains("dim"));
      var dim = (!!focusRels && !visible) || (!focusRels && !!filtered);
      if (active) shown++;
      item.els.forEach(function (el) { el.classList.toggle("on", active); el.classList.toggle("dim", dim); });
    });
    current.nodes = focus; current.rels = focusRels;
    $("search").parentNode.classList.toggle("has", !!q);
    $("searchCount").textContent = q ? String(hits) : "";
    Array.prototype.forEach.call(document.querySelectorAll("#reach button"), function (b) {
      var on = b.getAttribute("data-reach") === state.reach;
      b.setAttribute("aria-pressed", String(on));
    });
    $("routeBtn").setAttribute("aria-pressed", String(state.route.on));
    $("motionBtn").setAttribute("aria-pressed", String(state.motion));
    $("panelBtn").setAttribute("aria-pressed", String(state.panel === "overview"));
    $("presentBtn").setAttribute("aria-pressed", String(state.present));
    Array.prototype.forEach.call(document.querySelectorAll("#legend .chip"), function (c) {
      c.setAttribute("aria-pressed", String(state.kind === c.getAttribute("data-kind")));
    });
    app.classList.toggle("motion", state.motion);
    app.classList.toggle("following", !!focusRels);
    status(focus, hits, q);
  }

  function status(focus, hits, q) {
    var text = "";
    if (state.route.on) {
      if (!state.route.from) text = label("routePickFrom", "Pick the start");
      else if (!state.route.to) text = fmt(label("routePickTo", "From {name} — pick the end"), { name: byId[state.route.from].lines.join(" ") });
      else if (!route) text = label("routeNone", "No route between them");
      else text = fmt(label("routeFound", "{n} steps"), { n: route.steps[0].length });
    } else if (state.sel && focus) {
      var name = byId[state.sel].lines.join(" ");
      var total = nodes.length, n = Object.keys(focus).length;
      var key = state.reach === "up" ? "statusUp" : state.reach === "down" ? "statusDown" : "statusDirect";
      text = fmt(label(key, "{name}"), { name: name, n: n, total: total });
    } else if (q) {
      text = fmt(label("statusSearch", "{n} matches"), { n: hits });
    } else {
      text = fmt(label("counts", ""), { entities: nodes.length, relations: rels.length });
    }
    $("status").textContent = text;
  }

  // ---- selection --------------------------------------------------------------------------
  function onNode(id) {
    if (state.route.on) {
      if (!state.route.from || state.route.to) { state.route.from = id; state.route.to = null; route = null; }
      else if (id !== state.route.from) { state.route.to = id; route = routeOf(state.route.from, id); }
      state.sel = null; state.selRel = -1;
      state.panel = state.route.to ? "route" : (state.pinOverview ? "overview" : null);
      renderPanel(); refresh(); hash();
      return;
    }
    state.sel = id; state.selRel = -1; state.panel = "entity";
    renderPanel(); refresh(); hash();
  }
  function onRel(i) {
    if (state.route.on) return;
    state.sel = null; state.selRel = i; state.panel = "rel";
    renderPanel(); refresh(); hash();
  }
  function release() {
    state.sel = null; state.selRel = -1;
    state.panel = state.pinOverview ? "overview" : null;
    renderPanel(); refresh(); hash();
  }
  function closePanel() {
    state.sel = null; state.selRel = -1; state.pinOverview = false;
    state.panel = null;
    if (state.route.on) { state.route = { on: false, from: null, to: null }; route = null; }
    renderPanel(); refresh(); hash();
  }
  function setReach(mode) {
    state.reach = mode;
    refresh(); hash();
    if (state.panel === "entity") renderPanel();
  }
  function setRoute(on) {
    state.route = { on: on, from: null, to: null }; route = null;
    if (on) { state.sel = null; state.selRel = -1; }
    state.panel = on ? (state.pinOverview ? "overview" : null) : (state.sel ? "entity" : state.pinOverview ? "overview" : null);
    renderPanel(); refresh();
  }

  // ---- panel ------------------------------------------------------------------------------
  var panelBody = $("panelBody");
  function section(title) {
    var s = h("section", "sec", null, panelBody);
    if (title) h("p", "sec-title", title, s);
    return s;
  }
  function chip(text, kind) {
    var c = h("span", "kchip k-" + kind, null);
    h("i", "", null, c);
    h("span", "", text, c);
    return c;
  }
  function relRow(parent, relIndex, otherId) {
    var other = byId[otherId], r = rels[relIndex];
    var b = h("button", "row", null, parent);
    b.type = "button";
    var dot = h("i", "dot k-" + other.kind, null, b);
    h("span", "row-name", other.lines.join(" "), b);
    if (r.label) h("small", "", r.label, b);
    b.addEventListener("click", function () { onNode(otherId); focusOn(otherId); });
    return b;
  }
  function sourceRow(parent, s) {
    var where = s.path + (s.line ? ":" + s.line + (s.end ? "–" + s.end : "") : "");
    var a = h(s.href ? "a" : "div", "src", null, parent);
    var top = h("span", "src-path", where, a);
    a.insertBefore(h("span", "src-ic", null), top);
    a.firstChild.innerHTML = icon("file");
    if (s.label) h("span", "src-label", s.label, a);
    if (s.href) { a.href = s.href; a.target = "_blank"; a.rel = "noopener noreferrer"; }
  }
  function renderPanel() {
    panelBody.replaceChildren();
    var mode = state.panel;
    app.classList.toggle("has-panel", !!mode);
    if (!mode) { app.classList.remove("has-panel"); scheduleFit(); return; }
    var eyebrow = $("panelEyebrow"), title = $("panelTitle");
    if (mode === "overview") {
      eyebrow.textContent = label("overview", "Overview");
      title.textContent = S.title || "";
      if (S.subtitle) h("p", "lead", S.subtitle, panelBody);
      if (S.delta) {
        var ds = section(label("changes", "Changes"));
        var drow = h("div", "delta", null, ds);
        ["added", "removed", "changed"].forEach(function (k) {
          var c = h("span", "dchip d-" + k, null, drow);
          h("b", "", S.delta[k], c);
          h("span", "", label("status_" + k, k), c);
        });
      }
      (S.cards || []).forEach(function (card) {
        var block = h("div", "card-block", null, panelBody);
        var head = h("p", "card-title", null, block);
        h("i", "cdot dot-" + card.dot, null, head);
        h("span", "", card.title, head);
        var ul = h("ul", "", null, block);
        card.items.forEach(function (it) { h("li", "", it, ul); });
      });
      var all = section(label("entities", "Components"));
      var list = h("div", "list", null, all);
      nodes.slice().sort(function (a, b) { return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.index - b.index; }).forEach(function (n) {
        var b = h("button", "row", null, list);
        b.type = "button";
        h("i", "dot k-" + n.kind, null, b);
        h("span", "row-name", n.lines.join(" "), b);
        h("small", "", kindName(n.kind), b);
        b.addEventListener("click", function () { onNode(n.id); focusOn(n.id); });
      });
    } else if (mode === "entity") {
      var n = byId[state.sel];
      eyebrow.textContent = label("component", "Component");
      title.textContent = n.lines.join(" ");
      var chips = h("div", "chips", null, panelBody);
      chips.appendChild(chip(kindName(n.kind), n.kind));
      if (n.status) h("span", "dchip d-" + n.status, label("status_" + n.status, n.status), chips);
      if (n.tag) h("span", "tagchip", n.tag, chips);
      if (n.sublabel) h("p", "lead", n.sublabel, panelBody);
      var f = focusOf(n.id, state.reach);
      if (state.reach !== "direct") {
        var count = Object.keys(f.nodes).length - 1;
        h("p", "reach-note", fmt(label(state.reach === "up" ? "reachNoteUp" : "reachNoteDown", "{n}"), { n: count }), panelBody);
      }
      var inc = section(label("incoming", "Receives from"));
      if (!ins[n.id].length) h("p", "none", label("noRelations", "None"), inc);
      else { var l1 = h("div", "list", null, inc); ins[n.id].forEach(function (i) { relRow(l1, i, rels[i].from); }); }
      var out = section(label("outgoing", "Sends to"));
      if (!outs[n.id].length) h("p", "none", label("noRelations", "None"), out);
      else { var l2 = h("div", "list", null, out); outs[n.id].forEach(function (i) { relRow(l2, i, rels[i].to); }); }
      var srcs = section(label("sources", "Source files"));
      if (!n.sources.length) h("p", "none", label("noSources", "No source files listed"), srcs);
      else { var l3 = h("div", "list", null, srcs); n.sources.forEach(function (s) { sourceRow(l3, s); }); }
    } else if (mode === "rel") {
      var r = rels[state.selRel];
      eyebrow.textContent = label("relation", "Connection");
      title.textContent = r.label || label("untitled", "—");
      var ends = section("");
      [byId[r.from], byId[r.to]].forEach(function (end, k) {
        var b = h("button", "row end", null, ends);
        b.type = "button";
        h("small", "lead-in", label(k === 0 ? "from" : "to", k === 0 ? "From" : "To"), b);
        h("i", "dot k-" + end.kind, null, b);
        h("span", "row-name", end.lines.join(" "), b);
        b.addEventListener("click", function () { onNode(end.id); focusOn(end.id); });
        if (k === 0) h("span", "arrow-down", "↓", ends);
      });
      if (r.classification) h("span", "dchip d-class", r.classification, section(label("classification", "Classification")));
      if (r.note) h("p", "lead", r.note, section(label("note", "Note")));
    } else if (mode === "route") {
      eyebrow.textContent = label("route", "Route");
      title.textContent = route ? fmt(label("routeFound", "{n} steps"), { n: route.steps[0].length }) : label("routeNone", "No route");
      if (route) {
        if (route.reversed) h("p", "reach-note", label("routeReversed", "Following the connections the other way"), panelBody);
        route.steps.slice(0, 3).forEach(function (path, k) {
          var sec = section(route.steps.length > 1 ? fmt(label("routeOption", "Option {n}"), { n: k + 1 }) : "");
          var list = h("div", "list", null, sec);
          var first = byId[route.from];
          var b0 = h("button", "row", null, list); b0.type = "button";
          h("i", "dot k-" + first.kind, null, b0); h("span", "row-name", first.lines.join(" "), b0);
          b0.addEventListener("click", function () { focusOn(first.id); });
          path.forEach(function (st) {
            var to = byId[rels[st[1]].to];
            var b = h("button", "row", null, list); b.type = "button";
            h("i", "dot k-" + to.kind, null, b);
            h("span", "row-name", to.lines.join(" "), b);
            if (rels[st[1]].label) h("small", "", rels[st[1]].label, b);
            b.addEventListener("click", function () { focusOn(to.id); });
          });
        });
      }
    }
    panelBody.scrollTop = 0;
    scheduleFit();
  }

  // ---- legend and footer ------------------------------------------------------------------
  var legend = $("legend");
  S.legend.forEach(function (k) {
    var c = h("button", "chip k-" + k, null, legend);
    c.type = "button";
    c.setAttribute("data-kind", k);
    c.title = label("legendHint", "");
    h("i", "", null, c);
    h("span", "", kindName(k), c);
    c.addEventListener("click", function () {
      state.kind = state.kind === k ? null : k;
      refresh();
    });
  });

  // ---- camera -----------------------------------------------------------------------------
  var stage = $("stage");
  function setView(v) {
    state.view = v;
    svg.setAttribute("viewBox", [v.x, v.y, v.w, v.h].join(" "));
    var rect = svg.getBoundingClientRect();
    if (rect.width) $("zoomPct").textContent = Math.round((rect.width / v.w) * 100) + "%";
  }
  function fitView() {
    var b = S.bounds;
    var rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var pad = 12;
    var scale = Math.min((rect.width - pad * 2) / b[2], (rect.height - pad * 2) / b[3]);
    scale = Math.min(scale, 1.6);
    var w = rect.width / scale, hh = rect.height / scale;
    setView({ x: b[0] + b[2] / 2 - w / 2, y: b[1] + b[3] / 2 - hh / 2, w: w, h: hh });
  }
  var fitQueued = false;
  function scheduleFit() {
    if (!state.auto || fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(function () { fitQueued = false; if (state.auto) fitView(); });
  }
  function zoomAt(factor, cx, cy) {
    var rect = svg.getBoundingClientRect(), v = state.view;
    if (!rect.width || !rect.height) return;
    state.auto = false;
    var px = v.x + ((cx - rect.left) / rect.width) * v.w;
    var py = v.y + ((cy - rect.top) / rect.height) * v.h;
    var b = S.bounds;
    var minW = Math.min(b[2], b[3]) * 0.12, maxW = Math.max(b[2], b[3]) * 4;
    var w = Math.max(minW, Math.min(maxW, v.w / factor));
    var hh = (w * rect.height) / rect.width;
    setView({ x: px - ((px - v.x) / v.w) * w, y: py - ((py - v.y) / v.h) * hh, w: w, h: hh });
  }
  function zoomCentre(f) { var r = svg.getBoundingClientRect(); zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); }
  function tween(target) {
    var from = Object.assign({}, state.view), t0 = performance.now(), dur = 260;
    state.auto = false;
    (function step(now) {
      var k = Math.min(1, (now - t0) / dur);
      var e = 1 - Math.pow(1 - k, 3);
      setView({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e });
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }
  function focusOn(id) {
    var n = byId[id];
    if (!n) return;
    var rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    var v = state.view;
    var cx = n.box[0] + n.box[2] / 2, cy = n.box[1] + n.box[3] / 2;
    // Keep the zoom unless the box is off the screen; then bring it to the middle.
    var inside = n.box[0] > v.x && n.box[1] > v.y && n.box[0] + n.box[2] < v.x + v.w && n.box[1] + n.box[3] < v.y + v.h;
    if (inside) return;
    tween({ x: cx - v.w / 2, y: cy - v.h / 2, w: v.w, h: v.h });
  }

  svg.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    var mouse = ev.deltaMode === 1 || (Math.abs(ev.deltaY) >= 50 && ev.deltaX === 0 && Number.isInteger(ev.deltaY));
    if (ev.ctrlKey || ev.metaKey || mouse) zoomAt(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0016)), ev.clientX, ev.clientY);
    else {
      var rect = svg.getBoundingClientRect(), v = state.view;
      state.auto = false;
      setView({ x: v.x + (ev.deltaX / rect.width) * v.w, y: v.y + (ev.deltaY / rect.height) * v.h, w: v.w, h: v.h });
    }
  }, { passive: false });
  svg.addEventListener("pointerdown", function (ev) {
    if (ev.button !== 0) return;
    if (ev.target.closest && ev.target.closest(".node, .hit, .elabel")) return;
    state.drag = { x: ev.clientX, y: ev.clientY, view: Object.assign({}, state.view), moved: false };
    svg.setPointerCapture(ev.pointerId);
    svg.classList.add("panning");
  });
  svg.addEventListener("pointermove", function (ev) {
    var d = state.drag;
    if (!d) return;
    var rect = svg.getBoundingClientRect();
    var dx = ev.clientX - d.x, dy = ev.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) { d.moved = true; state.auto = false; }
    if (!d.moved) return;
    setView({ x: d.view.x - (dx / rect.width) * d.view.w, y: d.view.y - (dy / rect.height) * d.view.h, w: d.view.w, h: d.view.h });
  });
  function endDrag(ev) {
    var d = state.drag;
    if (!d) return;
    state.drag = null;
    svg.classList.remove("panning");
    try { svg.releasePointerCapture(ev.pointerId); } catch (_) {}
    if (!d.moved && ev.type === "pointerup" && !state.route.on && (state.sel || state.selRel >= 0)) release();
    else if (!d.moved && ev.type === "pointerup" && state.route.on && state.route.from) { state.route.from = null; state.route.to = null; route = null; state.panel = state.pinOverview ? "overview" : null; renderPanel(); refresh(); }
  }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  if (window.ResizeObserver) new ResizeObserver(function () { if (state.auto) fitView(); else setView(state.view); }).observe(stage);
  else window.addEventListener("resize", function () { if (state.auto) fitView(); });

  // ---- toolbar ----------------------------------------------------------------------------
  $("zoomIn").addEventListener("click", function () { zoomCentre(1.25); });
  $("zoomOut").addEventListener("click", function () { zoomCentre(0.8); });
  $("fit").addEventListener("click", function () { state.auto = true; fitView(); });
  $("closePanel").addEventListener("click", closePanel);
  $("panelBtn").addEventListener("click", function () {
    if (state.panel === "overview") { state.pinOverview = false; state.panel = state.sel ? "entity" : null; }
    else { state.pinOverview = true; if (!state.sel && state.selRel < 0) state.panel = "overview"; else { state.sel = null; state.selRel = -1; state.panel = "overview"; } }
    renderPanel(); refresh();
  });
  $("routeBtn").addEventListener("click", function () { setRoute(!state.route.on); });
  Array.prototype.forEach.call(document.querySelectorAll("#reach button"), function (b) {
    b.addEventListener("click", function () { setReach(b.getAttribute("data-reach")); });
  });
  $("motionBtn").addEventListener("click", function () { state.motion = !state.motion; refresh(); });
  $("themeBtn").addEventListener("click", function () {
    app.setAttribute("data-theme", app.getAttribute("data-theme") === "light" ? "dark" : "light");
  });
  presetSel.addEventListener("change", function () {
    app.setAttribute("data-preset", presetSel.value);
    if (presetSel.value !== "classic") clearHost();
    else if (data.host) applyHost(data.host);
  });
  var search = $("search");
  search.addEventListener("input", function () { state.query = search.value; refresh(); });
  search.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      var q = state.query.trim().toLowerCase();
      var first = q && nodes.filter(function (n) { return matches(n, q); })[0];
      if (first) { onNode(first.id); focusOn(first.id); }
    }
  });
  $("presentBtn").addEventListener("click", function () { setPresent(!state.present); });
  $("exitPresent").addEventListener("click", function () { setPresent(false); });
  function setPresent(on) {
    state.present = on;
    app.classList.toggle("present", on);
    if (on) { state.auto = true; }
    refresh(); scheduleFit();
  }
  var order = nodes.slice().sort(function (a, b) {
    return S.direction === "TB" ? a.box[1] - b.box[1] || a.box[0] - b.box[0] : a.box[0] - b.box[0] || a.box[1] - b.box[1];
  });
  function step(delta) {
    var at = order.findIndex(function (n) { return n.id === state.sel; });
    var next = order[(at + delta + order.length) % order.length];
    onNode(next.id); focusOn(next.id);
  }

  // ---- keyboard ---------------------------------------------------------------------------
  window.addEventListener("keydown", function (ev) {
    var typing = ev.target === search;
    if (ev.key === "Escape") {
      if (typing && search.value) { search.value = ""; state.query = ""; refresh(); }
      else if (state.present) setPresent(false);
      else if (state.route.on) setRoute(false);
      else if (state.sel || state.selRel >= 0) release();
      else if (state.kind) { state.kind = null; refresh(); }
      return;
    }
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var k = ev.key;
    if (k === "/") { ev.preventDefault(); search.focus(); }
    else if (k === "f" || k === "0") { state.auto = true; fitView(); }
    else if (k === "+" || k === "=") zoomCentre(1.25);
    else if (k === "-") zoomCentre(0.8);
    else if (k === "r") setRoute(!state.route.on);
    else if (k === "p") setPresent(!state.present);
    else if (k === "t" && !data.embed) $("themeBtn").click();
    else if (k === "ArrowRight" || k === "ArrowDown") { if (state.present || state.sel) { ev.preventDefault(); step(1); } }
    else if (k === "ArrowLeft" || k === "ArrowUp") { if (state.present || state.sel) { ev.preventDefault(); step(-1); } }
  });

  // ---- links ------------------------------------------------------------------------------
  function hash() {
    if (data.embed) return;
    try {
      var parts = [];
      if (state.sel) { parts.push("focus=" + encodeURIComponent(state.sel)); if (state.reach !== "direct") parts.push("reach=" + (state.reach === "up" ? "upstream" : "downstream")); }
      history.replaceState(null, "", location.pathname + location.search + (parts.length ? "#" + parts.join("&") : ""));
    } catch (_) {}
  }
  function readHash() {
    try {
      var m = /focus=([^&]+)/.exec(location.hash), r = /reach=(upstream|downstream)/.exec(location.hash);
      if (m && byId[decodeURIComponent(m[1])]) {
        if (r) state.reach = r[1] === "upstream" ? "up" : "down";
        onNode(decodeURIComponent(m[1]));
      }
    } catch (_) {}
  }

  // ---- export -----------------------------------------------------------------------------
  var PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "letter-spacing", "text-anchor", "paint-order"];
  function serialize() {
    app.classList.add("exporting");
    var b = S.bounds;
    var clone = svg.cloneNode(true);
    var src = svg.querySelectorAll("*"), dst = clone.querySelectorAll("*");
    for (var i = 0; i < src.length; i++) {
      var cs = getComputedStyle(src[i]);
      for (var p = 0; p < PROPS.length; p++) {
        var v = cs.getPropertyValue(PROPS[p]);
        if (v) dst[i].style.setProperty(PROPS[p], v);
      }
      if (src[i].classList && (src[i].classList.contains("hit") || src[i].classList.contains("dim"))) dst[i].style.display = src[i].classList.contains("hit") ? "none" : "";
    }
    var bg = getComputedStyle(stage).backgroundColor;
    app.classList.remove("exporting");
    clone.removeAttribute("class");
    clone.setAttribute("xmlns", NS);
    clone.setAttribute("viewBox", b.join(" "));
    clone.setAttribute("width", b[2]);
    clone.setAttribute("height", b[3]);
    clone.removeAttribute("style");
    var rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", b[0]); rect.setAttribute("y", b[1]); rect.setAttribute("width", b[2]); rect.setAttribute("height", b[3]);
    rect.setAttribute("fill", bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#ffffff");
    clone.insertBefore(rect, clone.firstChild);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  }
  function toPng(done) {
    var b = S.bounds, text = serialize();
    var scale = Math.min(2, 7600 / Math.max(b[2], b[3]));
    var img = new Image();
    img.onload = function () {
      var c = document.createElement("canvas");
      c.width = Math.round(b[2] * scale); c.height = Math.round(b[3] * scale);
      var ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(function (blob) { done(blob); }, "image/png");
    };
    img.onerror = function () { done(null); };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
  }
  function download(blob, name) {
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  var base = (S.title || "archify").replace(/[^\w\-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "archify";
  var menu = $("exportMenu");
  [["svg", "SVG"], ["png", "PNG"]].forEach(function (f) {
    var b = h("button", "", f[1], menu);
    b.type = "button";
    b.addEventListener("click", function () {
      menu.hidden = true;
      if (f[0] === "svg") download(new Blob([serialize()], { type: "image/svg+xml" }), base + ".svg");
      else toPng(function (blob) { if (blob) download(blob, base + ".png"); });
    });
  });
  $("exportBtn").addEventListener("click", function (ev) { ev.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener("click", function () { menu.hidden = true; });
  // Framed in the app, the browser's own menu on the frame ("Open frame in new window", "Inspect") is
  // not the app's: the diagram has its own controls. In the exported file it is an ordinary page.
  if (data.embed) document.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });

  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (ev.source !== window.parent || !m || typeof m !== "object") return;
    if (m.type === "archify:theme" && m.host) {
      data.host = m.host;
      if ((presetSel.value || "classic") === "classic") applyHost(m.host);
      else app.setAttribute("data-theme", m.host.scheme === "light" ? "light" : "dark");
    } else if (m.type === "archify:export") {
      if (m.format === "svg") window.parent.postMessage({ type: "archify:exported", id: m.id, format: "svg", svg: serialize() }, "*");
      else toPng(function (blob) {
        if (!blob) { window.parent.postMessage({ type: "archify:exported", id: m.id, format: "png", error: true }, "*"); return; }
        blob.arrayBuffer().then(function (buf) { window.parent.postMessage({ type: "archify:exported", id: m.id, format: "png", png: buf }, "*", [buf]); });
      });
    }
  });

  // ---- start ------------------------------------------------------------------------------
  var wide = window.innerWidth >= 1500;
  if (wide && (S.subtitle || (S.cards && S.cards.length) || S.delta)) { state.pinOverview = true; state.panel = "overview"; }
  renderPanel();
  refresh();
  fitView();
  requestAnimationFrame(fitView);
  readHash();
})();
