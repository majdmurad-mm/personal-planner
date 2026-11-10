/* Command Center: mounts the page in a shadow root and turns clicks, drags and keys into callbacks.
   It never talks to the database itself; the host (index.html) saves and then calls update(). */
(function () {
  var C = window.PPCommandCore, V = window.PPCommandView, P = window.PPCommand = {};
  var VIEWS = [["today", "Today"], ["week", "Week"], ["month", "Month"], ["horizon", "Horizon"], ["strategy", "Strategy"], ["backlog", "Backlog"]];

  P.mount = function (host, o) {
    o = o || {};
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    var S = { view: o.view || "today", q: "", pickerOpen: false, overdueOpen: false, over: null, qa: { text: "", kind: null, msg: "" }, hist: null, sample: !!o.sample, areas: o.areas || [] };
    var theme = o.theme || "light", fixedNow = o.now || null, busy = false;
    var call = function (name) { var a = [].slice.call(arguments, 1); return Promise.resolve(o[name] ? o[name].apply(null, a) : null); };
    function setData(d) {
      ["items", "goals", "projects", "feed", "feedNote", "mainId", "work"].forEach(function (k) { if (d[k] !== undefined) S[k] = d[k]; });
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
        '<div class="tools"><input class="in search" id="ccSearch" type="search" placeholder="Search  ( / )" aria-label="Search everything" value=""><button class="btn pri wide" style="display:inline-flex" data-act="add">+ Add <kbd>N</kbd></button></div></header>' +
        '<main id="ccView"></main></div><button class="fab" data-act="add" aria-label="Add something">+</button><div id="ccOver"></div>';
      draw();
    }
    function draw() {
      var v = S.q ? "search" : S.view;
      [].forEach.call(root.querySelectorAll(".seg button"), function (b) { b.setAttribute("aria-pressed", String(!S.q && b.dataset.view === S.view)); });
      $("#ccView").innerHTML = '<div class="view" data-v="' + v + '">' + V[v](S) + "</div>";
      drawOver(true);
    }
    function drawOver(fromData) {
      var el = $("#ccOver"), ov = S.over, act = root.activeElement, fid = act && act.id;
      if (!ov) { el.innerHTML = ""; return; }
      if (ov.type === "quick" && fromData && el.firstChild) return;            // never redraw under the typing cursor
      var it = ov.id ? S.byId[ov.id] : null, body = "";
      if ((ov.type === "item" || ov.type === "pick") && !it) { S.over = null; el.innerHTML = ""; return; }
      if (ov.type === "item") body = V.sheet(S, it, ov.date, S.hist);
      else if (ov.type === "day") body = V.daySheet(S, ov.date);
      else if (ov.type === "pick") body = V.pick(S, it);
      else if (ov.type === "quick") body = V.quick(S, parsed());
      else if (ov.type === "review") body = V.review(S);
      var st = el.querySelector(".sheet"), top = st ? st.scrollTop : 0;
      el.innerHTML = '<div class="shade' + (ov.type === "quick" || ov.type === "pick" ? " mid" : "") + '" data-shade="1"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + ({ item: "Details", day: "Day", pick: "Pick a date", quick: "Quick add", review: "Weekly review" })[ov.type] + '">' + body + "</div></div>";
      var s2 = el.querySelector(".sheet"); if (s2 && fromData) s2.scrollTop = top;
      if (fid && fromData) { var f = root.getElementById(fid); if (f) f.focus(); }
    }
    function open(over) {
      S.over = over; S.hist = null; drawOver(false);
      var first = over.type === "quick" ? $("#ccQ") : $("#ccOver .x"); if (first) first.focus();
      if (over.type === "quick") { var q = $("#ccQ"); q.setSelectionRange(q.value.length, q.value.length); }
      if (over.type === "item") call("onHistory", over.id).then(function (h) { if (S.over && S.over.id === over.id) { S.hist = h || []; drawOver(true); } }, function () { S.hist = []; drawOver(true); });
    }
    function close() { S.over = null; drawOver(false); }
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
      var t = e.target.closest("button,[data-day],.chip"); if (!t || t.disabled) return; var d = t.dataset, ov = S.over, it = ov && ov.id ? S.byId[ov.id] : null;
      if (d.view) { S.view = d.view; S.q = ""; $("#ccSearch").value = ""; S.cursor = S.today; call("onView", S.view); draw(); }
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
      else if (d.act === "add") { S.qa.date = null; open({ type: "quick" }); }
      else if (d.act === "qsave") guard(saveQuick(false));
      else if (d.act === "qmore") guard(saveQuick(true));
      else if (d.act === "picker") { S.pickerOpen = !S.pickerOpen; draw(); }
      else if (d.act === "overdue") { S.overdueOpen = !S.overdueOpen; draw(); }
      else if (d.act === "now") { S.cursor = S.today; draw(); }
      else if (d.act === "review") open({ type: "review" });
      else if (d.act === "treeall") { S.treeAll = !S.treeAll; S.treeOpen = {}; [].forEach.call(root.querySelectorAll("details.tn"), function (x) { S.treeOpen[x.dataset.tree] = S.treeAll; }); draw(); }
      else if (d.act === "newgoal") call("onNewGoal");
      else if (d.act === "newproject") call("onNewProject");
      else if (d.act === "pickok" && it) { var v = $("#ccPick").value; if (!v) { $("#ccPick").focus(); return; } var bk = ov; guard(Promise.resolve(moveTo(it, ov.date, v)).then(function () { if (S.over === bk) close(); })); }
    });
    cc.addEventListener("toggle", function (e) { var x = e.target; if (x.classList && x.classList.contains("tn")) { S.treeOpen = S.treeOpen || {}; S.treeOpen[x.dataset.tree] = x.open; } }, true);
    cc.addEventListener("input", function (e) {
      if (e.target.id === "ccSearch") { S.q = e.target.value.trim(); draw(); }
      else if (e.target.id === "ccQ") { S.qa.text = e.target.value; S.qa.msg = ""; $("#ccParsed").innerHTML = V.parsed(S, parsed()); }
    });
    cc.addEventListener("change", function (e) {
      var f = e.target.dataset && e.target.dataset.f, ov = S.over, it = ov && ov.id ? S.byId[ov.id] : null; if (!f || !it) return;
      var v = e.target.value, patch = {};
      if (f === "title") { v = v.trim(); if (!v) { e.target.value = it.title; return; } }
      if (f === "dur") v = v === "" ? null : Math.max(0, Math.round(+v) || 0);
      if (f === "date" || f === "time" || f === "area" || f === "priority" || f === "recurrence") v = v || null;
      patch[f] = v;
      if (f === "date" && v) patch.someday = false;
      if (f === "recurrence" && v && !it.date) patch.date = S.today;
      guard(call("onPatch", it.id, patch, "edit"));
    });
    cc.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("chip")) { e.preventDefault(); e.target.click(); }
      if (e.key === "Enter" && e.target.id === "ccQ") { e.preventDefault(); guard(saveQuick(e.ctrlKey || e.metaKey)); }
      if (e.key === "Enter" && e.target.id === "ccPick") { e.preventDefault(); $('[data-act="pickok"]').click(); }
      if (e.key === "Escape" && e.target.id === "ccSearch" && S.q) { S.q = ""; e.target.value = ""; draw(); e.stopPropagation(); }
    });
    /* drag from the tray onto a day or a time */
    var dragId = null, clearDrop = function () { [].forEach.call(root.querySelectorAll(".drop"), function (x) { x.classList.remove("drop"); }); };
    cc.addEventListener("dragstart", function (e) { var c = e.target.closest && e.target.closest("[data-drag]"); if (!c) return; dragId = c.dataset.drag; try { e.dataTransfer.setData("text/plain", dragId); e.dataTransfer.effectAllowed = "move"; } catch (x) {} });
    cc.addEventListener("dragover", function (e) { var z = dragId && e.target.closest("[data-dropcol],[data-dropday]"); if (!z) return; e.preventDefault(); if (!z.classList.contains("drop")) { clearDrop(); z.classList.add("drop"); } });
    cc.addEventListener("dragend", function () { dragId = null; clearDrop(); });
    cc.addEventListener("drop", function (e) {
      var z = dragId && e.target.closest("[data-dropcol],[data-dropday]"); clearDrop(); if (!z) return; e.preventDefault();
      var id = dragId, patch; dragId = null;
      if (z.dataset.dropcol) { var r = z.getBoundingClientRect(), mins = 7 * 60 + (e.clientY - r.top) / r.height * 16 * 60; patch = { date: z.dataset.dropcol, time: C.hhmm(Math.round(mins / 15) * 15), someday: false }; }
      else patch = { date: z.dataset.dropday, someday: false };
      guard(call("onPatch", id, patch, "schedule"));
    });
    P._drop = function (id, date, time) { return call("onPatch", id, time ? { date: date, time: time, someday: false } : { date: date, someday: false }, "schedule"); };
    /* keyboard: N add, / search, 1-5 views, arrows move, Esc closes, D done */
    function onKey(e) {
      if (!host.isConnected || host.offsetParent === null || e.ctrlKey || e.metaKey || e.altKey) return;
      var el = e.composedPath ? e.composedPath()[0] : e.target, typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (e.key === "Escape" && S.over) { e.preventDefault(); close(); return; }
      if (typing || document.querySelector(".modal-overlay.open,.modal.open")) return;
      var k = e.key.toLowerCase();
      if (k === "n") { e.preventDefault(); S.qa.date = null; open({ type: "quick" }); }
      else if (k === "/") { e.preventDefault(); $("#ccSearch").focus(); }
      else if (S.over) { if (k === "d" && S.over.type === "item") { var it = S.byId[S.over.id]; if (it && C.hasDone(it)) guard(toggleDone(it.id + "@" + (S.over.date || it.date || S.today))); } }
      else if (/^[1-6]$/.test(k)) { S.view = VIEWS[+k - 1][0]; S.q = ""; S.cursor = S.today; call("onView", S.view); draw(); }
      else if (k === "t") { S.view = "today"; S.cursor = S.today; draw(); }
      else if ((k === "arrowleft" || k === "arrowright") && (S.view === "week" || S.view === "month")) { var b = $(S.view === "week" ? '[data-move="' + (k === "arrowleft" ? -7 : 7) + '"]' : '[data-movem="' + (k === "arrowleft" ? -1 : 1) + '"]'); if (b) b.click(); }
    }
    document.addEventListener("keydown", onKey);
    shell();
    return {
      update: function (d) { if (d.theme) theme = d.theme; setData(d); cc.dataset.theme = theme; draw(); },
      setView: function (v) { S.view = v; draw(); },
      open: open, state: function () { return { view: S.view, over: S.over && S.over.type }; },
      destroy: function () { document.removeEventListener("keydown", onKey); }
    };
  };
})();
