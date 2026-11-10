/* People page, part 3 of 3: the page itself. Mounted by the planner into a shadow root, so its CSS
   and the planner's never meet. The planner owns the people rows (and saves them through
   opts.savePerson); this file owns the two side tables: person_situations and person_links.
   Nothing is ever deleted from here: notes, links and people are archived and can come back. */
(function () {
  "use strict";
  var SRC = document.currentScript && document.currentScript.src || "", BASE = SRC.replace(/[^\/]*$/, ""), VER = (SRC.match(/[?&]v=([^&]+)/) || [])[1] || "1";
  var C = window.PPPeopleCore, K = window.PPPeopleSky, T = window.PPPeopleTree, esc = K.esc, av = K.av, RINGS = C.RINGS, QL = C.QL, EN = C.EN;
  var S = { opts: null, root: null, pp: null, M: null, raw: null, sits: [], links: [], loadedFor: null, sample: false, view: "sky",
    st: { sel: null, showConn: false, flt: {}, group: "", ring: "", quality: "", q: "", narrow: false }, open: null };
  var Z = { box: { sky: null, tree: null }, ptrs: {}, n: 0, moved: false };   // zoom: the current viewBox per view (null = home)
  function $(sel) { return S.root.querySelector(sel); }
  function say(msg) { if (S.opts.toast) S.opts.toast(msg); }
  function fonts() {
    if (document.getElementById("pphFonts") || !window.fetch) return;
    var el = document.createElement("style"); el.id = "pphFonts"; document.head.appendChild(el);
    fetch("https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..700&family=Instrument+Sans:wght@400;500;600&display=swap")
      .then(function (r) { return r.ok ? r.text() : ""; }).then(function (css) { el.textContent = css.split("'Archivo'").join("'Archivo Health'"); }).catch(function () { /* system fonts are fine */ });
  }
  function theme() { if (S.pp) S.pp.dataset.theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light"; }

  /* ---------- shell ---------- */
  function shell() {
    S.pp.innerHTML =
      '<div class="sample" id="sample" hidden><b>SAMPLE</b> · these people are invented. Yours appear here once you are signed in and have added someone.</div>' +
      '<header class="top"><div class="title"><div class="eyebrow">People</div><h1 id="h1"></h1></div>' +
      '<div class="seg views" role="group" aria-label="View"><button data-view="sky">Constellation</button><button data-view="tree">Tree</button><button data-view="graph">Clusters</button><button data-view="list">List</button><button data-view="table">Table</button></div>' +
      '<button class="btn primary" id="new">New person</button></header>' +
      '<div class="filters"><input class="search" id="q" type="search" placeholder="Search a name" aria-label="Search people">' +
      '<button class="fchip" data-f="thread" aria-pressed="false">Open thread<span class="n"></span></button><button class="fchip" data-f="drift" aria-pressed="false">Drifting<span class="n"></span></button><button class="fchip" data-f="tense" aria-pressed="false">Tension<span class="n"></span></button>' +
      '<select class="fchip" id="fGroup" aria-label="Group"></select><select class="fchip" id="fRing" aria-label="Circle"></select><select class="fchip" id="fQual" aria-label="Relationship quality"></select>' +
      '<button class="fchip" data-f="archived" aria-pressed="false">Archived<span class="n"></span></button></div>' +
      '<button class="pill" id="pill" aria-expanded="false"></button>' +
      '<main class="stage"><div class="chart" id="chart"><svg id="sky" viewBox="-520 -520 1040 1040" role="group" aria-label="Constellation of people around you"></svg>' +
      '<div class="legend" id="legend"></div><div class="cornertools"><button class="tool" id="famBtn">Family roles</button><button class="tool" id="conn" aria-pressed="false">Show connections</button><span class="zoom" role="group" aria-label="Zoom"><button class="tool" id="zOut" aria-label="Zoom out">−</button><button class="tool" id="zIn" aria-label="Zoom in">+</button><button class="tool" id="zHome" disabled>Reset</button></span></div></div>' +
      '<div class="list" id="list" hidden></div>' +
      '<aside class="rail" id="rail" aria-label="Pulse and person details"><div class="pulse" id="pulse"></div><div class="panel" id="panel"></div></aside></main><div class="famshade" id="fam" hidden></div>';
    $("#legend").innerHTML = ["strong", "ok", "weak", "strained", "conflict"].map(function (q) { return "<span>" + K.glyph(q) + QL[q] + "</span>"; }).join("") + "<span><i></i>Open thread</span>";
    $("#fRing").innerHTML = '<option value="">Circle</option>' + [1, 2, 3, 4, 5].map(function (c) { return '<option value="' + c + '">' + RINGS[c] + "</option>"; }).join("");
    $("#fQual").innerHTML = '<option value="">Quality</option>' + Object.keys(QL).map(function (q) { return '<option value="' + q + '">' + QL[q] + "</option>"; }).join("");
    S.root.addEventListener("click", onClick); zoomWire($("#sky"));
    S.root.addEventListener("change", function (e) {
      var t = e.target, k = t.getAttribute && t.getAttribute("data-fam"), id = k && t.getAttribute("data-id"); if (!k) return;
      var p = person(id); if (!p) return;
      if (k === "role") patch(id, { kinRole: t.value || null, kinSide: C.KIN_SIDED[t.value] ? (p.kinSide || null) : null });
      else if (k === "side") patch(id, { kinSide: t.value || null });
      else if (k === "parent") famParent(p, t.value);
    });
    S.root.addEventListener("keydown", function (e) {
      var n = e.target.closest && e.target.closest(".nd");
      var ex = e.target.closest && e.target.closest("[data-exes]");
      if (ex && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); ex.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
      else if (n && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(n.getAttribute("data-id")); }
      else if (e.key === "Escape" && S.famOpen) { S.famOpen = false; $("#fam").hidden = true; var fb2 = $("#famBtn"); if (fb2) fb2.focus(); }
      else if (e.key === "Escape" && (S.open || S.st.sel)) { if (S.open) { S.open = null; panel(); } else select(null); }
      else if (e.key === "Enter" && e.target.id === "linkName") { e.preventDefault(); addLink(); }
    });
    $("#q").addEventListener("input", function () { S.st.q = this.value.trim().toLowerCase(); body(); });
    [["#fGroup", "group"], ["#fRing", "ring"], ["#fQual", "quality"]].forEach(function (f) { $(f[0]).addEventListener("change", function () { S.st[f[1]] = this.value; this.classList.toggle("set", !!this.value); body(); }); });
  }

  /* ---------- data ---------- */
  function rawNow() {
    var o = S.opts, ctx = o.ctx ? o.ctx() : {}, today = ctx.today || new Date().toISOString().slice(0, 10);
    S.sample = !o.userId || !(o.people || []).length;
    if (S.sample) { if (!S.raw || !S.raw.isSample) { S.raw = C.sample(today); S.raw.isSample = true; } return S.raw; }
    S.raw = { people: o.people, actions: ctx.actions, events: ctx.events, notes: ctx.notes, sits: S.sits, links: S.links, today: today, colors: o.groupColors || null };
    return S.raw;
  }
  function load() {
    var o = S.opts; if (!o.sb || !o.userId || S.loadedFor === o.userId) return;
    S.loadedFor = o.userId;
    Promise.all([o.sb.from("person_situations").select("*").is("archived_at", null).order("noted_on", { ascending: false }).limit(5000), o.sb.from("person_links").select("*").is("archived_at", null).limit(5000)])
      .then(function (r) {
        if (r[0].error || r[1].error) { console.warn(r[0].error || r[1].error); say("Some People details could not be loaded."); }
        S.sits = r[0].data || []; S.links = r[1].data || []; refresh();
      }).catch(function (e) { console.warn(e); S.loadedFor = null; });
  }
  function person(id) { return S.M && S.M.byId[id]; }
  function rawPerson(id) { return (S.raw.people || []).filter(function (p) { return p.id === id; })[0]; }

  /* ---------- render ---------- */
  function refresh(external) {
    S.M = C.build(rawNow());
    if (S.st.sel && !person(S.st.sel)) S.st.sel = null;
    var M = S.M, act = M.P.filter(function (p) { return !p.archived; }).length, n = function (f) { return M.on.filter(f).length || ""; };
    $("#sample").hidden = !S.sample;
    $("#h1").textContent = act + (act === 1 ? " person" : " people") + ", 5 circles";
    $('[data-f="thread"] .n').textContent = n(function (p) { return p.threads.length; });
    $('[data-f="drift"] .n').textContent = n(function (p) { return p.drift; });
    $('[data-f="tense"] .n').textContent = n(function (p) { return p.tense; });
    $('[data-f="archived"] .n').textContent = M.P.filter(function (p) { return p.archived; }).length || "";
    var g = $("#fGroup"); g.innerHTML = '<option value="">Group</option>' + M.allGroups.map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + "</option>"; }).join(""); g.value = S.st.group; if (g.value !== S.st.group) S.st.group = "";
    [].forEach.call(S.root.querySelectorAll(".views button"), function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-view") === S.view); });
    S.pp.setAttribute("data-view", S.view); pulse(); body(true);
    var a = S.root.activeElement, typing = external && a && /TEXTAREA|INPUT|SELECT/.test(a.tagName) && a.closest(".panel");
    if (!typing) panel();
  }
  function body(full) {
    var list = S.view === "list" || S.st.flt.archived;
    $("#chart").hidden = list; $("#list").hidden = !list;
    $("#chart").style.display = list ? "none" : ""; $("#list").style.display = list ? "" : "none";
    if (list) $("#list").innerHTML = K.listHtml(S.M, S.st);
    else {
      var svg = $("#sky"), tree = S.view === "tree" && T;
      if (full || svg._tree !== !!tree) { svg._tree = !!tree; svg.setAttribute("aria-label", tree ? "Family tree and the people around you" : "Constellation of people around you"); (tree ? T : K).draw(svg, S.M, S.st); setBox(Z.box[S.view]); }
      else K.paint(svg, S.M, S.st);
    }
  }

  /* ---------- zoom and pan: the SVG viewBox is the camera ---------- */
  function home(svg) {
    if (!svg._tree) { var VB = S.st.narrow ? 600 : 540; return [-VB, -VB, 2 * VB, 2 * VB]; }
    var vb = svg._vb || [-500, -300, 1000, 700], r = svg.getBoundingClientRect(), asp = r.width ? r.height / r.width : .7, f = svg._focus, w = Math.min(vb[2], S.st.narrow ? 640 : Math.min(1250, Math.max(900, f ? f[2] + 60 : 0)));
    var cx = vb[2] <= w ? vb[0] + vb[2] / 2 : Math.max(vb[0] + w / 2, Math.min(vb[0] + vb[2] - w / 2, 0));
    return [cx - w / 2, vb[1], w, w * asp];
  }
  function span(svg, h) { return [h[2] / 9, Math.max(h[2], svg._tree && svg._vb ? svg._vb[2] : 0, svg._tree && svg._vb ? svg._vb[3] * h[2] / h[3] : 0) * 1.15]; }
  function setBox(b) {
    var svg = $("#sky"), h = home(svg);
    if (b && Math.abs(b[2] - h[2]) < 1 && Math.abs(b[0] - h[0]) < 1 && Math.abs(b[1] - h[1]) < 1) b = null;
    Z.box[S.view] = b; var v = b || h;
    svg.setAttribute("viewBox", v.map(function (n) { return n.toFixed(1); }).join(" "));
    svg.classList.toggle("zoomed", h[2] / v[2] >= 1.45); svg.style.setProperty("--iz", Math.min(1, Math.pow(v[2] / h[2], .55)).toFixed(3)); svg.classList.toggle("zin", !!b);
    var z = $("#zHome"); if (z) z.disabled = !b;
  }
  function zoomAt(x, y, f) {
    var svg = $("#sky"), h = home(svg), cur = Z.box[S.view] || h, m = svg.getScreenCTM(), lim = span(svg, h); if (!m || !m.a) return;
    f = Math.max(cur[2] / lim[1], Math.min(cur[2] / lim[0], f));
    var px = (x - m.e) / m.a, py = (y - m.f) / m.d;
    setBox([px - (px - cur[0]) / f, py - (py - cur[1]) / f, cur[2] / f, cur[3] / f]);
  }
  function panBy(dx, dy) { var svg = $("#sky"), cur = Z.box[S.view] || home(svg), m = svg.getScreenCTM(); if (m && m.a) setBox([cur[0] - dx / m.a, cur[1] - dy / m.d, cur[2], cur[3]]); }
  function zoomBtn(f) { var r = $("#sky").getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); }
  function zoomWire(svg) {
    svg.addEventListener("wheel", function (e) {
      if (S.st.narrow && !e.ctrlKey && !Z.box[S.view] && !svg._tree) return;          // a small window: let the page scroll until you zoom in
      e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode ? .05 : .0016) * (e.ctrlKey ? 4 : 1)));
    }, { passive: false });
    svg.addEventListener("pointerdown", function (e) { if (e.button) return; if (!Z.n) Z.moved = false; Z.ptrs[e.pointerId] = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY }; Z.n = Object.keys(Z.ptrs).length; });
    svg.addEventListener("pointermove", function (e) {
      var p = Z.ptrs[e.pointerId]; if (!p) return;
      var ids = Object.keys(Z.ptrs), dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (ids.length === 1) {
        if (!Z.moved && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 6) return;
        if (!Z.moved) { Z.moved = true; svg.classList.add("grab"); try { svg.setPointerCapture(e.pointerId); } catch (x) { /* fine */ } dx = e.clientX - p.x0; dy = e.clientY - p.y0; }
        panBy(dx, dy);
      } else if (ids.length === 2) {
        var o = Z.ptrs[ids[0] === String(e.pointerId) ? ids[1] : ids[0]], d0 = Math.hypot(p.x - o.x, p.y - o.y), d1 = Math.hypot(e.clientX - o.x, e.clientY - o.y);
        Z.moved = true; panBy(dx / 2, dy / 2); if (d0 > 8 && d1 > 8) zoomAt((e.clientX + o.x) / 2, (e.clientY + o.y) / 2, d1 / d0);
      }
      p.x = e.clientX; p.y = e.clientY;
    });
    var up = function (e) { delete Z.ptrs[e.pointerId]; Z.n = Object.keys(Z.ptrs).length; if (!Z.n) svg.classList.remove("grab"); };
    svg.addEventListener("pointerup", up); svg.addEventListener("pointercancel", up);
    svg.addEventListener("dblclick", function (e) { if (!e.target.closest(".nd")) zoomAt(e.clientX, e.clientY, 1.8); });
  }
  function pulse() {
    var D = C.pulse(S.M), it = function (p, inner) { return '<button class="item" data-id="' + p.id + '">' + av(p) + "<span>" + inner + "</span></button>"; };
    $("#pulse").innerHTML =
      "<section><h2>Needs attention <small>" + (D.need.length || "") + "</small></h2>" + (D.need.length ? D.need.slice(0, 12).map(function (n) { return it(n.p, "<b>" + esc(n.p.name) + "</b>" + (n.tag ? '<span class="tag">' + esc(n.tag) + "</span>" : "") + '<span class="why">' + esc(n.why) + "</span>"); }).join("") : '<p class="empty">Nothing is waiting. Open threads and people you want a rhythm with show up here.</p>') + "</section>" +
      "<section><h2>Coming up <small>next 30 days</small></h2>" + (D.soon.length ? D.soon.map(function (n) { return it(n.p, "<b>" + esc(n.p.name) + '</b><span class="why">' + esc(n.why) + "</span>"); }).join("") : '<p class="empty">No birthdays or events with someone in the next 30 days.</p>') + "</section>" +
      "<section><h2>Recently updated</h2>" + (D.rec.length ? D.rec.map(function (n) { return it(n.p, "<b>" + esc(n.p.name) + "</b><q>" + esc(n.s.t.length > 92 ? n.s.t.slice(0, 90) + "…" : n.s.t) + '</q><span class="by">' + (n.s.by === "claude" ? "via Claude" : "you") + " · " + C.fmtDay(n.s.date) + "</span>"); }).join("") : '<p class="empty">No situation notes yet. Open someone and write how things are, or tell Claude.</p>') + "</section>";
    $("#pill").innerHTML = (D.need.length ? "<i></i><b>" + D.need.length + (D.need.length === 1 ? " needs" : " need") + " a moment</b>" : "<b>All calm</b>") + " · " + D.soon.length + ' coming up<span>' + (S.pp.classList.contains("pulse-open") ? "Close ▴" : "Open ▾") + "</span>";
  }
  function chip(key, label, extra) { return '<button class="chip" data-open="' + key + '" aria-expanded="' + (S.open === key) + '">' + (extra || "") + esc(label) + "</button>"; }
  function opts(key, title, items, cur) { return S.open !== key ? "" : '<div class="opts"><div class="lab">' + title + "</div>" + items.map(function (i) { return '<button class="chip" data-set="' + key + ":" + i[0] + '" aria-pressed="' + (String(cur) === String(i[0])) + '">' + (i[2] || "") + esc(i[1]) + "</button>"; }).join("") + "</div>"; }
  function panel() {
    var p = person(S.st.sel), rail = $("#rail"); rail.classList.toggle("person", !!p); if (!p) { $("#panel").innerHTML = ""; return; }
    var first = p.name.split(" ")[0], s = p.sits[0], by = function (x) { return (x.by === "claude" ? "via Claude" : "written by you") + " · " + C.fmtDay(x.date); },
      h = '<button class="back" id="back">← ' + (S.st.narrow ? "Close" : "Pulse") + '</button><div class="who">' + av(p) + "<div><h3>" + esc(p.name) + "</h3><p>" + esc([p.rel, p.group, RINGS[p.circle] + " circle", p.loc].filter(Boolean).join(" · ")) + "</p></div></div>";
    if (p.yearMet) h += '<p class="how">In your life since ' + esc(p.yearMet) + "</p>";
    if (p.archived) h += '<p class="state">Archived. Hidden from the map and the rest of the planner; nothing was deleted.</p>';
    else if (p.inMemory) h += '<p class="state">In memory. Kept here quietly, off the map.</p>';
    else if (p.quality === "cut_off") h += '<p class="state">Cut off. Kept off the map; change the quality below if that shifts.</p>';
    h += '<div class="sit"><div class="lab">Current situation</div>';
    if (S.open === "sit") h += '<textarea id="sitText" aria-label="How things are with ' + esc(first) + '" placeholder="How are things with ' + esc(first) + ' right now?"></textarea><div class="acts"><button class="btn primary" id="sitSave">Save note</button><button class="btn" data-open="">Cancel</button></div>';
    else h += (s ? "<p>" + esc(s.t) + '</p><span class="by">' + by(s) + '<button class="lk" data-hide="' + s.id + '">Hide</button></span>' : '<p class="empty">Nothing written yet. Write a line here, or tell Claude how things are with ' + esc(first) + " and it lands here.</p>") + '<div class="acts"><button class="btn" data-open="sit">' + (s ? "Write an update" : "Write a note") + "</button></div>";
    if (p.sits.length > 1) h += '<details class="hist"><summary>Earlier notes (' + (p.sits.length - 1) + ")</summary><ul>" + p.sits.slice(1).map(function (x) { return "<li>" + esc(x.t) + '<span class="by">' + by(x) + '<button class="lk" data-hide="' + x.id + '">Hide</button></span></li>'; }).join("") + "</ul></details>";
    h += '</div><div class="chips">' + chip("quality", QL[p.quality], K.glyph(p.quality)) + chip("energy", p.energy === "neutral" ? "Energy" : (p.energy === "nourishing" ? "← " : "→ ") + EN[p.energy]) + chip("circle", RINGS[p.circle] + " circle") + chip("rhythm", p.rhythm ? "Rhythm · " + C.rhythmText(p.rhythm) : "No rhythm") + (p.rel === "Family" || p.rel === "Partner" || p.kinRole ? chip("kin", p.kinRole ? C.KIN[p.kinRole] + (p.kinSide ? " · " + C.SIDE[p.kinSide].toLowerCase() : "") : "Family role") : "") + "</div>" +
      opts("quality", "How it is between you", Object.keys(QL).map(function (q) { return [q, QL[q], K.glyph(q)]; }), p.quality) +
      opts("energy", "What it does to your energy", [["nourishing", "← Gives energy"], ["neutral", "Even"], ["draining", "→ Takes energy"]], p.energy) +
      opts("circle", "How close", [1, 2, 3, 4, 5].map(function (c) { return [c, RINGS[c]]; }), p.circle) +
      opts("rhythm", "How often you'd like to be in touch. Only people with a rhythm can drift.", C.RHYTHMS, p.rhythm || 0) +
      opts("kin", "Who " + esc(first) + " is to you. This places them in the Tree view.", Object.keys(C.KIN).map(function (k) { return [k, C.KIN[k]]; }).concat([["", "Not set"]]), p.kinRole) +
      (S.open === "kin" && C.KIN_SIDED[p.kinRole] ? '<div class="opts"><div class="lab">On which side</div>' + Object.keys(C.SIDE).map(function (k) { return '<button class="chip" data-set="side:' + k + '" aria-pressed="' + (p.kinSide === k) + '">' + C.SIDE[k] + "</button>"; }).join("") + "</div>" : "");
    h += '<div class="row"><div class="lab">Last contact</div><p>' + (p.last != null ? C.KIND[p.kind] + " " + C.ago(p.last) + (p.drift ? ' <span class="soft">· a little longer than your rhythm</span>' : "") : '<span class="soft">Not noted yet.</span>') + '</p><div class="acts"><span class="soft" style="font-size:12.5px">Today I</span><button class="btn" data-log="call">talked</button><button class="btn" data-log="met">met</button><button class="btn" data-log="message">messaged</button></div></div>';
    h += '<div class="row"><div class="lab">Open between you</div>' + (p.threads.length ? p.threads.map(function (t) { return '<div class="thread"><i></i><span>' + esc(t.t) + "<small>" + (t.date ? C.fmtDay(t.date) + " · " : "") + 'planner action</small></span><button data-act="' + t.id + '">Open</button></div>'; }).join("") : '<p class="empty">Nothing open. Actions linked to ' + esc(first) + " appear here.</p>") + "</div>";
    var up = p.up.filter(function (u) { return !u.bday; });
    if (up.length) h += '<div class="row"><div class="lab">Upcoming</div>' + up.map(function (u) { return "<p>" + esc(u.t) + ' <span class="soft">· ' + C.fmtDay(u.date) + "</span></p>"; }).join("") + "</div>";
    h += '<div class="row"><div class="lab">Birthday<button class="lk" data-open="bday">' + (p.bdayText ? "Change" : "Add") + "</button></div>" + (S.open === "bday" ? '<div class="acts"><select class="field" id="bM" aria-label="Month">' + C.MON.map(function (m, i) { return '<option value="' + (i + 1) + '"' + (p.bm === i + 1 ? " selected" : "") + ">" + m + "</option>"; }).join("") + '</select><input class="field" id="bD" type="number" min="1" max="31" style="width:64px" aria-label="Day" value="' + (p.bd || "") + '"><button class="btn primary" id="bSave">Save</button>' + (p.bdayText ? '<button class="btn" id="bClear">Remove</button>' : "") + "</div>" : "<p>" + (p.bdayText ? esc(p.bdayText) + (p.bday != null && p.bday <= 30 ? ' <span class="soft">· ' + C.inDays(p.bday) + "</span>" : "") : '<span class="soft">Not noted.</span>') + "</p>") + "</div>";
    if (p.mentions.length) h += '<div class="row"><div class="lab">Mentions in your notes</div>' + p.mentions.slice(0, 5).map(function (m) { return '<p class="mention"><b>' + C.fmtDay(m.date) + "</b> · " + esc(m.t.length > 110 ? m.t.slice(0, 108) + "…" : m.t) + "</p>"; }).join("") + "</div>";
    h += '<div class="row"><div class="lab">Their people<button class="lk" data-open="link">Link someone</button></div>' + (p.links.length ? '<div class="kin">' + p.links.map(function (l) { var k = person(l.id); return k ? '<span class="k"><button data-id="' + k.id + '">' + av(k) + esc(k.name) + '</button><button class="x" data-unlink="' + l.linkId + '" aria-label="Remove the link to ' + esc(k.name) + '">×</button></span>' : ""; }).join("") + "</div>" : '<p class="empty">No one linked yet.</p>') +
      (S.open === "link" ? '<div class="acts"><input class="field" id="linkName" list="linkNames" placeholder="Type a name" aria-label="Person to link"><datalist id="linkNames">' + S.M.P.filter(function (x) { return x.id !== p.id && !x.archived; }).map(function (x) { return '<option value="' + esc(x.name) + '">'; }).join("") + '</datalist><button class="btn primary" id="linkAdd">Link</button></div>' : "") + "</div>";
    if (p.notes) h += '<div class="row"><div class="lab">Notes</div><p class="notes">' + esc(p.notes) + "</p></div>";
    h += '<div class="foot"><button class="btn" id="edit">Edit details</button>' + (p.archived ? '<button class="btn" id="restore">Restore</button>' : '<button class="btn" id="archive">Archive</button>') + "</div>";
    $("#panel").innerHTML = h;
    var f = S.open === "sit" ? $("#sitText") : S.open === "link" ? $("#linkName") : null; if (f) f.focus();
  }
  function select(id) { S.st.sel = id || null; S.open = null; panel(); if (id) $("#rail").scrollTop = 0; body(); }

  /* ---------- writes ---------- */
  function fail(e) { console.warn(e); say("That could not be saved. Check your connection and try again."); }
  function patch(id, fields) {
    if (S.sample) { Object.assign(rawPerson(id), fields); refresh(); famDraw(); return; }
    Promise.resolve(S.opts.savePerson(id, fields)).then(function () { refresh(); famDraw(); }, fail);
  }
  /* ---------- family roles: set who is who for every relative in one list ---------- */
  function famPeople() { return S.M.P.filter(function (p) { return !p.archived && (p.rel === "Family" || (p.kinRole && p.kinRole !== "partner" && p.kinRole !== "ex")); }); }
  function famDraw() {
    var box = $("#fam"); if (!box || !S.famOpen) return;
    var P = famPeople(), unset = function (p) { return !p.kinRole || (C.KIN_SIDED[p.kinRole] && !p.kinSide) ? 1 : 0; }, keep = box.querySelector(".famlist"), top = keep ? keep.scrollTop : 0, act = S.root.activeElement, fid = act && act.id;
    P.sort(function (a, b) { return unset(b) - unset(a) || (a.name < b.name ? -1 : 1); });
    var elders = P.filter(function (p) { return p.kinRole === "aunt" || p.kinRole === "uncle"; }), todo = P.filter(unset).length;
    var opt = function (v, label, cur) { return '<option value="' + esc(v) + '"' + (v === (cur || "") ? " selected" : "") + ">" + esc(label) + "</option>"; };
    var roles = [["", "Not set"]].concat(Object.keys(C.KIN).filter(function (k) { return k !== "partner" && k !== "ex"; }).map(function (k) { return [k, C.KIN[k]]; }));
    box.innerHTML = '<div class="famsheet" role="dialog" aria-modal="true" aria-label="Family roles"><button class="tool famx" id="famClose" aria-label="Close">✕</button><div class="eyebrow">Family tree</div><h2>Who is who</h2><p class="soft">' + (P.length ? (todo ? todo + " of " + P.length + " still need a place. Pick how each person is related to you; aunts, uncles, grandparents and cousins also need a side. A cousin can be put under their parent." : "Everyone has a place in the tree.") : "Nobody is marked as family yet. Set a person’s relationship to Family first.") + '</p><div class="famlist">' +
      P.map(function (p, i) {
        var sided = !!C.KIN_SIDED[p.kinRole], par = p.kinRole === "cousin" ? elders.filter(function (a) { return p.links.some(function (l) { return l.id === a.id; }); })[0] : null, choices = elders.filter(function (a) { return !p.kinSide || !a.kinSide || a.kinSide === p.kinSide; });
        return '<div class="famrow' + (unset(p) ? " todo" : "") + '"><span class="famname">' + esc(p.name) + '</span><select class="fchip" id="famR' + i + '" data-fam="role" data-id="' + p.id + '" aria-label="How ' + esc(p.name) + ' is related to you">' + roles.map(function (r) { return opt(r[0], r[1], p.kinRole); }).join("") + "</select>" +
          (sided ? '<select class="fchip" id="famS' + i + '" data-fam="side" data-id="' + p.id + '" aria-label="Which side ' + esc(p.name) + ' is on">' + opt("", "Which side?", p.kinSide) + Object.keys(C.SIDE).map(function (k) { return opt(k, C.SIDE[k], p.kinSide); }).join("") + "</select>" : "") +
          (p.kinRole === "cousin" && choices.length ? '<select class="fchip" id="famP' + i + '" data-fam="parent" data-id="' + p.id + '" aria-label="Whose child ' + esc(p.name) + ' is">' + opt("", "Child of…", par ? par.id : "") + choices.map(function (a) { return opt(a.id, "Child of " + a.first, par ? par.id : ""); }).join("") + "</select>" : "") + "</div>";
      }).join("") + "</div></div>";
    var l2 = box.querySelector(".famlist"); if (l2) l2.scrollTop = top;
    if (fid) { var f = S.root.getElementById(fid); if (f) f.focus(); }
  }
  // put a cousin under an aunt or uncle (a link between the two), or take them out again
  function famParent(p, parentId) {
    var elders = famPeople().filter(function (a) { return a.kinRole === "aunt" || a.kinRole === "uncle"; }), old = p.links.filter(function (l) { return l.id !== parentId && elders.some(function (a) { return a.id === l.id; }); });
    old.forEach(function (l) { hideRow("person_links", S.sample ? S.raw.links : S.links, l.linkId, "family link"); });
    if (!parentId || p.links.some(function (l) { return l.id === parentId; })) { famDraw(); return; }
    var a = p.id < parentId ? p.id : parentId, b = a === p.id ? parentId : p.id;
    if (S.sample) { S.raw.links.push({ id: "l" + Date.now(), person_a: a, person_b: b, quality: "ok" }); refresh(); famDraw(); return; }
    S.opts.sb.from("person_links").upsert({ user_id: S.opts.userId, person_a: a, person_b: b, quality: "ok", archived_at: null }, { onConflict: "person_a,person_b" }).select().single()
      .then(function (r) { if (r.error) return fail(r.error); S.links.push(r.data); refresh(); famDraw(); }, fail);
  }
  function addSit(id, text) {
    if (S.sample) { S.raw.sits.push({ id: "t" + Date.now(), person_id: id, text: text, noted_on: S.raw.today, author: "me", created_at: new Date().toISOString() }); return refresh(); }
    S.opts.sb.from("person_situations").insert({ user_id: S.opts.userId, person_id: id, text: text, noted_on: S.raw.today, author: "me" }).select().single()
      .then(function (r) { if (r.error) return fail(r.error); S.sits.push(r.data); refresh(); }, fail);
  }
  function hideRow(table, arr, id, label) {
    var i = arr.map(function (x) { return x.id; }).indexOf(id); if (i < 0) return; var row = arr[i];
    arr.splice(i, 1); refresh();
    if (S.sample) return;
    S.opts.sb.from(table).update({ archived_at: new Date().toISOString() }).eq("id", id).then(function (r) {
      if (r.error) { arr.push(row); refresh(); return fail(r.error); }
      if (S.opts.undo) S.opts.undo(label, function () { return S.opts.sb.from(table).update({ archived_at: null }).eq("id", id).then(function (u) { if (!u.error) { arr.push(row); refresh(); } }); });
    }, fail);
  }
  function addLink() {
    var p = person(S.st.sel), el = $("#linkName"), name = el ? el.value.trim().toLowerCase() : ""; if (!p || !name) return;
    var o = S.M.P.filter(function (x) { return x.id !== p.id && x.name.toLowerCase() === name; })[0] || S.M.P.filter(function (x) { return x.id !== p.id && !x.archived && x.name.toLowerCase().indexOf(name) === 0; })[0];
    if (!o) return say("Nobody by that name. Pick one from the list.");
    if (p.links.some(function (l) { return l.id === o.id; })) { S.open = null; return panel(); }
    var a = p.id < o.id ? p.id : o.id, b = a === p.id ? o.id : p.id; S.open = null;
    if (S.sample) { S.raw.links.push({ id: "l" + Date.now(), person_a: a, person_b: b, quality: "ok" }); return refresh(); }
    S.opts.sb.from("person_links").upsert({ user_id: S.opts.userId, person_a: a, person_b: b, quality: "ok", archived_at: null }, { onConflict: "person_a,person_b" }).select().single()
      .then(function (r) { if (r.error) return fail(r.error); S.links.push(r.data); refresh(); }, fail);
  }

  function onClick(e) {
    var t = e.target, b = t.closest("button"); if (Z.moved && t.closest("#sky")) { Z.moved = false; return; }
    if (b && b.id === "famBtn") { S.famOpen = true; $("#fam").hidden = false; famDraw(); var fc = $("#famClose"); if (fc) fc.focus(); return; }
    if ((b && b.id === "famClose") || t.id === "fam") { S.famOpen = false; $("#fam").hidden = true; var fb = $("#famBtn"); if (fb) fb.focus(); return; }
    if (t.closest("#fam")) return;
    if (!b && !t.closest(".nd") && !t.closest("[data-exes]") && t.closest("#sky")) return select(null);
    if (t.closest("[data-exes]")) { S.st.exOpen = !S.st.exOpen; var sv = $("#sky"); T.draw(sv, S.M, S.st); var again = sv.querySelector("[data-exes]"); if (again) again.focus(); return; }
    var nd = t.closest(".nd"); if (nd) return select(nd.getAttribute("data-id"));
    if (!b) return;
    var id = S.st.sel, p = person(id), d = function (k) { return b.getAttribute(k); };
    if (d("data-view")) { var v = d("data-view"); if (v === "sky" || v === "list" || v === "tree") { S.view = v; S.st.flt.archived = false; $('[data-f="archived"]').setAttribute("aria-pressed", "false"); refresh(); } if (S.opts.onView) S.opts.onView(v); return; }
    if (d("data-f")) { var k = d("data-f"); S.st.flt[k] = !S.st.flt[k]; b.setAttribute("aria-pressed", !!S.st.flt[k]); return body(k === "archived"); }
    if (b.id === "new") return S.sample && !S.opts.userId ? say("Sign in to add people.") : S.opts.onNew && S.opts.onNew();
    if (b.id === "zIn") return zoomBtn(1.5); if (b.id === "zOut") return zoomBtn(1 / 1.5); if (b.id === "zHome") return setBox(null);
    if (b.id === "conn") { S.st.showConn = !S.st.showConn; b.setAttribute("aria-pressed", S.st.showConn); return body(); }
    if (b.id === "pill") { var on = S.pp.classList.toggle("pulse-open"); b.setAttribute("aria-expanded", on); return pulse(); }
    if (b.id === "back") return select(null);
    if (d("data-id")) return select(d("data-id"));
    if (!p) return;
    if (b.hasAttribute("data-open")) { S.open = S.open === d("data-open") ? null : d("data-open") || null; return panel(); }
    if (d("data-set")) { var kv = d("data-set").split(":"), f = {}; S.open = null;
      if (kv[0] === "quality") f.quality = kv[1]; else if (kv[0] === "energy") f.energy = kv[1]; else if (kv[0] === "circle") f.circle = +kv[1];
      else if (kv[0] === "kin") { f.kinRole = kv[1] || null; if (!C.KIN_SIDED[kv[1]]) f.kinSide = null; else if (!p.kinSide) S.open = "kin"; }
      else if (kv[0] === "side") f.kinSide = kv[1] || null;
      else f.rhythmDays = +kv[1] || null;
      return patch(id, f); }
    if (d("data-log")) return patch(id, { lastContactAt: S.raw.today, lastContactKind: d("data-log") });
    if (d("data-act")) return S.sample ? null : S.opts.onOpenAction && S.opts.onOpenAction(d("data-act"));
    if (d("data-hide")) return hideRow("person_situations", S.sample ? S.raw.sits : S.sits, d("data-hide"), "hide a note about " + p.name);
    if (d("data-unlink")) return hideRow("person_links", S.sample ? S.raw.links : S.links, d("data-unlink"), "remove a link from " + p.name);
    if (b.id === "sitSave") { var tx = $("#sitText").value.trim(); if (!tx) return; S.open = null; return addSit(id, tx); }
    if (b.id === "linkAdd") return addLink();
    if (b.id === "bSave") { var m = +$("#bM").value, day = +$("#bD").value; if (!(day >= 1 && day <= 31)) return say("Pick a day between 1 and 31."); S.open = null; return patch(id, { birthdayMonth: m, birthdayDay: day }); }
    if (b.id === "bClear") { S.open = null; return patch(id, { birthdayMonth: null, birthdayDay: null }); }
    if (b.id === "edit") return S.sample ? say("This is a sample person.") : S.opts.onEdit && S.opts.onEdit(id);
    if (b.id === "archive") { if (S.sample) return patch(id, { archivedAt: new Date().toISOString() }); select(null); return S.opts.onArchive && S.opts.onArchive(id); }
    if (b.id === "restore") { if (S.sample) return patch(id, { archivedAt: null }); return S.opts.onRestore && S.opts.onRestore(id); }
  }

  /* ---------- mount ---------- */
  function mount(host, opts) {
    S.opts = opts || {};
    if (opts.view === "sky" || opts.view === "list" || opts.view === "tree") S.view = opts.view;
    if (!S.root || S.host !== host) {
      S.host = host; S.root = host.shadowRoot || host.attachShadow({ mode: "open" }); S.root.innerHTML = "";
      var css = document.createElement("link"); css.rel = "stylesheet"; css.href = BASE + "people.css?v=" + VER;
      S.pp = document.createElement("div"); S.pp.className = "pp"; S.pp.style.visibility = "hidden";
      var show = function () { if (S.pp.style.visibility) { S.pp.style.visibility = ""; body(true); } };
      css.onload = show; css.onerror = show; setTimeout(show, 2500);
      S.root.appendChild(css); S.root.appendChild(S.pp);
      fonts(); theme(); shell();
      new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      if (window.ResizeObserver) {
        var rt; new ResizeObserver(function () {
          clearTimeout(rt); rt = setTimeout(function () {
            var w = S.pp.getBoundingClientRect().width; if (!w) return;
            var nw = w <= 820; if (nw !== S.st.narrow) { S.st.narrow = nw; if (nw) S.pp.setAttribute("data-narrow", ""); else S.pp.removeAttribute("data-narrow"); panel(); }
            if (S.M) body(true);
          }, 100);
        }).observe(S.pp);
      }
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (S.M) body(true); });
    }
    refresh(true); load();
  }
  window.PPPeople = { mount: mount, select: function (id) { if (S.root) select(id); }, reload: function () { S.loadedFor = null; if (S.root) load(); } };
})();
