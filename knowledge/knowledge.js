/* Knowledge page: graph, list, search, detail panel and the "to sort" inbox, in a shadow root.
   It only draws and reports what the person did; the host (index.html) reads files, saves and searches. */
(function () {
  var K = window.PPKnowledgeCore, P = window.PPKnowledge = {};
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var fmtD = function (s) { var d = new Date(s); return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };
  var SRC = { upload: "uploaded", claude: "saved by Claude", me: "added by you", journal: "from your notes", onedrive: "OneDrive" };
  function shape(kind, x, y, s) {
    s = s || 1; var c = 'class="node"';
    if (kind === "doc") return "<rect " + c + ' x="' + (x - 6 * s) + '" y="' + (y - 8 * s) + '" width="' + 12 * s + '" height="' + 16 * s + '" rx="2"/>';
    if (kind === "book") return "<rect " + c + ' x="' + (x - 8 * s) + '" y="' + (y - 7 * s) + '" width="' + 16 * s + '" height="' + 14 * s + '" rx="2"/><line x1="' + (x - 3 * s) + '" y1="' + (y - 7 * s) + '" x2="' + (x - 3 * s) + '" y2="' + (y + 7 * s) + '" stroke="var(--c)" stroke-width="1.2"/>';
    if (kind === "link") return "<circle " + c + ' cx="' + x + '" cy="' + y + '" r="' + 7 * s + '"/>';
    if (kind === "idea") return "<rect " + c + ' x="' + (x - 6.5 * s) + '" y="' + (y - 6.5 * s) + '" width="' + 13 * s + '" height="' + 13 * s + '" transform="rotate(45 ' + x + " " + y + ')"/>';
    if (kind === "person") return "<circle " + c + ' cx="' + x + '" cy="' + y + '" r="' + 8 * s + '"/><circle cx="' + x + '" cy="' + y + '" r="' + 3 * s + '" fill="var(--c)"/>';
    return "<polygon " + c + ' points="' + [0, 1, 2, 3, 4, 5].map(function (i) { var a = Math.PI / 3 * i - Math.PI / 2; return (x + Math.cos(a) * 8 * s).toFixed(1) + "," + (y + Math.sin(a) * 8 * s).toFixed(1); }).join(" ") + '"/>';
  }
  // colour = the item's life area; files from OneDrive have a blue icon
  var aVar = function (a) { return a === "sol" ? "var(--a-sol-line)" : "var(--a-" + a + ")"; };
  var iconOf = function (i) { var a = K.areaOf(i); return '<svg class="ic" viewBox="-10 -10 20 20" style="--c:' + (i.onedrive ? "var(--od)" : aVar(a)) + '" aria-hidden="true">' + shape(K.shapeOf(i.zone), 0, 0) + "</svg>"; };
  var areaTag = function (i) { var a = K.areaOf(i); return '<small class="atag" style="--c:' + aVar(a) + '"><i></i>' + esc(K.areaName(a)) + "</small>"; };
  var icon = function (zone) { return '<svg class="ic" viewBox="-10 -10 20 20" style="--c:var(--' + zone + ')" aria-hidden="true">' + shape(K.shapeOf(zone), 0, 0) + "</svg>"; };
  var mark = function (s) { return esc(s).replace(/«/g, "<mark>").replace(/»/g, "</mark>"); };

  P.mount = function (host, o) {
    o = o || {};
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    var S = { items: [], edges: [], view: null, q: "", results: null, searching: false, sel: null, edit: false, f: { zone: "", area: "", type: "", topic: "", source: "", from: "", to: "" }, picked: {}, preview: null, sort: { key: "createdAt", dir: -1 }, cam: { x: 0, y: 0, k: 1 }, group: "zone", linking: false, sheet: null, progress: "", sample: !!o.sample, settings: {}, usage: null, meaning: null };
    var theme = o.theme || "light", links = [], byId = {}, W = 1000, H = 640, narrow = false, still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches, raf = 0, searchT = 0, searchN = 0;
    var call = function (name) { var a = [].slice.call(arguments, 1); return Promise.resolve(o[name] ? o[name].apply(null, a) : null); };
    root.innerHTML = '<link rel="stylesheet" href="' + (o.css || "knowledge/knowledge.css") + '"><div class="kn"></div>';
    var kn = root.querySelector(".kn"), $ = function (q) { return root.querySelector(q); };

    function setData(d) {
      ["items", "edges", "settings", "usage", "meaning", "spider", "onedrive"].forEach(function (k) { if (d[k] !== undefined) S[k] = d[k]; });
      S.items.forEach(function (i) { if (!i.topic) i.topic = K.topicOf(i); });
      byId = {}; S.items.forEach(function (i) { byId[i.id] = i; });
      if (S.sel && (!byId[S.sel] || byId[S.sel].archived)) S.sel = null;
      relayout();
    }
    function relayout() {
      narrow = host.getBoundingClientRect().width < 900;
      links = K.edges(S.items, S.edges); buildSim();
      if (!S.cam.set) { S.cam = home(); S.cam.set = 1; } else S.cam = clampCam(S.cam);
      if (S.view == null) S.view = narrow ? "list" : "graph";
    }
    var live = function () { return S.items.filter(function (i) { return !i.archived; }); };
    var linked = function (id) { var out = []; links.forEach(function (e) { if (e.from === id) out.push([e.to, e.kind]); else if (e.to === id) out.push([e.from, e.kind]); }); return out; };
    var degree = function (id) { return linked(id).length; };
    var hitIds = function () { return S.results ? S.results.map(function (r) { return r.id; }).filter(function (id, i, a) { return a.indexOf(id) === i; }) : []; };

    /* ----- graph: a live layout. Items float, are pulled to their group and sub-group, push each other
       apart, and linked items are drawn together. Change "Group by" and they fly to new clusters. ----- */
    var GROUPS = [["zone", "Zone"], ["area", "Area"], ["type", "Type"], ["topic", "Topic"], ["folder", "Folder"]], SIM = null, DOM = null, loop = 0, BX = 0, BY = 0;
    var hash = function (x) { var h = 2166136261; x = String(x); for (var i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
    var srcs = function () { return (S.onedrive && S.onedrive.sources) || []; };
    var keyOf = function (i, g) { return g === "zone" ? i.zone : g === "area" ? K.areaOf(i) : g === "type" ? K.typeName(i.zone, i.type) : g === "topic" ? (i.topic || "General") : g === "subfolder" ? K.folderLevels(i, srcs())[1] : K.folderLevels(i, srcs())[0]; };
    function buildSim() {
      var items = live(), g = S.group, sub = g === "topic" ? "type" : g === "folder" ? "subfolder" : "topic", old = SIM ? SIM.byId : {}, map = {}, order = [];
      items.forEach(function (i) { var k = keyOf(i, g), c = map[k]; if (!c) { c = map[k] = { key: k, label: g === "zone" ? K.zoneName(k) : g === "area" ? K.areaName(k) : k, color: g === "area" ? aVar(k) : "var(--muted)", n: 0, subs: {}, subOrder: [] }; order.push(k); } c.n++; var sk = keyOf(i, sub); if (!c.subs[sk]) { c.subs[sk] = { key: sk, n: 0 }; c.subOrder.push(sk); } c.subs[sk].n++; });
      if (g === "zone") order = K.ZONES.map(function (z) { return z[0]; }).filter(function (k) { return map[k]; }); else if (g === "area") order = K.AREAS.map(function (z) { return z[0]; }).filter(function (k) { return map[k]; }); else order.sort(function (a, b) { return map[b].n - map[a].n || (a < b ? -1 : 1); });
      if (g === "folder") order.forEach(function (k) { var c = map[k]; c.od = items.some(function (i) { return i.onedrive && keyOf(i, g) === k; }); if (c.od && c.subOrder.length === 1 && c.subOrder[0] !== "in this folder") c.label = k + " / " + c.subOrder[0]; });
      var cl = order.map(function (k) { return map[k]; }), aspect = narrow ? 380 / 620 : 1000 / 640;
      cl.forEach(function (c, i) { c.R = 34 + 17 * Math.sqrt(c.n); var a = i * 2.39996, d = 60 * Math.sqrt(i + 0.3) * 3; c.x = Math.cos(a) * d * (narrow ? 0.7 : 1.3); c.y = Math.sin(a) * d * (narrow ? 1.3 : 0.7); });
      for (var it = 0; it < 400; it++) {                                  // settle the group centres: no overlap, pulled together
        for (var a2 = 0; a2 < cl.length; a2++) for (var b2 = a2 + 1; b2 < cl.length; b2++) { var A = cl[a2], B = cl[b2], dx = B.x - A.x, dy = B.y - A.y, d2 = Math.sqrt(dx * dx + dy * dy) || 0.01, min = A.R + B.R + 26; if (d2 < min) { var p = (min - d2) / 2; A.x -= dx / d2 * p; A.y -= dy / d2 * p; B.x += dx / d2 * p; B.y += dy / d2 * p; } }
        cl.forEach(function (c) { c.x -= c.x * 0.02 * (narrow ? 1.6 : 0.7); c.y -= c.y * 0.02 * (narrow ? 0.7 : 1.6); });
      }
      var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; cl.forEach(function (c) { x0 = Math.min(x0, c.x - c.R); x1 = Math.max(x1, c.x + c.R); y0 = Math.min(y0, c.y - c.R); y1 = Math.max(y1, c.y + c.R); });
      if (!cl.length) { x0 = y0 = -200; x1 = y1 = 200; }
      var bw = x1 - x0 + 90, bh = y1 - y0 + 110; if (bw / bh < aspect) bw = bh * aspect; else bh = bw / aspect; bw = Math.max(bw, narrow ? 380 : 760); bh = bw / aspect;
      BX = (x0 + x1) / 2 - bw / 2; BY = (y0 + y1) / 2 - bh / 2; W = bw; H = bh;
      cl.forEach(function (c) { var m = c.subOrder.length; c.subOrder.sort(); c.subOrder.forEach(function (sk, j) { var su = c.subs[sk], ang = m === 1 ? 0 : j / m * Math.PI * 2 + hash(c.key) * 3, d = m === 1 ? 0 : c.R * 0.46; su.x = c.x + Math.cos(ang) * d; su.y = c.y + Math.sin(ang) * d; }); c.hx = c.x; c.hy = c.y; c.hr = c.R; });
      var recent = items.slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }).slice(0, 6).map(function (i) { return i.id; }), byId2 = {};
      var nodes = items.map(function (i) {
        var c = map[keyOf(i, g)], su = c.subs[keyOf(i, sub)], o = old[i.id], h1 = hash(i.id), h2 = hash(i.id + "y");
        var nd = { id: i.id, it: i, c: c, sub: su, x: o ? o.x : su.x + (h1 - 0.5) * 60, y: o ? o.y : su.y + (h2 - 0.5) * 60, vx: 0, vy: 0, fx: null, fy: null, ph: h1, r: 11, imp: degree(i.id) >= 1 || recent.indexOf(i.id) >= 0, sc: 0.86 + Math.min(degree(i.id), 3) * 0.08 };
        byId2[i.id] = nd; return nd;
      });
      SIM = { nodes: nodes, byId: byId2, clusters: cl, links: links.map(function (e) { return { a: byId2[e.from], b: byId2[e.to], kind: e.kind }; }).filter(function (l) { return l.a && l.b; }), alpha: 1, sub: sub };
      if (still) for (var q = 0; q < 320; q++) tick();
    }
    function tick() {
      var N = SIM.nodes, a = SIM.alpha;
      N.forEach(function (n) { if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; return; } n.vx += (n.sub.x - n.x) * 0.045 * a + (n.c.x - n.x) * 0.012 * a; n.vy += (n.sub.y - n.y) * 0.045 * a + (n.c.y - n.y) * 0.012 * a; });
      SIM.links.forEach(function (l) { var dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01; if (d < 70) return; var f = (d - 70) * 0.0035 * a; if (l.a.fx == null) { l.a.vx += dx / d * f; l.a.vy += dy / d * f; } if (l.b.fx == null) { l.b.vx -= dx / d * f; l.b.vy -= dy / d * f; } });
      N.forEach(function (n) { if (n.fx != null) return; n.vx *= 0.8; n.vy *= 0.8; n.x += n.vx; n.y += n.vy; });
      for (var i = 0; i < N.length; i++) for (var j = i + 1; j < N.length; j++) {
        var A = N[i], B = N[j], dx = B.x - A.x, dy = B.y - A.y, d2 = dx * dx + dy * dy, min = 31; if (d2 >= min * min) continue;
        var d = Math.sqrt(d2) || 0.01, p = (min - d) / 2, ux = d > 0.02 ? dx / d : Math.cos(i + j), uy = d > 0.02 ? dy / d : Math.sin(i + j);
        if (A.fx == null) { A.x -= ux * p; A.y -= uy * p; } if (B.fx == null) { B.x += ux * p; B.y += uy * p; }
      }
      SIM.clusters.forEach(function (c) { var sx = 0, sy = 0, m = 0; N.forEach(function (n) { if (n.c === c) { sx += n.x; sy += n.y; m++; } }); if (!m) return; sx /= m; sy /= m; var r = 0; N.forEach(function (n) { if (n.c === c) r = Math.max(r, Math.hypot(n.x - sx, n.y - sy)); }); c.hx += (sx - c.hx) * 0.2; c.hy += (sy - c.hy) * 0.2; c.hr += (r + 30 - c.hr) * 0.2; });
      SIM.alpha = Math.max(0, a * 0.985);
    }
    var level = function (k) { return k < 1.3 ? 0 : k < 2.2 ? 2 : 3; };
    /* The spider is Claude sorting the knowledge through the connector. The host passes in its recent
       steps (read, cluster, link, note); the spider walks to the item it is on and spins a thread for each link. */
    var SPIDER_LIVE = 4 * 60 * 1000;
    var spiderEvents = function () { return (S.spider && S.spider.events) || []; };
    var spiderActive = function () { var ev = spiderEvents()[0]; return !!ev && Date.now() - new Date(ev.at).getTime() < SPIDER_LIVE; };
    function spiderSvg() {
      var legs = ""; for (var i = 0; i < 8; i++) { var side = i < 4 ? -1 : 1, j = i % 4, ang = (-50 + j * 33) * Math.PI / 180, x1 = Math.cos(ang) * 6 * side, y1 = Math.sin(ang) * 6, x2 = Math.cos(ang) * 15 * side, y2 = Math.sin(ang) * 15 - 5, x3 = Math.cos(ang) * 22 * side, y3 = Math.sin(ang) * 22 + 4; legs += '<path class="leg l' + (i % 2) + '" d="M' + x1.toFixed(1) + "," + y1.toFixed(1) + " Q" + x2.toFixed(1) + "," + y2.toFixed(1) + " " + x3.toFixed(1) + "," + y3.toFixed(1) + '"/>'; }
      return '<g id="knSilk"></g><g id="knSpider" class="spider" aria-hidden="true" style="display:none"><g class="sbody">' + legs + '<ellipse class="abd" cx="0" cy="7" rx="7.5" ry="9"/><circle class="hd" cx="0" cy="-5" r="5"/><circle class="eye" cx="-2" cy="-6.5" r="1.1"/><circle class="eye" cx="2" cy="-6.5" r="1.1"/></g></g>';
    }
    function spiderBar() {
      var ev = spiderEvents(), on = spiderActive(); if (!ev.length) return "";
      var e = ev[0], it = e.item ? byId[e.item] : null, what = e.action === "read" ? "Reading " + (it ? "“" + it.title + "”" : "a document") : e.action === "cluster" ? "Grouped " + (it ? "“" + it.title + "”" : "an item") + (e.note ? " under " + e.note.split(" — ")[0] : "") : e.action === "link" ? "Linked two items" + (e.note ? ": " + e.note : "") : e.note || "Sorting";
      var ago = Math.round((Date.now() - new Date(e.at).getTime()) / 60000);
      return '<div class="spbar' + (on ? " live" : "") + '" role="status" aria-live="polite"><span class="spdot"></span><span><b>' + (on ? "The spider is at work" : "The spider last worked " + (ago < 60 ? ago + " min ago" : ago < 1440 ? Math.round(ago / 60) + " h ago" : Math.round(ago / 1440) + " d ago")) + "</b> · " + esc(what) + '</span><button class="btn sm" data-act="spider">About the spider</button></div>';
    }
    var spos = null;
    function spiderFrame(t) {
      var g = DOM && DOM.svg.querySelector("#knSpider"), silk = DOM && DOM.svg.querySelector("#knSilk"); if (!g) return;
      var on = spiderActive(); g.style.display = on ? "" : "none"; if (!on) { if (silk && silk.innerHTML) silk.innerHTML = ""; return; }
      var target = null; spiderEvents().some(function (e) { var n = e.item && SIM.byId[e.item]; if (n) { target = n; return true; } return false; });
      var tx = target ? target.dx + 16 : BX + W / 2, ty = target ? target.dy - 14 : BY + 30;
      if (!spos || still) spos = { x: tx, y: ty }; else { spos.x += (tx - spos.x) * 0.06; spos.y += (ty - spos.y) * 0.06; }
      var moving = Math.hypot(tx - spos.x, ty - spos.y) > 2, z = 1 / Math.sqrt(S.cam.k), ang = moving ? Math.atan2(ty - spos.y, tx - spos.x) * 180 / Math.PI + 90 : Math.sin(t * 0.002) * 8;
      g.setAttribute("transform", "translate(" + spos.x.toFixed(1) + "," + spos.y.toFixed(1) + ") rotate(" + ang.toFixed(1) + ") scale(" + (0.9 * z).toFixed(3) + ")");
      g.classList.toggle("walk", moving && !still);
      if (silk) {
        var since = Date.now() - 10 * 60 * 1000, lines = "";
        spiderEvents().forEach(function (e) { if (e.action !== "link" || new Date(e.at).getTime() < since) return; var a = SIM.byId[e.item], b = SIM.byId[e.other]; if (a && b) lines += '<line class="silk" x1="' + a.dx.toFixed(1) + '" y1="' + a.dy.toFixed(1) + '" x2="' + b.dx.toFixed(1) + '" y2="' + b.dy.toFixed(1) + '"/>'; });
        if (target) lines += '<line class="thread" x1="' + spos.x.toFixed(1) + '" y1="' + (spos.y - 8).toFixed(1) + '" x2="' + spos.x.toFixed(1) + '" y2="' + (BY - 40).toFixed(1) + '"/>';
        silk.innerHTML = lines;
      }
    }
    function graphHtml() {
      var types = [["doc", "Document"], ["book", "Book or paper"], ["link", "Link or media"], ["idea", "Idea"], ["person", "Author"], ["note", "My note"]], sv = "";
      SIM.clusters.forEach(function (c, i) { sv += '<g class="hull" data-c="' + i + '"><circle fill="' + c.color + '" fill-opacity="var(--zfill)" stroke="' + c.color + '" stroke-opacity=".3"/><text class="zl" text-anchor="middle" style="fill:' + c.color + '">' + esc(c.label) + '</text><text class="tl cn" text-anchor="middle">' + c.n + (c.n === 1 ? " item" : " items") + "</text></g>"; });
      SIM.clusters.forEach(function (c, i) { if (c.subOrder.length > 1) c.subOrder.forEach(function (sk, j) { sv += '<text class="tl sl' + (c.od ? " sf" : "") + '" data-c="' + i + '" data-s="' + j + '" text-anchor="middle">' + esc(sk) + "</text>"; }); });
      sv += '<g id="knEdges">' + SIM.links.map(function (l, i) { return '<line class="edge x" data-l="' + i + '"/>'; }).join("") + '</g><g id="knNodes">';
      SIM.nodes.forEach(function (n) {
        var i = n.it, title = i.title.length > 34 ? i.title.slice(0, 33) + "…" : i.title;
        sv += '<g class="n' + (n.imp ? " imp" : "") + '" data-id="' + esc(i.id) + '" tabindex="0" role="button" aria-label="' + esc(i.title + ", " + K.typeName(i.zone, i.type) + ", " + K.zoneName(i.zone) + ", " + K.areaName(K.areaOf(i)) + (i.onedrive ? ", from OneDrive" : "") + ", in " + n.c.label) + '" style="--c:' + (i.onedrive ? "var(--od)" : aVar(K.areaOf(i))) + ";--f:var(--a-" + K.areaOf(i) + '-soft)"><circle class="halo" r="22"/><circle r="14" fill="transparent"/>' + shape(K.shapeOf(i.zone), 0, 0, 1) + (i.onedrive ? '<g class="odb" transform="translate(9,-9)"><title>' + esc(odState(i)) + '</title><circle r="4.6"/>' + (i.onedrive.privacy === "private" ? '<path d="M-1.8 -0.4h3.6v2.6h-3.6z M-1.1 -0.4v-1a1.1 1.1 0 0 1 2.2 0v1" />' : i.onedrive.indexStatus === "indexed" ? '<path d="M-2 0l1.4 1.4 2.6-2.8"/>' : '<path d="M-2 0h4"/>') + "</g>" : "") + '<text class="nl lbl" text-anchor="middle" y="24">' + esc(title) + "</text></g>";
      });
      return '<div class="graph"><svg id="knSvg" data-g="' + S.group + '" viewBox="' + vb() + '" data-lvl="' + level(S.cam.k) + '" role="group" aria-label="Knowledge graph: items float in groups by ' + S.group + '. Use Tab to move between items and Enter to open one; drag an item to move it. The List view shows the same items as a table.">' + sv + "</g>" + spiderSvg() + "</svg>" +
        '<div class="gby"><span>Group by</span><div class="seg" role="group" aria-label="Group items by">' + GROUPS.map(function (x) { return '<button data-group="' + x[0] + '" aria-pressed="' + (S.group === x[0]) + '">' + x[1] + "</button>"; }).join("") + "</div></div>" +
        '<div class="legend wide">' + types.map(function (t) { return '<span><svg viewBox="-10 -10 20 20" class="ic" style="--c:var(--muted)">' + shape(t[0], 0, 0) + "</svg>" + t[1] + "</span>"; }).join("") + '<span class="lbreak"></span>' + K.AREAS.filter(function (a) { return live().some(function (i) { return K.areaOf(i) === a[0]; }); }).map(function (a) { return '<span class="la" style="--c:' + aVar(a[0]) + '"><i></i>' + esc(a[1]) + "</span>"; }).join("") + (live().some(function (i) { return i.onedrive; }) ? '<span><svg viewBox="-10 -10 20 20" class="ic" style="--c:var(--od)">' + shape("doc", 0, 0) + "</svg>From OneDrive</span>" : "") + '</div><div class="zoom"><span class="zl" id="knZl" aria-live="polite">' + Math.round(S.cam.k * 100) + ' %</span><button data-zoom="-1" aria-label="Zoom out">−</button><button data-zoom="0" aria-label="Show everything">⤢</button><button data-zoom="1" aria-label="Zoom in">+</button></div></div>';
    }
    function mountGraph() {
      var svg = $("#knSvg"); if (!svg) { DOM = null; return; }
      DOM = { svg: svg, nodes: {}, lines: [].slice.call(svg.querySelectorAll("#knEdges line")), hulls: [].slice.call(svg.querySelectorAll(".hull")), subs: [].slice.call(svg.querySelectorAll(".sl")) };
      [].forEach.call(svg.querySelectorAll(".n"), function (el) { DOM.nodes[el.getAttribute("data-id")] = el; });
      paintClasses(); frame(0, true);
      if (!loop && !still) loop = requestAnimationFrame(run);
    }
    function paintClasses() {
      if (!DOM) return;
      var hits = hitIds(), focus = S.sel && SIM.byId[S.sel] ? S.sel : null, near = {}, quiet = focus || hits.length;
      if (focus) { near[focus] = 1; linked(focus).forEach(function (x) { near[x[0]] = 1; }); }
      SIM.nodes.forEach(function (n) { var el = DOM.nodes[n.id]; if (!el) return; var on = n.id === focus, hit = hits.indexOf(n.id) >= 0, lit = focus ? !!near[n.id] : hits.length ? hit : true; el.setAttribute("class", "n" + (n.imp ? " imp" : "") + (on ? " on" : "") + (hit ? " hit" : "") + (focus && lit && !on ? " near" : "") + (lit ? "" : " dim")); n.big = on ? 1.5 : hit ? 1.25 : n.sc; });
      SIM.links.forEach(function (l, i) { var hot = focus && (l.a.id === focus || l.b.id === focus); DOM.lines[i].setAttribute("class", "edge x" + (hot ? " hot" : quiet ? " off" : "")); });
      DOM.svg.classList.toggle("quiet", !!quiet);
    }
    function frame(t, force) {
      if (!DOM) return;
      var k = S.cam.k, z = 1 / Math.sqrt(k), wob = still ? 0 : 2.4;
      SIM.nodes.forEach(function (n) { var el = DOM.nodes[n.id]; if (!el) return; var dx = n.fx != null ? 0 : Math.sin(t * 0.0007 * (0.6 + n.ph) + n.ph * 6.28) * wob, dy = n.fx != null ? 0 : Math.cos(t * 0.0006 * (0.7 + n.ph) + n.ph * 9.1) * wob; n.dx = n.x + dx; n.dy = n.y + dy; el.setAttribute("transform", "translate(" + n.dx.toFixed(1) + "," + n.dy.toFixed(1) + ") scale(" + ((n.big || n.sc) * z).toFixed(3) + ")"); });
      spiderFrame(t);
      SIM.links.forEach(function (l, i) { var e = DOM.lines[i]; e.setAttribute("x1", l.a.dx.toFixed(1)); e.setAttribute("y1", l.a.dy.toFixed(1)); e.setAttribute("x2", l.b.dx.toFixed(1)); e.setAttribute("y2", l.b.dy.toFixed(1)); });
      if (force || SIM.alpha > 0.02 || SIM.dragging) {
        DOM.hulls.forEach(function (h) { var c = SIM.clusters[+h.getAttribute("data-c")], ci = h.firstChild, a = ci.nextSibling, b = a.nextSibling; ci.setAttribute("cx", c.hx.toFixed(1)); ci.setAttribute("cy", c.hy.toFixed(1)); ci.setAttribute("r", Math.max(24, c.hr).toFixed(1)); a.setAttribute("x", c.hx.toFixed(1)); a.setAttribute("y", (c.hy - Math.max(24, c.hr) - 7 * z).toFixed(1)); a.style.fontSize = (9.5 * z).toFixed(1) + "px"; b.setAttribute("x", c.hx.toFixed(1)); b.setAttribute("y", (c.hy - Math.max(24, c.hr) + 12 * z).toFixed(1)); b.style.fontSize = (9 * z).toFixed(1) + "px"; });
        DOM.subs.forEach(function (e) { var c = SIM.clusters[+e.getAttribute("data-c")], su = c.subs[c.subOrder[+e.getAttribute("data-s")]]; e.setAttribute("x", (su.x + c.hx - c.x).toFixed(1)); e.setAttribute("y", (su.y + c.hy - c.y - 20).toFixed(1)); e.style.fontSize = (10.5 * z).toFixed(1) + "px"; });
      }
    }
    function run(ts) {
      loop = 0;
      if (!DOM || !DOM.svg.isConnected) { DOM = null; return; }
      if (host.offsetParent !== null && !document.hidden) { if (SIM.alpha > 0.02 || SIM.dragging) tick(); frame(ts); }
      loop = requestAnimationFrame(run);
    }
    var heat = function (v) { if (SIM) SIM.alpha = Math.max(SIM.alpha, v); if (still && SIM) { for (var q = 0; q < 200; q++) tick(); frame(0, true); } };
    var vb = function () { var c = S.cam; return (c.x - W / (2 * c.k)).toFixed(1) + " " + (c.y - H / (2 * c.k)).toFixed(1) + " " + (W / c.k).toFixed(1) + " " + (H / c.k).toFixed(1); };
    var home = function () { return { x: BX + W / 2, y: BY + H / 2, k: 1 }; };
    function clampCam(c) { c.k = Math.max(ZMIN, Math.min(ZMAX, c.k)); var hw = W / (2 * c.k), hh = H / (2 * c.k); c.x = hw * 2 >= W ? BX + W / 2 : Math.max(BX + hw, Math.min(BX + W - hw, c.x)); c.y = hh * 2 >= H ? BY + H / 2 : Math.max(BY + hh, Math.min(BY + H - hh, c.y)); return c; }
    var ZMIN = 0.4, ZMAX = 8;
    function zoomBy(f) { setCam({ x: S.cam.x, y: S.cam.y, k: S.cam.k * f }); var zl = $("#knZl"); if (zl) zl.textContent = Math.round(S.cam.k * 100) + " %"; }
    function setCam(c) { S.cam = clampCam(c); var svg = $("#knSvg"); if (!svg) return; svg.setAttribute("viewBox", vb()); svg.setAttribute("data-lvl", level(S.cam.k)); frame(performance.now(), true); }
    function flyTo(c) {
      cancelAnimationFrame(raf); c = clampCam(c);
      if (still) { setCam(c); return; }
      var a = { x: S.cam.x, y: S.cam.y, k: S.cam.k }, t0 = null;
      var step = function (ts) { if (t0 == null) t0 = ts; var t = Math.min(1, (ts - t0) / 380), e = 1 - Math.pow(1 - t, 3); setCam({ x: a.x + (c.x - a.x) * e, y: a.y + (c.y - a.y) * e, k: a.k + (c.k - a.k) * e }); if (t < 1) raf = requestAnimationFrame(step); };
      raf = requestAnimationFrame(step);
    }
    function flyToIds(ids) {
      var pts = ids.map(function (id) { var n = SIM.byId[id]; return n ? [n.x, n.y] : null; }).filter(Boolean); if (!pts.length) return;
      var x0 = Math.min.apply(0, pts.map(function (p) { return p[0]; })), x1 = Math.max.apply(0, pts.map(function (p) { return p[0]; })), y0 = Math.min.apply(0, pts.map(function (p) { return p[1]; })), y1 = Math.max.apply(0, pts.map(function (p) { return p[1]; }));
      flyTo({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, k: Math.max(1, Math.min(2.8, 0.7 * Math.min(W / (x1 - x0 + 180), H / (y1 - y0 + 180)))) });
    }

    /* ----- panels ----- */
    function detail(i) {
      var m = i.meta || {}, lk = linked(i.id), dup = i.mirror ? null : K.duplicateOf(S.items, i), kv = [], ro = !!i.mirror;
      if (m.author) kv.push(["Author", m.author]); if (m.starts) kv.push(["Starts", m.starts]); if (m.notice) kv.push(["Notice period", m.notice]); if (m.expires) kv.push(["Valid until", m.expires]); if (m.isbn) kv.push(["ISBN", m.isbn]);
      if ((m.named || []).length) kv.push(["Named", m.named.join(", ")]); if ((m.works || []).length) kv.push(["Works", m.works.join(", ")]); if ((m.dates || []).length) kv.push(["Dates in it", m.dates.slice(0, 5).join(", ")]); if (m.language) kv.push(["Language", m.language === "de" ? "German" : m.language === "en" ? "English" : m.language]);
      var head = '<button class="btn sm x" data-act="close" aria-label="Close">✕</button><p class="lab">' + esc(K.zoneName(i.zone)) + " · " + esc(K.typeName(i.zone, i.type)) + "</p>";
      if (S.edit && !ro) {
        var zt = []; K.ZONES.forEach(function (z) { if (z[0] === "mine" && i.zone !== "mine") return; K.TYPES[z[0]].forEach(function (t) { zt.push('<option value="' + z[0] + "|" + t[0] + '"' + (z[0] === i.zone && t[0] === i.type ? " selected" : "") + ">" + esc(z[1] + " · " + t[1]) + "</option>"); }); });
        return head + '<h2>Edit</h2><div class="f"><label for="knT">Title</label><input class="in" id="knT" value="' + esc(i.title) + '"' + (i.onedrive ? ' readonly title="The name comes from OneDrive"' : "") + '></div><div class="f"><label for="knZ">Zone and type</label><select class="in" id="knZ">' + zt.join("") + '</select></div><div class="f"><label for="knA">Area (sets its colour)</label><select class="in" id="knA"><option value="">Automatic: ' + esc(K.areaName(K.areaOf(Object.assign({}, i, { meta: Object.assign({}, i.meta, { area: null }) })))) + "</option>" + K.AREAS.map(function (a) { return '<option value="' + a[0] + '"' + (i.meta && i.meta.area === a[0] ? " selected" : "") + ">" + esc(a[1]) + "</option>"; }).join("") + '</select></div><div class="f"><label for="knTo">Topic</label><input class="in" id="knTo" list="knTopics" value="' + esc(i.topic) + '"><datalist id="knTopics">' + live().map(function (t) { return t.topic; }).filter(function (n, k, a) { return n && a.indexOf(n) === k; }).map(function (n) { return '<option value="' + esc(n) + '">'; }).join("") + '</datalist></div><div class="f"><label for="knFo">Folder (optional, groups items in the graph)</label><input class="in" id="knFo" value="' + esc((i.meta && i.meta.folder) || "") + '"></div><div class="f"><label for="knS">Summary</label><textarea class="in" id="knS">' + esc(i.summary) + '</textarea></div><div class="f"><label for="knW">Why it matters</label><input class="in" id="knW" value="' + esc(i.why) + '"></div><div class="f"><label for="knG">Tags, separated by commas</label><input class="in" id="knG" value="' + esc((i.tags || []).join(", ")) + '"></div><div class="acts"><button class="btn pri" data-act="save">Save</button><button class="btn" data-act="cancel">Cancel</button></div>';
      }
      if (i.onedrive) return head + odDetail(i, lk);
      return head + "<h2>" + esc(i.title) + '</h2><p class="sub">' + [SRC[i.source] || i.source, i.pages ? i.pages + (i.pages === 1 ? " page" : " pages") : "", fmtD(i.createdAt), i.needsSort ? "waiting to be sorted" : ""].filter(Boolean).map(esc).join(" · ") + "</p>" +
        (i.hasFile ? (S.preview && S.preview.id === i.id ? (S.preview.url ? (S.preview.kind === "image" ? '<img class="prev" src="' + esc(S.preview.url) + '" alt="Preview of ' + esc(i.title) + '">' : S.preview.kind === "pdf" ? '<iframe class="prev pdf" src="' + esc(S.preview.url) + '" title="Preview of ' + esc(i.title) + '"></iframe>' : '<p class="sub prevnote">This kind of file has no preview. Use “Open the file”.</p>') : '<p class="sub prevnote">' + esc(S.preview.note || "Loading the preview…") + "</p>") : '<div class="acts" style="margin-top:12px"><button class="btn sm" data-act="preview">Show a preview</button></div>') : "") +
        (i.url ? '<div class="linkcard"><span class="lc-d">' + esc(i.url.replace(/^https?:\/\//, "").split("/")[0]) + '</span><span class="lc-p">' + esc(("/" + i.url.replace(/^https?:\/\//, "").split("/").slice(1).join("/")).slice(0, 70)) + "</span></div>" : "") +
        (i.summary ? '<p style="margin-top:12px">' + esc(i.summary) + "</p>" : "") + (i.why ? '<p class="sub" style="margin-top:8px">Why it matters: ' + esc(i.why) + "</p>" : "") +
        (i.url ? '<p style="margin-top:8px;overflow-wrap:anywhere"><a href="' + esc(i.url) + '" target="_blank" rel="noopener noreferrer" style="color:var(--acc)">' + esc(i.url.replace(/^https?:\/\//, "")) + "</a></p>" : "") +
        (kv.length ? '<dl class="kv">' + kv.map(function (x) { return "<dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd>"; }).join("") + "</dl>" : "") +
        '<div class="tags">' + areaTag(i) + '<span class="tag">topic: ' + esc(i.topic) + "</span>" + (i.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + "</div>" +
        (S.passages && S.passages.id === i.id && S.passages.list.length ? '<div class="sec"><p class="lab">Matching passages</p>' + S.passages.list.map(function (r) { return '<p class="s" style="font-size:14px;margin-top:6px">' + mark(r.snippet) + (r.page ? ' <span class="sub">· ' + (i.type === "book" && !i.pages ? "section " : "page ") + r.page + "</span>" : "") + "</p>"; }).join("") + "</div>" : "") +
        '<div class="sec"><p class="lab">Linked</p>' + (lk.length ? lk.map(function (x) { var t = byId[x[0]], mine = S.edges.some(function (e) { return (e.from === i.id && e.to === t.id) || (e.to === i.id && e.from === t.id); }); return '<div class="lkrow"><button class="lk" data-id="' + esc(t.id) + '">' + iconOf(t) + "<span>" + esc(t.title) + "</span><small>" + esc(K.EDGE_LABEL[x[1]] || x[1]) + "</small></button>" + (mine && !ro ? '<button class="btn sm" data-unlink="' + esc(t.id) + '" aria-label="Remove the link to ' + esc(t.title) + '">✕</button>' : "") + "</div>"; }).join("") : '<p class="sub">Not linked to anything yet.</p>') +
          (ro ? "" : S.linking ? '<div class="f"><label for="knLq">Link this to…</label><input class="in" id="knLq" placeholder="Type part of a title" value="' + esc(S.linkQ || "") + '"><div id="knLr">' + linkChoices(i) + '</div></div><div class="acts"><button class="btn sm" data-act="linkdone">Done</button></div>' : '<div class="acts" style="margin-top:8px"><button class="btn sm" data-act="linkpick">+ Link to another item</button></div>') + "</div>" +
        (dup ? '<div class="sec"><p class="warn">This looks the same as “' + esc(dup.title) + '”.</p><div class="acts"><button class="btn sm" data-act="merge" data-other="' + esc(dup.id) + '">Keep this one, archive the other</button></div></div>' : "") +
        '<div class="acts">' + (i.hasFile ? '<button class="btn pri" data-act="file">Open the file</button>' : "") + (ro ? '<button class="btn" data-act="mirror">Open on the Self page</button>' : '<button class="btn" data-act="edit">Edit or change type</button><button class="btn" data-act="archive">Archive</button>') + "</div>" +
        '<p class="sub" style="margin-top:12px">' + (ro ? "A read-only copy of one of your notes." : i.hasFile ? "Read and sorted on your device. The file is stored privately in your own database." : "Stored privately in your own database.") + "</p>";
    }
    /* ---- OneDrive ---- */
    var ago = function (t) { if (!t) return "never"; var m = Math.round((Date.now() - new Date(t).getTime()) / 60000); return m < 2 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
    var mb = function (b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; };
    var PRIVL = { index: "Index (read the text)", links: "Links only (never read)", private: "Private (hidden from Claude)" };
    function odState(i) { var o = i.onedrive; if (o.gone) return "no longer in OneDrive"; if (o.privacy === "private") return o.indexStatus === "indexed" ? "private, text searchable only by you" : "private, hidden from Claude"; return { indexed: "text read for search", pending: "waiting to be read", links_only: "link only, content never read", skipped: "skipped", failed: "could not be read", private: "private" }[o.indexStatus] || "link only"; }
    function odDetail(i, lk) {
      var o = i.onedrive, crumbs = (o.path || "").split("/").filter(Boolean);
      return "<h2>" + esc(i.title) + '</h2><p class="sub">' + ["OneDrive", o.size ? mb(o.size) : "", o.modified ? "changed " + fmtD(o.modified) : "", odState(i)].filter(Boolean).map(esc).join(" · ") + "</p>" +
        '<nav class="crumbs" aria-label="Path in OneDrive">' + crumbs.map(function (c, k) { return '<span' + (k === crumbs.length - 1 ? ' aria-current="page"' : "") + ">" + esc(c) + "</span>"; }).join('<span aria-hidden="true">›</span>') + "</nav>" +
        (o.gone ? '<p class="warn">This file is no longer in OneDrive (deleted or moved out of the folder). It is kept here, archived.</p>' : "") +
        (i.summary && o.indexStatus === "indexed" ? '<p style="margin-top:12px">' + esc(i.summary) + "</p>" : "") +
        (S.passages && S.passages.id === i.id && S.passages.list.length ? '<div class="sec"><p class="lab">Matching passages</p>' + S.passages.list.map(function (r) { return '<p class="s" style="font-size:14px;margin-top:6px">' + mark(r.snippet) + (r.page ? ' <span class="sub">· page ' + r.page + "</span>" : "") + "</p>"; }).join("") + "</div>" : "") +
        '<div class="tags">' + areaTag(i) + '<span class="tag">topic: ' + esc(i.topic) + "</span>" + (i.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + "</div>" +
        '<div class="sec"><p class="lab">Linked</p>' + (lk.length ? lk.map(function (x) { var t = byId[x[0]]; return '<div class="lkrow"><button class="lk" data-id="' + esc(t.id) + '">' + iconOf(t) + "<span>" + esc(t.title) + "</span><small>" + esc(K.EDGE_LABEL[x[1]] || x[1]) + "</small></button></div>"; }).join("") : '<p class="sub">Not linked to anything yet.</p>') +
          (S.linking ? '<div class="f"><label for="knLq">Link this to…</label><input class="in" id="knLq" placeholder="Type part of a title" value="' + esc(S.linkQ || "") + '"><div id="knLr">' + linkChoices(i) + '</div></div><div class="acts"><button class="btn sm" data-act="linkdone">Done</button></div>' : '<div class="acts" style="margin-top:8px"><button class="btn sm" data-act="linkpick">+ Link to another item</button></div>') + "</div>" +
        '<div class="acts">' + (o.webUrl && !o.gone ? '<a class="btn pri" href="' + esc(o.webUrl) + '" target="_blank" rel="noopener noreferrer">Open in OneDrive</a>' : "") + (i.hasFile ? '<button class="btn" data-act="file">Open the saved copy</button>' : o.gone ? "" : '<button class="btn" data-act="odcopy">Save a copy in the planner</button>') + '<button class="btn" data-act="edit">Topic and type</button><button class="btn" data-act="archive">Archive</button></div>' +
        '<p class="sub" style="margin-top:12px">The file lives in OneDrive and is never changed from here. ' + (i.hasFile ? "A copy is also stored privately in your database." : "No copy is kept in the planner unless you save one.") + "</p>";
    }
    function zoneOptions(sel) { return K.ZONES.map(function (z) { return '<option value="' + z[0] + '"' + (z[0] === sel ? " selected" : "") + ">" + esc(z[1]) + "</option>"; }).join("") + '<option value="__new">New zone…</option>'; }
    function privOptions(sel) { return ["index", "links", "private"].map(function (p) { return '<option value="' + p + '"' + (p === sel ? " selected" : "") + ">" + PRIVL[p] + "</option>"; }).join(""); }
    function odSheet() {
      var od = S.onedrive || {}, x = '<button class="btn sm x" data-act="sheetclose" aria-label="Close">✕</button><p class="lab">OneDrive</p><h2 style="font:500 22px var(--disp)">Folders from your OneDrive</h2>';
      x += '<p class="sub">Files stay in OneDrive and open there. The planner keeps their names, paths and dates, and reads the text only of folders you set to Index. Access is read-only: nothing in OneDrive is ever changed from here.</p>';
      if (!od.loaded) return x + '<p class="sub" style="margin-top:12px">Checking OneDrive…</p>';
      if (od.unavailable) return x + '<p class="sub" style="margin-top:12px">' + esc(od.note || "OneDrive is not available right now.") + "</p>";
      if (!od.configured) return x + '<p class="sub" style="margin-top:12px">OneDrive is not set up yet. It needs the app registration in Microsoft and two secrets in Supabase (see the setup checklist).</p>';
      if (!od.connected) return x + '<div class="acts"><button class="btn pri" data-act="odconnect">Connect OneDrive</button></div><p class="sub" style="margin-top:8px">You sign in with Microsoft. The planner asks only to read files; the sign-in is kept on the server, never in this browser.</p>';
      x += '<div class="sec"><p class="lab">Account</p><p class="sub">' + (od.status === "reconnect" ? "Needs to be reconnected." : "Connected" + (od.account ? " as " + esc(od.account) : "") + ".") + '</p><div class="acts">' + (od.status === "reconnect" ? '<button class="btn pri" data-act="odconnect">Reconnect OneDrive</button>' : "") + '<button class="btn" data-act="oddisconnect">Disconnect</button></div></div>';
      (od.sources || []).forEach(function (s, k) {
        var ov = Object.keys(s.overrides || {}).map(function (p) { return p + " = " + s.overrides[p]; }).join("\n");
        x += '<div class="sec odsrc"><p class="lab">' + esc(s.path || "OneDrive") + '</p><p class="sub">' + (s.status === "syncing" ? "Syncing…" : s.status === "reconnect" ? "Waiting for the reconnect" : s.status === "error" ? esc(s.lastError || "Sync stopped") : "Last synced " + ago(s.lastSyncedAt)) + " · " + s.items + (s.items === 1 ? " item" : " items") + " · " + s.indexed + " read</p>" +
          '<div class="f"><label for="odP' + k + '">Privacy</label><select class="in" id="odP' + k + '">' + privOptions(s.privacy) + "</select></div>" +
          '<div class="f"><label for="odZ' + k + '">Zone</label><select class="in" id="odZ' + k + '" data-zonesel="1">' + zoneOptions(s.zone) + "</select></div>" +
          '<label class="ck"><input type="checkbox" id="odS' + k + '"' + (s.includeSubfolders ? " checked" : "") + "> Include subfolders</label>" +
          '<label class="ck"><input type="checkbox" id="odI' + k + '"' + (s.indexPrivately ? " checked" : "") + "> For Private: make the text searchable for me only</label>" +
          '<label class="ck"><input type="checkbox" id="odO' + k + '"' + (s.ocr ? " checked" : "") + "> Read scans and images (OCR, slower)</label>" +
          '<div class="f"><label for="odM' + k + '">Largest file to read (MB)</label><input class="in" id="odM' + k + '" type="number" min="1" max="500" value="' + s.maxIndexMb + '"></div>' +
          '<div class="f"><label for="odT' + k + '">Only these file types (optional, e.g. pdf, docx)</label><input class="in" id="odT' + k + '" value="' + esc((s.fileTypes || []).join(", ")) + '"></div>' +
          '<div class="f"><label for="odX' + k + '">Leave out names like (optional, * as wildcard)</label><input class="in" id="odX' + k + '" value="' + esc((s.excludes || []).join(", ")) + '"></div>' +
          '<div class="f"><label for="odV' + k + '">Subfolder levels (one per line: Sub/Folder = index, links or private)</label><textarea class="in" id="odV' + k + '" rows="2">' + esc(ov) + "</textarea></div>" +
          '<div class="acts"><button class="btn sm pri" data-odsave="' + k + '">Save</button><button class="btn sm" data-odsync="' + esc(s.id) + '">Sync now</button><button class="btn sm" data-odremove="' + esc(s.id) + '" data-odpath="' + esc(s.path) + '">Remove</button></div><p class="msg" id="odMsg' + k + '" role="alert"></p></div>';
      });
      var b = od.browse;
      x += '<div class="sec"><p class="lab">Add a folder</p>';
      if (!b) x += '<div class="acts"><button class="btn" data-odfolder="">Browse OneDrive</button></div>';
      else if (b.loading) x += '<p class="sub">Loading folders…</p>';
      else if (b.error) x += '<p class="warn">' + esc(b.error) + '</p><div class="acts"><button class="btn sm" data-odfolder="">Try again</button></div>';
      else {
        x += '<p class="sub">' + esc(b.folder && b.folder.path ? b.folder.path : "OneDrive") + "</p>" + (b.folder && b.folder.parentId !== undefined && b.folder.path ? '<button class="lk" data-odfolder="' + esc(b.folder.parentId || "") + '"><span>↑ Up one level</span></button>' : "") +
          (b.folders.length ? b.folders.map(function (f) { return '<button class="lk" data-odfolder="' + esc(f.id) + '"><span>' + esc(f.name) + "</span><small>" + f.children + "</small></button>"; }).join("") : '<p class="sub">No subfolders here.</p>');
        if (b.folder && b.folder.path) x += '<div class="f"><label for="odNP">Privacy for this folder</label><select class="in" id="odNP">' + privOptions("links") + '</select></div><div class="f"><label for="odNZ">Zone</label><select class="in" id="odNZ" data-zonesel="1">' + zoneOptions("documents") + '</select></div><div class="acts"><button class="btn pri" data-odadd="' + esc(b.folder.id) + '">Map “' + esc(b.folder.name) + '”</button></div><p class="msg" id="odNM" role="alert"></p>';
      }
      return x + "</div>";
    }
    var listOf = function (v) { return String(v || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); };
    function zoneFrom(sel) { if (sel.value !== "__new") return Promise.resolve(sel.value); var label = window.prompt("Name of the new zone (for example Work)"); if (!label) return Promise.resolve(null); return call("onOneDrive", "zone", { label: label }); }
    var ctxId = null;
    var ctxOpen = function () { var m = $("#knCtx"); return m && !m.hidden; };
    function closeCtx() { var m = $("#knCtx"); if (m) m.hidden = true; ctxId = null; }
    function groupNames() { return SIM ? SIM.clusters.map(function (c) { return c.key; }) : []; }
    function openCtx(id, cx, cy) {
      var i = byId[id], m = $("#knCtx"); if (!i || !m) return; ctxId = id;
      var gname = { zone: "zone", type: "type", topic: "topic", folder: "folder" }[S.group], cur = SIM && SIM.byId[id] ? SIM.byId[id].c.key : "";
      var others = groupNames().filter(function (k) { return k !== cur; }), lab = function (k) { return S.group === "zone" ? K.zoneName(k) : k; };
      var ro = !!i.mirror, zoneLocked = S.group === "zone" && (i.zone === "mine") ;
      m.innerHTML = '<p class="ctxh">' + esc(i.title.length > 40 ? i.title.slice(0, 39) + "…" : i.title) + '</p><button role="menuitem" data-ctx="open">Open</button>' +
        (ro ? '<p class="ctxn">A read-only copy of one of your notes. Change it on the Self page.</p>' :
          '<p class="ctxl">Move to another ' + gname + "</p>" + (zoneLocked ? '<p class="ctxn">My notes stay in My constellation.</p>' : others.filter(function (k) { return !(S.group === "zone" && k === "mine"); }).map(function (k) { return '<button role="menuitem" data-ctxmove="' + esc(k) + '">' + esc(lab(k)) + "</button>"; }).join("") + (S.group === "topic" || S.group === "folder" ? '<div class="ctxnew"><input class="in" id="knCtxNew" placeholder="New ' + gname + '…" aria-label="Move to a new ' + gname + '"><button class="btn sm" data-ctx="new">Move</button></div>' : "")) +
          '<button role="menuitem" class="ctxdel" data-ctx="archive">Delete (archive)</button>');
      m.hidden = false;
      var hr = kn.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
      m.style.left = Math.max(8, Math.min(cx - hr.left, hr.width - mw - 8)) + "px"; m.style.top = Math.max(8, Math.min(cy - hr.top, (window.innerHeight - hr.top) - mh - 8)) + "px";
      var first = m.querySelector("button"); if (first) first.focus();
    }
    // Moving an item to another group means changing the field the board is grouped by.
    function moveTo(id, key) {
      var i = byId[id]; if (!i || i.mirror) return;
      var p = {};
      if (S.group === "zone") { if (key === "mine" || key === i.zone) return; p = { zone: key, type: K.TYPES[key][0][0], needsSort: false }; }
      else if (S.group === "type") { var hit = null; K.ZONES.forEach(function (z) { K.TYPES[z[0]].forEach(function (t) { if (!hit && t[1] === key && z[0] !== "mine") hit = [z[0], t[0]]; }); }); if (!hit || (hit[0] === i.zone && hit[1] === i.type)) return; p = { zone: hit[0], type: hit[1], needsSort: false }; }
      else if (S.group === "topic") { if (key === i.topic) return; p = { topic: key }; }
      else { var f = key === "No folder" ? "" : key; if (f === ((i.meta && i.meta.folder) || "")) return; p = { folder: f }; }
      call("onPatch", id, p);
    }
    function linkChoices(i) {
      var q = (S.linkQ || "").toLowerCase().trim(), taken = {}; taken[i.id] = 1; linked(i.id).forEach(function (x) { taken[x[0]] = 1; });
      var list = live().filter(function (t) { return !taken[t.id] && !t.mirror && (!q || t.title.toLowerCase().indexOf(q) >= 0 || (t.topic || "").toLowerCase().indexOf(q) >= 0); }).slice(0, 6);
      return list.length ? list.map(function (t) { return '<button class="lk" data-linkto="' + esc(t.id) + '">' + iconOf(t) + "<span>" + esc(t.title) + "</span><small>" + esc(K.zoneName(t.zone)) + "</small></button>"; }).join("") : '<p class="sub" style="margin-top:6px">' + (q ? "No other item matches." : "Nothing else to link to yet.") + "</p>";
    }
    function resultsHtml() {
      var r = S.results || [];
      return '<p class="lab">' + (S.searching ? "Searching…" : r.length + (r.length === 1 ? " result" : " results")) + "</p>" + (r.length ? r.map(function (x) { var i = byId[x.id]; if (!i) return ""; return '<button class="res" data-id="' + esc(i.id) + '" data-hit="1"><span class="t">' + iconOf(i) + "<span>" + esc(i.title) + '</span></span><span class="s">' + mark(x.snippet || i.summary || "") + '</span><span class="m">' + [x.page ? "page " + x.page : "", K.zoneName(i.zone), K.typeName(i.zone, i.type), x.how].filter(Boolean).map(esc).join(" · ") + "</span></button>"; }).join("") : S.searching ? "" : '<p class="sub" style="margin-top:8px">Nothing matches “' + esc(S.q) + "”. Try fewer or different words.</p>") +
        '<p class="sub" style="margin-top:12px">' + (S.meaning && S.meaning.ready ? "Searching by word and by meaning." : "Searching by word. Meaning search can be switched on under Privacy and search.") + " For a question inside a document, ask Claude; it answers from these passages.</p>";
    }
    function listHtml() {
      var rows = K.filter(S.items, S.f), hits = S.results ? hitIds() : null, k = S.sort.key, dir = S.sort.dir;
      if (hits) rows = rows.filter(function (i) { return hits.indexOf(i.id) >= 0; });
      rows.sort(function (a, b) { var x = k === "type" ? K.typeName(a.zone, a.type) : a[k], y = k === "type" ? K.typeName(b.zone, b.type) : b[k]; return String(x || "").localeCompare(String(y || "")) * dir; });
      var th = function (key, label, cls) { return '<th class="' + (cls || "") + '" aria-sort="' + (k === key ? (dir > 0 ? "ascending" : "descending") : "none") + '"><button data-sort="' + key + '">' + label + (k === key ? (dir > 0 ? " ↑" : " ↓") : "") + "</button></th>"; };
      var can = rows.filter(function (i) { return !i.mirror; }), picked = can.filter(function (i) { return S.picked[i.id]; }), zt = ['<option value="">Keep the type</option>'];
      K.ZONES.forEach(function (z) { if (z[0] === "mine") return; K.TYPES[z[0]].forEach(function (t) { zt.push('<option value="' + z[0] + "|" + t[0] + '">' + esc(z[1] + " · " + t[1]) + "</option>"); }); });
      var bulk = picked.length ? '<div class="bulk" role="group" aria-label="Change the selected items"><b>' + picked.length + ' selected</b><select class="sel" id="knBz" aria-label="New type">' + zt.join("") + '</select><input class="sel" id="knBt" placeholder="New topic" aria-label="New topic" list="knTopics2"><input class="sel" id="knBf" placeholder="New folder" aria-label="New folder"><datalist id="knTopics2">' + live().map(function (t) { return t.topic; }).filter(function (n, k2, a) { return n && a.indexOf(n) === k2; }).map(function (n) { return '<option value="' + esc(n) + '">'; }).join("") + '</datalist><button class="btn sm pri" data-act="bulkapply">Apply</button><button class="btn sm" data-act="bulkarchive">Archive</button><button class="btn sm" data-act="bulkclear">Clear</button></div>' : "";
      return bulk + '<div class="panel" style="padding:8px 12px">' + (rows.length ? '<table class="tbl"><thead><tr><th style="width:28px"><input type="checkbox" id="knAll" aria-label="Select all shown"' + (can.length && picked.length === can.length ? " checked" : "") + "></th>" + th("title", "Title") + th("type", "Type", "hide") + th("topic", "Topic", "hide") + th("source", "From", "hide") + th("createdAt", "Added") + "</tr></thead><tbody>" + rows.map(function (i) { return '<tr><td>' + (i.mirror ? "" : '<input type="checkbox" data-pick="' + esc(i.id) + '" aria-label="Select ' + esc(i.title) + '"' + (S.picked[i.id] ? " checked" : "") + ">") + '</td><td><button class="ti" data-id="' + esc(i.id) + '">' + iconOf(i) + "<span>" + esc(i.title) + (i.onedrive ? ' <small class="odtag" title="' + esc(odState(i)) + '">OneDrive' + (i.onedrive.privacy === "private" ? " · private" : i.onedrive.indexStatus === "indexed" ? " · read" : " · link") + "</small>" : "") + '</span></button><span class="sub" style="display:block;margin:2px 0 0 25px">' + areaTag(i) + '<span class="narrow"> ' + esc(K.typeName(i.zone, i.type) + " · " + i.topic) + '</span></span></td><td class="hide">' + esc(K.typeName(i.zone, i.type)) + '</td><td class="hide">' + esc(i.topic) + '</td><td class="hide">' + esc(SRC[i.source] || i.source) + '</td><td style="white-space:nowrap">' + esc(fmtD(i.createdAt)) + "</td></tr>"; }).join("") + "</tbody></table>" : '<p class="sub" style="padding:18px 8px">' + (live().length ? "Nothing matches these filters." : "Nothing here yet. Add a file, or ask Claude to save a link or an idea.") + "</p>") + "</div>";
    }
    function filtersHtml() {
      var f = S.f, items = live(), types = {}, topics = {};
      items.forEach(function (i) { if (!f.zone || i.zone === f.zone) { types[i.type] = K.typeName(i.zone, i.type); topics[i.topic] = 1; } });
      var sel = function (key, label, opts) { return '<select class="sel" data-f="' + key + '" aria-label="' + label + '"><option value="">' + label + "</option>" + opts.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (f[key] === x[0] ? " selected" : "") + ">" + esc(x[1]) + "</option>"; }).join("") + "</select>"; };
      return '<div class="bar"><button class="chip" data-zonef="" aria-pressed="' + !f.zone + '">All zones</button>' + K.ZONES.map(function (z) { return '<button class="chip" data-zonef="' + z[0] + '" aria-pressed="' + (f.zone === z[0]) + '" style="--c:var(--' + z[0] + ')"><i></i>' + z[1] + "</button>"; }).join("") +
        sel("area", "Any area", K.AREAS.filter(function (a) { return items.some(function (i) { return K.areaOf(i) === a[0]; }); })) + sel("type", "Any type", Object.keys(types).map(function (t) { return [t, types[t]]; })) + sel("topic", "Any topic", Object.keys(topics).sort().map(function (t) { return [t, t]; })) + sel("source", "Any source", [["upload", "Uploaded"], ["claude", "Saved by Claude"], ["me", "Added by you"], ["journal", "From your notes"]]) +
        '<label class="dr">Added from <input type="date" class="sel" data-f="from" value="' + esc(f.from) + '" aria-label="Added from"></label><label class="dr">to <input type="date" class="sel" data-f="to" value="' + esc(f.to) + '" aria-label="Added up to"></label>' +
        (f.zone || f.area || f.type || f.topic || f.source || f.from || f.to ? '<button class="chip" data-act="fclear">Clear filters</button>' : "") + '<button class="chip" data-act="topics">Topics…</button></div>';
    }
    function sheetHtml() {
      if (S.sheet === "sort") {
        var list = live().filter(function (i) { return i.needsSort; });
        return '<button class="btn sm x" data-act="sheetclose" aria-label="Close">✕</button><p class="lab">To sort</p><h2 style="font:500 22px var(--disp)">What are these?</h2><p class="sub">Pick the right kind and confirm. Nothing is moved until you do.</p>' + (list.length ? list.map(function (i) {
          var zt = []; K.ZONES.forEach(function (z) { if (z[0] === "mine") return; K.TYPES[z[0]].forEach(function (t) { zt.push('<option value="' + z[0] + "|" + t[0] + '"' + (z[0] === i.zone && t[0] === i.type ? " selected" : "") + ">" + esc(z[1] + " · " + t[1]) + "</option>"); }); });
          return '<div class="sec"><p style="font-weight:600;overflow-wrap:anywhere">' + esc(i.title) + '</p><p class="sub">' + esc(i.summary ? i.summary.slice(0, 140) : "No readable text was found.") + '</p><div class="acts" style="margin-top:8px"><select class="in" style="flex:1;min-width:180px" data-sortsel="' + esc(i.id) + '" aria-label="Kind for ' + esc(i.title) + '">' + zt.join("") + '</select><button class="btn pri" data-confirm="' + esc(i.id) + '">Confirm</button></div></div>';
        }).join("") : '<p class="sub" style="margin-top:12px">Nothing is waiting.</p>');
      }
      if (S.sheet === "spider") {
        var ev2 = spiderEvents().slice(0, 12), sp = S.spider || {};
        return '<button class="btn sm x" data-act="sheetclose" aria-label="Close">✕</button><p class="lab">The spider</p><h2 style="font:500 22px var(--disp)">Claude, sorting your knowledge</h2>' +
          '<p class="sub">The spider is Claude (Sonnet) working through your connector in a Claude chat, so it runs on your Max plan. A web page cannot use that plan by itself, so the spider starts when you ask Claude, or on a schedule you set up in Claude. While it works, this page shows it walking to each item it reads and spinning a thread for each link it makes.</p>' +
          '<p class="sub" style="margin-top:8px">It only reads zones you allow under Privacy and search. Personal documents stay closed to it unless you open them there.</p>' +
          '<div class="f"><label for="knSpP">Paste this into a Claude chat (pick Sonnet as the model)</label><textarea class="in" id="knSpP" readonly rows="6">' + esc(sp.prompt || "") + '</textarea></div><div class="acts"><button class="btn pri" data-act="spcopy">Copy</button><span class="sub" id="knSpC" role="status"></span></div>' +
          '<div class="sec"><p class="lab">Recent steps</p>' + (ev2.length ? ev2.map(function (e) { var it = e.item ? byId[e.item] : null; return '<p class="sub" style="padding:5px 0;border-top:1px solid var(--line)">' + esc(new Date(e.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })) + " · " + esc(e.action === "read" ? "read " + (it ? it.title : "an item") : e.action === "cluster" ? "grouped " + (it ? it.title : "an item") + " · " + e.note : e.action === "link" ? "linked " + (it ? it.title : "an item") + (e.other && byId[e.other] ? " ↔ " + byId[e.other].title : "") + (e.note ? " · " + e.note : "") : e.note) + "</p>"; }).join("") : '<p class="sub">Nothing yet. The first steps appear here when Claude starts.</p>') + "</div>";
      }
      if (S.sheet === "topics") {
        var tc = {}; live().forEach(function (i) { if (!i.mirror) tc[i.topic] = (tc[i.topic] || 0) + 1; });
        var names = Object.keys(tc).sort(function (a, b) { return tc[b] - tc[a] || (a < b ? -1 : 1); });
        return '<button class="btn sm x" data-act="sheetclose" aria-label="Close">✕</button><p class="lab">Topics</p><h2 style="font:500 22px var(--disp)">Rename or merge</h2><p class="sub">Type a new name to rename a topic. Type the name of another topic to merge the two.</p>' + (names.length ? names.map(function (n, k2) { return '<div class="sec" style="margin-top:10px"><div class="acts" style="margin-top:0"><input class="in" style="flex:1;min-width:160px" id="knTn' + k2 + '" value="' + esc(n) + '" aria-label="Name for the topic ' + esc(n) + '" list="knTopics3"><span class="sub">' + tc[n] + (tc[n] === 1 ? " item" : " items") + '</span><button class="btn sm" data-topicsave="' + k2 + '" data-old="' + esc(n) + '">Save</button></div></div>'; }).join("") + '<datalist id="knTopics3">' + names.map(function (n) { return '<option value="' + esc(n) + '">'; }).join("") + "</datalist>" : '<p class="sub" style="margin-top:12px">No topics yet.</p>');
      }
      if (S.sheet === "onedrive") return odSheet();
      if (S.sheet === "add") return '<button class="btn sm x" data-act="sheetclose" aria-label="Close">✕</button><p class="lab">Add by hand</p><div class="f"><label for="knAK">What is it?</label><select class="in" id="knAK"><option value="web|link">A link</option><option value="ideas|idea">An idea</option><option value="ideas|question">A question I am exploring</option><option value="ideas|quote">A quote</option><option value="thinkers|author">An author or creator</option><option value="mine|note">A note to keep</option></select></div><div class="f"><label for="knAT">Title or text</label><textarea class="in" id="knAT"></textarea></div><div class="f"><label for="knAU">Web address (for a link)</label><input class="in" id="knAU" type="url" placeholder="https://"></div><div class="f"><label for="knAW">Why it matters (optional)</label><input class="in" id="knAW"></div><div class="f"><label for="knAG">Tags, separated by commas (optional)</label><input class="in" id="knAG"></div><div class="acts"><button class="btn pri" data-act="addsave">Save</button></div><p class="msg" id="knAM" role="alert"></p>';
      var u = S.usage, m = S.meaning || {};
      return '<button class="btn sm x" data-act="sheetclose" aria-label="Close">✕</button><p class="lab">Privacy and search</p><h2 style="font:500 22px var(--disp)">Who may read what</h2><p class="sub">Files are read and sorted on this device. Nothing is sent to an AI service by this page. The switches below decide which zones Claude may read through the connector when you ask it a question.</p>' +
        '<div class="acts" style="margin-top:6px"><button class="btn sm" data-act="onedrive">OneDrive folders…</button></div>' +
        K.ZONES.map(function (z) { var on = !!(S.settings.external || {})[z[0]]; return '<div class="lk" style="cursor:default"><span>' + esc(z[1]) + '</span><small><button class="chip" data-ext="' + z[0] + '" aria-pressed="' + on + '">' + (on ? "Claude may read" : "Kept from Claude") + "</button></small></div>"; }).join("") +
        '<div class="sec"><p class="lab">Search by meaning</p><p class="sub">' + (m.ready ? "On. " + (m.pending ? m.pending + " passages still need preparing." : "Every passage is prepared.") : "Off. Turning it on downloads a language model once (about 120 MB) and runs it on this device. Best done on a computer, not on the phone.") + '</p><div class="acts"><button class="btn" data-act="meaning"' + (m.busy ? " disabled" : "") + ">" + (m.busy ? "Working…" : m.ready ? (m.pending ? "Prepare the remaining passages" : "Prepared") : "Turn on meaning search") + "</button></div></div>" +
        (u ? '<div class="sec"><p class="lab">Storage</p><p class="sub">' + (u.bytes / 1048576).toFixed(1) + " MB used by your files" + (u.limit ? " of about " + Math.round(u.limit / 1048576) + " MB on the free plan" : "") + ". Single files can be up to " + Math.round((u.maxFile || 52428800) / 1048576) + " MB.</p>" + (u.limit && u.bytes > u.limit * 0.8 ? '<p class="warn">▲ Storage is nearly full.</p>' : "") + "</div>" : "");
    }
    function render() {
      kn.dataset.theme = theme;
      K.ZONES.forEach(function (z, k) { if (K.isCustomZone(z[0])) { var c = K.CUSTOM_COLORS[k % K.CUSTOM_COLORS.length]; kn.style.setProperty("--" + z[0], theme === "dark" ? c[1] : c[0]); } });
      var items = live(), toSort = items.filter(function (i) { return i.needsSort; }).length, sel = S.sel ? byId[S.sel] : null, side = sel ? detail(sel) : S.results ? resultsHtml() : "";
      var keepFocus = root.activeElement && root.activeElement.id === "knQ", pos = keepFocus ? root.activeElement.selectionStart : 0;
      kn.innerHTML = (S.sample ? '<div class="ribbon" role="note"><b>SAMPLE DATA</b> · invented documents, books and names · nothing below is yours</div>' : "") +
        '<header class="top"><div><p class="eyebrow">Knowledge</p><h1>' + items.length + (items.length === 1 ? " thing" : " things") + '</h1></div><input class="search" id="knQ" type="search" placeholder="Search by word' + (S.meaning && S.meaning.ready ? " or by meaning" : "") + '" aria-label="Search your knowledge" value="' + esc(S.q) + '">' +
        '<div class="seg" role="group" aria-label="View"><button data-view="graph" aria-pressed="' + (S.view === "graph") + '">Graph</button><button data-view="list" aria-pressed="' + (S.view === "list") + '">List</button></div>' +
        '<button class="btn pri" data-act="pick">+ Add files</button><button class="btn" data-act="pickdir" title="Copy the files of a folder on this device into the planner">+ Add a folder</button><button class="btn" data-act="onedrive" title="Map a OneDrive folder; files stay in OneDrive">+ OneDrive folder</button><input type="file" id="knDir" webkitdirectory multiple hidden><button class="btn" data-act="add">+ Note or link</button><button class="btn spbtn" data-act="spider" title="Claude sorting your knowledge"><svg viewBox="-24 -24 48 48" class="ic" aria-hidden="true"><ellipse cx="0" cy="5" rx="7" ry="9" fill="currentColor"/><circle cx="0" cy="-7" r="5" fill="currentColor"/><path d="M-6 0 L-20 -10 M-6 4 L-21 2 M-6 8 L-19 14 M6 0 L20 -10 M6 4 L21 2 M6 8 L19 14" stroke="currentColor" stroke-width="2.4" fill="none"/></svg> Spider</button><button class="btn" data-act="privacy">Privacy and search</button><input type="file" id="knFile" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.epub,.docx,.txt,.md,image/*,application/pdf"></header>' +
        (S.view === "list" || S.results ? filtersHtml() : "") +
        (S.progress ? '<div class="note" role="status" aria-live="polite"><span>' + esc(S.progress) + "</span></div>" : "") +
        (S.onedrive && S.onedrive.connected && S.onedrive.status === "reconnect" ? '<div class="note"><span><b>OneDrive needs to be reconnected</b> · your items are still here; new changes wait until then</span><button class="btn sm" data-act="odconnect">Reconnect OneDrive</button></div>' : "") +
        (S.onedrive && S.onedrive.reading && S.onedrive.reading.left ? '<div class="note"><span>Reading ' + S.onedrive.reading.left + " OneDrive " + (S.onedrive.reading.left === 1 ? "file" : "files") + " on this device…</span></div>" : "") +
        (toSort ? '<div class="note"><span><b>' + toSort + " to sort</b> · not sure what " + (toSort === 1 ? "this is" : "these are") + ' yet</span><button class="btn sm" data-act="sort">Review</button></div>' : "") +
        spiderBar() + '<div class="stage' + (side && S.view === "graph" && !narrow ? " two" : "") + '">' + (S.view === "list" ? (side && narrow ? "" : listHtml()) : (side && narrow ? "" : graphHtml())) + (side ? '<aside class="panel" aria-label="' + (sel ? "Details" : "Search results") + '">' + side + "</aside>" : "") +
        (S.view === "graph" && !side && !items.length ? '<p class="sub">Nothing here yet. Add a file, or ask Claude to save a link or an idea, and it will appear in its zone.</p>' : "") + (S.view === "graph" && !side && items.length ? '<p class="sub">Drag an item to move it; the rest make room. Pinch, scroll or use + and − to zoom in until every title shows.</p>' : "") + "</div>" +
        '<div class="ctx" id="knCtx" role="menu" aria-label="Item menu" hidden></div>' +
        (S.sheet ? '<div class="shade" data-shade="1"><div class="sheet" role="dialog" aria-modal="true">' + sheetHtml() + "</div></div>" : "");
      if (keepFocus) { var q = $("#knQ"); q.focus(); try { q.setSelectionRange(pos, pos); } catch (e) {} }
      mountGraph();
    }
    function select(id, fromHit) {
      S.sel = id; S.edit = false; S.linking = false; S.linkQ = ""; if (!S.preview || S.preview.id !== id) S.preview = null;
      S.passages = fromHit && S.results ? { id: id, list: S.results.filter(function (r) { return r.id === id && r.snippet && r.page !== undefined && r.how !== "title or tags"; }) } : null;
      render();
      if (S.view === "graph" && !narrow && id && SIM) { var near = [id].concat(linked(id).map(function (x) { return x[0]; })); flyToIds(near); }
    }
    function runSearch() {
      var q = S.q.trim(), n = ++searchN;
      if (!q) { S.results = null; S.searching = false; S.sel = null; render(); if (S.view === "graph") flyTo(home()); return; }
      var local = K.search(S.items, q); S.results = local; S.searching = !!o.onSearch; S.sel = null; render();
      if (S.view === "graph" && local.length) flyToIds(local.map(function (r) { return r.id; }));
      call("onSearch", q, S.f).then(function (more) {
        if (n !== searchN) return;
        var out = (more || []).filter(function (r) { return byId[r.id] && !byId[r.id].archived; }), seen = {};
        out.forEach(function (r) { seen[r.id] = 1; });
        S.results = out.concat(local.filter(function (r) { return !seen[r.id]; })); S.searching = false; if (!S.sel) { render(); if (S.view === "graph" && S.results.length) flyToIds(hitIds()); }
      }, function () { if (n === searchN) { S.searching = false; render(); } });
    }

    kn.addEventListener("contextmenu", function (e) {
      var nd = e.target.closest && e.target.closest(".n,.tbl tr .ti,.res[data-id]"); if (!nd) return;
      var id = nd.getAttribute("data-id"); if (!id || !byId[id]) return; e.preventDefault(); openCtx(id, e.clientX, e.clientY);
    });
    kn.addEventListener("click", function (e) {
      if (ctxOpen() && !(e.target.closest && e.target.closest("#knCtx"))) { closeCtx(); if (e.target.closest && e.target.closest(".n")) return; }
      var cb = e.target.closest && e.target.closest("[data-ctx],[data-ctxmove]");
      if (cb && ctxId) {
        var cid = ctxId, ca = cb.getAttribute("data-ctx"), mv = cb.getAttribute("data-ctxmove");
        if (ca === "new") { var nv = ($("#knCtxNew") || {}).value; if (!nv || !nv.trim()) { $("#knCtxNew").focus(); return; } closeCtx(); moveTo(cid, nv.trim()); return; }
        closeCtx();
        if (ca === "open") select(cid); else if (ca === "archive") { if (S.sel === cid) S.sel = null; call("onArchive", cid); } else if (mv != null) moveTo(cid, mv);
        return;
      }
      if (e.target.dataset && e.target.dataset.shade) { S.sheet = null; render(); return; }
      var node = e.target.closest && e.target.closest(".n"), t = e.target.closest("button,a"), d = t ? t.dataset : {};
      if (node && !t) { if (drag.moved) return; select(node.getAttribute("data-id")); return; }
      if (!t || t.disabled || t.tagName === "A") return;
      if (d.view) { S.view = d.view; render(); }
      else if (d.id) select(d.id, !!d.hit);
      else if (d.zoom != null) { if (d.zoom === "0") flyTo(home()); else flyTo({ x: S.cam.x, y: S.cam.y, k: S.cam.k * (d.zoom === "1" ? 1.5 : 1 / 1.5) }); setTimeout(function () { var zl = $("#knZl"); if (zl) zl.textContent = Math.round(S.cam.k * 100) + " %"; }, 420); }
      else if (d.group) { S.group = d.group; var keep = S.cam.k; relayout(); S.cam = home(); S.cam.set = 1; if (SIM) SIM.alpha = 1; render(); if (still) frame(0, true); void keep; }
      else if (d.linkto && S.sel) { S.linkQ = ""; call("onLink", S.sel, d.linkto); }
      else if (d.unlink && S.sel) call("onUnlink", S.sel, d.unlink);
      else if (d.act === "spider") { S.sheet = "spider"; render(); var sx = root.querySelector(".sheet .x"); if (sx) sx.focus(); }
      else if (d.act === "spcopy") { var ta = $("#knSpP"), done2 = function (ok2) { var c2 = $("#knSpC"); if (c2) c2.textContent = ok2 ? "Copied." : "Select the text and copy it."; }; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(function () { done2(true); }, function () { ta.select(); done2(false); }); else { ta.select(); done2(false); } }
      else if (d.act === "fclear") { S.f = { zone: "", area: "", type: "", topic: "", source: "", from: "", to: "" }; render(); }
      else if (d.act === "topics") { S.sheet = "topics"; render(); var tf = root.querySelector(".sheet .x"); if (tf) tf.focus(); }
      else if (d.topicsave != null) { var nv = $("#knTn" + d.topicsave).value.trim(); if (!nv || nv === d.old) return; t.disabled = true; call("onTopic", d.old, nv); }
      else if (d.act === "bulkclear") { S.picked = {}; render(); }
      else if (d.act === "bulkarchive") { var ids0 = Object.keys(S.picked).filter(function (x) { return S.picked[x]; }); S.picked = {}; call("onBulkArchive", ids0); }
      else if (d.act === "bulkapply") {
        var ids1 = Object.keys(S.picked).filter(function (x) { return S.picked[x]; }), zv = $("#knBz").value, p1 = {}; if (zv) { p1.zone = zv.split("|")[0]; p1.type = zv.split("|")[1]; p1.needsSort = false; }
        if ($("#knBt").value.trim()) p1.topic = $("#knBt").value.trim(); if ($("#knBf").value.trim()) p1.folder = $("#knBf").value.trim();
        if (!Object.keys(p1).length) { $("#knBz").focus(); return; } S.picked = {}; call("onBulk", ids1, p1);
      }
      else if (d.act === "preview" && S.sel) { var pid = S.sel; S.preview = { id: pid, url: "", note: "Loading the preview…" }; render(); call("onPreview", pid).then(function (r) { if (S.sel !== pid) return; S.preview = { id: pid, url: (r && r.url) || "", kind: r && r.kind, note: r && r.url ? "" : "The preview could not be loaded." }; render(); }); }
      else if (d.act === "linkpick") { S.linking = true; S.linkQ = ""; render(); var lq = $("#knLq"); if (lq) lq.focus(); }
      else if (d.act === "linkdone") { S.linking = false; render(); }
      else if (d.zonef != null) { S.f.zone = d.zonef; S.f.type = ""; S.f.topic = ""; render(); }
      else if (d.sort) { if (S.sort.key === d.sort) S.sort.dir *= -1; else S.sort = { key: d.sort, dir: d.sort === "createdAt" ? -1 : 1 }; render(); }
      else if (d.confirm) { var sv = root.querySelector('[data-sortsel="' + d.confirm + '"]').value.split("|"); call("onPatch", d.confirm, { zone: sv[0], type: sv[1], needsSort: false }); }
      else if (d.ext) call("onSetting", d.ext, !(S.settings.external || {})[d.ext]);
      else if (d.act === "close") { S.sel = null; S.edit = false; S.linking = false; render(); }
      else if (d.act === "pick") $("#knFile").click();
      else if (d.act === "pickdir") $("#knDir").click();
      else if (d.act === "add" || d.act === "sort" || d.act === "privacy") { S.sheet = d.act; render(); var f = root.querySelector(".sheet .x"); if (f) f.focus(); }
      else if (d.act === "sheetclose") { S.sheet = null; render(); }
      else if (d.act === "edit") { S.edit = true; render(); $("#knT").focus(); }
      else if (d.act === "cancel") { S.edit = false; render(); }
      else if (d.act === "save" && S.sel) { var zt = $("#knZ").value.split("|"), title = byId[S.sel] && byId[S.sel].onedrive ? byId[S.sel].title : $("#knT").value.trim(); if (!title) { $("#knT").focus(); return; } S.edit = false; call("onPatch", S.sel, { title: title, zone: zt[0], type: zt[1], topic: $("#knTo").value.trim() || "General", folder: $("#knFo").value.trim(), summary: $("#knS").value.trim(), why: $("#knW").value.trim(), tags: $("#knG").value.split(",").map(function (x) { return x.trim(); }).filter(Boolean), area: $("#knA").value || null, needsSort: false }); S.edit = false; }
      else if (d.act === "archive" && S.sel) { var id = S.sel; S.sel = null; call("onArchive", id); }
      else if (d.act === "merge" && S.sel) call("onArchive", d.other);
      else if (d.act === "file" && S.sel) call("onOpenFile", S.sel);
      else if (d.act === "mirror" && S.sel) call("onOpenMirror", S.sel);
      else if (d.act === "meaning") call("onMeaning");
      else if (d.act === "onedrive") { S.sheet = "onedrive"; render(); var ox = root.querySelector(".sheet .x"); if (ox) ox.focus(); }
      else if (d.act === "odconnect") { t.disabled = true; call("onOneDrive", "connect"); }
      else if (d.act === "oddisconnect") { if (window.confirm("Disconnect OneDrive? The stored access is deleted and syncing stops. Your items stay in the planner, and nothing in OneDrive changes.")) call("onOneDrive", "disconnect"); }
      else if (d.odfolder != null) call("onOneDrive", "browse", { folderId: d.odfolder || null });
      else if (d.act === "odcopy" && S.sel) { t.disabled = true; call("onSaveCopy", S.sel); }
      else if (d.odsync) { t.disabled = true; call("onOneDrive", "sync", { id: d.odsync }); }
      else if (d.odremove) { if (window.confirm("Stop mapping “" + d.odpath + "”? Its items are archived in the planner. Nothing in OneDrive is touched.")) call("onOneDrive", "remove", { id: d.odremove }); }
      else if (d.odadd) { var nm = $("#odNM"); zoneFrom($("#odNZ")).then(function (zone) { if (!zone) { nm.textContent = "Pick a zone."; return; } t.disabled = true; call("onOneDrive", "add", { folderId: d.odadd, privacy: $("#odNP").value, zone: zone }).then(function () { if (S.onedrive) S.onedrive.browse = null; render(); }); }); }
      else if (d.odsave != null) {
        var k = d.odsave, src = (S.onedrive.sources || [])[+k], msg2 = $("#odMsg" + k), ov = {}, bad = "";
        $("#odV" + k).value.split("\n").forEach(function (line) { if (!line.trim()) return; var m = line.split("="); var p = (m[0] || "").trim().replace(/^\/+|\/+$/g, ""), lv = (m[1] || "").trim().toLowerCase(); if (!p || ["index", "links", "private"].indexOf(lv) < 0) bad = line; else ov[p] = lv; });
        if (bad) { msg2.textContent = "Write each line as Sub/Folder = index, links or private (“" + bad + "”)."; return; }
        zoneFrom($("#odZ" + k)).then(function (zone) { if (!zone) return; t.disabled = true; call("onOneDrive", "update", { id: src.id, privacy: $("#odP" + k).value, zone: zone, includeSubfolders: $("#odS" + k).checked, indexPrivately: $("#odI" + k).checked, ocr: $("#odO" + k).checked, maxIndexMb: +$("#odM" + k).value || 50, fileTypes: listOf($("#odT" + k).value), excludes: listOf($("#odX" + k).value), overrides: ov }); });
      }
      else if (d.act === "addsave") {
        var kd = $("#knAK").value.split("|"), text = $("#knAT").value.trim(), url = $("#knAU").value.trim(), msg = $("#knAM");
        if (!text && !url) { msg.textContent = "Write a title or some text first."; $("#knAT").focus(); return; }
        if (kd[1] === "link" && !url) { msg.textContent = "A link needs a web address."; $("#knAU").focus(); return; }
        t.disabled = true;
        call("onCreate", { zone: kd[0], type: kd[1], title: (text || url).split("\n")[0].slice(0, 120), summary: text.indexOf("\n") >= 0 || text.length > 120 ? text : "", url: kd[1] === "link" ? url : "", why: $("#knAW").value.trim(), tags: $("#knAG").value.split(",").map(function (x) { return x.trim(); }).filter(Boolean) }).then(function (res) {
          if (res && res.error) { msg.textContent = res.error; t.disabled = false; return; }
          S.sheet = null; if (res && res.id) S.sel = res.id; render();
        });
      }
    });
    kn.addEventListener("change", function (e) {
      if (e.target.id === "knFile" || e.target.id === "knDir") { if (e.target.files.length) call("onUpload", [].slice.call(e.target.files)); e.target.value = ""; }
      else if (e.target.dataset && e.target.dataset.f) { S.f[e.target.dataset.f] = e.target.value; render(); }
      else if (e.target.dataset && e.target.dataset.pick) { S.picked[e.target.dataset.pick] = e.target.checked; render(); }
      else if (e.target.id === "knAll") { var on = e.target.checked; [].forEach.call(root.querySelectorAll("[data-pick]"), function (x) { S.picked[x.getAttribute("data-pick")] = on; }); render(); }
    });
    kn.addEventListener("input", function (e) { if (e.target.id === "knLq") { S.linkQ = e.target.value; var box = $("#knLr"), cur = S.sel && byId[S.sel]; if (box && cur) box.innerHTML = linkChoices(cur); return; } if (e.target.id === "knQ") { S.q = e.target.value; clearTimeout(searchT); searchT = setTimeout(runSearch, 260); } });
    kn.addEventListener("keydown", function (e) {
      var n = e.target.closest && e.target.closest(".n");
      if (n && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); n.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
      if (e.key === "Escape") { if (S.sheet) { S.sheet = null; render(); } else if (S.sel) { S.sel = null; S.edit = false; render(); } else if (S.q && e.target.id === "knQ") { S.q = ""; runSearch(); } }
      if (e.key === "Enter" && e.target.id === "knCtxNew") { e.preventDefault(); var nb = root.querySelector('[data-ctx="new"]'); if (nb) nb.click(); return; }
      if (e.target.id === "knQ" && e.key === "Enter") { clearTimeout(searchT); runSearch(); }
      if (e.target.closest && e.target.closest("#knSvg") && (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0")) { e.preventDefault(); if (e.key === "0") flyTo(home()); else zoomBy(e.key === "-" ? 1 / 1.25 : 1.25); }
      if (e.key === "Escape" && ctxOpen()) { closeCtx(); return; }
      if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && e.target.closest && e.target.closest(".n")) { e.preventDefault(); var rb = e.target.getBoundingClientRect(); openCtx(e.target.getAttribute("data-id"), rb.left + rb.width / 2, rb.top + rb.height / 2); return; }
      if (e.target.closest && e.target.closest("#knSvg") && /^Arrow/.test(e.key)) { e.preventDefault(); var st = 60 / S.cam.k; setCam({ x: S.cam.x + (e.key === "ArrowRight" ? st : e.key === "ArrowLeft" ? -st : 0), y: S.cam.y + (e.key === "ArrowDown" ? st : e.key === "ArrowUp" ? -st : 0), k: S.cam.k }); }
    });
    /* drag an item, pan the board, wheel zoom and pinch */
    var drag = { on: false, moved: false, pts: {}, node: null };
    var toBoard = function (e) { var svg = $("#knSvg"), r = svg.getBoundingClientRect(), k = S.cam.k; return [S.cam.x - W / (2 * k) + (e.clientX - r.left) / r.width * (W / k), S.cam.y - H / (2 * k) + (e.clientY - r.top) / r.height * (H / k)]; };
    var press = 0;
    kn.addEventListener("pointerdown", function (e) { clearTimeout(press); var pn = e.pointerType !== "mouse" && e.target.closest && e.target.closest(".n"); if (pn) { var px = e.clientX, py = e.clientY; press = setTimeout(function () { if (!drag.moved) { drag.on = false; if (drag.node) { drag.node.fx = drag.node.fy = null; drag.node = null; } openCtx(pn.getAttribute("data-id"), px, py); } }, 560); } });
    kn.addEventListener("pointermove", function (e) { if (press && drag.moved) clearTimeout(press); });
    kn.addEventListener("pointerup", function () { clearTimeout(press); });
    kn.addEventListener("pointerdown", function (e) { var svg = e.target.closest && e.target.closest("#knSvg"); if (!svg) return; drag.pts[e.pointerId] = [e.clientX, e.clientY]; drag.on = true; drag.moved = false; drag.x = e.clientX; drag.y = e.clientY; drag.sx = e.clientX; drag.sy = e.clientY; drag.pinch = 0; var nd = e.target.closest(".n"); drag.node = nd && SIM ? SIM.byId[nd.getAttribute("data-id")] : null; });
    kn.addEventListener("pointermove", function (e) {
      if (!drag.on || !drag.pts[e.pointerId]) return; var svg = $("#knSvg"); if (!svg) return; var r = svg.getBoundingClientRect(), ids = Object.keys(drag.pts);
      drag.pts[e.pointerId] = [e.clientX, e.clientY];
      if (ids.length >= 2) { var a = drag.pts[ids[0]], b = drag.pts[ids[1]], dist = Math.hypot(a[0] - b[0], a[1] - b[1]); if (drag.pinch) setCam({ x: S.cam.x, y: S.cam.y, k: S.cam.k * dist / drag.pinch }); drag.pinch = dist; drag.moved = true; if (drag.node) { drag.node.fx = drag.node.fy = null; drag.node = null; } return; }
      if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 5) return;
      drag.moved = true; svg.classList.add("drag");
      if (drag.node) { var p = toBoard(e); drag.node.fx = p[0]; drag.node.fy = p[1]; SIM.dragging = true; heat(0.35); if (still) frame(0, true); var tgt = SIM.clusters.filter(function (c) { return c !== drag.node.c && Math.hypot(p[0] - c.hx, p[1] - c.hy) < Math.max(24, c.hr) - 4; })[0]; DOM.hulls.forEach(function (h) { h.classList.toggle("into", !!tgt && SIM.clusters[+h.getAttribute("data-c")] === tgt); }); return; }
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; setCam({ x: S.cam.x - dx * (W / S.cam.k) / r.width, y: S.cam.y - dy * (H / S.cam.k) / r.height, k: S.cam.k });
    });
    var endDrag = function (e) { delete drag.pts[e.pointerId]; if (!Object.keys(drag.pts).length) { drag.on = false; if (drag.node && drag.moved && SIM) { var dn = drag.node, px2 = dn.fx != null ? dn.fx : dn.x, py2 = dn.fy != null ? dn.fy : dn.y, into = SIM.clusters.filter(function (c) { return c !== dn.c && Math.hypot(px2 - c.hx, py2 - c.hy) < Math.max(24, c.hr) - 4; })[0]; if (into) { var mid = dn.id; setTimeout(function () { moveTo(mid, into.key); }, 0); } }
      if (drag.node) { drag.node.x = drag.node.fx != null ? drag.node.fx : drag.node.x; drag.node.y = drag.node.fy != null ? drag.node.fy : drag.node.y; drag.node.fx = drag.node.fy = null; drag.node = null; if (SIM) { SIM.dragging = false; heat(0.5); } } var svg = $("#knSvg"); if (svg) { svg.classList.remove("drag"); [].forEach.call(svg.querySelectorAll(".hull.into"), function (h) { h.classList.remove("into"); }); } setTimeout(function () { drag.moved = false; }, 0); } drag.pinch = 0; };
    kn.addEventListener("pointerup", endDrag); kn.addEventListener("pointercancel", endDrag);
    kn.addEventListener("wheel", function (e) {
      var svg = e.target.closest && e.target.closest("#knSvg"); if (!svg) return; e.preventDefault();
      var k = S.cam.k, nk = Math.max(ZMIN, Math.min(ZMAX, k * Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1)))), p = toBoard(e);
      setCam({ x: p[0] - (p[0] - S.cam.x) * k / nk, y: p[1] - (p[1] - S.cam.y) * k / nk, k: nk }); var zl = $("#knZl"); if (zl) zl.textContent = Math.round(S.cam.k * 100) + " %";
    }, { passive: false });
    /* drop files anywhere on the page */
    kn.addEventListener("dragover", function (e) { if (e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], "Files") >= 0) { e.preventDefault(); kn.classList.add("drop"); } });
    kn.addEventListener("dragleave", function (e) { if (e.target === kn) kn.classList.remove("drop"); });
    kn.addEventListener("drop", function (e) { kn.classList.remove("drop"); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); call("onUpload", [].slice.call(e.dataTransfer.files)); } });
    if (window.ResizeObserver) new ResizeObserver(function () { var n = host.getBoundingClientRect().width < 900; if (n !== narrow && host.offsetParent !== null) { S.cam = { x: 0, y: 0, k: 1 }; relayout(); S.cam = home(); S.cam.set = 1; render(); } }).observe(host);

    setData(o); render();
    return {
      update: function (d) { if (d.theme) theme = d.theme; if (Object.keys(d).length === 1 && d.spider) { S.spider = d.spider; var bar = root.querySelector(".spbar"), html = spiderBar(); if (bar) bar.outerHTML = html || ""; else if (html) { var c3 = root.querySelector(".stage"); if (c3) c3.insertAdjacentHTML("beforebegin", html); } return; } setData(d); if (SIM) SIM.alpha = Math.max(SIM.alpha, 0.6); render(); },
      progress: function (text) { S.progress = text || ""; var n = root.querySelector('.note[role="status"] span'); if (n && text) n.textContent = text; else render(); },
      openSheet: function (name) { S.sheet = name; render(); },
      select: select, state: function () { return { view: S.view, sel: S.sel, results: S.results ? S.results.length : null, k: S.cam.k, sheet: S.sheet, group: S.group, clusters: SIM ? SIM.clusters.map(function (c) { return [c.label, c.n]; }) : [], alpha: SIM ? SIM.alpha : 0 }; },
      node: function (id) { var n = SIM && SIM.byId[id]; return n ? { x: n.x, y: n.y, cluster: n.c.label } : null; }
    };
  };
})();
