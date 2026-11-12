/* Health page, part 4 of 4: mounting, data loading, theme, and everything interactive.
   The page lives in a shadow root so the planner's styles and the page's styles never touch. */
(function () {
  var H = window.PPH, clamp = H.clamp, fmt = H.fmt, STATUS = H.STATUS, MUSCLES = H.MUSCLES, esc = H.esc;
  var SRC = (document.currentScript && document.currentScript.src) || "health/health.js";
  var BASE = SRC.replace(/health\.js.*$/, ""), VER = (SRC.match(/[?&]v=([^&]+)/) || [])[1] || "1";
  var THEME_KEY = "pp_health_theme", FRESH_MS = 5 * 60 * 1000;
  var S = { host: null, root: null, hp: null, opts: null, M: null, layer: "recovery", view: "front", loadedAt: 0, busy: false, ui: {}, raw: null, layerSet: false };
  var $ = function (q, el) { return (el || S.root).querySelector(q); };
  var $$ = function (q, el) { return Array.prototype.slice.call((el || S.root).querySelectorAll(q)); };
  var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- theme and fonts ---------- */
  function themePref() { try { return localStorage.getItem(THEME_KEY) || "auto"; } catch (e) { return "auto"; } }
  function applyTheme() {
    if (!S.hp) return; var p = themePref(), t = p === "auto" ? (document.documentElement.dataset.theme === "dark" ? "dark" : "light") : p;
    S.hp.dataset.theme = t; $$(".chip-t").forEach(function (c) { c.setAttribute("aria-pressed", c.dataset.t === p); });
  }
  function fonts() {
    if (document.getElementById("pphFonts") || !window.fetch) return;
    var el = document.createElement("style"); el.id = "pphFonts"; document.head.appendChild(el);
    fetch("https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..700&family=Instrument+Sans:wght@400;500;600&display=swap")
      .then(function (r) { return r.ok ? r.text() : ""; }).then(function (css) { el.textContent = css.split("'Archivo'").join("'Archivo Health'"); }).catch(function () { /* system fonts are fine */ });
  }

  /* ---------- body figure ---------- */
  function muscleText(m) {
    var M = S.M;
    if (!M.sessions.length) return [MUSCLES[m], "No data", "No sessions are logged yet"];
    if (S.layer === "week") { var w = Math.round(M.WEEK[m]); return [MUSCLES[m], w + " set" + (w === 1 ? "" : "s") + " in the last 7 days", w > 20 ? "above the 10–20 band" : w >= 10 ? "in your 10–20 band" : "the band starts at 10"]; }
    var s = H.loadSt(M.LOAD[m]), o = M.DRIVER[m];
    if (!o) return [MUSCLES[m], "Fresh", "Not worked directly in the last 6 days"];
    return [MUSCLES[m], STATUS[s].label, o.sets + " sets on " + o.day + (o.top != null ? " · " + o.top + " kg top set" : "") + (s === "good" ? "" : " · ready " + M.readyDay(m))];
  }
  function flagText(f) { return [esc(f.label), f.word, esc(f.note || (f.state === "cleared" ? "Cleared. Kept here as a reminder." : "No note yet.")) + (f.since ? " · since " + H.dstr(f.since) : "")]; }
  function legend() {
    var M = S.M, lg = function (s, t) { return '<span class="lg ' + s + '"><b class="ic ' + s + '">' + (s === "under" ? "○" : STATUS[s].icon) + "</b> " + t + "</span>"; };
    if (S.layer === "recovery") return lg("good", "Fresh") + lg("watch", "Recovering") + lg("low", "Worked hard") + '<span class="lg-note">Estimated from your logged sets</span>';
    if (S.layer === "week") return lg("under", "Under 10 sets") + lg("good", "10–20 sets") + lg("watch", "Over 20") + '<span class="lg-note">Last 7 days</span>';
    if (S.layer === "vitals") return lg("good", "Good") + lg("watch", "Watch") + lg("none", "No data") + '<span class="lg-note">' + (M.energy == null ? "No Body Battery reading" : "Energy glow · Body Battery " + Math.round(M.energy)) + "</span>";
    return M.flags.length ? lg("good", "Cleared") + lg("watch", "Recovering") : '<span class="lg-note">No flags. Tell Claude if something aches.</span>';
  }
  function listView() {
    var M = S.M;
    if (S.layer === "vitals") return Object.keys(M.vitals).map(function (k) { return "<li><b>" + H.ORGANS[k].label + "</b> " + M.vitals[k].label + ". " + M.vitals[k].text + "</li>"; }).join("");
    if (S.layer === "flags") return M.flags.length ? M.flags.map(function (f) { var t = flagText(f); return "<li><b>" + t[0] + "</b> " + t[1] + ". " + t[2] + "</li>"; }).join("") : "<li>No flags.</li>";
    return Object.keys(MUSCLES).map(function (m) { var t = muscleText(m); return "<li><b>" + t[0] + "</b> " + t[1] + ". " + t[2] + "</li>"; }).join("");
  }
  function paint() {
    var M = S.M, stage = $("#stage"), L = S.layer, flagged = {}; if (!stage) return;
    M.flags.forEach(function (f) { if (MUSCLES[f.region]) flagged[f.region] = f.s; });
    stage.dataset.layer = L; stage.dataset.energy = M.energy == null ? "none" : M.energy >= 70 ? "good" : M.energy >= 45 ? "watch" : "low";
    $$(".mg", stage).forEach(function (g) {
      var m = g.dataset.m, s = "none", a = 0.08, w = M.WEEK[m] || 0;
      if (M.sessions.length && L === "recovery") { s = H.loadSt(M.LOAD[m]); a = s === "good" ? 0.42 : 0.92; }
      else if (M.sessions.length && L === "week") { s = w >= 10 ? (w > 20 ? "watch" : "good") : "under"; a = clamp(0.2 + w / 12, 0.22, 0.95); }
      else if (L === "flags" && flagged[m]) { s = flagged[m]; a = 0.9; }
      g.dataset.s = s; g.style.setProperty("--a", a);
    });
    $$(".organ", stage).forEach(function (g) { g.dataset.s = M.vitals[g.dataset.o].s; g.dataset.mon = (M.conditions || []).some(function (c) { return c.area === g.dataset.o; }) ? "1" : ""; });
    /* one tab stop per thing you can actually read in this layer and on this face */
    var face = S.view === "back" ? "#faceB" : "#faceF", on = function (sel, yes) { $$(sel, stage).forEach(function (g) { g.setAttribute("tabindex", yes && g.closest(face) ? "0" : "-1"); }); };
    on(".muscles .mg", L === "recovery" || L === "week"); on(".organ", L === "vitals"); on(".flagmark", L === "flags");
    $$(".chip-l").forEach(function (c) { c.setAttribute("aria-pressed", c.dataset.l === L); });
    $$(".chip-v").forEach(function (c) { c.setAttribute("aria-pressed", c.dataset.v === S.view); });
    $("#flipper").classList.toggle("back", S.view === "back");
    $("#legend").innerHTML = legend(); $("#a11y").innerHTML = listView();
  }
  function pop(el, parts, stat) {
    var p = $("#pop"), st0 = $("#stage").getBoundingClientRect(), r = el.getBoundingClientRect();
    p.innerHTML = "<b>" + parts[0] + '</b><em class="' + (stat || "") + '">' + parts[1] + "</em><span>" + parts[2] + "</span>"; p.hidden = false;
    var x = r.left + r.width / 2 - st0.left, W = p.offsetWidth;
    p.style.left = clamp(x - W / 2, 4, Math.max(4, st0.width - W - 4)) + "px"; p.style.top = Math.max(0, r.top - st0.top - p.offsetHeight - 8) + "px";
  }
  function wireBody() {
    var M = S.M, stage = $("#stage"), hide = function () { $("#pop").hidden = true; };
    $("#faceF").innerHTML = H.bodySVG("front", M.flags); $("#faceB").innerHTML = H.bodySVG("back", M.flags);
    $$(".chip-l").forEach(function (c) { c.onclick = function () { S.layer = c.dataset.l; var f = M.flags.filter(function (x) { return x.view; })[0]; if (S.layer === "flags" && f) S.view = f.view; if (S.layer === "vitals") S.view = "front"; hide(); paint(); }; });
    $$(".chip-v").forEach(function (c) { c.onclick = function () { S.view = c.dataset.v; hide(); paint(); }; });
    var activate = function (g) {
      if (g.classList.contains("mg")) { if (S.layer === "vitals") return; var fl = S.layer === "flags" ? M.flags.filter(function (f) { return f.region === g.dataset.m; })[0] : null; if (S.layer === "flags") { if (fl) pop(g, flagText(fl), fl.s); return; } pop(g, muscleText(g.dataset.m), g.dataset.s); }
      else if (g.classList.contains("organ")) { if (S.layer !== "vitals") return; var v = M.vitals[g.dataset.o]; pop(g, [H.ORGANS[g.dataset.o].label, v.label, v.text], v.s); }
      else if (g.classList.contains("flagmark")) { var f = M.flags[+g.dataset.f]; if (f) pop(g, flagText(f), f.s); }
    };
    var hit = function (e) { return e.target.closest && e.target.closest(".muscles .mg, .organ, .flagmark"); };
    stage.addEventListener("pointerover", function (e) { var g = hit(e); if (g && e.pointerType !== "touch") activate(g); });
    stage.addEventListener("click", function (e) { var g = hit(e); if (g) activate(g); else hide(); });
    stage.addEventListener("focusin", function (e) { var g = hit(e); if (g) activate(g); else hide(); });
    stage.addEventListener("pointerleave", hide);
    stage.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); else if ((e.key === "Enter" || e.key === " ") && hit(e)) { e.preventDefault(); activate(hit(e)); } });
    paint();
  }

  /* ---------- motion, chart hover, trends ---------- */
  function countUp() {
    $$("[data-count]").forEach(function (el) {
      var to = +el.dataset.count; if (REDUCED || document.hidden) { el.textContent = fmt(to); return; }
      var t0 = performance.now(), D = 900; (function f(t) { var p = Math.min(1, Math.max(0, (t - t0) / D)), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(to * e); if (p < 1) requestAnimationFrame(f); })(t0);
    });
  }
  function wireCharts() {
    var tip = $("#tip");
    H.charts.forEach(function (c) {
      var svg = S.root.getElementById(c.id); if (!svg || svg.dataset.w) return; svg.dataset.w = 1;
      var cross = $(".c-cross", svg);
      var move = function (e) {
        var r = svg.getBoundingClientRect(), hr = S.hp.getBoundingClientRect(), mx = (e.clientX - r.left) / r.width * c.w, best = 0;
        c.x.forEach(function (x, i) { if (Math.abs(x - mx) < Math.abs(c.x[best] - mx)) best = i; });
        tip.textContent = c.labels[best]; tip.hidden = false;
        tip.style.left = clamp(e.clientX - hr.left + 12, 8, Math.max(8, hr.width - tip.offsetWidth - 8)) + "px"; tip.style.top = (e.clientY - hr.top - 36) + "px";
        if (cross) { cross.style.display = ""; cross.setAttribute("x1", c.x[best]); cross.setAttribute("x2", c.x[best]); }
      };
      svg.addEventListener("pointermove", move); svg.addEventListener("pointerdown", move);
      svg.addEventListener("pointerleave", function () { tip.hidden = true; if (cross) cross.style.display = "none"; });
    });
  }
  var PILLAR = { sleep: ["sleep_score", "Sleep score", ""], energy: ["resting_hr", "Resting heart rate", "bpm"], move: ["steps", "Steps", ""] };
  function expandHTML(key, n) {
    var M = S.M, m = PILLAR[key], b = M.B[m[0]];
    return '<div class="range" role="group" aria-label="Range"><button data-r="30" aria-pressed="' + (n === 30) + '">30 days</button><button data-r="90" aria-pressed="' + (n === 90) + '">90 days</button></div>' +
      H.trend(M.col(m[0], n), M.days.slice(-n).map(function (x) { return x.d; }), { band: b ? [b.lo, b.hi] : null, unit: m[2], periods: M.periods, label: m[1] + ", last " + n + " days", empty: "Not enough readings for a trend yet." }) +
      '<p class="hint">' + (b ? "The band is your own usual range. " : "") + "Gaps mean no reading that day." + (M.periods.length ? " Shaded days were sick, injured or a break." : "") + "</p>";
  }
  function wirePillars() {
    $$("[data-pillar]").forEach(function (p) {
      var btn = $(".expand", p), box = $(".deep", p), key = p.dataset.pillar;
      btn.onclick = function () { var o = p.classList.toggle("open"); btn.setAttribute("aria-expanded", o); btn.textContent = o ? "Close trend" : "See trend"; if (o) { box.innerHTML = expandHTML(key, 30); wireCharts(); } else box.innerHTML = ""; };
      box.addEventListener("click", function (e) { var r = e.target.dataset && e.target.dataset.r; if (r) { box.innerHTML = expandHTML(key, +r); wireCharts(); var again = $('[data-r="' + r + '"]', box); if (again) again.focus(); } });
    });
  }

  /* ---------- render and load ---------- */
  function render(raw) {
    var now = S.opts.now || new Date(); S.raw = raw;
    S.M = H.build(JSON.parse(JSON.stringify(raw)), now);
    if (!S.layerSet) { S.layerSet = true; if (S.M.pains.length) { S.layer = "flags"; var f = S.M.pains.filter(function (x) { return x.view; })[0]; if (f) S.view = f.view; } }
    paintPage();
  }
  /* draw the page for the current UI state (overview or one detail view) */
  /* a selector for whatever has focus, so a redraw can put it back */
  function focusKey() {
    var el = S.root && S.root.activeElement; if (!el || !S.hp.contains(el)) return null;
    if (el.id) return "#" + el.id;
    var at = ["data-act", "data-detail", "data-ex", "data-day", "data-v", "data-d", "data-id", "data-l", "data-date"].filter(function (k) { return el.hasAttribute(k); });
    return at.length ? at.map(function (k) { return "[" + k + "=\"" + String(el.getAttribute(k)).replace(/"/g, "\\\"") + "\"]"; }).join("") : null;
  }
  function paintPage(focusSel) {
    if (!focusSel) focusSel = focusKey();
    var M = S.M; H.charts.length = 0; S.hp.innerHTML = H.pageHTML(M, S.ui);
    $$(".chip-t").forEach(function (c) { c.onclick = function () { try { localStorage.setItem(THEME_KEY, c.dataset.t); } catch (e) { } applyTheme(); }; });
    $("#refresh").onclick = function () { load(true); };
    applyTheme(); if ($("#stage")) wireBody(); wireCharts(); wirePillars(); countUp(); paintFigures();
    if (S.ui.detail === "workouts" && H.libState === "idle") H.loadLibrary(function () { if (S.ui.detail === "workouts") paintPage(); });
    var d = $(".detail"); if (d && S.entering && !REDUCED) { d.classList.add("enter"); S.entering = false; }
    if (focusSel) { var el = $(focusSel); if (el) el.focus({ preventScroll: true }); }
  }
  /* small figures: an exercise's muscles, and sets per muscle */
  function paintFigures() {
    var M = S.M;
    $$(".mfig[data-pm]").forEach(function (fig) { var pm = fig.dataset.pm.split(",").filter(Boolean), sm = fig.dataset.sm.split(",").filter(Boolean); $$(".mg", fig).forEach(function (g) { var m = g.dataset.m; g.dataset.s = pm.indexOf(m) >= 0 ? "low" : sm.indexOf(m) >= 0 ? "watch" : "none"; g.style.setProperty("--a", pm.indexOf(m) >= 0 ? 0.95 : sm.indexOf(m) >= 0 ? 0.6 : 0.08); }); fig.dataset.layer = "recovery"; });
    $$(".mfig[data-balance]").forEach(function (fig) { var mb = S.ui.mb === "month" ? M.MONTH : M.WEEK, mx = Math.max.apply(0, Object.keys(mb).map(function (k) { return mb[k]; }).concat([1])); $$(".mg", fig).forEach(function (g) { var v = mb[g.dataset.m] || 0; g.dataset.s = v ? "good" : "none"; g.style.setProperty("--a", v ? clamp(0.2 + v / mx * 0.8, 0.2, 1) : 0.08); }); fig.dataset.layer = "recovery"; });
  }
  function go(detail, extra) { S.ui = Object.assign({ detail: detail }, extra || {}); S.entering = true; paintPage(detail ? ".dhead .back" : '[data-detail]'); var top = S.host.getBoundingClientRect().top + window.scrollY - 70; if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: REDUCED ? "auto" : "smooth" }); }

  /* ---------- writes: straight to the owner's own rows (RLS), then reload ---------- */
  function sb() { return S.M && !S.M.sample && S.opts.sb && S.opts.userId ? S.opts.sb : null; }
  function say(form, text) { var m = form && form.querySelector(".msg"); if (m) m.textContent = text; }
  function saved(form, text, after) { say(form, text); load(true, after); }
  function sample(form) { say(form, "This is sample data, so nothing was saved."); }
  function onSubmit(e) {
    var lf = e.target.dataset && e.target.dataset.form;
    if (lf === "logval" || lf === "logsum") {
      e.preventDefault(); var dd = S.ui.logDay || isoToday(), fdl = new FormData(e.target);
      if (lf === "logval") { var vv = String(fdl.get("v") || "").trim(); if (vv) logWrite(e.target.dataset.id, dd, vv); } else logSummary(dd, String(fdl.get("s") || "").trim());
      var b2 = e.target.querySelector("button"); if (b2) { var was = b2.textContent; b2.textContent = "Saved"; setTimeout(function () { b2.textContent = was; }, 1200); }
      return;
    }
    var f = e.target; if (!f.id) return; e.preventDefault();
    var db = sb(), fd = new FormData(f), today = H.iso(S.M.now);
    if (!db) return sample(f);
    var btn = f.querySelector('[type="submit"]'); if (btn) btn.disabled = true;
    var done = function (r, ok, ui) { if (btn) btn.disabled = false; if (r && r.error) { say(f, "Couldn’t save: " + r.error.message); return; } S.ui = ui || S.ui; saved(f, ok); };
    if (f.id === "fCheckin") {
      var en = +fd.get("energy"); if (!en) { if (btn) btn.disabled = false; return say(f, "Pick a number from 1 to 5."); }
      var pains = fd.getAll("pain").map(function (r) { return { region: r, level: 1, note: "" }; });
      db.from("health_checkins").upsert({ user_id: S.opts.userId, date: today, source: "me", energy: en, note: String(fd.get("note") || "").trim() || null, pains: pains, updated_at: new Date().toISOString(), archived_at: null }, { onConflict: "user_id,date,source" }).then(function (r) {
        if (r.error) return done(r);
        var have = (S.raw.flags || []).map(function (x) { return x.region; });
        var newF = pains.filter(function (p) { var cur = (S.raw.flags || []).filter(function (x) { return x.region === p.region; })[0]; return !cur || cur.state === "cleared"; });
        Promise.all(newF.map(function (p) { return db.from("health_flags").upsert({ user_id: S.opts.userId, region: p.region, state: "watch", note: "Mentioned in a check-in.", since: today, archived_at: null, updated_at: new Date().toISOString() }, { onConflict: "user_id,region" }); })).then(function () { void have; done(null, "Check-in saved.", Object.assign({}, S.ui, { checkin: false })); });
      });
    } else if (f.id === "fFix") {
      var date = f.dataset.date, bed = fd.get("bed"), wake = fd.get("wake"), m = H.hm(wake) - H.hm(bed); if (m <= 0) m += 1440;
      if (m > 960) { if (btn) btn.disabled = false; return say(f, "That is more than 16 hours. The bedtime is the evening before."); }
      db.from("health_daily").upsert({ user_id: S.opts.userId, date: date, bed_time_corrected: bed, wake_time_corrected: wake, sleep_minutes_corrected: m, corrected_at: new Date().toISOString() }, { onConflict: "user_id,date" }).then(function (r) { done(r, "Night corrected.", Object.assign({}, S.ui, { fix: null })); });
    } else if (f.id === "fBP") {
      var sys = +fd.get("sys"), dia = +fd.get("dia"), pulse = fd.get("pulse") ? +fd.get("pulse") : null, at = fd.get("at") ? new Date(fd.get("at")) : new Date();
      if (!(dia < sys)) { if (btn) btn.disabled = false; return say(f, "The lower value should be smaller than the upper one."); }
      db.from("bp_readings").upsert({ user_id: S.opts.userId, measured_at: at.toISOString(), date: H.iso(at), systolic: sys, diastolic: dia, pulse: pulse, source: "manual", archived_at: null }, { onConflict: "user_id,measured_at" }).then(function (r) { done(r, "Reading added."); });
    } else if (f.id === "fSF") {
      db.from("health_milestones").upsert({ user_id: S.opts.userId, kind: "smoke_free", since_date: fd.get("since"), archived_at: null, updated_at: new Date().toISOString() }, { onConflict: "user_id,kind" }).then(function (r) { done(r, "Saved.", Object.assign({}, S.ui, { sfEdit: false })); });
    } else if (f.id === "fCond") saveCondition(db, f, fd, done);
  }
  /* a condition, and its one Command Center reminder titled only "Health check-up" */
  function saveCondition(db, f, fd, done) {
    var id = f.dataset.id, cur = id ? (S.raw.conditions || []).filter(function (c) { return c.id === id; })[0] : null;
    var row = { user_id: S.opts.userId, name: String(fd.get("name")).trim(), note: String(fd.get("note") || "").trim() || null, checkup_every_months: fd.get("every") ? +fd.get("every") : null, next_checkup: fd.get("next") || null, metrics: fd.getAll("metric"), body_area: fd.get("area") || null, updated_at: new Date().toISOString() };
    var q = cur ? db.from("health_conditions").update(row).eq("id", id).select().single() : db.from("health_conditions").insert(row).select().single();
    q.then(function (r) {
      if (r.error) return done(r);
      var c = r.data, aid = c.action_id;
      var rem = { title: "Health check-up", kind: "deadline", is_milestone: true, date: c.next_checkup, category: "Health", reminders: [1440], done: false, archived_at: null };
      var next = function (r2) { if (r2 && r2.error) return done(r2); done(null, "Saved." + (c.next_checkup ? " The reminder is in the Command Center." : ""), Object.assign({}, S.ui, { cond: null })); };
      if (c.next_checkup && aid) db.from("actions").update(rem).eq("id", aid).then(next);
      else if (c.next_checkup) db.from("actions").insert(Object.assign({ user_id: S.opts.userId, source: "health", priority: "P2", type: "Task", parent_type: "none", parent_id: null, notes_md: "" }, rem)).select("id").single().then(function (r3) { if (r3.error) return next(r3); db.from("health_conditions").update({ action_id: r3.data.id }).eq("id", c.id).then(next); });
      else if (aid) db.from("actions").update({ archived_at: new Date().toISOString() }).eq("id", aid).then(next);
      else next();
    });
  }
  function onClick(e) {
    var t = e.target.closest && e.target.closest("[data-detail],[data-act],[data-day],[data-ex]"); if (!t || !S.hp.contains(t)) return;
    var a = t.dataset.act, ui = S.ui;
    if (t.dataset.detail) return go(t.dataset.detail);
    if (t.dataset.day) { var k = t.dataset.day; S.ui = Object.assign({}, ui, { day: k, histAll: true }); paintPage(); var w = $("#w-" + k); if (w) { w.open = true; w.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "center" }); w.querySelector("summary").focus({ preventScroll: true }); } return; }
    if (t.dataset.ex) { S.ui = Object.assign({}, ui, { ex: t.dataset.ex }); paintPage('[data-ex="' + t.dataset.ex.replace(/"/g, '\\"') + '"]'); var x = $(".exd"); if (x && x.getBoundingClientRect().top > window.innerHeight) x.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" }); return; }
    if (a === "back") return go(null);
    if (a === "logday") { var nd = new Date((ui.logDay || isoToday()) + "T12:00:00"); nd.setDate(nd.getDate() + (+t.dataset.d)); var ns = nd.toISOString().slice(0, 10); S.ui = Object.assign({}, ui, { logDay: ns > isoToday() ? isoToday() : ns }); paintPage(); return; }
    if (a === "logset") return logWrite(t.dataset.id, (ui.logDay || isoToday()), t.getAttribute("aria-pressed") === "true" ? "false" : "true");
    if (a === "checkin") { S.ui = Object.assign({}, ui, { checkin: !ui.checkin }); paintPage(ui.checkin ? '[data-act="checkin"]' : "#fCheckin input"); return; }
    if (a === "fixnight") { var dt = t.dataset.date; if (!ui.detail) return go("sleep", { fix: dt }); S.ui = Object.assign({}, ui, { fix: ui.fix === dt ? null : dt }); paintPage(ui.fix === dt ? null : "#fFix input"); return; }
    if (a === "unfix") { var db = sb(); if (!db) return; db.from("health_daily").update({ bed_time_corrected: null, wake_time_corrected: null, sleep_minutes_corrected: null, corrected_at: null }).eq("user_id", S.opts.userId).eq("date", t.dataset.date).then(function () { S.ui = Object.assign({}, ui, { fix: null }); load(true); }); return; }
    if (a === "layer-flags") { S.layer = "flags"; var f = S.M.pains.filter(function (x) { return x.view; })[0]; if (f) S.view = f.view; paint(); $("#stage").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" }); return; }
    var set = function (k, v) { var o = {}; o[k] = v; S.ui = Object.assign({}, ui, o); paintPage(); };
    if (a === "month") return set("month", (ui.month || 0) + (+t.dataset.d));
    if (a === "cal") return set("cal", t.dataset.v);
    if (a === "histall") return set("histAll", true);
    if (a === "metric") return set("metric", t.dataset.v);
    if (a === "sort") return set("sort", t.dataset.v);
    if (a === "mb") return set("mb", t.dataset.v);
    if (a === "sfedit") return set("sfEdit", !ui.sfEdit);
    if (a === "cond") return set("cond", t.dataset.id || null);
    if (a === "condarchive") { var db2 = sb(); if (!db2) return; var c = (S.raw.conditions || []).filter(function (x) { return x.id === t.dataset.id; })[0]; db2.from("health_conditions").update({ archived_at: new Date().toISOString() }).eq("id", t.dataset.id).then(function () { if (c && c.action_id) db2.from("actions").update({ archived_at: new Date().toISOString() }).eq("id", c.action_id).then(function () { S.ui = Object.assign({}, ui, { cond: null }); load(true); }); else { S.ui = Object.assign({}, ui, { cond: null }); load(true); } }); return; }
  }
  /* Daily log writes: one value per variable per day (tracker_entries, unique per day). Unticking stores
     "false" instead of deleting the row. */
  function isoToday() { var n = S.opts.now || new Date(); return new Date(n.getTime() - n.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }
  function logWrite(vid, day, value) {
    var Ts = [S.raw && S.raw.tracker, S.M && S.M.raw && S.M.raw.tracker].filter(function (x, i, a) { return x && a.indexOf(x) === i; }); if (!Ts.length) return;
    Ts.forEach(function (T) { var cur = T.entries.filter(function (x) { return x.variable_id === vid && x.date === day; })[0]; if (cur) cur.value = value; else T.entries.push({ variable_id: vid, date: day, value: value }); });
    paintPage('[data-act="logset"][data-id="' + vid + '"]');
    var db = sb(); if (!db) return;
    db.from("tracker_entries").upsert({ user_id: S.opts.userId, variable_id: vid, date: day, value: value }, { onConflict: "user_id,date,variable_id" }).then(function (r) { if (r.error && window.console) console.warn("Daily log save failed", r.error); });
  }
  function logSummary(day, text) {
    var Ts = [S.raw && S.raw.tracker, S.M && S.M.raw && S.M.raw.tracker].filter(function (x, i, a) { return x && a.indexOf(x) === i; }); if (!Ts.length) return;
    Ts.forEach(function (T) { var cur = T.days.filter(function (x) { return x.date === day; })[0]; if (cur) cur.summary = text; else T.days.push({ date: day, summary: text }); });
    var db = sb(); if (db) db.from("tracker_days").upsert({ user_id: S.opts.userId, date: day, summary: text }, { onConflict: "user_id,date" }).then(function (r) { if (r.error && window.console) console.warn("Day summary save failed", r.error); });
  }
  function fail(err) {
    S.hp.innerHTML = '<div class="err" role="alert"><b>Health data couldn’t be loaded</b><span>' + esc((err && err.message) || "The connection dropped or the server didn’t answer.") + '</span><span>Nothing was changed. Your data is safe.</span><button class="btn" id="retry">Try again</button></div>';
    $("#retry").onclick = function () { load(true); };
  }
  function load(force, after) {
    var o = S.opts; if (S.busy) return; if (!force && S.M && Date.now() - S.loadedAt < FRESH_MS) return;
    var now = o.now || new Date(), done = function (raw) { S.busy = false; S.loadedAt = Date.now(); render(raw); if (after) after(); };
    if (o.raw) return done(o.raw);
    if (!o.sb || !o.userId) return done(H.sample(now));
    S.busy = true; if (!S.M) S.hp.innerHTML = '<div class="loading" role="status">Loading your health data…</div>';
    var btn = S.M && $("#refresh"); if (btn) btn.classList.add("spin");
    H.load(o.sb, o.userId, now).then(function (raw) {
      if (raw.missingTables.length || raw.empty) { var s = H.sample(now); s.missingTables = raw.missingTables; raw = s; }
      done(raw);
    }).catch(function (err) { S.busy = false; if (window.console) console.warn("Health load failed", err); fail(err); });
  }
  function mount(el, opts) {
    opts = opts || {};
    if (S.host !== el) {
      S.host = el; S.root = el.shadowRoot || el.attachShadow({ mode: "open" }); S.root.innerHTML = "";
      var link = document.createElement("link"); link.rel = "stylesheet"; link.href = BASE + "health.css?v=" + VER;
      var hp = S.hp = document.createElement("div"); hp.className = "hp"; hp.style.visibility = "hidden";
      var show = function () { hp.style.visibility = ""; }; link.onload = show; link.onerror = show; setTimeout(show, 2500);
      S.root.appendChild(link); S.root.appendChild(hp); S.M = null; S.loadedAt = 0;
      hp.addEventListener("click", onClick); hp.addEventListener("submit", onSubmit);
      /* Escape leaves a detail view, from anywhere on the page except a form field */
      document.addEventListener("keydown", function (e) {
        if (e.key !== "Escape" || !S.ui.detail || !S.host || S.host.offsetParent === null) return;
        var t = S.root.activeElement || document.activeElement; if (t && t.closest && t.closest("form, input, textarea, select")) return;
        go(null);
      });
      fonts(); applyTheme();
      if (window.MutationObserver) new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    }
    var changed = !S.opts || S.opts.userId !== opts.userId || S.opts.raw !== opts.raw; S.opts = opts;
    load(changed);
  }
  window.PPHealth = { mount: mount, reload: function () { load(true); }, sample: H.sample, state: S, go: function (d, x) { go(d, x); } };
})();
