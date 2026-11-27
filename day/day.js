/* The Day page: everything about one date in one place, and trends across days. A view only: the one thing it can do is archive a conversation summary.
   The host hands over load(from, to) → the raw rows for that range; PPDay.build (supabase/functions/_shared/day.js,
   the same code the connector uses) turns them into a day. Sections appear only when the day has data for them;
   a missing single value shows as "—". Each section carries its area colour. */
(function () {
  var D = window.PPDay, P = window.PPDayPage = {};
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var dash = function (v, suffix) { return v == null ? "—" : esc(v) + (suffix || ""); };
  var hm = function (m) { return m == null ? "—" : Math.floor(m / 60) + " h " + ("0" + Math.round(m % 60)).slice(-2); };
  var nf = function (v) { return v == null ? "—" : new Intl.NumberFormat("en-GB").format(v); };
  var long = function (d) { return new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); };
  var short = function (d) { return new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
  var CHARTS = [["sleepScore", "health", "line", 100], ["mood", "none", "line", 100], ["stressAvg", "health", "line", 100], ["steps", "health", "bar"], ["restingHr", "health", "line"], ["workoutVolume", "health", "bar"], ["tasksDone", "task", "bar"], ["spending", "task", "bar"]];

  P.mount = function (host, o) {
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    var S = { date: o.date || o.today, today: o.today, tab: o.tab || "day", span: 30, raw: null, rawKey: "", err: "", loading: false, theme: o.theme || "light" };
    root.innerHTML = '<link rel="stylesheet" href="' + (o.css || "day/day.css") + '"><div class="dp"></div>';
    var dp = root.querySelector(".dp");
    var money = function (v) { return v == null ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency: o.currency || "EUR" }).format(v); };

    function need() { return S.tab === "trends" ? [D.add(S.today, -(S.span - 1)), S.today] : [S.date, S.date]; }
    function load() {
      var r = need(), key = r[0] + ".." + r[1];
      if (S.rawKey === key && S.raw) return Promise.resolve();
      S.loading = true; draw();
      return Promise.resolve(o.load(r[0], r[1])).then(function (raw) { S.raw = raw || {}; S.rawKey = key; S.err = ""; }, function (e) { S.raw = {}; S.rawKey = ""; S.err = "This day couldn’t be loaded. Check your connection and try again."; if (window.console) console.warn(e); }).then(function () { S.loading = false; draw(); });
    }
    function head() {
      var isToday = S.date === S.today;
      return '<header class="top"><div><p class="eyebrow">' + (S.tab === "trends" ? "Trends" : isToday ? "Today" : S.date < S.today ? "A past day" : "A day ahead") + '</p><h1>' + esc(S.tab === "trends" ? "The last " + S.span + " days" : long(S.date)) + '</h1></div>' +
        '<div class="tools"><span class="seg" role="group" aria-label="View"><button data-tab="day" aria-pressed="' + (S.tab === "day") + '">Day</button><button data-tab="trends" aria-pressed="' + (S.tab === "trends") + '">Trends</button></span>' +
        (S.tab === "day" ? '<span class="nav"><button class="btn" data-go="-1" aria-label="Previous day">←</button><input class="btn date" id="dpDate" type="date" value="' + esc(S.date) + '" aria-label="Choose a date"><button class="btn" data-go="1" aria-label="Next day">→</button><button class="btn" data-go="today"' + (isToday ? " disabled" : "") + ">Today</button></span>"
          : '<span class="seg" role="group" aria-label="Period">' + [7, 30, 90].map(function (n) { return '<button data-span="' + n + '" aria-pressed="' + (S.span === n) + '">' + n + " days</button>"; }).join("") + "</span>") + "</div></header>";
    }
    var sec = function (key, title, body, note) { return '<section class="card" style="--c:var(--area-' + key + ');--cs:var(--area-' + key + '-soft)" aria-label="' + esc(title) + '"><h2><i aria-hidden="true"></i>' + esc(title) + (note ? "<small>" + esc(note) + "</small>" : "") + "</h2>" + body + "</section>"; };
    var kv = function (rows) { return '<dl class="kv">' + rows.map(function (r) { return "<div><dt>" + esc(r[0]) + "</dt><dd>" + r[1] + "</dd></div>"; }).join("") + "</dl>"; };
    function dayHtml() {
      var d = D.build(S.date, S.raw), s = d.summary, h = "";
      h += '<div class="strip" role="group" aria-label="The day in numbers">' + [["Sleep score", dash(s.sleepScore)], ["Mood", s.mood == null ? "—" : s.mood + "<small>/100</small>"], ["Stress", dash(s.stressAvg)], ["Workout", s.workout ? "Yes" : "No"], ["Tasks done", String(s.tasksDone)], ["Spending", money(s.spending)]].map(function (t) { return '<div class="tile"><span>' + t[0] + "</span><b>" + t[1] + "</b></div>"; }).join("") + "</div>";
      var cards = [];
      if (d.health) { var x = d.health; cards.push(sec("health", "Health", kv([["Sleep score", dash(x.sleepScore)], ["Slept", hm(x.sleepMinutes)], ["Bed and wake", x.bed || x.wake ? dash(x.bed) + " – " + dash(x.wake) : "—"], ["Resting heart rate", dash(x.restingHr, " bpm")], ["Average stress", dash(x.stressAvg)], ["Body Battery", dash(x.bodyBattery)], ["Steps", nf(x.steps)]]), "last night’s sleep, today’s body")); }
      if (d.sport) cards.push(sec("health", "Sport", d.sport.workouts.map(function (w) {
        return '<div class="wo"><p class="t">' + esc(w.title) + "<small>" + [w.start, w.minutes != null ? w.minutes + " min" : null, w.volumeKg != null ? nf(Math.round(w.volumeKg)) + " kg" : null].filter(Boolean).join(" · ") + "</small></p>" + (w.exercises.length ? '<ul class="ex">' + w.exercises.slice(0, 8).map(function (e) { return "<li><span>" + esc(e.name) + "</span><span>" + dash(e.topSet) + "</span></li>"; }).join("") + (w.exercises.length > 8 ? '<li class="more">and ' + (w.exercises.length - 8) + " more</li>" : "") + "</ul>" : "") + "</div>";
      }).join("") + d.sport.activities.map(function (a) { return '<div class="wo"><p class="t">' + esc(a.name) + "<small>" + [a.minutes != null ? Math.round(a.minutes) + " min" : null, a.km != null ? a.km + " km" : null, a.avgHr != null ? a.avgHr + " bpm" : null].filter(Boolean).join(" · ") + "</small></p></div>"; }).join("")));
      if (d.tasks) cards.push(sec("task", "Tasks", (d.tasks.done.length ? '<p class="lab">Done this day</p><ul class="list">' + d.tasks.done.map(function (t) { return '<li class="done"><span class="ck" aria-hidden="true">✓</span>' + esc(t.title) + (t.repeats ? "<small>repeats</small>" : "") + "</li>"; }).join("") + "</ul>" : "") + (d.tasks.dueNotDone.length ? '<p class="lab">Due, not done</p><ul class="list">' + d.tasks.dueNotDone.map(function (t) { return '<li><span class="ck" aria-hidden="true">' + (t.kind === "deadline" ? "◆" : "○") + "</span>" + esc(t.title) + (t.doneLater ? "<small>done " + esc(short(t.doneLater)) + "</small>" : "") + "</li>"; }).join("") + "</ul>" : "")));
      if (d.events) cards.push(sec("task", "Calendar", '<ul class="list">' + d.events.map(function (e) { return '<li><span class="tm">' + dash(e.time) + "</span>" + esc(e.title) + (e.minutes ? "<small>" + e.minutes + " min</small>" : "") + "</li>"; }).join("") + "</ul>"));
      if (d.notes) cards.push(sec("growth", "Notes", d.notes.map(function (n) { return '<button class="note" data-note="' + esc(n.id) + '"><b>' + esc(n.title) + "</b><span>" + esc(n.firstLines) + "</span></button>"; }).join("")));
      if (d.checkin) { var c = d.checkin, m = c.mood; cards.push(sec("none", "Check-in", (m ? '<div class="mood"><b>' + m.score + '</b><span>/100 · ' + esc(m.label) + '</span></div><div class="mbar"><i style="width:' + m.score + '%"></i></div><ul class="mparts">' + m.parts.map(function (p) { return "<li><span>" + esc(p.k) + '</span><span class="mb"><i style="width:' + p.v + '%"></i></span><span class="mv">' + p.v + "</span><small>" + esc(p.t) + "</small></li>"; }).join("") + '</ul><p class="hint">Mood is worked out, not typed in: from the feelings tagged in your notes, how you sounded with Claude, your check-in, sleep and stress. ' + (m.basis === "sleep and stress only" ? "Today it rests on sleep and stress only." : "") + "</p>" : "") + kv([["Energy", c.energy == null ? "—" : c.energy + " of 5"]].concat(c.note ? [["Note", esc(c.note)]] : [])) + (c.dailyLog.length ? '<p class="lab">Daily log</p><p class="chips">' + c.dailyLog.map(function (t) { return "<span>" + esc(t) + "</span>"; }).join("") + "</p>" : ""))); }
      if (d.money) cards.push(sec("task", "Money", kv([["Spent", money(d.money.spent)]]) + '<ul class="list">' + d.money.transactions.map(function (t) { return "<li>" + esc(t.description || "Transaction") + '<small class="amt">' + money(t.amount) + "</small></li>"; }).join("") + "</ul>"));
      if (d.people) cards.push(sec("people", "People", '<ul class="list">' + d.people.map(function (p) { return "<li>" + esc(p.name) + "<small>" + esc({ call: "talked", met: "met", message: "messaged", other: "in touch" }[p.kind] || "in touch") + "</small></li>"; }).join("") + "</ul>"));
      if (d.conversations) cards.push(sec("none", "Conversations with Claude", d.conversations.map(function (c) {
        return '<article class="conv"><p class="cmeta"><span>' + (c.source === "voice" ? "Voice" : "Chat") + (c.time ? " · " + esc(c.time) : "") + '</span><button class="arch" data-archive="' + esc(c.id) + '" aria-label="Archive this summary">Archive</button></p><ul>' + c.bullets.map(function (b) { return "<li>" + esc(b) + "</li>"; }).join("") + "</ul>" + (c.topics.length ? '<p class="chips">' + c.topics.map(function (t) { return "<span>" + esc(t) + "</span>"; }).join("") + "</p>" : "") + "</article>";
      }).join(""), "saved by Claude, not in your notes"));
      h += cards.length ? '<div class="grid">' + cards.join("") + "</div>" : '<section class="card empty"><p>' + (S.date > S.today ? "Nothing is planned for this day yet." : "Nothing was recorded for this day.") + "</p></section>";
      return h;
    }
    function chart(m, key, kind, max, days) {
      var vals = days.map(function (d) { return D.metric(d, m); }), have = vals.filter(function (v) { return v != null; });
      var W = 320, H = 96, L = 4, T = 8, B = 16, n = days.length, top = max || Math.max.apply(null, have.concat([1])), lo = kind === "line" && !max && have.length ? Math.min.apply(null, have) * 0.9 : 0;
      var x = function (i) { return L + (n === 1 ? (W - 2 * L) / 2 : i * (W - 2 * L) / (n - 1)); }, y = function (v) { return T + (H - T - B) * (1 - (v - lo) / ((top - lo) || 1)); };
      var avg = have.length ? have.reduce(function (s, v) { return s + v; }, 0) / have.length : null, last = null; for (var i = n - 1; i >= 0; i--) if (vals[i] != null) { last = vals[i]; break; }
      var fmtV = function (v) { return m === "spending" ? money(v) : nf(Math.round(v * 10) / 10); };
      var g = '<line class="base" x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - L) + '" y2="' + (H - B) + '"/>';
      if (kind === "line") { var seg = [], cur = []; vals.forEach(function (v, i) { if (v == null) { if (cur.length) seg.push(cur); cur = []; } else cur.push(x(i).toFixed(1) + "," + y(v).toFixed(1)); }); if (cur.length) seg.push(cur); g += seg.map(function (s) { return '<polyline points="' + s.join(" ") + '"/>'; }).join(""); }
      var bw = Math.max(2, Math.min(14, (W - 2 * L) / n - 2));
      vals.forEach(function (v, i) {
        if (v == null) return; var lab = short(days[i].date) + ": " + fmtV(v);
        g += kind === "bar" ? '<rect class="pt" data-date="' + days[i].date + '" tabindex="0" role="link" aria-label="' + esc(lab) + '" x="' + (x(i) - bw / 2).toFixed(1) + '" y="' + y(v).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, H - B - y(v)).toFixed(1) + '" rx="2"><title>' + esc(lab) + "</title></rect>"
          : '<circle class="pt' + (n > 45 ? " sm" : "") + '" data-date="' + days[i].date + '" tabindex="0" role="link" aria-label="' + esc(lab) + '" cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="' + (n > 45 ? 1.8 : 3.2) + '"><title>' + esc(lab) + "</title></circle>";
      });
      g += '<text class="ax" x="' + L + '" y="' + (H - 3) + '">' + esc(short(days[0].date)) + '</text><text class="ax" x="' + (W - L) + '" y="' + (H - 3) + '" text-anchor="end">' + esc(short(days[n - 1].date)) + "</text>";
      return '<section class="card ch" style="--c:var(--area-' + key + ')"><h2><i aria-hidden="true"></i>' + esc(D.METRICS[m]) + "</h2>" + (have.length ? '<p class="num"><b>' + fmtV(last) + "</b><span>latest · average " + fmtV(avg) + " · " + have.length + " of " + n + ' days</span></p><svg viewBox="0 0 ' + W + " " + H + '" role="group" aria-label="' + esc(D.METRICS[m]) + ' by day">' + g + "</svg>" : '<p class="none">No data in this period.</p>') + "</section>";
    }
    function trendsHtml() {
      var r = need(), days = D.range(r[0], r[1]).map(function (d) { return D.build(d, S.raw); });
      return '<p class="sub">Each metric by day. Click a point to open that day.</p><div class="grid charts">' + CHARTS.map(function (c) { return chart(c[0], c[1], c[2], c[3], days); }).join("") + "</div>";
    }
    function draw() {
      dp.dataset.theme = S.theme;
      dp.innerHTML = '<div class="wrap">' + head() + (S.err ? '<section class="card empty"><p>' + esc(S.err) + '</p><button class="btn" data-retry="1">Try again</button></section>' : S.loading || !S.raw ? '<p class="loading" role="status">Loading…</p>' : S.tab === "trends" ? trendsHtml() : dayHtml()) + "</div>";
    }
    function go(date, tab) { if (date) S.date = date; if (tab) S.tab = tab; if (o.onChange) o.onChange(S.date, S.tab); return load(); }
    dp.addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest("[data-go],[data-tab],[data-span],[data-note],[data-date],[data-retry],[data-archive]"); if (!t || t.disabled) return; var d = t.dataset;
      if (d.go) go(d.go === "today" ? S.today : D.add(S.date, +d.go));
      else if (d.tab) go(null, d.tab);
      else if (d.span) { S.span = +d.span; load(); }
      else if (d.note) { if (o.onOpenNote) o.onOpenNote(d.note); }
      else if (d.date) go(d.date, "day");
      else if (d.retry) { S.rawKey = ""; load(); }
      else if (d.archive && o.onArchiveSummary) { t.disabled = true; Promise.resolve(o.onArchiveSummary(d.archive)).then(function () { S.rawKey = ""; load(); }, function () { t.disabled = false; }); }
    });
    dp.addEventListener("change", function (e) { if (e.target.id === "dpDate" && /^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) go(e.target.value); });
    dp.addEventListener("keydown", function (e) { var t = e.target.closest && e.target.closest(".pt[data-date]"); if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); go(t.dataset.date, "day"); } });
    load();
    return {
      show: function (date, tab) { if ((date && date !== S.date) || (tab && tab !== S.tab)) { if (date) S.date = date; if (tab) S.tab = tab; } return load(); },
      update: function (d) { if (d.theme) S.theme = d.theme; if (d.today) S.today = d.today; if (d.refresh) S.rawKey = ""; return load(); },
      state: function () { return { date: S.date, tab: S.tab, span: S.span }; }
    };
  };
})();
