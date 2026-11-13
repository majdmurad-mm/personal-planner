/* Command Center: mounts the page in a shadow root and turns clicks, drags and keys into callbacks.
   It never talks to the database itself; the host (index.html) saves and then calls update(). */
(function () {
  var C = window.PPCommandCore, V = window.PPCommandView, P = window.PPCommand = {};
  var VIEWS = [["today", "Today"], ["areas", "Big picture"], ["week", "Week"], ["month", "Month"], ["horizon", "Horizon"], ["backlog", "Backlog"]];

  P.mount = function (host, o) {
    o = o || {};
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    var S = { view: o.view || "today", q: "", pickerOpen: false, overdueOpen: false, over: null, qa: { text: "", kind: null, msg: "" }, hist: null, sample: !!o.sample, classicToday: !!o.classicToday, areas: o.areas || [] };
    var theme = o.theme || "light", fixedNow = o.now || null, busy = false, terrain = null;
    try { if (localStorage.getItem("pp_cc_actual") === "0") S.showActual = false; } catch (x) {}
    var call = function (name) { var a = [].slice.call(arguments, 1); return Promise.resolve(o[name] ? o[name].apply(null, a) : null); };
    function setData(d) {
      ["items", "goals", "projects", "feed", "feedNote", "mainId", "work", "push", "actual", "pulse"].forEach(function (k) { if (d[k] !== undefined) S[k] = d[k]; });
      S.items = S.items || []; S.byId = {}; S.items.forEach(function (i) { S.byId[i.id] = i; });
      var n = fixedNow || new Date(); S.today = d.today || C.localIso(n); S.nowMin = n.getHours() * 60 + n.getMinutes();
      if (!S.cursor) S.cursor = S.today;
    }
    setData(o);
    root.innerHTML = '<link rel="stylesheet" href="' + (o.css || "command/command.css") + '"><div class="cc"></div>';
    var cc = root.querySelector(".cc"), $ = function (q) { return root.querySelector(q); };

    function shell() {
      cc.dataset.theme = theme;
      cc.innerHTML = (S.sample ? '<div class="ribbon" role="note"><b>SAMPLE DATA</b> · invented items and names · nothing below is yours</div>' : "") +
        '<div class="wrap"><header class="top"><div class="seg" role="group" aria-label="View">' + VIEWS.map(function (v, i) { return '<button data-view="' + v[0] + '" aria-pressed="false" title="Press ' + (i + 1) + '">' + v[1] + "</button>"; }).join("") + '</div>' +
        '<div class="tools"><input class="in search" id="ccSearch" type="search" placeholder="Search ( / ) · Ctrl K" aria-label="Search everything" value=""><button class="btn wait" data-act="waiting" title="Proposals to approve, agent reports and what Claude changed">Waiting for you<span class="wbadge" id="ccWaitN" hidden></span></button><button class="btn" data-act="push" title="Reminders on your phone" aria-label="Reminders">🔔<span class="wide" style="display:inline"> Reminders</span></button><button class="btn pri wide addbtn" data-act="add">+ Add <kbd>N</kbd></button></div></header>' +
        '<div class="legend" id="ccLegend" role="group" aria-label="Areas: click to show one area"></div><main id="ccView"></main></div><button class="fab" data-act="add" aria-label="Add something">+</button><div id="ccOver"></div>';
      draw();
    }
    function legend() {
      var el = $("#ccLegend"); if (!el) return;
      el.innerHTML = ["task", "work", "health", "growth", "people", "sol", "none"].map(function (k) { return '<button data-areaf="' + k + '" aria-pressed="' + (S.areaFilter === k) + '" style="--c:var(--area-' + k + ');--cs:var(--area-' + k + '-soft);--ct:var(--area-' + k + '-text)' + (k === "sol" ? ";--co:var(--area-sol-line)" : "") + '"><i></i>' + C.AREA_NAME[k] + "</button>"; }).join("") +
        '<button class="act-t" data-act="actual" aria-pressed="' + (S.showActual !== false) + '" title="Workouts and sleep that were synced">Show actual</button>';
    }
    function draw() {
      if (S.view === "strategy") S.view = "areas";   // Strategy became the constellation in Big picture
      var v = S.q ? "search" : S.view; legend();
      var all = S.items; S.allItems = all; if (S.areaFilter) S.items = all.filter(function (i) { return C.areaKey(i.area) === S.areaFilter; });
      [].forEach.call(root.querySelectorAll(".seg button"), function (b) { b.setAttribute("aria-pressed", String(!S.q && b.dataset.view === S.view)); });
      if (v === "horizon" && S.hz3d == null) { var pref = null; try { pref = localStorage.getItem("pp_cc_terrain"); } catch (x) {} S.hz3d = pref === "1" || (pref !== "0" && host.getBoundingClientRect().width >= 900 && !(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)); }
      if (terrain) { terrain.destroy(); terrain = null; }
      $("#ccView").innerHTML = '<div class="view" data-v="' + v + '">' + V[v](S) + "</div>"; S.items = all;
      if (v === "horizon" && S.hz3d && window.PPTerrain) {
        var tb = $("#ccTerrain"), fall = function (msg) { S.hz3d = false; S.hzNote = msg; draw(); };
        window.PPTerrain.load().then(function () {
          if (!tb.isConnected || S.view !== "horizon") return;
          try { terrain = window.PPTerrain.mount(tb, V.terrainData(S), { themeEl: cc, only: S.areaFilter && S.areaFilter !== "none" && S.areaFilter !== "sol" ? S.areaFilter : null, noGuard: !!o.noGuard,
            onWeek: function (date, key) { S.view = "week"; S.cursor = date; S.areaFilter = key === "total" ? null : key; draw(); },
            onSlow: function (f) { fall("The 3D view ran at " + f + " frames per second on this device, so this is the roadmap."); },
            onFlat: function () { S.hz3d = false; S.hzNote = ""; draw(); } }); } catch (err) { if (window.console) console.warn(err); fall("The 3D view is not available in this browser, so this is the roadmap."); }
        }, function () { fall("The 3D view could not be loaded, so this is the roadmap."); });
      }
      if (v === "areas" && V.cnMount) V.cnMount(root, S, { open: open, call: call, redraw: draw, patch: function (id, p, label) { return call("onPatch", id, p, label); } });
      drawOver(true);
    }
    function drawOver(fromData) {
      var el = $("#ccOver"), ov = S.over, act = root.activeElement, fid = act && act.id;
      if (!ov) { el.innerHTML = ""; return; }
      if ((ov.type === "quick" || ov.type === "palette") && fromData && el.firstChild) return;            // never redraw under the typing cursor
      var it = ov.id ? S.byId[ov.id] : null, body = "";
      if ((ov.type === "item" || ov.type === "pick") && !it) { S.over = null; el.innerHTML = ""; return; }
      if (ov.type === "item") body = V.sheet(S, it, ov.date, S.hist);
      else if (ov.type === "day") body = V.daySheet(S, ov.date);
      else if (ov.type === "pick") body = V.pick(S, it);
      else if (ov.type === "quick") body = V.quick(S, parsed());
      else if (ov.type === "review") body = V.review(S);
      else if (ov.type === "push") body = V.push(S);
      else if (ov.type === "palette") body = V.palette(S);
      var st = el.querySelector(".sheet"), top = st ? st.scrollTop : 0;
      el.innerHTML = '<div class="shade' + (ov.type === "quick" || ov.type === "pick" || ov.type === "palette" ? " mid" : "") + '" data-shade="1"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + ({ item: "Details", day: "Day", pick: "Pick a date", quick: "Quick add", review: "Weekly review", push: "Reminders", palette: "Command palette" })[ov.type] + '">' + body + "</div></div>";
      var s2 = el.querySelector(".sheet"); if (s2 && fromData) s2.scrollTop = top;
      if (fid && fromData) { var f = root.getElementById(fid); if (f) f.focus(); }
    }
    function open(over) {
      S.over = over; S.hist = null; drawOver(false);
      var first = over.type === "quick" ? $("#ccQ") : over.type === "palette" ? $("#ccPal") : $("#ccOver .x"); if (first) first.focus();
      if (over.type === "quick") { var q = $("#ccQ"); q.setSelectionRange(q.value.length, q.value.length); }
      if (over.type === "item") call("onHistory", over.id).then(function (h) { if (S.over && S.over.id === over.id) { S.hist = h || []; drawOver(true); } }, function () { S.hist = []; drawOver(true); });
    }
    function close() { S.over = null; drawOver(false); }
    function runPal(i) {
      var r = V.paletteResults(S, S.pq)[i]; if (!r) return; S.pq = ""; S.psel = 0;
      if (r.kind === "view") { close(); S.view = r.view; S.q = ""; S.cursor = S.today; call("onView", S.view); draw(); }
      else if (r.kind === "item") open({ type: "item", id: r.id, date: null });
      else if (r.kind === "move") { close(); guard(call("onPatch", r.id, { time: r.time }, "move")); }
      else if (r.kind === "add") { close(); guard(call("onCreate", C.parseQuick(r.text, S.today, S.areas))); }
    }
    function parsed() { var p = C.parseQuick(S.qa.text, S.today, S.areas); if (S.qa.kind) p.kind = S.qa.kind; if (S.qa.date && !p.date) p.date = S.qa.date; return p; }
    function guard(pr) { if (busy) return; busy = true; return Promise.resolve(pr).then(function () { busy = false; }, function (e) { busy = false; if (window.console) console.warn(e); }); }
    var occOf = function (key) { var i = key.lastIndexOf("@"), it = S.byId[key.slice(0, i)]; return it ? { item: it, date: key.slice(i + 1) || null } : null; };

    /* ----- actions ----- */
    function toggleDone(key) {
      var x = occOf(key); if (!x) return; var it = x.item;
      if (it.recurrence) { var d = x.date || S.today, list = (it.doneDates || []).slice(), i = list.indexOf(d); if (i >= 0) list.splice(i, 1); else list.push(d); return call("onPatch", it.id, { doneDates: list }, i >= 0 ? "reopen" : "complete"); }
      return call("onPatch", it.id, { done: !it.done }, it.done ? "reopen" : "complete");
    }
    // Moving one date of a repeating item: skip that date and add a one-off copy on the new day.
    function moveTo(it, fromDate, toDate) {
      if (it.recurrence && fromDate) return call("onPatch", it.id, { exceptions: (it.exceptions || []).concat([fromDate]) }, "skip one date").then(function () { return call("onCreate", { title: it.title, kind: it.kind, date: toDate, time: it.time, dur: it.dur, area: it.area, priority: it.priority, allDay: it.allDay, notes: it.notes }); });
      return call("onPatch", it.id, { date: toDate, someday: false }, "reschedule");
    }
    function tri(kind, key) {
      var x = occOf(key); if (!x) return; var it = x.item;
      if (kind === "today") return moveTo(it, x.date, S.today);
      if (kind === "pick") { open({ type: "pick", id: it.id, date: x.date, back: S.over }); return; }
      if (kind === "skip") return call("onPatch", it.id, { exceptions: (it.exceptions || []).concat([x.date]) }, "skip one date");
      if (kind === "someday") return call("onPatch", it.id, { someday: true, date: null, time: null }, "move to someday");
      if (kind === "unsomeday") return call("onPatch", it.id, { someday: false }, "move back to the backlog");
      if (kind === "archive") return call("onArchive", it.id);
    }
    function saveQuick(thenOpen) {
      var p = parsed(); if (!p.title) { $("#ccQ").focus(); return; }
      return call("onCreate", p).then(function (id) {
        if (id === false || id == null) { S.qa.msg = "That could not be saved. Your text is still here; try again."; drawOver(false); return; }
        S.qa = { text: "", kind: null, msg: "" };
        if (thenOpen) open({ type: "item", id: id, date: p.date }); else close();
      });
    }

    cc.addEventListener("click", function (e) {
      if (e.target.dataset && e.target.dataset.shade) { close(); return; }
      var t = e.target.closest("button,[data-day],.chip,[data-ropen],[data-workout]"); if (!t || t.disabled) return; var d = t.dataset, ov = S.over, it = ov && ov.id ? S.byId[ov.id] : null;
      if (d.view) { S.view = d.view; S.q = ""; $("#ccSearch").value = ""; S.cursor = S.today; call("onView", S.view); draw(); }
      else if (d.wotime) { S.woEdit = d.wotime; draw(); var wf = root.getElementById("ccWoT"); if (wf) wf.focus(); }
      else if (d.wocancel) { S.woEdit = null; draw(); }
      else if (d.wosave) { var wv = (root.getElementById("ccWoT") || {}).value || ""; if (!/^\d\d:\d\d$/.test(wv)) return; guard(call("onSetWorkoutTime", d.wosave, d.date, wv).then(function () { S.woEdit = null; draw(); })); }
      else if (d.done) guard(toggleDone(d.done));
      else if (d.tri) guard(tri(d.tri, d.key));
      else if (d.open) open({ type: "item", id: d.open, date: d.date || null });
      else if (d.day) open({ type: "day", date: d.day });
      else if (d.addday) { S.qa = { text: "", kind: null, msg: "", date: d.addday }; open({ type: "quick" }); }
      else if (d.main) { S.pickerOpen = false; guard(call("onSetMain", d.main)); }
      else if (d.mainTomorrow) guard(call("onPatch", d.mainTomorrow, { date: C.add(S.today, 1) }, "move to tomorrow"));
      else if (d.undo) { t.disabled = true; guard(call("onUndo", d.undo)); }
      else if (d.goal) call("onOpenGoal", d.goal);
      else if (d.project) call("onOpenProject", d.project);
      else if (d.move) { S.cursor = C.add(S.cursor, +d.move); draw(); }
      else if (d.movem) { var y = +S.cursor.slice(0, 4), m = +S.cursor.slice(5, 7) - 1 + +d.movem; S.cursor = C.localIso(new Date(y, m, 1)); draw(); }
      else if (d.qkind) { S.qa.kind = d.qkind; $("#ccParsed").innerHTML = V.parsed(S, parsed()); }
      else if (d.pickdate && it) { var back = ov; guard(Promise.resolve(moveTo(it, ov.date, d.pickdate)).then(function () { if (S.over === back) close(); })); }
      else if (d.rem != null && it) { var r = (it.reminders || []).slice(), n = +d.rem, i = r.indexOf(n); if (i >= 0) r.splice(i, 1); else r.push(n); guard(call("onPatch", it.id, { reminders: r.sort(function (a, b) { return a - b; }) }, "change reminders")); }
      else if (d.mute && it) guard(call("onPatch", it.id, { muted: !it.muted }, "mute"));
      else if (d.quick && it) {
        var q = d.quick, date = ov.date || it.date;
        if (q === "tomorrow") guard(moveTo(it, it.recurrence ? date : null, C.add(S.today, 1)));
        else if (q === "nextweek") guard(moveTo(it, it.recurrence ? date : null, C.add(C.monday(S.today), 7)));
        else if (q === "someday") guard(call("onPatch", it.id, it.someday ? { someday: false } : { someday: true, date: null, time: null }, "someday"));
        else if (q === "skip") guard(Promise.resolve(tri("skip", it.id + "@" + date)).then(close));
        else if (q === "main") guard(call("onSetMain", it.id));
        else if (q === "archive") { close(); guard(call("onArchive", it.id)); }
        else if (q === "full") { close(); call("onOpenFull", it.id); }
      }
      else if (d.act === "close") close();
      else if (d.act === "hz3d" || d.act === "hz2d") { S.hz3d = d.act === "hz3d"; S.hzNote = ""; try { localStorage.setItem("pp_cc_terrain", S.hz3d ? "1" : "0"); } catch (x) {} draw(); }
      else if (d.act === "hzflat" && terrain) terrain.flatten();
      else if (d.pal != null) runPal(+d.pal);
      else if (d.pattern) { S.pattern = S.pattern === d.pattern ? null : d.pattern; draw(); }
      else if (d.ropen) open({ type: "item", id: d.ropen, date: S.today });
      else if (d.go) { if (t.querySelector("[data-blur]") && !S.unblur) { S.unblur = true; draw(); } else call("onGo", d.go); }
      else if (d.act === "planday") { S.plan = V.proposePlan(S); draw(); }
      else if (d.act === "planno") { S.plan = null; draw(); }
      else if (d.act === "planok" && S.plan) { var todo = S.plan.slice(); S.plan = null; guard(todo.reduce(function (p, x) { return p.then(function () { return call("onPatch", x.id, { date: S.today, time: x.time, someday: false }, "plan the day"); }); }, Promise.resolve())); }
      else if (d.planone && S.plan) { var one = S.plan.filter(function (x) { return x.id === d.planone; })[0]; S.plan = S.plan.filter(function (x) { return x.id !== d.planone; }); if (!S.plan.length) S.plan = null; if (one) guard(call("onPatch", one.id, { date: S.today, time: one.time, someday: false }, "plan the day")); }
      else if (d.eve) { if (d.eve === "done") guard(toggleDone(d.key)); else if (d.eve === "moved") { var ex = occOf(d.key); if (ex) guard(moveTo(ex.item, ex.item.recurrence ? ex.date : null, C.add(S.today, 1))); } else guard(tri("archive", d.key)); }
      else if (d.act === "actual") { S.showActual = S.showActual === false; try { localStorage.setItem("pp_cc_actual", S.showActual ? "1" : "0"); } catch (x) {} draw(); }
      else if (d.areaf) { S.areaFilter = S.areaFilter === d.areaf ? null : d.areaf; draw(); var b0 = root.querySelector('[data-areaf="' + d.areaf + '"]'); if (b0) b0.focus(); }
      else if (d.workout) call("onOpenWorkout", d.workout);
      else if (d.act === "waiting") call("onOpenWaiting");
      else if (d.act === "push") { open({ type: "push" }); call("onPush", "refresh"); }
      else if (d.act === "pushon") call("onPush", "enable");
      else if (d.act === "pushoff") call("onPush", "disable");
      else if (d.act === "pushtest") call("onPush", "test");
      else if (d.act === "add") { S.qa.date = null; open({ type: "quick" }); }
      else if (d.act === "qsave") guard(saveQuick(false));
      else if (d.act === "qmore") guard(saveQuick(true));
      else if (d.act === "picker") { S.pickerOpen = !S.pickerOpen; draw(); }
      else if (d.act === "overdue") { S.overdueOpen = !S.overdueOpen; draw(); }
      else if (d.act === "now") { S.cursor = S.today; draw(); }
      else if (d.act === "review") open({ type: "review" });
      else if (d.cnfocus) { if (V.cnFocus) V.cnFocus(d.cnfocus); }
      else if (d.bpx) { S.bpOpen = S.bpOpen || {}; S.bpOpen[d.bpx] = d.bpopen ? true : !S.bpOpen[d.bpx]; if (S.view !== "areas") S.view = "areas"; draw(); var gb = root.querySelector('.bp-gh[data-bpx="' + d.bpx + '"]'); if (gb) { gb.focus(); if (d.bpopen && gb.scrollIntoView) gb.scrollIntoView({ block: "center", behavior: (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) ? "auto" : "smooth" }); } }
      else if (d.act === "newgoal") call("onNewGoal");
      else if (d.act === "newproject") call("onNewProject");
      else if (d.act === "pickok" && it) { var v = $("#ccPick").value; if (!v) { $("#ccPick").focus(); return; } var bk = ov; guard(Promise.resolve(moveTo(it, ov.date, v)).then(function () { if (S.over === bk) close(); })); }
    });
    cc.addEventListener("toggle", function (e) { var x = e.target; if (x.classList && x.classList.contains("tn")) { S.treeOpen = S.treeOpen || {}; S.treeOpen[x.dataset.tree] = x.open; } }, true);
    cc.addEventListener("input", function (e) {
      if (e.target.id === "ccSearch") { S.q = e.target.value.trim(); draw(); }
      else if (e.target.id === "ccPal") { S.pq = e.target.value; S.psel = 0; $("#ccPalList").innerHTML = V.paletteList(V.paletteResults(S, S.pq), 0); }
      else if (e.target.id === "ccQ") { S.qa.text = e.target.value; S.qa.msg = ""; $("#ccParsed").innerHTML = V.parsed(S, parsed()); }
    });
    cc.addEventListener("change", function (e) {
      var pf = e.target.dataset && e.target.dataset.pf; if (pf) { var pv = {}; pv[pf] = e.target.type === "checkbox" ? e.target.checked : e.target.value; if (e.target.type !== "checkbox" && !pv[pf]) return; call("onPushSettings", pv); return; }
      var f = e.target.dataset && e.target.dataset.f, ov = S.over, it = ov && ov.id ? S.byId[ov.id] : null; if (!f || !it) return;
      var v = e.target.value, patch = {};
      if (f === "title") { v = v.trim(); if (!v) { e.target.value = it.title; return; } }
      if (f === "dur") v = v === "" ? null : Math.max(0, Math.round(+v) || 0);
      if (f === "date" || f === "time" || f === "area" || f === "priority" || f === "recurrence") v = v || null;
      if (f === "parent") { var pp = v ? v.split(":") : ["none", null]; guard(call("onPatch", it.id, { parentType: pp[0], parentId: pp[1] || null }, "move")); return; }
      patch[f] = v;
      if (f === "date" && v) patch.someday = false;
      if (f === "recurrence" && v && !it.date) patch.date = S.today;
      guard(call("onPatch", it.id, patch, "edit"));
    });
    cc.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("chip")) { e.preventDefault(); e.target.click(); }
      if (e.target.id === "ccPal" && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
        e.preventDefault(); var res = V.paletteResults(S, S.pq);
        if (e.key === "Enter") { runPal(Math.min(S.psel || 0, res.length - 1)); return; }
        S.psel = Math.max(0, Math.min(res.length - 1, (S.psel || 0) + (e.key === "ArrowDown" ? 1 : -1))); $("#ccPalList").innerHTML = V.paletteList(res, S.psel); return;
      }
      /* arrow keys walk through the items of a list */
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.target.closest && e.target.closest(".it") && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) {
        var rows = [].slice.call(root.querySelectorAll(".view .it")), at = rows.indexOf(e.target.closest(".it")), nx = rows[at + (e.key === "ArrowDown" ? 1 : -1)];
        if (nx) { e.preventDefault(); var fb2 = nx.querySelector(e.target.classList.contains("box") ? ".box, .ti button" : ".ti button"); if (fb2) fb2.focus(); }
      }
      if (e.key === " " && e.target.closest && e.target.closest(".it .ti") && e.target.tagName === "BUTTON") { var bx = e.target.closest(".it").querySelector(".box"); if (bx) { e.preventDefault(); bx.click(); } }
      if (e.key === "Enter" && e.target.id === "ccQ") { e.preventDefault(); guard(saveQuick(e.ctrlKey || e.metaKey)); }
      if (e.key === "Enter" && e.target.id === "ccPick") { e.preventDefault(); $('[data-act="pickok"]').click(); }
      if (e.key === "Escape" && e.target.id === "ccSearch" && S.q) { S.q = ""; e.target.value = ""; draw(); e.stopPropagation(); }
    });
    /* drag from the tray onto a day or a time */
    var dragId = null, clearDrop = function () { [].forEach.call(root.querySelectorAll(".drop"), function (x) { x.classList.remove("drop"); }); };
    cc.addEventListener("dragstart", function (e) { var c = e.target.closest && e.target.closest("[data-drag]"); if (!c) return; dragId = c.dataset.drag; try { e.dataTransfer.setData("text/plain", dragId); e.dataTransfer.effectAllowed = "move"; } catch (x) {} });
    function ringTime(svg, e) {
      var r = svg.getBoundingClientRect(), x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2), a = Math.atan2(x, -y) - Math.PI; if (a < 0) a += Math.PI * 2;
      var m = Math.round(a / (Math.PI * 2) * 1440 / 15) * 15, it = S.byId[dragId] || {}, need = it.est || it.dur || 30, D = V.dayModel(S), gaps = D.free.filter(function (f) { return f[1] - f[0] >= Math.min(need, 15); });
      if (!gaps.length) return C.hhmm(m);
      var best = gaps[0], bd = 1e9; gaps.forEach(function (f) { var dist = m < f[0] ? f[0] - m : m > f[1] ? m - f[1] : 0; if (dist < bd) { bd = dist; best = f; } });
      var g0 = Math.ceil(best[0] / 15) * 15; return C.hhmm(Math.max(g0, Math.min(m, Math.max(g0, best[1] - need))));
    }
    cc.addEventListener("dragover", function (e) { var rg = dragId && e.target.closest("[data-dropring]"); if (rg) { e.preventDefault(); rg.classList.add("drop"); return; } var z = dragId && e.target.closest("[data-dropcol],[data-dropday]"); if (!z) return; e.preventDefault(); if (!z.classList.contains("drop")) { clearDrop(); z.classList.add("drop"); } });
    cc.addEventListener("dragend", function () { dragId = null; clearDrop(); });
    cc.addEventListener("drop", function (e) {
      var rg = dragId && e.target.closest("[data-dropring]");
      if (rg) { e.preventDefault(); clearDrop(); var rid = dragId, tm = ringTime(rg, e); dragId = null; guard(call("onPatch", rid, { date: S.today, time: tm, someday: false }, "schedule")); return; }
      var z = dragId && e.target.closest("[data-dropcol],[data-dropday]"); clearDrop(); if (!z) return; e.preventDefault();
      var id = dragId, patch; dragId = null;
      if (z.dataset.dropcol) { var r = z.getBoundingClientRect(), mins = 7 * 60 + (e.clientY - r.top) / r.height * 16 * 60; patch = { date: z.dataset.dropcol, time: C.hhmm(Math.round(mins / 15) * 15), someday: false }; }
      else patch = { date: z.dataset.dropday, someday: false };
      guard(call("onPatch", id, patch, "schedule"));
    });
    P._ringDrop = function (id, clientX, clientY) { dragId = id; var tm = ringTime($("#ccRing"), { clientX: clientX, clientY: clientY }); dragId = null; return call("onPatch", id, { date: S.today, time: tm, someday: false }, "schedule").then(function () { return tm; }); };
    /* Week grid, calendar style: drag a block to move it (day and time, 15-minute steps), drag its top or bottom
       edge to change the start or the length. The move shows at once and saves (the host's toast offers Undo).
       Repeating items ask "this one / this and all following". Google items are locked. Esc cancels a drag. */
    var gd = null, noClick = 0, WDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    var gTop = function (m) { return "calc(" + ((m - 420) / 60).toFixed(3) + "*var(--hh) + 1px)"; }, gH = function (l) { return "calc(" + (l / 60).toFixed(3) + "*var(--hh) - 2px)"; };
    var dayDiff = function (a, b) { return Math.round((C.ms(a) - C.ms(b)) / 864e5); };
    function shiftRule(rule, delta) {
      if (!delta) return rule;
      return rule.split(";").map(function (p) {
        var kv = p.split("="); if (kv[0] === "BYDAY") return "BYDAY=" + kv[1].split(",").map(function (d) { var m = /^([+-]?\d*)(SU|MO|TU|WE|TH|FR|SA)$/.exec(d); return m ? m[1] + WDAYS[((WDAYS.indexOf(m[2]) + delta) % 7 + 7) % 7] : d; }).join(",");
        if (kv[0] === "BYMONTHDAY") return "BYMONTHDAY=" + kv[1].split(",").map(function (d) { var n = +d; return n > 0 ? Math.max(1, Math.min(31, n + delta)) : n; }).join(",");
        return p;
      }).join(";");
    }
    var untilRule = function (rule, last) { return rule.split(";").filter(function (p) { return !/^(UNTIL|COUNT)=/.test(p); }).concat("UNTIL=" + last.replace(/-/g, "")).join(";"); };
    var dropCount = function (rule) { return rule.split(";").filter(function (p) { return !/^(UNTIL|COUNT)=/.test(p); }).join(";"); };
    function gCols() { return [].slice.call(root.querySelectorAll("[data-dropcol]")); }
    function gCancel() { if (!gd) return; var g = gd; gd = null; try { g.el.releasePointerCapture(g.pid); } catch (x) {} if (g.moved) { noClick = Date.now(); draw(); } }
    cc.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || gd) return;
      var b = e.target.closest && e.target.closest(".blk[data-blk]"), col = b && b.closest("[data-dropcol]"), it = b && S.byId[b.dataset.blk]; if (!col || !it) return;
      var rz = e.target.closest(".rz"), r = col.getBoundingClientRect();
      gd = { el: b, it: it, mode: rz ? (rz.classList.contains("t") ? "top" : "bot") : "move", x0: e.clientX, y0: e.clientY, ppm: r.height / (16 * 60), s0: +b.dataset.s, len0: +b.dataset.len, d0: b.dataset.date, pid: e.pointerId, moved: false };
      gd.s = gd.s0; gd.len = gd.len0; gd.d = gd.d0;
      if (rz) e.preventDefault();
    });
    cc.addEventListener("pointermove", function (e) {
      var g = gd; if (!g || e.pointerId !== g.pid) return;
      var dy = e.clientY - g.y0, dx = e.clientX - g.x0;
      if (!g.moved) { if (Math.abs(dx) + Math.abs(dy) < 5) return; g.moved = true; try { g.el.setPointerCapture(g.pid); } catch (x) {} g.el.classList.add("gdrag"); g.tip = document.createElement("span"); g.tip.className = "gtip"; g.el.appendChild(g.tip); }
      e.preventDefault();
      var snap = function (m) { return Math.round(m / 15) * 15; }, lo = 420, hi = 420 + 16 * 60;
      if (g.mode === "move") {
        g.s = Math.max(lo, Math.min(hi - 15, snap(g.s0 + dy / g.ppm)));
        var col = gCols().filter(function (c) { var r = c.getBoundingClientRect(); return e.clientX >= r.left && e.clientX < r.right; })[0];
        if (col && col.dataset.dropcol !== g.d) { g.d = col.dataset.dropcol; col.appendChild(g.el); }
      } else if (g.mode === "bot") g.len = Math.max(15, Math.min(hi, snap(g.s0 + g.len0 + dy / g.ppm)) - g.s0);
      else { var end = g.s0 + g.len0; g.s = Math.max(lo, Math.min(end - 15, snap(g.s0 + dy / g.ppm))); g.len = end - g.s; }
      g.el.style.top = gTop(g.s); g.el.style.height = gH(g.len);
      g.tip.textContent = (g.d !== g.d0 ? fmtShort(g.d) + " · " : "") + C.hhmm(g.s) + "–" + C.hhmm(g.s + g.len);
    });
    var fmtShort = function (d) { return new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric" }); };
    cc.addEventListener("pointercancel", gCancel);
    cc.addEventListener("pointerup", function (e) {
      var g = gd; if (!g || e.pointerId !== g.pid) return; gd = null;
      try { g.el.releasePointerCapture(g.pid); } catch (x) {}
      if (!g.moved) return;
      noClick = Date.now();
      var patch = {}; if (g.d !== g.d0) patch.date = g.d; if (g.s !== g.s0) patch.time = C.hhmm(g.s); if (g.len !== g.len0) patch.dur = g.len;
      if (!Object.keys(patch).length) { draw(); return; }
      gApply(g, patch);
    });
    cc.addEventListener("click", function (e) { if (Date.now() - noClick < 400 && e.target.closest && e.target.closest(".blk")) { e.stopPropagation(); e.preventDefault(); } }, true);
    function gApply(g, patch) {
      var it = g.it, label = g.mode === "move" ? "move" : "resize";
      if (!it.recurrence) {
        if (patch.date) it.date = patch.date; if (patch.time) it.time = patch.time; if (patch.dur) it.dur = patch.dur; draw();   // shows at once
        guard(call("onPatch", it.id, patch, label)); return;
      }
      gAsk("Move a repeating item", "“" + it.title + "” repeats. Change only " + fmtShort(g.d0) + ", or this one and every one after it?", function (which) {
        if (!which) { draw(); return; }
        var time = patch.time || it.time, dur = patch.dur || it.dur || g.len0;
        if (which === "one") {
          var copy = { title: it.title, kind: it.kind, area: it.area || null, date: g.d, time: time, dur: dur, notes: it.notes || "", priority: it.priority || null };
          guard(call("onPatch", it.id, { exceptions: (it.exceptions || []).concat(g.d0) }, "move one date of").then(function () { return call("onCreate", copy); }).then(function (nid) {
            if (nid && (it.projectId || it.goalId)) return call("onPatch", nid, it.projectId ? { parentType: "project", parentId: it.projectId } : { parentType: "goal", parentId: it.goalId }, "file");
          }));
          return;
        }
        var delta = g.d === g.d0 ? 0 : dayDiff(g.d, g.d0);
        if (!it.date || g.d0 <= it.date) {   // the first one: move the whole series
          var sp = { time: time, dur: dur }; if (delta) { sp.date = C.add(it.date || g.d0, delta); sp.recurrence = shiftRule(it.recurrence, delta); }
          guard(call("onPatch", it.id, sp, label)); return;
        }
        var next = { title: it.title, kind: it.kind, area: it.area || null, date: g.d, time: time, dur: dur, notes: it.notes || "", priority: it.priority || null, recurrence: shiftRule(dropCount(it.recurrence), delta) };
        guard(call("onPatch", it.id, { recurrence: untilRule(it.recurrence, C.add(g.d0, -1)) }, "end").then(function () { return call("onCreate", next); }).then(function (nid) {
          if (nid && (it.projectId || it.goalId)) return call("onPatch", nid, it.projectId ? { parentType: "project", parentId: it.projectId } : { parentType: "goal", parentId: it.goalId }, "file");
        }));
      });
    }
    /* the small "this one / all following" question */
    var askDone = null;
    function gAsk(title, text, done, labels) {
      var old = root.getElementById("ccAsk"); if (old) old.remove();
      labels = labels || ["This one", "This and all following"];
      var d = document.createElement("div"); d.id = "ccAsk"; d.className = "ask-ov";
      d.innerHTML = '<div class="ask" role="dialog" aria-modal="true" aria-labelledby="ccAskT"><h3 id="ccAskT"></h3><p class="sub"></p><div class="acts"><button class="btn pri" data-ask="one"></button><button class="btn" data-ask="all"></button><button class="btn ghost" data-ask="">Cancel</button></div></div>';
      d.querySelector("h3").textContent = title; d.querySelector("p").textContent = text; d.querySelector('[data-ask="one"]').textContent = labels[0]; d.querySelector('[data-ask="all"]').textContent = labels[1];
      var prev = root.activeElement;
      askDone = function (v) { askDone = null; d.remove(); try { if (prev && prev.isConnected) prev.focus(); } catch (x) {} done(v); };
      d.addEventListener("click", function (e) { var b = e.target.closest("[data-ask]"); if (b) askDone(b.dataset.ask || null); else if (e.target === d) askDone(null); });
      cc.appendChild(d); d.querySelector('[data-ask="one"]').focus();
    }
    /* Delete on a focused block archives it (a repeating one asks: just this date, or the whole series) */
    function gArchive(b) {
      var it = S.byId[b.dataset.blk]; if (!it) return;
      if (!it.recurrence) { it.archived = true; draw(); guard(call("onArchive", it.id)); return; }
      gAsk("Archive a repeating item", "“" + it.title + "” repeats. Archive only " + fmtShort(b.dataset.date) + ", or the whole series?", function (which) {
        if (which === "one") guard(call("onPatch", it.id, { exceptions: (it.exceptions || []).concat(b.dataset.date) }, "skip one date of"));
        else if (which === "all") guard(call("onArchive", it.id));
      }, ["Only this date", "The whole series"]);
    }
    P._ask = function (v) { if (askDone) askDone(v); };
    P._drop = function (id, date, time) { return call("onPatch", id, time ? { date: date, time: time, someday: false } : { date: date, someday: false }, "schedule"); };
    /* keyboard: N add, / search, 1-5 views, arrows move, Esc closes, D done */
    function onKey(e) {
      if (!host.isConnected || host.offsetParent === null) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); S.pq = ""; S.psel = 0; open({ type: "palette" }); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var el = e.composedPath ? e.composedPath()[0] : e.target, typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (e.key === "Escape" && gd) { e.preventDefault(); gCancel(); return; }
      if (e.key === "Escape" && askDone) { e.preventDefault(); askDone(null); return; }
      if (e.key === "Escape" && S.over) { e.preventDefault(); close(); return; }
      if (typing || document.querySelector(".modal-overlay.open,.modal.open")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && !askDone && el && el.closest && el.closest(".blk[data-blk]")) { e.preventDefault(); gArchive(el.closest(".blk[data-blk]")); return; }
      var k = e.key.toLowerCase();
      if (k === "n") { e.preventDefault(); S.qa.date = null; open({ type: "quick" }); }
      else if (k === "/") { e.preventDefault(); $("#ccSearch").focus(); }
      else if (S.over) { if (k === "d" && S.over.type === "item") { var it = S.byId[S.over.id]; if (it && C.hasDone(it)) guard(toggleDone(it.id + "@" + (S.over.date || it.date || S.today))); } }
      else if (/^[1-7]$/.test(k)) { S.view = VIEWS[+k - 1][0]; S.q = ""; S.cursor = S.today; call("onView", S.view); draw(); }
      else if (k === "t") { S.view = "today"; S.cursor = S.today; draw(); }
      else if (k === "w" || k === "m" || k === "h") { S.view = { w: "week", m: "month", h: "horizon" }[k]; S.q = ""; S.cursor = S.today; call("onView", S.view); draw(); }
      else if ((k === "arrowleft" || k === "arrowright") && (S.view === "week" || S.view === "month")) { var b = $(S.view === "week" ? '[data-move="' + (k === "arrowleft" ? -7 : 7) + '"]' : '[data-movem="' + (k === "arrowleft" ? -1 : 1) + '"]'); if (b) b.click(); }
    }
    document.addEventListener("keydown", onKey);
    var tick = setInterval(function () { if (fixedNow || !host.isConnected) return; var n = new Date(), m = n.getHours() * 60 + n.getMinutes(); if (m === S.nowMin) return; S.nowMin = m; S.today = C.localIso(n); if (S.view === "today" && !S.q && !S.over && !dragId && host.offsetParent !== null) draw(); }, 20000);
    shell();
    function setWaiting(n) { S.waiting = n; var b = root.getElementById("ccWaitN"); if (!b) return; b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n || ""); var w = b.parentNode; if (w) w.setAttribute("aria-label", "Waiting for you" + (n ? ", " + n + " waiting" : "")); }
    return {
      setWaiting: setWaiting,
      update: function (d) { if (d.theme) theme = d.theme; setData(d); cc.dataset.theme = theme; draw(); },
      setView: function (v) { S.view = v === "strategy" ? "areas" : v; draw(); },
      terrain: function () { return terrain; },
      open: open, state: function () { return { view: S.view, over: S.over && S.over.type }; },
      destroy: function () { document.removeEventListener("keydown", onKey); clearInterval(tick); }
    };
  };
})();
