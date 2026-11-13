/* Command Center → Big picture. The strategic dashboard: how each area of life stands, at a glance, then deeper.
   Top line first (overall score, goal status counts, what is late, what is due), then what needs attention,
   then the areas side by side: score, 4-week trend, the day's signal, counts, and every goal as one dense row
   (status, score bar with the 40/70 marks, change, due date, open and overdue tasks). A goal row opens to what
   its score is made of, its projects, the next tasks and a tip for the next step. Tasks are detail, not the subject.
   Status rule (shown on the page): on track ≥ 70, watch 40–69, at risk < 40; overdue tasks pull a goal down to
   watch; a goal past its due date and unfinished is at risk. Status always has a shape and a word, never colour alone. */
(function () {
  var V = window.PPCommandView, C = window.PPCommandCore;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var ORDER = ["health", "work", "task", "growth", "people", "sol"];
  var PULSE = { health: "health", task: "money", people: "people", growth: "growth" };
  var ST = { ok: ["●", "On track"], watch: ["▲", "Watch"], risk: ["◆", "At risk"], none: ["○", "Not rated"] };
  var RANK = { risk: 0, watch: 1, none: 2, ok: 3 };
  var fmtD = function (d) { return d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""; };
  var days = function (a, b) { return Math.round((C.ms(b) - C.ms(a)) / 864e5); };
  var ink = function (k) { return k === "sol" ? "var(--bp-sol)" : "var(--area-" + k + ")"; };
  var plural = function (n, w) { return n + " " + w + (n === 1 ? "" : "s"); };
  var MODE = { manual: "your own rating", sleep: "7-day sleep score", workout: "workouts done of planned, last 28 days", net_zero: "share of the starting debt cleared", tasks: "tasks done under this goal" };
  /* change over about four weeks: the latest point against the oldest one in the last 28 days */
  function delta(hist, t) {
    var h = (hist || []).filter(function (x) { return typeof x.s === "number" && x.d && days(x.d, t) <= 28; }); if (h.length < 2) return null;
    return Math.round(h[h.length - 1].s - h[0].s);
  }
  function spark(hist, w, ht, k) {
    var h = (hist || []).filter(function (x) { return typeof x.s === "number"; }); if (h.length < 2) return "";
    var xs = h.map(function (_, i) { return (i / (h.length - 1)) * (w - 4) + 2; }), ys = h.map(function (x) { return ht - 2 - (x.s / 100) * (ht - 4); });
    var pts = xs.map(function (x, i) { return x.toFixed(1) + "," + ys[i].toFixed(1); }).join(" ");
    return '<svg class="bp-spk" viewBox="0 0 ' + w + " " + ht + '" style="--c:' + ink(k) + '" aria-hidden="true"><polygon points="2,' + ht + " " + pts + " " + (w - 2) + "," + ht + '"/><polyline points="' + pts + '"/><circle cx="' + xs[xs.length - 1].toFixed(1) + '" cy="' + ys[ys.length - 1].toFixed(1) + '" r="2"/></svg>';
  }
  var dl = function (d) { return d == null ? "" : '<span class="bp-d ' + (d > 0 ? "up" : d < 0 ? "dn" : "") + '" title="Change over the last 4 weeks">' + (d > 0 ? "▲ +" + d : d < 0 ? "▼ −" + Math.abs(d) : "– 0") + "</span>"; };
  var stEl = function (s) { return '<span class="bp-st ' + s + '"><i aria-hidden="true">' + ST[s][0] + "</i>" + ST[s][1] + "</span>"; };
  var scoreTxt = function (g) { return g.score == null ? "–" : g.scoreMode === "manual" ? (g.score / 10).toFixed(g.score % 10 ? 1 : 0) + "/10" : Math.round(g.score) + "%"; };

  /* everything the view shows, worked out once */
  V.bigModel = function (S) {
    var t = S.today, items = (S.items || []).filter(function (i) { return !i.archived && i.kind !== "event"; }), goals = S.goals || [], projects = S.projects || [];
    var wk0 = C.monday(t), wk1 = C.add(wk0, 6), week = C.expand((S.items || []).filter(function (i) { return !i.archived; }), wk0, wk1);
    var isOpen = function (i) { return !i.recurrence && !i.done && !i.someday; }, isLate = function (i) { return isOpen(i) && i.date && i.date < t && C.hasDone(i); };
    var G = goals.map(function (g) {
      var mine = items.filter(function (i) { return i.goalId === g.id; }), open = mine.filter(isOpen), late = mine.filter(isLate), done = mine.filter(function (i) { return !i.recurrence && i.done; });
      var next = open.filter(function (i) { return i.date; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }).concat(open.filter(function (i) { return !i.date; }));
      var ps = projects.filter(function (p) { return p.goalId === g.id; }), d = delta(g.scoreHistory, t), left = g.due ? days(t, g.due) : null;
      var hist = (g.scoreHistory || []).filter(function (x) { return typeof x.s === "number"; }), last = hist.length ? hist[hist.length - 1].d : null;
      var st = g.score == null ? "none" : g.score >= 70 ? "ok" : g.score >= 40 ? "watch" : "risk";
      if (left != null && left < 0 && (g.score == null || g.score < 100)) st = "risk"; else if (late.length && st === "ok") st = "watch";
      // the one next step
      var tip, sev = 0;
      if (left != null && left < 0 && (g.score == null || g.score < 100)) { tip = "Past its due date by " + plural(-left, "day") + ". Set a new date or close it."; sev = 5; }
      else if (late.length) { tip = "Clear " + plural(late.length, "overdue task") + ", starting with “" + late.sort(function (a, b) { return a.date < b.date ? -1 : 1; })[0].title + "”."; sev = 4; }
      else if (left != null && left <= 30 && g.score != null && g.score < 70) { tip = "Due in " + plural(left, "day") + " at " + scoreTxt(g) + ". Decide what must be done by then and drop the rest."; sev = 4; }
      else if (d != null && d <= -10) { tip = "Down " + Math.abs(d) + " points in four weeks. Look at what changed."; sev = 3; }
      else if (g.score == null) { tip = g.scoreMode === "manual" ? "Not rated yet. Give it a score out of 10." : "No score yet: it appears once there is data (" + MODE[g.scoreMode || "tasks"] + ")."; sev = 2; }
      else if (!open.length && (g.scoreMode === "tasks" || g.scoreMode === "manual") && g.score < 100) { tip = "No next step is planned. Add one task that moves it forward."; sev = 3; }
      else if (g.scoreMode === "manual" && last && days(last, t) > 30) { tip = "Last rated " + days(last, t) + " days ago. Rate it again."; sev = 2; }
      else if (st === "risk") { tip = "Low score. Pick the one thing that would raise it most this week."; sev = 3; }
      else if (next[0]) { tip = "Next: “" + next[0].title + "”" + (next[0].date ? " on " + fmtD(next[0].date) : "") + "."; sev = st === "watch" ? 1 : 0; }
      else { tip = "On track. Keep the rhythm."; sev = 0; }
      return { g: g, k: C.areaKey(g.area), st: st, d: d, left: left, open: open, late: late, done: done, total: mine.filter(function (i) { return !i.recurrence; }).length, next: next, ps: ps, tip: tip, sev: sev, last: last };
    });
    var A = ORDER.map(function (k) {
      var gs = G.filter(function (x) { return x.k === k; }).sort(function (a, b) { return RANK[a.st] - RANK[b.st] || (a.g.score || 0) - (b.g.score || 0); });
      var mine = items.filter(function (i) { return C.areaKey(i.area) === k || (i.goalId && gs.some(function (x) { return x.g.id === i.goalId; })); });
      var scored = gs.filter(function (x) { return x.g.score != null; }), avg = scored.length ? Math.round(scored.reduce(function (s, x) { return s + +x.g.score; }, 0) / scored.length) : null;
      // the area's own line: the average of its goals' scores on every day one of them has a point
      var byDay = {}; scored.forEach(function (x) { (x.g.scoreHistory || []).forEach(function (p) { if (typeof p.s === "number") (byDay[p.d] = byDay[p.d] || []).push(p.s); }); });
      var hist = Object.keys(byDay).sort().map(function (d) { return { d: d, s: byDay[d].reduce(function (a, b) { return a + b; }, 0) / byDay[d].length }; });
      var wkOcc = week.filter(function (o) { return C.areaKey(o.item.area) === k; }), wkMin = wkOcc.reduce(function (s, o) { return s + (o.item.time && !o.item.allDay ? (o.item.dur || o.item.est || 30) : 0); }, 0);
      var loose = mine.filter(function (i) { return isOpen(i) && !i.goalId && !i.projectId; });
      var st = !gs.length ? "none" : gs.some(function (x) { return x.st === "risk"; }) ? (avg != null && avg >= 70 ? "watch" : "risk") : gs.some(function (x) { return x.st === "watch"; }) ? "watch" : avg == null ? "none" : "ok";
      var top = gs.slice().sort(function (a, b) { return b.sev - a.sev; })[0];
      var tip = top && top.sev > 0 ? { text: top.g.title + ": " + top.tip, goal: top.g.id, sev: top.sev } : !gs.length ? { text: loose.length ? plural(loose.length, "open task") + " here but no goal. Add a goal if this area matters right now." : "No goals here. That is fine if it is on purpose.", sev: loose.length ? 1 : 0 } : { text: "All goals on track. Keep the rhythm.", sev: 0 };
      return { k: k, name: C.AREA_NAME[k], gs: gs, avg: avg, d: delta(hist, t), hist: hist.slice(-28), st: st, tip: tip, open: mine.filter(isOpen).length, late: mine.filter(isLate).length, due7: mine.filter(function (i) { return isOpen(i) && i.date && i.date >= t && i.date <= C.add(t, 7); }).length,
        done: mine.filter(function (i) { return !i.recurrence && i.done; }).length, total: mine.filter(function (i) { return !i.recurrence; }).length, projects: gs.reduce(function (s, x) { return s + x.ps.filter(function (p) { return !p.done; }).length; }, 0), wkN: wkOcc.length, wkMin: wkMin, loose: loose.length, pulse: S.pulse && PULSE[k] ? S.pulse[PULSE[k]] : null };
    });
    var scoredAll = G.filter(function (x) { return x.g.score != null; }), cnt = { ok: 0, watch: 0, risk: 0, none: 0 }; G.forEach(function (x) { cnt[x.st]++; });
    var dues = G.filter(function (x) { return x.left != null && x.left >= 0; }).sort(function (a, b) { return a.left - b.left; });
    var allDay = {}; scoredAll.forEach(function (x) { (x.g.scoreHistory || []).forEach(function (p) { if (typeof p.s === "number") (allDay[p.d] = allDay[p.d] || []).push(p.s); }); });
    var allHist = Object.keys(allDay).sort().map(function (d) { return { d: d, s: allDay[d].reduce(function (a, b) { return a + b; }, 0) / allDay[d].length }; });
    return { areas: A, goals: G, avg: scoredAll.length ? Math.round(scoredAll.reduce(function (s, x) { return s + +x.g.score; }, 0) / scoredAll.length) : null, d: delta(allHist, t), hist: allHist.slice(-28), cnt: cnt,
      late: items.filter(isLate).length, due7: items.filter(function (i) { return isOpen(i) && i.date && i.date >= t && i.date <= C.add(t, 7); }).length, open: items.filter(isOpen).length, nextDue: dues[0] || null,
      attention: G.filter(function (x) { return x.sev >= 3; }).sort(function (a, b) { return b.sev - a.sev || RANK[a.st] - RANK[b.st]; }).slice(0, 5) };
  };

  function bar(g, k) {
    var v = g.score == null ? null : Math.max(0, Math.min(100, +g.score));
    return '<span class="bp-bar" role="img" aria-label="' + esc(v == null ? "No score yet" : "Score " + scoreTxt(g)) + '" style="--c:' + ink(k) + '"><i style="width:' + (v == null ? 0 : v) + '%"></i><b style="left:40%"></b><b style="left:70%"></b></span>';
  }
  function goalRow(S, x) {
    var g = x.g, open = !!(S.bpOpen && S.bpOpen[g.id]), id = "bpg" + esc(g.id);
    var due = g.ongoing ? "ongoing" : g.due ? (x.left < 0 ? "was due " + fmtD(g.due) : x.left <= 60 ? "due in " + x.left + " d" : "due " + fmtD(g.due)) : "no date";
    var h = '<li class="bp-g ' + x.st + (open ? " open" : "") + '"><button class="bp-gh" data-bpx="' + esc(g.id) + '" aria-expanded="' + open + '" aria-controls="' + id + '"><span class="bp-st ' + x.st + '" title="' + ST[x.st][1] + '"><i aria-hidden="true">' + ST[x.st][0] + '</i><span class="sr">' + ST[x.st][1] + '</span></span><span class="bp-gt">' + esc(g.title) + "</span><span class=\"bp-v\">" + scoreTxt(g) + "</span>" + bar(g, x.k) +
      '<span class="bp-gm">' + dl(x.d) + '<span class="' + (x.left != null && x.left < 0 ? "bad" : "") + '">' + esc(due) + "</span><span>" + x.open.length + " open</span>" + (x.late.length ? '<span class="bad">' + x.late.length + " late</span>" : "") + '</span><span class="bp-car" aria-hidden="true">' + (open ? "▾" : "▸") + "</span></button>";
    if (open) {
      h += '<div class="bp-gd" id="' + id + '"><p class="bp-tip"><b>Next step</b>' + esc(x.tip) + "</p>" +
        '<dl class="bp-dl"><div><dt>Score</dt><dd>' + scoreTxt(g) + " · " + esc(MODE[g.scoreMode || "tasks"]) + (g.netZero && g.netZero.of ? " (" + new Intl.NumberFormat("en-GB", { style: "currency", currency: g.netZero.currency || "EUR", maximumFractionDigits: 0 }).format(g.netZero.cleared || 0) + " of " + new Intl.NumberFormat("en-GB", { style: "currency", currency: g.netZero.currency || "EUR", maximumFractionDigits: 0 }).format(g.netZero.of) + ")" : "") + "</dd></div>" +
        "<div><dt>4 weeks</dt><dd>" + (x.d == null ? "not enough history yet" : (x.d > 0 ? "up " : x.d < 0 ? "down " : "no change, ") + (x.d ? Math.abs(x.d) + " points" : "")) + spark(g.scoreHistory, 72, 18, x.k) + "</dd></div>" +
        "<div><dt>Tasks</dt><dd>" + x.done.length + " of " + x.total + " done · " + x.open.length + " open" + (x.late.length ? " · " + x.late.length + " overdue" : "") + "</dd></div>" +
        (x.last ? "<div><dt>Updated</dt><dd>" + esc(fmtD(x.last)) + "</dd></div>" : "") + "</dl>";
      if (x.ps.length) h += '<p class="bp-lab">Projects</p><ul class="bp-ps">' + x.ps.map(function (p) { return '<li><button data-project="' + esc(p.id) + '">' + esc(p.title) + '</button><span class="bp-bar" style="--c:' + ink(x.k) + '" role="img" aria-label="' + (p.doneCount || 0) + " of " + (p.total || 0) + ' tasks done"><i style="width:' + (p.total ? Math.round(p.doneCount / p.total * 100) : 0) + '%"></i></span><small>' + (p.doneCount || 0) + "/" + (p.total || 0) + (p.due ? " · " + esc(fmtD(p.due)) : "") + "</small></li>"; }).join("") + "</ul>";
      if (x.next.length) h += '<p class="bp-lab">Next tasks</p><ul class="bp-ts">' + x.next.slice(0, 3).map(function (i) { var late = i.date && i.date < S.today; return '<li><button data-open="' + esc(i.id) + '" data-date="' + esc(i.date || S.today) + '">' + esc(i.title) + "</button><small" + (late ? ' class="bad"' : "") + ">" + (i.date ? (late ? "overdue · " : "") + esc(fmtD(i.date)) : "no date") + "</small></li>"; }).join("") + (x.next.length > 3 ? '<li class="more">and ' + (x.next.length - 3) + " more</li>" : "") + "</ul>";
      h += '<p class="bp-acts"><button class="btn sm" data-goal="' + esc(g.id) + '">Open the goal</button><button class="btn sm ghost" data-cnfocus="' + esc(g.id) + '">Show in the map</button></p></div>';
    }
    return h + "</li>";
  }
  function areaCard(S, a) {
    var hm = function (m) { return m >= 60 ? Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) : "") : m + " min"; };
    var h = '<section class="bp-a ' + a.st + '" style="--c:' + ink(a.k) + ";--cs:var(--area-" + a.k + '-soft)" aria-label="' + esc(a.name) + '"><header><div class="bp-an"><i aria-hidden="true"></i><h2>' + esc(a.name) + "</h2>" + stEl(a.st) + '</div><div class="bp-as"><b>' + (a.avg == null ? "–" : a.avg) + (a.avg == null ? "" : "<small>%</small>") + "</b>" + dl(a.d) + spark(a.hist, 96, 26, a.k) + "</div></header>";
    if (a.pulse && a.pulse.big && a.pulse.big !== "–" && a.pulse.big !== "…") h += '<p class="bp-pulse"><b>' + esc(a.pulse.big) + "</b> " + esc(a.pulse.sub || "") + "</p>";
    h += '<dl class="bp-stats"><div><dt>Goals</dt><dd>' + a.gs.length + "</dd></div><div><dt>Projects</dt><dd>" + a.projects + "</dd></div><div><dt>Open</dt><dd>" + a.open + '</dd></div><div><dt>Overdue</dt><dd class="' + (a.late ? "bad" : "") + '">' + a.late + "</dd></div><div><dt>Due 7 d</dt><dd>" + a.due7 + "</dd></div><div><dt>Done</dt><dd>" + (a.total ? Math.round(a.done / a.total * 100) + "%" : "–") + "</dd></div></dl>" +
      '<p class="bp-wk">This week: ' + (a.wkN ? plural(a.wkN, "item") + (a.wkMin ? " · " + hm(a.wkMin) + " planned" : "") : "nothing planned") + (a.loose ? " · " + a.loose + " loose" : "") + "</p>";
    h += a.gs.length ? '<ul class="bp-gs">' + a.gs.map(function (x) { return goalRow(S, x); }).join("") + "</ul>" : '<p class="bp-none">No goals in this area.</p>';
    h += '<p class="bp-tip a"><b>Next step</b>' + (a.tip.goal ? '<button data-bpx="' + esc(a.tip.goal) + '" data-bpopen="1">' + esc(a.tip.text) + "</button>" : esc(a.tip.text)) + "</p></section>";
    return h;
  }
  V.areas = function (S) {
    var M = V.bigModel(S), keys = M.areas.filter(function (a) { return !S.areaFilter || S.areaFilter === a.k; }).filter(function (a) { return a.gs.length || a.open || S.areaFilter; });
    var n = M.goals.length, seg = function (k) { return M.cnt[k] ? '<i class="' + k + '" style="flex:' + M.cnt[k] + '" title="' + M.cnt[k] + " " + ST[k][1].toLowerCase() + '"></i>' : ""; };
    var h = '<div class="head"><div><p class="eyebrow">Big picture</p><h1>How your areas stand</h1><p class="sub" style="margin-top:6px">Your life as connected dots, then every area and goal in numbers. Open a goal for what its score is made of and the next step.</p></div></div>';
    h += V.cnHtml ? V.cnHtml(S) : "";   // the constellation first, the numbers below it
    h += '<div class="bp-top"><div class="bp-k main"><span class="l">Overall</span><b>' + (M.avg == null ? "–" : M.avg + "<small>%</small>") + "</b>" + dl(M.d) + spark(M.hist, 120, 30, "none") + '<span class="s">average of ' + plural(n - M.cnt.none, "rated goal") + "</span></div>" +
      '<div class="bp-k wide"><span class="l">Goals by status</span><div class="bp-mix" role="img" aria-label="' + M.cnt.ok + " on track, " + M.cnt.watch + " to watch, " + M.cnt.risk + " at risk, " + M.cnt.none + ' not rated">' + seg("ok") + seg("watch") + seg("risk") + seg("none") + '</div><div class="bp-leg">' + ["ok", "watch", "risk", "none"].map(function (k) { return '<span class="bp-st ' + k + '"><i aria-hidden="true">' + ST[k][0] + "</i><b>" + M.cnt[k] + "</b> " + ST[k][1].toLowerCase() + "</span>"; }).join("") + "</div></div>" +
      '<div class="bp-k"><span class="l">Overdue tasks</span><b class="' + (M.late ? "bad" : "") + '">' + M.late + '</b><span class="s">of ' + M.open + " open</span></div>" +
      '<div class="bp-k"><span class="l">Due in 7 days</span><b>' + M.due7 + '</b><span class="s">tasks and deadlines</span></div>' +
      '<div class="bp-k"><span class="l">Next goal date</span><b class="t">' + (M.nextDue ? (M.nextDue.left === 0 ? "today" : M.nextDue.left + " d") : "–") + '</b><span class="s">' + (M.nextDue ? esc(M.nextDue.g.title) : "no dated goals") + "</span></div></div>";
    if (!n) return h + '<section class="card"><p class="none">No goals yet. Add a goal and it appears here with its score, trend and next step.</p></section>';
    h += '<section class="bp-att" aria-label="Needs attention"><h2>Needs attention</h2>' + (M.attention.length ? "<ol>" + M.attention.map(function (x) { return '<li style="--c:' + ink(x.k) + '"><button data-bpx="' + esc(x.g.id) + '" data-bpopen="1">' + stEl(x.st) + '<span class="bp-at"><b>' + esc(x.g.title) + "</b>" + esc(x.tip) + '</span><span class="bp-chip"><i aria-hidden="true"></i>' + esc(C.AREA_NAME[x.k]) + "</span></button></li>"; }).join("") + "</ol>" : '<p class="sub">Nothing urgent. No goal is overdue, slipping or without a next step.</p>') + "</section>";
    h += '<div class="bp-grid">' + keys.map(function (a) { return areaCard(S, a); }).join("") + "</div>";
    h += '<details class="bp-how"><summary>How status and scores are worked out</summary><p><b>On track</b> is a score of 70 or more, <b>watch</b> is 40 to 69, <b>at risk</b> is under 40; the two marks on each bar are those lines. Overdue tasks move an on-track goal to watch, and a goal past its due date is at risk until it is finished or re-dated. An area’s number is the average of its rated goals. Scores come from your own rating, your sleep, your workouts, debt cleared, or tasks done, depending on the goal. Change is measured over the last four weeks.</p></details>';
    return h;
  };
})();
