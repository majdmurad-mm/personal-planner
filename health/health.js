/* Health page, part 4 of 4: mounting, data loading, theme, and everything interactive.
   The page lives in a shadow root so the planner's styles and the page's styles never touch. */
(function () {
  var H = window.PPH, clamp = H.clamp, fmt = H.fmt, STATUS = H.STATUS, MUSCLES = H.MUSCLES, esc = H.esc;
  var SRC = (document.currentScript && document.currentScript.src) || "health/health.js";
  var BASE = SRC.replace(/health\.js.*$/, ""), VER = (SRC.match(/[?&]v=([^&]+)/) || [])[1] || "1";
  var THEME_KEY = "pp_health_theme", FRESH_MS = 5 * 60 * 1000;
  var S = { host: null, root: null, hp: null, opts: null, M: null, layer: "recovery", view: "front", loadedAt: 0, busy: false };
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
    $$(".organ", stage).forEach(function (g) { g.dataset.s = M.vitals[g.dataset.o].s; });
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
    var now = S.opts.now || new Date(), M = S.M = H.build(raw, now);
    H.charts.length = 0; S.hp.innerHTML = H.pageHTML(M);
    $$(".chip-t").forEach(function (c) { c.onclick = function () { try { localStorage.setItem(THEME_KEY, c.dataset.t); } catch (e) { } applyTheme(); }; });
    $("#refresh").onclick = function () { load(true); };
    applyTheme(); wireBody(); wireCharts(); wirePillars(); countUp();
  }
  function fail(err) {
    S.hp.innerHTML = '<div class="err" role="alert"><b>Health data couldn’t be loaded</b><span>' + esc((err && err.message) || "The connection dropped or the server didn’t answer.") + '</span><span>Nothing was changed. Your data is safe.</span><button class="btn" id="retry">Try again</button></div>';
    $("#retry").onclick = function () { load(true); };
  }
  function load(force) {
    var o = S.opts; if (S.busy) return; if (!force && S.M && Date.now() - S.loadedAt < FRESH_MS) return;
    var now = o.now || new Date(), done = function (raw) { S.busy = false; S.loadedAt = Date.now(); render(raw); };
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
      fonts(); applyTheme();
      if (window.MutationObserver) new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    }
    var changed = !S.opts || S.opts.userId !== opts.userId || S.opts.raw !== opts.raw; S.opts = opts;
    load(changed);
  }
  window.PPHealth = { mount: mount, reload: function () { load(true); }, sample: H.sample, state: S };
})();
