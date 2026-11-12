/* The sidebar's live parts: the masthead (date, clock, today's strip, what's next), the ink marker that slides to
   the active page, the goal pulse, the Command Center count, the avatar letter and two shortcuts:
   [ folds the sidebar into its rail, Alt+1…9 opens a page. index.html calls PPNav.update(data) on every render:
   { today:"YYYY-MM-DD", items:[{ title, time:"HH:MM", dur, area, done }], openToday, overdue,
     goals:[{ title, area, score, mode }] }. Draws only; navigation itself stays with showSection. */
(function () {
  var A = window.PPAreas, D = null, $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var key = function (area) { return A ? A.keyOf(area) : "none"; };
  var ink = function (k) { return "var(--area-" + (k === "sol" ? "sol-line" : k) + ")"; };
  var mins = function (t) { return t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null; };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var DAY0 = 6 * 60, DAY1 = 24 * 60;          // the strip runs from 06:00 to midnight
  var ORDER = ["task", "work", "health", "growth", "people", "sol", "none"];

  function week(d) { var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())), n = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - n); var y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return Math.ceil(((t - y0) / 864e5 + 1) / 7); }
  function mast() {
    var now = new Date(), m = now.getHours() * 60 + now.getMinutes(), el;
    if ((el = $("#nvWeekday"))) el.textContent = now.toLocaleDateString("en-GB", { weekday: "long" }) + " · Week " + week(now);
    if ((el = $("#nvClock"))) el.textContent = pad(now.getHours()) + ":" + pad(now.getMinutes());
    if ((el = $("#nvDate"))) el.textContent = now.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
    if ((el = $("#nvMini"))) el.innerHTML = "<small>" + esc(now.toLocaleDateString("en-GB", { weekday: "short" })) + "</small>" + now.getDate();
    var strip = $("#nvDay"); if (!strip) return;
    var items = (D && D.items) || [], pct = function (x) { return Math.max(0, Math.min(100, (x - DAY0) / (DAY1 - DAY0) * 100)); };
    var segs = items.map(function (it) {
      var s = mins(it.time); if (s == null) return "";
      var e = s + (it.dur || 30); if (e <= DAY0 || s >= DAY1) return "";
      var k = key(it.area);
      return '<i class="' + (e <= m || it.done ? "past" : "") + '" style="left:' + pct(s).toFixed(2) + "%;width:" + Math.max(0.8, pct(e) - pct(s)).toFixed(2) + "%;--c:" + ink(k) + '" title="' + esc(it.time + " " + it.title) + '"></i>';
    }).join("");
    strip.innerHTML = segs + (m >= DAY0 ? '<span class="nv-now" style="left:' + pct(m).toFixed(2) + '%"></span>' : "");
    strip.setAttribute("aria-label", items.length ? items.length + (items.length === 1 ? " timed item today" : " timed items today") : "Nothing timed today");
    // now / next
    var cur = null, next = null;
    items.slice().sort(function (a, b) { return mins(a.time) - mins(b.time); }).forEach(function (it) {
      var s = mins(it.time), e = s + (it.dur || 30); if (it.done) return;
      if (s <= m && e > m && !cur) cur = it; else if (s > m && !next) next = it;
    });
    var show = cur || next, nx = $("#nvNext");
    if (nx) nx.innerHTML = show ? '<span class="nv-dot" style="--c:' + ink(key(show.area)) + '"></span><span>' + (cur ? "Now" : "Next") + '</span><b title="' + esc(show.title) + '">' + esc(show.title) + "</b><time>" + esc(cur ? "until " + hm(mins(cur.time) + (cur.dur || 30)) : show.time) + "</time>" : '<span class="nv-dot"></span><span>' + (items.length ? "Nothing else timed today" : "A free day so far") + "</span>";
  }
  var hm = function (x) { x = Math.min(1439, x); return pad(Math.floor(x / 60)) + ":" + pad(x % 60); };

  function pulse() {
    var bars = $("#nvBars"); if (!bars) return;
    var gs = ((D && D.goals) || []).slice().sort(function (a, b) { return ORDER.indexOf(key(a.area)) - ORDER.indexOf(key(b.area)) || (b.score || 0) - (a.score || 0); });
    bars.innerHTML = gs.map(function (g) {
      var k = key(g.area), v = g.score == null ? null : Math.max(0, Math.min(100, +g.score));
      var label = g.title + " · " + (v == null ? "no score yet" : g.mode === "manual" ? (v / 10) + "/10" : Math.round(v) + "%");
      return v == null ? '<i class="none" title="' + esc(label) + '"></i>' : '<i style="--h:' + Math.max(8, v) + "%;--c:" + ink(k) + '" title="' + esc(label) + '"></i>';
    }).join("");
    var scored = gs.filter(function (g) { return g.score != null; }), avg = scored.length ? Math.round(scored.reduce(function (s, g) { return s + +g.score; }, 0) / scored.length) : null;
    var a = $("#nvAvg"); if (a) a.textContent = avg == null ? "" : "average " + avg + "%";
    bars.setAttribute("aria-label", gs.length + " goals" + (avg == null ? "" : ", average score " + avg + " percent"));
  }
  function counts() {
    var m = $("#nvCmdMeta"); if (!m || !D) return;
    var h = "";
    if (D.overdue) h += '<span class="late" title="' + D.overdue + (D.overdue === 1 ? " overdue task" : " overdue tasks") + '">' + D.overdue + "</span>";
    if (D.openToday) h += '<span title="' + D.openToday + (D.openToday === 1 ? " task left today" : " tasks left today") + '">' + D.openToday + "</span>";
    m.innerHTML = h;
  }
  /* the ink marker: one card that slides under the active page and takes its colour */
  function placeInk() {
    var nav = $("#sideNav"), mark = $("#nvInk"); if (!nav || !mark) return;
    var a = nav.querySelector(".side-link.active");
    if (!a || !a.offsetParent) { mark.classList.remove("on"); return; }
    mark.style.transform = "translateY(" + a.offsetTop + "px)"; mark.style.height = a.offsetHeight + "px";
    mark.style.left = a.offsetLeft + "px"; mark.style.width = a.offsetWidth + "px"; mark.style.right = "auto";
    mark.style.setProperty("--ci", getComputedStyle(a).getPropertyValue("--ci") || "");
    mark.classList.add("on");
  }
  function avatar() { var e = $("#userEmailLabel"), v = $("#nvAv"); if (e && v) v.textContent = (e.textContent || "·").trim().charAt(0) || "·"; }

  window.PPNav = {
    update: function (d) { D = d || D; mast(); pulse(); counts(); },
    placeInk: placeInk,
  };

  function wire() {
    var nav = $("#sideNav"); if (!nav) return;
    mast(); avatar(); placeInk();
    new MutationObserver(function () { requestAnimationFrame(placeInk); }).observe(nav, { subtree: true, attributes: true, attributeFilter: ["class"] });
    var em = $("#userEmailLabel"); if (em) new MutationObserver(avatar).observe(em, { childList: true, characterData: true, subtree: true });
    new MutationObserver(function () { setTimeout(placeInk, 340); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-sidebar-collapsed", "data-mobile-menu-open"] });
    window.addEventListener("resize", function () { requestAnimationFrame(placeInk); });
    setInterval(mast, 30000);
    var p = $("#nvPulse"); if (p) p.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.click(); } });
    document.addEventListener("keydown", function (e) {
      var el = e.composedPath ? e.composedPath()[0] : e.target;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (document.querySelector(".modal-overlay.open,.modal.open")) return;
      if (e.key === "[" && !e.ctrlKey && !e.metaKey && !e.altKey && window.matchMedia("(min-width: 821px)").matches) { var b = $("#sidebarToggleBtn"); if (b) { e.preventDefault(); b.click(); } return; }
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
        var links = [].slice.call(nav.querySelectorAll(".side-link[data-section]")), l = links[+e.code.slice(5) - 1];
        if (l) { e.preventDefault(); l.click(); }
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
})();
