/* Health page, part 3b: the overview (Today + tiles) and the detail views behind each tile.
   HTML only, built from the model and a small UI state (ui). No events here; health.js wires them.
   Wording is effects-first: what matters for health, never the habit or substance behind it. */
(function () {
  var H = window.PPH = window.PPH || {};
  var fmt = H.fmt, esc = H.esc, dstr = H.dstr, wday = H.wday, st = H.st, STATUS = H.STATUS, clock = H.clock, dd = H.dayDiff, pad2 = H.pad2;
  var ic = function (s) { return '<b class="ic ' + s + '" aria-hidden="true">' + STATUS[s].icon + "</b> "; };
  var ago = function (n) { return n == null ? "" : n === 0 ? "today" : n === 1 ? "yesterday" : n < 14 ? n + " days ago" : n < 60 ? Math.round(n / 7) + " weeks ago" : Math.round(n / 30) + " months ago"; };
  var span = function (n) { return n == null ? "" : n < 14 ? n + (n === 1 ? " day" : " days") : n < 60 ? Math.round(n / 7) + " weeks" : Math.round(n / 30.4) + " months"; };
  var when = function (d, now) { var n = dd(d, now); return n === 0 ? "Today" : n === 1 ? "Tomorrow" : n < 7 ? wday(d) : wday(d) + " " + dstr(d); };
  var kg = function (v) { return v == null ? "–" : (Math.round(v * 10) / 10) + " kg"; };
  var hmin = function (m) { return m == null ? "–" : Math.floor(m / 60) + " h " + pad2(Math.round(m % 60)); };
  var REGIONS = [["neck", "Neck"], ["upper_back", "Upper back"], ["lower_back", "Lower back"], ["shoulder", "Shoulder"], ["elbow", "Elbow"], ["wrist", "Wrist"], ["hip", "Hip"], ["knee", "Knee"], ["ankle", "Ankle"]];
  var AREAS = [["", "No marker"], ["heart", "Heart"], ["lungs", "Lungs"], ["brain", "Brain"], ["other", "Elsewhere (listed only)"]];
  var METRICS = [["blood_pressure", "Blood pressure"], ["resting_hr", "Resting heart rate"], ["weight_kg", "Weight"]];
  H.REGIONS = REGIONS;

  /* a small line chart with points that carry their own tooltip */
  function lines(series, o) {
    var W = o.w || 640, Hh = o.h || 200, all = []; series.forEach(function (s) { s.v.forEach(function (p) { if (p.y != null) all.push(p.y); }); });
    if (!all.length) return '<p class="empty">' + (o.empty || "Nothing to chart yet.") + "</p>";
    var lo = Math.min.apply(0, all.concat(o.band ? [o.band[0]] : [])), hi = Math.max.apply(0, all.concat(o.band ? [o.band[1]] : [])); var pad = (hi - lo) * 0.12 || 5; lo -= pad; hi += pad;
    var n = Math.max.apply(0, series.map(function (s) { return s.v.length; })), X = function (i) { return 36 + (n > 1 ? i / (n - 1) : 0.5) * (W - 46); }, Y = function (v) { return Hh - 22 - (v - lo) / (hi - lo) * (Hh - 36); };
    var g = "", ticks = 4; for (var t = 0; t <= ticks; t++) { var v = lo + (hi - lo) * t / ticks; g += '<line x1="36" x2="' + (W - 10) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '" class="ln-grid"/><text x="30" y="' + (Y(v) + 3.5).toFixed(1) + '" class="ln-ax" text-anchor="end">' + Math.round(v) + "</text>"; }
    var band = o.band ? '<rect class="ln-band" x="36" width="' + (W - 46) + '" y="' + Y(o.band[1]).toFixed(1) + '" height="' + (Y(o.band[0]) - Y(o.band[1])).toFixed(1) + '"/><text class="ln-ax" x="' + (W - 12) + '" y="' + (Y(o.band[1]) + 11).toFixed(1) + '" text-anchor="end">' + esc(o.bandLabel || "") + "</text>" : "";
    var body = series.map(function (s) {
      var d = "", pts = ""; s.v.forEach(function (p, i) { if (p.y == null) return; d += (d ? "L" : "M") + X(i).toFixed(1) + "," + Y(p.y).toFixed(1); pts += '<circle class="ln-pt ' + s.cls + '" cx="' + X(i).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="' + (p.star ? 0 : 3.2) + '"><title>' + esc(p.t || "") + "</title></circle>" + (p.star ? '<g class="ln-star" transform="translate(' + X(i).toFixed(1) + "," + (Y(p.y) - 11).toFixed(1) + ')"><title>' + esc(p.t || "") + '</title><path d="M0,-5 L1.5,-1.5 L5,-1.2 L2.3,1 L3.1,4.6 L0,2.7 L-3.1,4.6 L-2.3,1 L-5,-1.2 L-1.5,-1.5Z"/></g>' : ""); });
      return '<path class="ln ' + s.cls + (s.dash ? " dash" : "") + '" d="' + d + '"/>' + pts;
    }).join("");
    var lab = o.xl ? '<text class="ln-ax" x="36" y="' + (Hh - 4) + '">' + esc(o.xl[0]) + '</text><text class="ln-ax" x="' + (W - 10) + '" y="' + (Hh - 4) + '" text-anchor="end">' + esc(o.xl[1]) + "</text>" : "";
    return '<svg class="lnc" viewBox="0 0 ' + W + " " + Hh + '" role="img" aria-label="' + esc(o.label || "") + '">' + band + g + body + lab + "</svg>";
  }
  H.lines = lines;
  var mini = function (vals, cls) { var v = vals.filter(function (x) { return x != null; }); if (v.length < 2) return ""; var mn = Math.min.apply(0, v), mx = Math.max.apply(0, v), w = 96, h = 22, pts = []; vals.forEach(function (x, i) { if (x != null) pts.push([i / (vals.length - 1) * w, h - 3 - (x - mn) / ((mx - mn) || 1) * (h - 6)]); }); return '<svg class="mini ' + (cls || "") + '" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '" aria-hidden="true"><path d="' + pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1); }).join("") + '"/><circle cx="' + pts[pts.length - 1][0].toFixed(1) + '" cy="' + pts[pts.length - 1][1].toFixed(1) + '" r="2.6"/></svg>'; };

  /* ---------------- overview ---------------- */
  function todayCard(M, ui) {
    var T = M.T, now = M.now, rows = [];
    var bbn = T.body_battery_now != null ? +T.body_battery_now : null, bbh = T.body_battery_high != null ? +T.body_battery_high : null, rs = M.paused ? "none" : st(M.ready);
    rows.push(["Energy", bbn == null && bbh == null ? '<span class="v nil">No Body Battery yet</span>' : '<span class="v">' + (bbn != null ? bbn : bbh) + "<small>" + (bbn != null ? "Body Battery now" : "Body Battery this morning") + (bbn != null && bbh != null ? " · " + bbh + " this morning" : "") + "</small></span>", '<span class="pill">' + ic(rs) + (M.ready == null ? "No readiness yet" : "Ready " + M.ready) + "</span>"]);
    var sm = T.sleep_minutes != null ? +T.sleep_minutes : null, ss = T.sleep_score != null ? +T.sleep_score : null;
    rows.push(["Sleep last night", sm == null && ss == null ? '<span class="v nil">No sleep recorded</span>' : '<span class="v">' + hmin(sm) + "<small>" + (ss != null ? "score " + ss + " · " : "") + (T.bed_time ? clock(T.bed_time) + " to " + clock(T.wake_time) : "") + (T.corrected ? ", corrected" : "") + "</small></span>",
      T.corrected && T.watch ? '<span class="pill">watch said ' + hmin(T.watch.mins) + "</span>" : '<button class="pill btn-s" data-act="fixnight" data-date="' + H.iso(now) + '">Fix the times</button>']);
    var l = M.last;
    rows.push(["Last workout", l ? '<span class="v">' + (l.ago === 0 ? "Today" : l.ago === 1 ? "Yesterday" : ago(l.ago).replace(/^./, function (c) { return c.toUpperCase(); })) + "<small>" + esc(l.routine) + (l.mins ? " · " + l.mins + " min" : "") + "</small></span>" : '<span class="v nil">None logged yet</span>', l && l.prs ? '<span class="pill">' + l.prs + " PR" + (l.prs > 1 ? "s" : "") + "</span>" : ""]);
    var c = M.checkin;
    rows.push(["How my body feels", c ? '<span class="v">' + c.energy + " / 5<small>" + (c.note ? "“" + esc(c.note) + "” · " : "") + (dd(now, c.d) === 0 ? "today" : ago(dd(now, c.d))) + " · by " + c.by + "</small></span>" : '<span class="v nil">No check-in today</span>', '<button class="pill btn-s" data-act="checkin" aria-expanded="' + !!ui.checkin + '">' + (c && dd(now, c.d) === 0 ? "Update" : "Check in") + "</button>"]);
    if (M.pains.length) rows.push(["Pain or injuries", '<span class="v pains">' + M.pains.map(function (f) { return "<span>" + esc(f.label) + "<small>" + f.word.toLowerCase() + (f.days != null ? " · " + span(f.days) : "") + "</small></span>"; }).join("") + "</span>", '<button class="pill btn-s" data-act="layer-flags">On the body</button>']);
    var form = ui.checkin ? checkinForm(M) : "";
    return '<section class="today card" aria-label="Today"><p class="lab">Today</p>' + rows.map(function (r) { return '<div class="trow"><span class="k">' + r[0] + "</span>" + r[1] + '<span class="a">' + (r[2] || "") + "</span></div>"; }).join("") + form + "</section>";
  }
  function checkinForm(M) {
    var c = M.checkin && dd(M.now, M.checkin.d) === 0 && M.checkin.by === "you" ? M.checkin : null, pains = c ? c.pains.map(function (p) { return p.region; }) : [];
    return '<form class="hform" id="fCheckin"><fieldset><legend>Energy today</legend><div class="scale">' + [1, 2, 3, 4, 5].map(function (n) { return '<label><input type="radio" name="energy" value="' + n + '"' + (c && c.energy === n ? " checked" : "") + "><span>" + n + "</span></label>"; }).join("") + '</div><p class="fine">1 very low · 5 great</p></fieldset>' +
      '<label class="f">A few words<input name="note" maxlength="300" value="' + esc(c ? c.note : "") + '" placeholder="How does your body feel?"></label>' +
      '<fieldset><legend>Anything hurting?</legend><div class="chips">' + REGIONS.map(function (r) { return '<label class="chip"><input type="checkbox" name="pain" value="' + r[0] + '"' + (pains.indexOf(r[0]) >= 0 ? " checked" : "") + "><span>" + r[1] + "</span></label>"; }).join("") + "</div></fieldset>" +
      '<div class="acts"><button class="btn pri" type="submit">Save check-in</button><button class="btn" type="button" data-act="checkin">Cancel</button></div><p class="msg" role="status"></p></form>';
  }
  function tiles(M) {
    var t = [], now = M.now, n = M.cfg.perWeek, done = M.weekDone, dots = ""; for (var i = 0; i < n; i++) dots += '<i class="' + (i < done ? "on" : "") + '"></i>';
    t.push(["workouts", "This week", '<span class="big">' + done + "<small> of " + n + "</small></span>", '<span class="dots" aria-hidden="true">' + dots + "</span>", done + " of " + n + " workouts this week"]);
    var ns = M.nextSession;
    t.push(["workouts", "Next session", '<span class="big">' + (ns.d ? when(ns.d, now) : "Not planned") + (ns.time ? "<small> " + ns.time + "</small>" : "") + "</span>", '<span class="sub">' + esc(ns.routine || "") + (ns.routine ? " · next in rotation" : "") + "</span>", "Next session " + (ns.d ? when(ns.d, now) + (ns.time ? " at " + ns.time : "") : "not planned") + ", " + (ns.routine || "")]);
    t.push(["sleep", "Sleep · 7 days", '<span class="big">' + hmin(M.sleep7) + "</span>", mini(M.col("sleep_minutes", 7), "s2"), "Sleep 7-day average " + hmin(M.sleep7)]);
    t.push(["readiness", "Readiness · 7 days", '<span class="big">' + (M.ready == null ? "–" : M.ready) + (M.readyTrend ? "<small> " + (M.readyTrend === "rising" ? "↗ rising" : M.readyTrend === "dipping" ? "↘ dipping" : "→ steady") + "</small>" : "") + "</span>", mini(M.ready7, "good"), "Readiness " + (M.ready == null ? "not scored" : M.ready) + (M.readyTrend ? ", " + M.readyTrend : "")]);
    if (M.smokeFree) t.push(["records", "Smoke-free", '<span class="big">' + fmt(M.smokeFree.days) + "<small> days</small></span>", '<span class="sub">' + (M.smokeFree.days >= 60 ? span(M.smokeFree.days) : "since " + dstr(M.smokeFree.since)) + "</span>", "Smoke-free for " + M.smokeFree.days + " days"]);
    if (M.nextCheckup) t.push(["records", "Next check-up", '<span class="big">' + dstr(M.nextCheckup.next) + "</span>", '<span class="sub">in ' + span(dd(M.nextCheckup.next, now)) + "</span>", "Next check-up " + dstr(M.nextCheckup.next)]);
    if (t.length < 6) { var b = M.bp[M.bp.length - 1]; t.push(["vitals", "Vitals", '<span class="big">' + (b ? b.sys + "/" + b.dia : (M.T.resting_hr != null ? M.T.resting_hr : "–")) + "<small> " + (b ? "BP" : "bpm") + "</small></span>", '<span class="sub">' + (b ? "last reading " + ago(dd(now, b.d)) : "resting heart rate") + "</span>", "Vitals"]); }
    if (t.length < 6) t.push(["records", "Records", '<span class="big">+</span>', '<span class="sub">check-ups and milestones</span>', "Health records"]);
    return '<nav class="tiles" aria-label="At a glance">' + t.slice(0, 6).map(function (x) { return '<button class="tile" data-detail="' + x[0] + '" aria-label="' + esc(x[4]) + ', open details"><span class="lab">' + x[1] + "</span>" + x[2] + (x[3] || "") + "</button>"; }).join("") + "</nav>" +
      '<p class="later">Nutrition gets a tile here once MyFitnessPal is connected. <button class="linkish" data-detail="more">Movement, weight, notes and the day so far ›</button></p>';
  }
  H.overviewHTML = function (M, ui, heroFigure) {
    return '<section class="hero o" id="stage" aria-label="Today and your body"><div class="duo">' + heroFigure + '<div class="side">' + todayCard(M, ui) + "</div></div>" + H.layerControls() + "</section>" + tiles(M);
  };

  /* ---------------- details ---------------- */
  var head = function (title, sub) { return '<div class="dhead"><button class="back" data-act="back" aria-label="Back to Health">← Health</button><div><p class="lab">' + esc(sub || "Health") + "</p><h1>" + esc(title) + "</h1></div></div>"; };
  var card = function (title, inner, extra) { return '<section class="card dsec"' + (extra || "") + "><h2 class=\"lab\">" + title + "</h2>" + inner + "</section>"; };

  function workouts(M, ui) {
    var now = M.now, key = H.iso, days = {};
    M.sessions.forEach(function (s) { (days[key(s.d)] = days[key(s.d)] || []).push(s); });
    var other = {}; M.acts.forEach(function (a) { if (!/walk|steps|commute/i.test((a.type || "") + " " + (a.name || ""))) other[key(a.d)] = 1; });
    var n28 = M.sessions.filter(function (s) { return s.ago < 28; }).length;
    /* calendar */
    var cal;
    if (ui.cal === "year") {
      var start = H.addDays(now, -364 - ((now.getDay() + 6) % 7)), cells = "";
      for (var i = 0; i < 371; i++) { var d = H.addDays(start, i); if (d > now) break; var k = key(d), s = days[k]; cells += '<button class="yc' + (s ? " on" : other[k] ? " oth" : "") + '" data-day="' + k + '" title="' + esc(wday(d) + " " + dstr(d) + (s ? ": " + s.map(function (x) { return x.routine; }).join(", ") : "")) + '" aria-label="' + esc(wday(d) + " " + dstr(d) + (s ? ", " + s.map(function (x) { return x.routine; }).join(", ") : ", no session")) + '"></button>'; }
      cal = '<div class="year" role="group" aria-label="The last 12 months, one square per day">' + cells + "</div>";
    } else {
      var off = ui.month || 0, first = new Date(now.getFullYear(), now.getMonth() + off, 1), lead = (first.getDay() + 6) % 7, nd = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(), g = ["M", "T", "W", "T", "F", "S", "S"].map(function (x) { return '<b aria-hidden="true">' + x + "</b>"; }).join("");
      for (var j = 0; j < lead; j++) g += "<span></span>";
      for (var dn = 1; dn <= nd; dn++) { var dt = new Date(first.getFullYear(), first.getMonth(), dn), k2 = key(dt), s2 = days[k2], fut = dt > now; g += '<button class="mc' + (s2 ? " on" : other[k2] ? " oth" : "") + (k2 === key(now) ? " today" : "") + (ui.day === k2 ? " sel" : "") + '"' + (fut ? " disabled" : "") + ' data-day="' + k2 + '" aria-label="' + esc(wday(dt) + " " + dn + (s2 ? ", " + s2.map(function (x) { return x.routine; }).join(", ") : other[k2] ? ", other sport" : ", no session")) + '">' + dn + (s2 ? '<i aria-hidden="true">●</i>' : "") + "</button>"; }
      cal = '<div class="mnav"><button class="btn-s" data-act="month" data-d="-1" aria-label="Previous month">‹</button><b>' + first.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) + '</b><button class="btn-s" data-act="month" data-d="1" aria-label="Next month"' + (off >= 0 ? " disabled" : "") + ">›</button></div><div class=\"month\">" + g + "</div>";
    }
    var calSec = card("Calendar", '<div class="seg" role="group" aria-label="Calendar view"><button data-act="cal" data-v="month" aria-pressed="' + (ui.cal !== "year") + '">Month</button><button data-act="cal" data-v="year" aria-pressed="' + (ui.cal === "year") + '">Year</button></div>' + cal + '<p class="fine">● strength session · faint = other sport · tap a day to open its workout</p>');
    /* history */
    var list = M.sessions.slice().reverse().slice(0, ui.histAll ? 400 : 12);
    var hist = list.map(function (s) {
      var k = key(s.d), open = ui.day === k;
      return '<details class="w" id="w-' + k + '"' + (open ? " open" : "") + "><summary><b>" + esc(s.routine) + "</b>" + (s.prs ? ' <span class="pill">' + s.prs + " PR</span>" : "") + '<span class="meta">' + wday(s.d) + " " + dstr(s.d) + (s.mins ? " · " + s.mins + " min" : "") + (s.vol ? " · " + fmt(s.vol) + " kg" : "") + "</span></summary><ul>" +
        s.ex.map(function (e) { return "<li><b>" + esc(e.name) + "</b> " + e.sets.map(function (x) { return (x.set_type === "warmup" ? '<span class="wu" title="warm-up">w </span>' : "") + (x.weight_kg != null ? (Math.round(x.weight_kg * 10) / 10) + " × " : "") + (x.reps != null ? x.reps : "–") + (x.is_pr ? " ★" : ""); }).join(" · ") + "</li>"; }).join("") + "</ul></details>";
    }).join("");
    var histSec = card("History", (hist || '<p class="empty">No workouts logged yet. Once Claude syncs Hevy, they appear here.</p>') + (M.sessions.length > 12 && !ui.histAll ? '<button class="linkish" data-act="histall">Show all ' + M.sessions.length + " workouts</button>" : ""));
    /* exercises */
    var ex = M.exercises.slice();
    if (ui.sort === "az") ex.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    else if (ui.sort === "up") ex.sort(function (a, b) { var g1 = function (o) { var p = o.points.filter(function (x) { return x.top != null; }); return p.length > 1 ? p[p.length - 1].top - p[0].top : -1e9; }; return g1(b) - g1(a); });
    var selName = ui.ex || (ex[0] && ex[0].name), sel = ex.filter(function (e) { return e.name === selName; })[0];
    var rows = ex.map(function (e) { var old = e.lastAgo > 14; return '<tr class="' + (e === sel ? "sel" : "") + '"><td><button class="exbtn" data-ex="' + esc(e.name) + '" aria-pressed="' + (e === sel) + '">' + esc(e.name) + "</button>" + (e.anyPr ? ' <span class="pill" title="personal record">★ PR</span>' : "") + '</td><td class="' + (old ? "old" : "") + '">' + (old ? '<span aria-hidden="true">▲ </span>' : "") + ago(e.lastAgo) + "</td><td>" + kg(e.top) + '</td><td class="hide-s">' + mini(e.points.slice(-12).map(function (p) { return p.top; }), "good") + "</td></tr>"; }).join("");
    var metric = ui.metric || "top", detailEx = "";
    if (sel) {
      var pts = sel.points.slice(-24), val = function (p) { return metric === "e1" ? p.e1 : metric === "vol" ? p.vol : p.top; };
      var series = [{ cls: "good", v: pts.map(function (p) { return { y: val(p), star: metric === "top" && (p.record || p.pr), t: dstr(p.d) + ": " + (metric === "vol" ? fmt(p.vol) + " kg volume" : kg(val(p)) + (metric === "top" && p.reps ? " × " + p.reps : "")) + (p.record || p.pr ? " · personal record" : "") }; }) }];
      var lib = H.libMatch ? H.libMatch(sel.name) : null, mus = lib && lib.muscles ? lib.muscles : sel.muscles ? { primary: [sel.muscles[0]], secondary: sel.muscles[1] || [] } : null;
      var vis = lib && lib.images && lib.images.length ? '<div class="frames">' + lib.images.slice(0, 2).map(function (src, i) { return '<img loading="lazy" src="' + esc(src) + '" alt="' + esc(sel.name + (i ? ", end position" : ", start position")) + '">'; }).join("") + '</div><p class="fine">Images: <a href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noopener">free-exercise-db</a>, public domain · matched as “' + esc(lib.name) + "”</p>" : '<p class="fine">' + (H.libState === "loading" ? "Looking up how it is done…" : H.libState === "failed" ? "The exercise library could not be loaded; the muscles are shown instead." : "No picture matched this exercise, so the muscles are shown instead.") + "</p>";
      detailEx = '<div class="exd"><div><h3 class="exh">' + esc(sel.name) + '</h3><p class="sub">Last trained ' + ago(sel.lastAgo) + " · best top set " + kg(sel.best) + " · " + sel.points.length + " sessions</p>" +
        '<div class="seg" role="group" aria-label="Chart"><button data-act="metric" data-v="top" aria-pressed="' + (metric === "top") + '">Top set</button><button data-act="metric" data-v="e1" aria-pressed="' + (metric === "e1") + '">Estimated 1RM</button><button data-act="metric" data-v="vol" aria-pressed="' + (metric === "vol") + '">Volume</button></div>' +
        lines(series, { w: 620, h: 200, label: sel.name + ", " + (metric === "e1" ? "estimated one-rep max" : metric === "vol" ? "volume per session" : "top set") + " over the last " + pts.length + " sessions", xl: pts.length ? [dstr(pts[0].d), dstr(pts[pts.length - 1].d)] : null, empty: "No weighted sets for this exercise." }) +
        '<p class="fine">' + (metric === "top" ? "★ personal record · " : "") + (metric === "e1" ? "Estimated from the top set (Epley), a rough guide." : "Hover or tap a point for the date.") + '</p></div><div class="exvis"><p class="lab">How it is done</p>' + vis + (mus ? '<p class="lab" style="margin-top:10px">Muscles</p><div class="mfig" data-pm="' + esc((mus.primary || []).join(",")) + '" data-sm="' + esc((mus.secondary || []).join(",")) + '"><div class="mf">' + H.bodySVG("front", []) + '</div><div class="mf">' + H.bodySVG("back", []) + '</div></div><p class="fine">' + esc((mus.primary || []).map(function (m) { return H.MUSCLES[m] || m; }).join(", ")) + (mus.secondary && mus.secondary.length ? " · also " + esc(mus.secondary.map(function (m) { return H.MUSCLES[m] || m; }).join(", ")) : "") + "</p>" : "") + "</div></div>";
    }
    var unmatched = H.libUnmatched ? H.libUnmatched(M.exercises.map(function (e) { return e.name; })) : [];
    var exSec = card("Exercises", ex.length ? '<div class="seg" role="group" aria-label="Sort"><button data-act="sort" data-v="least" aria-pressed="' + (!ui.sort || ui.sort === "least") + '">Least recently trained</button><button data-act="sort" data-v="az" aria-pressed="' + (ui.sort === "az") + '">A–Z</button><button data-act="sort" data-v="up" aria-pressed="' + (ui.sort === "up") + '">Most improved</button></div>' +
      '<div class="tablewrap"><table class="ex"><thead><tr><th>Exercise</th><th>Last trained</th><th>Top set</th><th class="hide-s">Recent</th></tr></thead><tbody>' + rows + "</tbody></table></div>" + detailEx + (unmatched.length ? '<p class="fine">No picture found yet for: ' + esc(unmatched.join(", ")) + ".</p>" : "") : '<p class="empty">Exercises appear after the first synced workout.</p>');
    /* muscle balance */
    var mb = ui.mb === "month" ? M.MONTH : M.WEEK, keys = Object.keys(H.MUSCLES).sort(function (a, b) { return (mb[b] || 0) - (mb[a] || 0); }), mx = Math.max.apply(0, keys.map(function (k) { return mb[k] || 0; }).concat([1]));
    var bal = '<div class="seg" role="group" aria-label="Period"><button data-act="mb" data-v="week" aria-pressed="' + (ui.mb !== "month") + '">Last 7 days</button><button data-act="mb" data-v="month" aria-pressed="' + (ui.mb === "month") + '">Last 30 days</button></div><div class="bal"><ul class="bars">' +
      keys.map(function (k) { var v = Math.round((mb[k] || 0) * 10) / 10; return "<li><span>" + H.MUSCLES[k] + '</span><i style="--w:' + Math.round(v / mx * 100) + '%"></i><b>' + v + "</b></li>"; }).join("") + '</ul><div class="mfig bal-fig" data-balance="1"><div class="mf">' + H.bodySVG("front", []) + '</div><div class="mf">' + H.bodySVG("back", []) + '</div></div></div><p class="fine">Sets per muscle; a secondary muscle counts as half a set. Deeper colour means more sets.</p>';
    var rot = M.cfg.rotation, rotLine = rot.length ? '<p class="sub">Rotation: ' + rot.map(function (r) { return r === M.next ? "<b>" + esc(r) + "</b>" : esc(r); }).join(" → ") + " · next up in bold</p>" : "";
    return head("Workouts", n28 + (n28 === 1 ? " session" : " sessions") + " in the last 4 weeks") + rotLine + '<div class="dgrid">' + calSec + histSec + "</div>" + exSec + card("Muscle balance", bal) + card("Weeks and records", H.trainingHTML ? H.trainingHTML(M) : "");
  }

  function sleep(M, ui) {
    var nights = M.days.slice(-14).reverse().map(function (x) {
      var r = x.r, k = x.iso; if (!r) return '<li><time>' + wday(x.d) + " " + dstr(x.d) + '</time><span class="mut">no data</span></li>';
      var editing = ui.fix === k, has = r.bed_time || r.wake_time || r.sleep_minutes != null;
      return "<li><time>" + wday(x.d) + " " + dstr(x.d) + "</time><span>" + (has ? hmin(r.sleep_minutes) + " · " + clock(r.bed_time) + "–" + clock(r.wake_time) + (r.sleep_score != null ? " · score " + r.sleep_score : "") : '<span class="mut">no sleep recorded</span>') + (r.corrected ? ' <span class="pill">corrected · watch said ' + clock(r.watch && r.watch.bed) + "–" + clock(r.watch && r.watch.wake) + "</span>" : "") + '</span><button class="btn-s" data-act="fixnight" data-date="' + k + '" aria-expanded="' + editing + '">' + (r.corrected ? "Change" : "Fix") + "</button>" + (editing ? fixForm(r, k) : "") + "</li>";
    }).join("");
    var none = !M.days.slice(-14).some(function (x) { return x.r; });
    if (ui.fix && !M.days.slice(-14).some(function (x) { return x.iso === ui.fix && x.r; })) nights = '<li><time>' + esc(ui.fix) + "</time><span>No watch data for this night.</span>" + fixForm(null, ui.fix) + "</li>" + nights;
    var P = H.pillarsHTML ? H.pillarsHTML(M) : null;
    return head("Sleep", "7-night average " + hmin(M.sleep7) + (M.sleepNights7 < 7 ? " (" + M.sleepNights7 + " nights with data)" : "")) +
      card("Nights", (none ? '<p class="empty">No nights recorded in the last two weeks.</p>' : "") + '<ul class="nights">' + nights + '</ul><p class="fine">The watch sometimes gets the bedtime wrong. A corrected night is used everywhere on this page; the watch’s own times stay listed for reference.</p>') +
      (P ? '<div class="pillars solo">' + P.sleep + "</div>" : "");
  }
  function fixForm(r, k) {
    return '<form class="hform fix" id="fFix" data-date="' + k + '"><label class="f">Fell asleep<input type="time" name="bed" required value="' + esc(r ? clock(r.bed_time_corrected || r.bed_time).replace("–", "") : "") + '"></label><label class="f">Woke up<input type="time" name="wake" required value="' + esc(r ? clock(r.wake_time_corrected || r.wake_time).replace("–", "") : "") + '"></label><div class="acts"><button class="btn pri" type="submit">Save</button>' + (r && r.corrected ? '<button class="btn" type="button" data-act="unfix" data-date="' + k + '">Use the watch’s times</button>' : "") + '<button class="btn" type="button" data-act="fixnight" data-date="' + k + '">Cancel</button></div><p class="msg" role="status"></p></form>';
  }
  function readiness(M) {
    var series = [{ cls: "good", v: M.ready7.map(function (v, i) { var d = M.days[83 + i].d; return { y: v, t: wday(d) + " " + dstr(d) + ": " + (v == null ? "not enough readings" : v) }; }) }];
    return head("Readiness", M.ready == null ? "Not scored today" : "Today " + M.ready + (M.readyTrend ? ", " + M.readyTrend + " over 7 days" : "")) +
      card("Last 7 days", lines(series, { w: 620, h: 170, label: "Readiness over the last 7 days", xl: [dstr(M.days[83].d), "today"], empty: "Not enough readings yet." }) + '<p class="sub">' + esc(M.verdict) + "</p>") +
      card("What goes into today’s score", H.contribHTML ? H.contribHTML(M) : "") + card("Today’s plan", H.planHTML ? H.planHTML(M) : "");
  }
  function vitals(M, ui) {
    var bp = M.bp.slice(-40), last = bp[bp.length - 1], P = H.pillarsHTML ? H.pillarsHTML(M) : null;
    var chart = lines([{ cls: "s1", v: bp.map(function (b) { return { y: b.sys, t: dstr(b.d) + " " + pad2(b.at.getHours()) + ":" + pad2(b.at.getMinutes()) + ": " + b.sys + "/" + b.dia + (b.pulse ? ", pulse " + b.pulse : "") }; }) }, { cls: "s2", v: bp.map(function (b) { return { y: b.dia, t: dstr(b.d) + ": " + b.sys + "/" + b.dia }; }) }],
      { w: 620, h: 210, label: "Blood pressure readings, upper and lower values", band: [60, 120], bandLabel: "general guidance range", xl: bp.length ? [dstr(bp[0].d), dstr(bp[bp.length - 1].d)] : null, empty: "No blood pressure readings yet. Add one below, or tell Claude." });
    var avg = function (a) { return a.length ? Math.round(a.reduce(function (s, x) { return s + x; }, 0) / a.length) : null; };
    var r30 = M.bp.filter(function (b) { return dd(M.now, b.d) < 30; }), p30 = M.bp.filter(function (b) { var n = dd(M.now, b.d); return n >= 30 && n < 60; });
    var trend = r30.length && p30.length ? (function () { var a = avg(r30.map(function (b) { return b.sys; })), b2 = avg(p30.map(function (b) { return b.sys; })); return Math.abs(a - b2) < 3 ? "about the same as the month before" : a < b2 ? (b2 - a) + " lower than the month before" : (a - b2) + " higher than the month before"; })() : null;
    var form = '<form class="hform row" id="fBP"><label class="f">Upper (systolic)<input name="sys" type="number" inputmode="numeric" min="50" max="260" required></label><label class="f">Lower (diastolic)<input name="dia" type="number" inputmode="numeric" min="30" max="180" required></label><label class="f">Pulse<input name="pulse" type="number" inputmode="numeric" min="25" max="230"></label><label class="f">When<input name="at" type="datetime-local" value="' + H.iso(M.now) + "T" + pad2(M.now.getHours()) + ":" + pad2(M.now.getMinutes()) + '"></label><div class="acts"><button class="btn pri" type="submit">Add reading</button></div><p class="msg" role="status"></p></form>';
    var mon = M.conditions.filter(function (c) { return c.metrics.indexOf("blood_pressure") >= 0 && c.next; })[0];
    return head("Vitals", last ? "Last blood pressure " + last.sys + "/" + last.dia + ", " + ago(dd(M.now, last.d)) : "Heart, blood pressure, recovery and stress") +
      card("Blood pressure", '<div class="bphead"><div><span class="big">' + (last ? last.sys + "/" + last.dia : "–") + "</span><small>" + (last && last.pulse ? " pulse " + last.pulse : "") + '</small><p class="sub">' + (r30.length ? "30-day average " + avg(r30.map(function (b) { return b.sys; })) + "/" + avg(r30.map(function (b) { return b.dia; })) + (trend ? ", upper value " + trend : "") : "Readings build a trend over time.") + "</p></div>" + (mon ? '<p class="pill">Next check-up ' + dstr(mon.next) + "</p>" : M.nextCheckup ? '<p class="pill">Next check-up ' + dstr(M.nextCheckup.next) + "</p>" : "") + "</div>" + chart + '<p class="fine">The shaded band is general guidance, not a diagnosis. Your doctor’s advice comes first.</p>' + form) +
      (P ? '<div class="pillars solo">' + P.vitals + "</div>" : "");
  }
  /* general information, NHS Better Health (nhs.uk/better-health/quit-smoking/benefits-of-quitting-smoking) */
  var SF = [[0, "From day one", "Your body starts to repair itself."], [7, "Within days or weeks", "Taste and smell improve, breathing gets easier and energy rises."], [42, "Around 6 weeks", "Many people start to feel the mental health benefits."], [90, "In the months that follow", "Circulation and lung function improve, with less coughing and wheezing."], [365, "1 year", "Risk of a heart attack is about half of what it was."], [3652, "10 years", "Risk of dying from lung cancer is about half of what it was."], [5479, "15 years", "Risk of a heart attack is the same as for someone who never smoked."]];
  function records(M, ui) {
    var sf = M.smokeFree, now = M.now;
    var sfCard = sf ? '<div class="sf"><div><span class="big">' + fmt(sf.days) + '</span><small> days smoke-free</small><p class="sub">' + (sf.days >= 30 ? Math.floor(sf.days / 30.44) + " months" + (sf.days % 30 >= 7 ? ", " + Math.floor((sf.days % 30.44) / 7) + " weeks" : "") + " · " : "") + "since " + dstr(sf.since) + " " + sf.since.getFullYear() + '</p></div></div><ol class="ms">' +
      SF.map(function (m) { var done = sf.days >= m[0]; return '<li class="' + (done ? "done" : "") + '"><span class="mk" aria-hidden="true">' + (done ? "✓" : "○") + "</span><b>" + m[1] + "</b> " + m[2] + '<span class="sr">' + (done ? " (reached)" : " (ahead)") + "</span></li>"; }).join("") + '</ol><p class="fine">General information from the NHS, not a personal assessment.</p>' : '<p class="sub">Count the days from a date you choose.</p>';
    var sfForm = (ui.sfEdit || !sf) ? '<form class="hform row" id="fSF"><label class="f">Smoke-free since<input type="date" name="since" required max="' + H.iso(now) + '" value="' + (sf ? H.iso(sf.since) : "") + '"></label><div class="acts"><button class="btn pri" type="submit">Save</button>' + (sf ? '<button class="btn" type="button" data-act="sfedit">Cancel</button>' : "") + '</div><p class="msg" role="status"></p></form>' : '<button class="linkish" data-act="sfedit">Change the date</button>';
    var conds = M.conditions.map(function (c) {
      var editing = ui.cond === c.id;
      return '<li class="cond"><div><b>' + esc(c.name) + "</b>" + (c.note ? ' <span class="sub">' + esc(c.note) + "</span>" : "") + '<p class="sub">' + (c.next ? "Next check-up " + dstr(c.next) + " " + c.next.getFullYear() + " (in " + span(dd(c.next, now)) + ")" : "No check-up date") + (c.every ? " · every " + c.every + " months" : "") + (c.metrics.length ? " · watching " + c.metrics.map(function (m) { var x = METRICS.filter(function (y) { return y[0] === m; })[0]; return x ? x[1].toLowerCase() : m; }).join(", ") : "") + (c.actionId ? " · reminder in the Command Center" : "") + '</p></div><button class="btn-s" data-act="cond" data-id="' + esc(c.id) + '" aria-expanded="' + editing + '">Edit</button>' + (editing ? condForm(c) : "") + "</li>";
    }).join("");
    return head("Records", "Private: stored only in your own database") +
      card("Milestone", sfCard + sfForm) +
      card("Monitored conditions", (conds ? '<ul class="conds">' + conds + "</ul>" : '<p class="empty">Nothing monitored yet.</p>') + (ui.cond === "new" ? condForm(null) : '<button class="btn" data-act="cond" data-id="new">Add a condition</button>') + '<p class="fine">A next check-up adds one reminder to the Command Center, titled only “Health check-up”. Names stay on this page.</p>');
  }
  function condForm(c) {
    return '<form class="hform" id="fCond" data-id="' + (c ? esc(c.id) : "") + '"><label class="f">Name (private)<input name="name" required maxlength="80" value="' + esc(c ? c.name : "") + '"></label><label class="f">Short note<input name="note" maxlength="300" value="' + esc(c ? c.note : "") + '"></label>' +
      '<div class="row"><label class="f">Check-up every (months)<input name="every" type="number" min="1" max="120" value="' + (c && c.every ? c.every : "") + '"></label><label class="f">Next check-up<input name="next" type="date" value="' + (c && c.next ? H.iso(c.next) : "") + '"></label><label class="f">Marker on the body<select name="area">' + AREAS.map(function (a) { return '<option value="' + a[0] + '"' + ((c ? c.area || "" : "") === a[0] ? " selected" : "") + ">" + a[1] + "</option>"; }).join("") + "</select></label></div>" +
      '<fieldset><legend>Metrics to watch</legend><div class="chips">' + METRICS.map(function (m) { return '<label class="chip"><input type="checkbox" name="metric" value="' + m[0] + '"' + (c && c.metrics.indexOf(m[0]) >= 0 ? " checked" : "") + "><span>" + m[1] + "</span></label>"; }).join("") + "</div></fieldset>" +
      '<div class="acts"><button class="btn pri" type="submit">Save</button><button class="btn" type="button" data-act="cond" data-id="">Cancel</button>' + (c ? '<button class="btn" type="button" data-act="condarchive" data-id="' + esc(c.id) + '">Archive</button>' : "") + '</div><p class="msg" role="status"></p></form>';
  }
  function more(M) {
    var P = H.pillarsHTML ? H.pillarsHTML(M) : null;
    return head("Movement and more", "Steps, weight, the day so far, notes and gaps") + (P ? '<div class="pillars solo">' + P.move + "</div>" : "") +
      card("Nutrition", '<p class="sub">Coming later: daily calories and protein against your targets, from MyFitnessPal.</p>' + (H.nutritionHTML ? H.nutritionHTML(M) : "")) + (H.extrasHTML ? '<div class="dsec">' + H.extrasHTML(M) + "</div>" : "");
  }
  H.detailHTML = function (M, key, ui) {
    return '<div class="detail" data-d="' + key + '">' + ({ workouts: workouts, sleep: sleep, readiness: readiness, vitals: vitals, records: records, more: more }[key] || more)(M, ui) + "</div>";
  };

  /* ---------------- the open exercise library (free-exercise-db, public domain) ---------------- */
  var LIB_URL = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json", IMG = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";
  var LIB_MUSCLE = { chest: "chest", lats: "lats", "middle back": "lats", "lower back": "lower_back", shoulders: "shoulders", biceps: "biceps", triceps: "triceps", forearms: "forearms", abdominals: "abs", quadriceps: "quads", hamstrings: "hamstrings", glutes: "glutes", adductors: "adductors", abductors: "glutes", calves: "calves", traps: "traps", neck: "traps" };
  var STOP = { the: 1, a: 1, with: 1, on: 1, to: 1, of: 1, and: 1, "-": 1 };
  var EQUIP = { barbell: "barbell", dumbbell: "dumbbell", dumbbells: "dumbbell", cable: "cable", machine: "machine", smith: "machine", kettlebell: "kettlebells", bodyweight: "body only", band: "bands", "ez bar": "e-z curl bar" };
  var toks = function (s) { return String(s || "").toLowerCase().replace(/[()\-,/]/g, " ").split(/\s+/).filter(function (w) { return w && !STOP[w]; }).map(function (w) { return w.replace(/s$/, ""); }); };
  H.libState = "idle"; var LIB = null, cache = {};
  H.loadLibrary = function (done) {
    if (LIB || H.libState === "loading") return; H.libState = "loading";
    fetch(LIB_URL).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (list) {
      LIB = list.map(function (e) { return { e: e, t: toks(e.name), eq: (e.equipment || "").toLowerCase() }; }); H.libState = "ready"; cache = {}; if (done) done();
    }).catch(function () { H.libState = "failed"; if (done) done(); });
  };
  H.libMatch = function (name) {
    if (!LIB) return null; if (cache[name] !== undefined) return cache[name];
    var paren = (String(name).match(/\(([^)]+)\)/) || [])[1] || "", eq = EQUIP[paren.toLowerCase().trim()] || null, t = toks(String(name).replace(/\([^)]*\)/g, "")), best = null, bs = 0;
    if (!t.length) return (cache[name] = null);
    LIB.forEach(function (x) {
      var hit = t.filter(function (w) { return x.t.indexOf(w) >= 0; }).length; if (!hit) return;
      var s = hit / t.length * 0.75 + hit / x.t.length * 0.25 + (eq && x.eq === eq ? 0.2 : 0) - (eq && x.eq && x.eq !== eq ? 0.1 : 0);
      if (s > bs) { bs = s; best = x; }
    });
    var m = best && bs >= 0.7 ? { name: best.e.name, images: (best.e.images || []).map(function (p) { return IMG + p; }), muscles: { primary: (best.e.primaryMuscles || []).map(function (m) { return LIB_MUSCLE[m]; }).filter(Boolean), secondary: (best.e.secondaryMuscles || []).map(function (m) { return LIB_MUSCLE[m]; }).filter(Boolean) } } : null;
    return (cache[name] = m);
  };
  H.libUnmatched = function (names) { return LIB ? names.filter(function (n) { return !H.libMatch(n); }) : []; };
})();
