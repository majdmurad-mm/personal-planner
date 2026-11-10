/* Command Center: builds the HTML for each view from plain data. No state and no event handling here. */
(function () {
  var C = window.PPCommandCore, V = window.PPCommandView = {};
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  V.esc = esc;
  var AREAS = ["Health", "Finance", "Career", "Maintenance", "Growth", "Relationships", "Sol"];
  var H0 = 7, HRS = 16;
  var dt = function (s) { return new Date(s + "T12:00:00"); };
  var fmt = function (s, o) { return dt(s).toLocaleDateString("en-GB", o || { weekday: "short", day: "numeric", month: "short" }); };
  V.fmt = fmt;
  var cvar = function (a) { return AREAS.indexOf(a) >= 0 ? ' style="--c:var(--' + a + ')"' : ""; };
  var dot = function (a) { return '<i class="dot"' + cvar(a) + "></i>"; };
  var dur = function (m) { return m >= 60 ? (m % 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : m / 60 + " h") : m + " min"; };
  var hrs = function (m) { var h = Math.round(m / 6) / 10; return String(h).replace(".", ",") + " h"; };
  var KIND = { task: "Task", event: "Event", deadline: "Deadline", block: "Time block" };
  V.KIND = KIND;
  var when = function (o) { var it = o.item; return it.allDay || !it.time ? (it.kind === "deadline" ? "due" : it.est ? dur(it.est) : "") : it.time + (it.dur ? "–" + C.hhmm(C.mins(it.time) + it.dur) : ""); };
  var blocked = function (S, it) { return (it.dependsOn || []).some(function (id) { var d = S.byId[id]; return d && !d.done && !d.archived; }); };
  var weekNo = function (s) { var d = new Date(C.ms(s)), day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); var first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d - first) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7); };
  var isWork = function (S, d) { return S.work && S.work.days.indexOf(C.dow(d)) >= 0; };

  /* one line for an item on a day */
  function row(S, o, extra) {
    var it = o.item, has = C.hasDone(it), w = when(o);
    return '<div class="it' + (o.done ? " done" : "") + '">' +
      (has ? '<button class="box" role="checkbox" aria-checked="' + !!o.done + '" data-done="' + esc(o.key) + '" aria-label="' + (o.done ? "Mark not done: " : "Mark done: ") + esc(it.title) + '"><i>' + (o.done ? "✓" : "") + "</i></button>"
        : '<span class="mark"' + cvar(it.area) + ' title="' + KIND[it.kind] + '"><i></i></span>') +
      '<span class="ti"><button data-open="' + esc(it.id) + '" data-date="' + o.date + '">' + esc(it.title || "Untitled") + "</button>" +
      (it.area ? ' <span class="m">· ' + dot(it.area) + esc(it.area) + "</span>" : "") +
      (it.kind === "deadline" ? '<span class="tag">◆ deadline</span>' : "") + (it.priority && it.priority <= "P1" ? '<span class="tag">' + esc(it.priority) + "</span>" : "") +
      (o.repeats ? '<span class="tag" title="' + esc(C.ruleText(it.recurrence)) + '">↻ repeats</span>' : "") + (blocked(S, it) ? '<span class="tag">waiting on another task</span>' : "") + (it.source === "google" ? '<span class="tag">Google</span>' : "") +
      '</span><span class="when">' + esc(extra != null ? extra : w) + "</span></div>";
  }
  V.row = row;
  function triage(o, inBacklog) {
    var k = esc(o.key);
    return '<div class="tri">' + (inBacklog ? "" : '<button class="btn sm" data-tri="today" data-key="' + k + '">Do today</button>') + '<button class="btn sm" data-tri="pick" data-key="' + k + '">' + (inBacklog ? "Schedule" : "Pick a date") + "</button>" +
      (o.repeats ? '<button class="btn sm" data-tri="skip" data-key="' + k + '">Skip this one</button>' : o.item.someday ? '<button class="btn sm" data-tri="unsomeday" data-key="' + k + '">Back to backlog</button>' : '<button class="btn sm" data-tri="someday" data-key="' + k + '">Someday</button>') +
      (o.repeats ? "" : '<button class="btn sm" data-tri="archive" data-key="' + k + '">Archive</button>') + "</div>";
  }

  /* a day as a time column */
  function timecol(S, date, occs, withHours) {
    var out = "", left = withHours ? 52 : 6, w = isWork(S, date) ? [C.mins(S.work.start), C.mins(S.work.end)] : null, top = function (m) { return "calc(" + ((m - H0 * 60) / 60).toFixed(3) + "*var(--hh))"; };
    for (var h = 0; h < HRS; h++) out += '<div class="hr" style="top:calc(' + h + '*var(--hh))">' + (withHours && h % 2 === 0 ? C.pad(H0 + h) + ":00" : "") + "</div>";
    if (w) out += '<div class="blk work" style="top:' + top(w[0]) + ";height:calc(" + ((w[1] - w[0]) / 60) + "*var(--hh) - 2px);left:" + left + "px;width:calc(100% - " + (left + 6) + 'px)">Work<small>' + S.work.start + " to " + S.work.end + "</small></div>";
    occs.filter(function (o) { return o.date === date && o.item.time && !o.item.allDay; }).forEach(function (o) {
      var it = o.item, s = Math.max(H0 * 60, C.mins(it.time)), len = it.dur || it.est || (it.kind === "task" || it.kind === "deadline" ? 30 : 60), e = Math.min((H0 + HRS) * 60, s + len);
      if (e <= s) return;
      var inW = w && s >= w[0] && e <= w[1];
      out += '<button class="blk' + (inW ? " inw" : "") + (o.done ? " dn" : "") + '" data-open="' + esc(it.id) + '" data-date="' + date + '" style="top:calc(' + ((s - H0 * 60) / 60).toFixed(3) + "*var(--hh) + 1px);height:calc(" + ((e - s) / 60).toFixed(3) + "*var(--hh) - 2px);" + (AREAS.indexOf(it.area) >= 0 ? "--c:var(--" + it.area + ");" : "") + (withHours ? (inW ? "left:45%;width:calc(55% - 6px)" : "left:52px;width:calc(100% - 58px)") : "") + '" title="' + esc(it.title + " · " + when(o)) + '">' + esc(it.title) + (e - s >= 60 ? "<small>" + esc(when(o)) + "</small>" : "") + "</button>";
    });
    if (date === S.today && S.nowMin >= H0 * 60 && S.nowMin <= (H0 + HRS) * 60) out += '<div class="nowline" style="top:' + top(S.nowMin) + '"></div>';
    return out;
  }
  function capBar(S, occs, date) {
    var c = C.capacity(occs, date, S.work), full = c.free < 180;
    return '<div class="cap" role="img" aria-label="' + hrs(c.booked) + " booked, " + hrs(c.free) + ' free"><i style="width:' + (c.work / c.total * 100).toFixed(1) + '%"></i><i class="x" style="width:' + (c.other / c.total * 100).toFixed(1) + '%"></i></div><div class="capt' + (full ? " full" : "") + '">' + (full ? "Full · " : "") + hrs(c.free) + " free</div>";
  }

  /* ---------- Today ---------- */
  V.today = function (S) {
    var t = S.today, occ = C.expand(S.items, t, t), main = S.byId[S.mainId], over = C.overdue(S.items, t), feed = S.feed || [];
    if (main && (main.done || main.archived)) main = null;
    var hour = Math.floor(S.nowMin / 60), hi = hour < 5 ? "Still up." : hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening.";
    var open = occ.filter(function (o) { return !o.done; }).length, cap = C.capacity(occ, t, S.work);
    var sub = (open ? open + (open === 1 ? " thing" : " things") + " today." : "Nothing on the list today.") + (isWork(S, t) && S.nowMin < C.mins(S.work.end) ? " Work until " + S.work.end + "." : "");
    var html = '<div class="grid today"><div class="grid"><div><p class="eyebrow">' + fmt(t, { weekday: "long", day: "numeric", month: "long" }) + "</p><h1>" + hi + '</h1><p class="sub" style="margin-top:6px">' + sub + "</p></div>";
    html += '<section class="card main" aria-label="The main thing"><p class="lab acc">★ The main thing</p>';
    if (main) html += '<p class="t">' + esc(main.title) + '</p><p class="sub">' + (main.area ? dot(main.area) + esc(main.area) + " · " : "") + (main.date === t ? "today" : main.date ? fmt(main.date) : "no date") + (main.time ? " at " + main.time : "") + (main.est ? " · about " + dur(main.est) : "") + '</p><div class="acts"><button class="btn pri" data-done="' + esc(main.id + "@" + (main.date || t)) + '">Done</button><button class="btn" data-main-tomorrow="' + esc(main.id) + '">Tomorrow</button><button class="btn" data-act="picker">Change</button><button class="btn ghost" data-open="' + esc(main.id) + '">Details</button></div>';
    else html += '<p class="t">Nothing pressing today.</p><div class="acts"><button class="btn" data-act="picker">Pick a main thing</button></div>';
    if (S.pickerOpen) {
      var opts = S.items.filter(function (i) { return i.kind !== "event" && !i.done && !i.archived && !i.someday && !i.recurrence && i.id !== S.mainId; }).sort(function (a, b) { return (!!b.date - !!a.date) || String(a.priority || "P9").localeCompare(String(b.priority || "P9")) || String(a.date || "").localeCompare(String(b.date || "")); }).slice(0, 10);
      html += '<div class="picker">' + (opts.length ? opts.map(function (i) { return '<button data-main="' + esc(i.id) + '"><span>' + esc(i.title) + '</span><span class="sub">' + (i.date ? fmt(i.date, { day: "numeric", month: "short" }) : esc(i.priority || "")) + "</span></button>"; }).join("") : '<p class="none">Nothing else is open.</p>') + "</div>";
    }
    html += '</section><section class="card"><h2>Today</h2><div style="margin-top:6px">' + (occ.length ? occ.map(function (o) { return row(S, o); }).join("") : '<p class="none">Nothing planned. Add something with the + button, or enjoy the room.</p>') + "</div></section>";
    if (over.length) html += '<section class="card"><div class="over"><div><h2>' + over.length + (over.length === 1 ? " thing from earlier is" : " things from earlier are") + ' still open</h2><p class="sub">No rush. Look when you have a minute.</p></div><button class="btn" data-act="overdue" aria-expanded="' + !!S.overdueOpen + '">' + (S.overdueOpen ? "Close" : "Go through them") + "</button></div>" +
      (S.overdueOpen ? '<div style="margin-top:10px">' + over.map(function (o) { return row(S, o, fmt(o.date, { day: "numeric", month: "short" })) + triage(o); }).join("") + "</div>" : "") + "</section>";
    var nx = C.expand(S.items, C.add(t, 1), C.add(t, 3));
    html += '<div class="grid two"><section class="card"><h2>Next three days</h2><div class="days3">' + [1, 2, 3].map(function (n) {
      var d = C.add(t, n), day = nx.filter(function (o) { return o.date === d; }), fixed = day.filter(function (o) { return o.item.kind !== "task"; }), tasks = day.length - fixed.length;
      return '<button data-day="' + d + '"><b>' + fmt(d, { weekday: "short", day: "numeric" }) + "</b>" + fixed.slice(0, 2).map(function (o) { return "<p>" + (o.item.kind === "deadline" ? "◆ " : "") + esc(o.item.title) + (o.item.time ? " " + o.item.time : "") + "</p>"; }).join("") + '<p class="sub">' + (day.length ? (fixed.length > 2 ? "+" + (fixed.length - 2) + " more · " : "") + (tasks ? tasks + (tasks === 1 ? " task" : " tasks") : "no tasks") : "free") + "</p></button>";
    }).join("") + "</div></section>" +
      '<section class="card feed"><h2>What Claude changed</h2><div style="margin-top:4px">' + (feed.length ? feed.slice(0, 6).map(function (f) { return "<p><span>" + esc(f.text) + ' <i>· ' + esc(f.when) + "</i></span>" + (f.canUndo === false ? "" : '<button class="link" data-undo="' + esc(f.id) + '">undo</button>') + "</p>"; }).join("") : '<p class="none">' + esc(S.feedNote || "No changes in the last 24 hours.") + "</p>") + "</div></section></div>";
    html += '</div><aside class="card wide" style="--hh:30px;--hrs:' + HRS + '" aria-label="Today by the hour"><h2>Today’s time</h2><p class="sub" style="margin-bottom:12px">' + hrs(cap.free) + ' free between 07:00 and 23:00</p><div class="col" style="border-left:0">' + timecol(S, t, occ, true) + "</div></aside></div>";
    return html;
  };

  /* ---------- Week ---------- */
  V.week = function (S) {
    var start = C.monday(S.cursor), days = C.range(start, 7), end = days[6], occ = C.expand(S.items, start, end), t = S.today;
    var caps = days.map(function (d) { return C.capacity(occ, d, S.work).free; }), lo = caps.indexOf(Math.min.apply(null, caps)), hi = caps.indexOf(Math.max.apply(null, caps));
    var title = +start.slice(5, 7) === +end.slice(5, 7) ? +start.slice(8) + " to " + fmt(end, { day: "numeric", month: "long" }) : fmt(start, { day: "numeric", month: "short" }) + " to " + fmt(end, { day: "numeric", month: "short" });
    var tray = S.items.filter(function (i) { return !i.date && !i.someday && !i.done && !i.archived && i.kind !== "event"; });
    var loose = function (d) { return occ.filter(function (o) { return o.date === d && (o.item.allDay || !o.item.time); }); };
    var html = '<div class="head"><div><p class="eyebrow">Week ' + weekNo(start) + "</p><h1>" + title + '</h1><p class="sub" style="margin-top:6px">' + (lo === hi ? "Every day has about the same room." : fmt(days[lo], { weekday: "long" }) + " has the least room. " + fmt(days[hi], { weekday: "long" }) + " has the most.") + '</p></div><div class="nav"><button class="btn sm" data-move="-7" aria-label="Previous week">←</button><button class="btn sm" data-act="now">This week</button><button class="btn sm" data-move="7" aria-label="Next week">→</button><button class="btn sm' + (C.dow(t) === 0 ? " pri" : "") + '" data-act="review">Weekly review</button></div></div>';
    html += '<div class="wide"><div class="wk"><div></div>' + days.map(function (d) {
      var l = loose(d);
      return '<div class="hd' + (d === t ? " today" : "") + '" data-dropday="' + d + '"><button data-day="' + d + '" style="display:block;width:100%">' + fmt(d, { weekday: "short" }) + (d === t ? " · today" : "") + "<b>" + +d.slice(8) + "</b></button>" + capBar(S, occ, d) + '<div class="allday">' + l.slice(0, 3).map(function (o) { return '<button data-open="' + esc(o.item.id) + '" data-date="' + d + '" class="' + (o.item.kind === "deadline" ? "due" : "") + '"' + (o.done ? ' style="text-decoration:line-through;opacity:.6"' : "") + ">" + (o.item.kind === "deadline" ? "◆ " : C.hasDone(o.item) ? (o.done ? "☑ " : "☐ ") : "") + esc(o.item.title) + "</button>"; }).join("") + (l.length > 3 ? '<button data-day="' + d + '" class="sub">+' + (l.length - 3) + " more</button>" : "") + "</div></div>";
    }).join("") + '<div class="axis">' + [0, 2, 4, 6, 8, 10, 12, 14].map(function (h) { return '<span style="top:calc(' + h + '*var(--hh))">' + C.pad(H0 + h) + ":00</span>"; }).join("") + "</div>" + days.map(function (d) { return '<div class="col" data-dropcol="' + d + '">' + timecol(S, d, occ, false) + "</div>"; }).join("") + "</div></div>";
    html += '<div class="narrow agenda">' + days.map(function (d) {
      var day = occ.filter(function (o) { return o.date === d; });
      return '<div class="day"><div class="dh"><button data-day="' + d + '"><b' + (d === t ? ' class="acc"' : "") + ">" + fmt(d, { weekday: "short", day: "numeric" }) + (d === t ? " · today" : "") + "</b></button><span>" + capBar(S, occ, d) + "</span></div>" + (isWork(S, d) ? '<div class="r"><span>' + S.work.start + '</span><span class="sub">Work until ' + S.work.end + "</span></div>" : "") +
        day.map(function (o) { return '<button class="r' + (o.done ? " dn" : "") + '" data-open="' + esc(o.item.id) + '" data-date="' + d + '"><span>' + (o.item.time && !o.item.allDay ? o.item.time : o.item.kind === "deadline" ? "due" : "any") + "</span><span>" + dot(o.item.area) + (o.item.kind === "deadline" ? "◆ " : "") + esc(o.item.title) + "</span></button>"; }).join("") + (!day.length && !isWork(S, d) ? '<p class="none">Free.</p>' : "") + "</div>";
    }).join("") + "</div>";
    html += '<section class="card" style="margin-top:16px"><h2>Not scheduled yet <span class="sub wide" style="font-weight:400;display:inline">· drag onto a day or a time</span></h2><div class="tray">' + (tray.length ? tray.slice(0, 14).map(function (i) { return '<div class="chip" role="button" tabindex="0" draggable="true" data-drag="' + esc(i.id) + '" data-open="' + esc(i.id) + '"' + cvar(i.area) + ">" + esc(i.title) + "</div>"; }).join("") + (tray.length > 14 ? '<button class="btn sm" data-view="backlog">+' + (tray.length - 14) + " more in Backlog</button>" : "") : '<p class="none">Everything open has a date.</p>') + "</div></section>";
    return html;
  };

  /* ---------- Month ---------- */
  V.month = function (S) {
    var first = S.cursor.slice(0, 8) + "01", start = C.monday(first), t = S.today, mon = first.slice(0, 7), weeks = 6;
    if (C.add(start, 35).slice(0, 7) !== mon) weeks = 5;
    var days = C.range(start, weeks * 7), occ = C.expand(S.items, days[0], days[days.length - 1]);
    var html = '<div class="head"><div><p class="eyebrow">Month</p><h1>' + fmt(first, { month: "long", year: "numeric" }) + '</h1></div><div class="nav"><button class="btn sm" data-movem="-1" aria-label="Previous month">←</button><button class="btn sm" data-act="now">This month</button><button class="btn sm" data-movem="1" aria-label="Next month">→</button></div></div>';
    html += '<div class="mo">' + ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(function (w) { return '<div class="wd">' + w + "</div>"; }).join("") + days.map(function (d) {
      var day = occ.filter(function (o) { return o.date === d; }), fixed = day.filter(function (o) { return o.item.kind === "event" || o.item.kind === "block"; }), dls = day.filter(function (o) { return o.item.kind === "deadline"; }), tasks = day.filter(function (o) { return o.item.kind === "task" && !o.done; }).length;
      var label = fmt(d, { weekday: "long", day: "numeric", month: "long" }) + ": " + fixed.length + " events, " + dls.length + " deadlines, " + tasks + " open tasks";
      return '<button class="dy' + (d.slice(0, 7) !== mon ? " out" : "") + (d === t ? " today" : "") + '" data-day="' + d + '" aria-label="' + esc(label) + '"><b>' + +d.slice(8) + "</b>" + dls.slice(0, 1).map(function (o) { return '<p class="acc">◆ ' + esc(o.item.title) + "</p>"; }).join("") + fixed.slice(0, 2).map(function (o) { return "<p>" + esc(o.item.title) + "</p>"; }).join("") +
        '<span class="dots">' + dls.map(function () { return '<i class="d"></i>'; }).join("") + fixed.slice(0, 4).map(function (o) { return '<i class="e"' + cvar(o.item.area) + "></i>"; }).join("") + (tasks ? "<span>" + tasks + (tasks === 1 ? " task" : " tasks") + "</span>" : "") + "</span></button>";
    }).join("") + '</div><p class="sub" style="margin-top:10px">◆ deadline · ● event or time block · the number counts open tasks. Tap a day to open it.</p>';
    return html;
  };

  /* ---------- Horizon ---------- */
  V.horizon = function (S) {
    var n = 6, t = S.today, ws = t.slice(0, 8) + "01", y = +ws.slice(0, 4), m = +ws.slice(5, 7), months = [];
    for (var i = 0; i <= n; i++) { var mm = m + i, yy = y + Math.floor((mm - 1) / 12); months.push(yy + "-" + C.pad(((mm - 1) % 12) + 1) + "-01"); }
    var we = months[n], span = C.diff(ws, we), pos = function (d) { return Math.max(0, Math.min(100, C.diff(ws, d) / span * 100)); }, inWin = function (d) { return d && d >= ws && d < we; };
    var goals = (S.goals || []).slice(), projects = (S.projects || []).filter(function (p) { return !p.done; }), loose = projects.filter(function (p) { return !goals.some(function (g) { return g.id === p.goalId; }); });
    if (loose.length) goals.push({ id: "", title: "Projects without a goal", area: "", progress: null });
    var dlOf = function (key, id) { return S.items.filter(function (i) { return i.kind === "deadline" && !i.done && !i.archived && i[key] === id && inWin(i.date); }); };
    var lane = function (p, area) {
      var s = p.start && p.start > ws ? p.start : (p.start ? ws : t), e = p.due, endP = e ? pos(e) : 100, sP = Math.min(pos(s), endP), dls = (e && inWin(e) ? [{ date: e, title: p.title + " due" }] : []).concat(dlOf("projectId", p.id));
      return '<div class="lane" style="--n:' + n + '"><div class="today-m" style="left:' + pos(t).toFixed(1) + '%"></div>' + (e && e < ws ? "" : '<div class="bar' + (e ? "" : " open") + '" style="left:' + sP.toFixed(1) + "%;width:" + Math.max(2, endP - sP).toFixed(1) + '%"><i style="width:' + p.progress + "%;" + (AREAS.indexOf(area) >= 0 ? "--c:var(--" + area + ")" : "--c:var(--muted)") + '"></i></div>') +
        dls.map(function (d) { return '<i class="dl" style="left:' + pos(d.date).toFixed(1) + '%" title="' + esc(d.title + " · " + fmt(d.date)) + '"></i>'; }).join("") + "</div>";
    };
    var psub = function (p) { return (p.total ? p.doneCount + " of " + p.total + " done" : "no tasks yet") + (p.due ? " · due " + fmt(p.due, { day: "numeric", month: "short" }) + (p.due < t ? " (passed)" : "") : " · no end date"); };
    var wide = "", narrow = "";
    goals.forEach(function (g) {
      var ps = g.id ? projects.filter(function (p) { return p.goalId === g.id; }) : loose, gd = g.id ? dlOf("goalId", g.id).filter(function (i) { return !i.projectId; }) : [];
      var meta = (g.progress == null ? "" : g.progress + " % done") + (g.area ? " · " + esc(g.area) : "") + (g.due ? " · due " + fmt(g.due, { day: "numeric", month: "short", year: "numeric" }) : g.ongoing ? " · ongoing" : "") + (g.open ? " · " + g.open + " open" : "");
      var name = g.id ? '<button data-goal="' + esc(g.id) + '">' + dot(g.area) + esc(g.title) + "</button>" : "<b>" + esc(g.title) + "</b>";
      wide += '<div class="goal">' + name + '<span class="prog">' + meta.replace(/^ · /, "") + "</span></div>" + (ps.length ? ps.map(function (p) { return '<div class="pn"><button data-project="' + esc(p.id) + '">' + esc(p.title) + "</button><small>" + esc(psub(p)) + "</small></div>" + lane(p, g.area); }).join("") : '<div class="pn sub">No projects yet</div><div class="lane" style="--n:' + n + '"><div class="today-m" style="left:' + pos(t).toFixed(1) + '%"></div>' + gd.map(function (d) { return '<i class="dl" style="left:' + pos(d.date).toFixed(1) + '%" title="' + esc(d.title) + '"></i>'; }).join("") + "</div>");
      var dl = ps.filter(function (p) { return inWin(p.due); }).map(function (p) { return p.title + " " + fmt(p.due, { day: "numeric", month: "short" }); }).concat(gd.map(function (d) { return d.title + " " + fmt(d.date, { day: "numeric", month: "short" }); }));
      narrow += '<div class="p"><p class="goal" style="border:0;padding:0">' + name + '<span class="prog">' + (g.progress == null ? "" : g.progress + " %") + "</span></p>" + (g.progress == null ? "" : '<div class="pbar"><i style="width:' + g.progress + "%;" + (AREAS.indexOf(g.area) >= 0 ? "--c:var(--" + g.area + ")" : "--c:var(--muted)") + '"></i></div>') + ps.map(function (p) { return '<p style="font-size:15px;padding:4px 0"><button data-project="' + esc(p.id) + '">' + esc(p.title) + '</button> <span class="sub">· ' + esc(psub(p)) + "</span></p>"; }).join("") + (dl.length ? '<p class="sub acc">◆ ' + esc(dl.join(" · ◆ ")) + "</p>" : "") + "</div>";
    });
    var head = '<div class="head"><div><p class="eyebrow">Horizon</p><h1>' + fmt(ws, { month: "long" }) + " to " + fmt(C.add(we, -1), { month: "long" }) + '</h1><p class="sub" style="margin-top:6px">' + (S.goals || []).length + ((S.goals || []).length === 1 ? " goal, " : " goals, ") + projects.length + (projects.length === 1 ? " open project." : " open projects.") + ' The vertical line is today; ◆ marks a deadline.</p></div><div class="nav"><button class="btn sm" data-act="newgoal">+ Goal</button><button class="btn sm" data-act="newproject">+ Project</button></div></div>';
    if (!goals.length) return head + '<section class="card"><p class="none">No goals or projects yet. Add a goal to see it laid out over the next six months.</p></section>';
    return head + '<section class="card"><div class="wide"><div class="hz"><div></div><div class="months" style="--n:' + n + '">' + months.slice(0, n).map(function (d) { return "<span>" + fmt(d, { month: "short" }) + "</span>"; }).join("") + "</div>" + wide + '</div></div><div class="narrow hlist">' + narrow + "</div></section>";
  };

  /* ---------- Strategy: goal trees (goal → projects → tasks), then what hangs loose ---------- */
  V.strategy = function (S) {
    var items = S.items.filter(function (i) { return !i.archived && i.kind !== "event"; }), goals = S.goals || [], projects = S.projects || [], t = S.today;
    var asOcc = function (i) { return { item: i, date: i.date || t, key: i.id + "@" + (i.date || ""), repeats: !!i.recurrence, done: i.recurrence ? false : !!i.done }; };
    var whenOf = function (i) { return i.someday ? "someday" : i.date ? fmt(i.date, { day: "numeric", month: "short" }) : "no date"; };
    var leaves = function (list) {
      var open = list.filter(function (i) { return i.recurrence || !i.done; }).sort(function (a, b) { return String(a.date || "9999").localeCompare(String(b.date || "9999")); }), done = list.length - open.length;
      return (open.length ? open.map(function (i) { return '<li class="leaf">' + row(S, asOcc(i), whenOf(i)) + "</li>"; }).join("") : "") + (done ? '<li class="leaf sub">' + done + (done === 1 ? " task" : " tasks") + " done</li>" : "") + (!list.length ? '<li class="leaf sub">No tasks yet</li>' : "");
    };
    var bar = function (p, area) { return '<span class="tbar" role="img" aria-label="' + p + ' percent done"><i style="width:' + p + "%;" + (AREAS.indexOf(area) >= 0 ? "background:var(--" + area + ")" : "") + '"></i></span><span class="prog">' + p + " %</span>"; };
    var projNode = function (p, area) {
      var mine = items.filter(function (i) { return i.projectId === p.id; }), open = mine.filter(function (i) { return i.recurrence || !i.done; }).length;
      return '<li><details class="tn"' + (S.treeOpen && S.treeOpen["p" + p.id] ? " open" : "") + ' data-tree="p' + esc(p.id) + '"><summary><span class="tk">Project</span><span class="tt">' + esc(p.title) + (p.done ? ' <span class="tag">done</span>' : "") + "</span>" + bar(p.progress, area) + '<span class="sub tc">' + open + " open" + (p.due ? " · due " + fmt(p.due, { day: "numeric", month: "short" }) : "") + '</span></summary><ul class="tree">' + leaves(mine) + '<li class="leaf"><button class="link" data-project="' + esc(p.id) + '">Open the project</button></li></ul></details></li>';
    };
    var html = '<div class="head"><div><p class="eyebrow">Strategy</p><h1>How it all connects</h1><p class="sub" style="margin-top:6px">Each goal with its projects, and each project with its tasks. Tasks that belong to nothing are listed at the end.</p></div><div class="nav"><button class="btn sm" data-act="treeall">' + (S.treeAll ? "Close all" : "Open all") + '</button><button class="btn sm" data-act="newgoal">+ Goal</button><button class="btn sm" data-act="newproject">+ Project</button></div></div>';
    if (!goals.length && !projects.length && !items.length) return html + '<section class="card"><p class="none">No goals, projects or tasks yet.</p></section>';
    html += '<section class="card"><ul class="tree root">';
    goals.forEach(function (g) {
      var ps = projects.filter(function (p) { return p.goalId === g.id; }), direct = items.filter(function (i) { return i.goalId === g.id && !i.projectId; }), open = items.filter(function (i) { return i.goalId === g.id && (i.recurrence || !i.done); }).length;
      html += '<li><details class="tn goalnode"' + (!S.treeOpen || S.treeOpen["g" + g.id] !== false ? " open" : "") + ' data-tree="g' + esc(g.id) + '"><summary><span class="tk"' + cvar(g.area) + ">" + dot(g.area) + 'Goal</span><span class="tt big">' + esc(g.title) + "</span>" + bar(g.progress, g.area) + '<span class="sub tc">' + ps.length + (ps.length === 1 ? " project" : " projects") + " · " + open + " open" + (g.due ? " · due " + fmt(g.due, { day: "numeric", month: "short", year: "numeric" }) : g.ongoing ? " · ongoing" : "") + '</span></summary><ul class="tree">' +
        ps.map(function (p) { return projNode(p, g.area); }).join("") + (direct.length ? '<li><details class="tn"' + (S.treeOpen && S.treeOpen["d" + g.id] ? " open" : "") + ' data-tree="d' + esc(g.id) + '"><summary><span class="tk">Tasks</span><span class="tt">Straight under this goal</span><span class="sub tc">' + direct.filter(function (i) { return i.recurrence || !i.done; }).length + ' open</span></summary><ul class="tree">' + leaves(direct) + "</ul></details></li>" : "") +
        (!ps.length && !direct.length ? '<li class="leaf sub">Nothing hangs under this goal yet</li>' : "") + '<li class="leaf"><button class="link" data-goal="' + esc(g.id) + '">Open the goal</button></li></ul></details></li>';
    });
    var looseP = projects.filter(function (p) { return !goals.some(function (g) { return g.id === p.goalId; }); });
    if (looseP.length) html += '<li><details class="tn goalnode" open data-tree="loosep"><summary><span class="tk">No goal</span><span class="tt big">Projects without a goal</span><span class="sub tc">' + looseP.length + '</span></summary><ul class="tree">' + looseP.map(function (p) { return projNode(p, ""); }).join("") + "</ul></details></li>";
    var orphans = items.filter(function (i) { return !i.goalId && !i.projectId && (i.recurrence || !i.done); });
    html += '<li><details class="tn goalnode"' + (S.treeOpen && S.treeOpen.orph ? " open" : "") + ' data-tree="orph"><summary><span class="tk">Loose</span><span class="tt big">Tasks that belong to no goal or project</span><span class="sub tc">' + orphans.length + ' open</span></summary><ul class="tree">' + (orphans.length ? orphans.sort(function (a, b) { return String(a.date || "9999").localeCompare(String(b.date || "9999")); }).map(function (i) { return '<li class="leaf">' + row(S, asOcc(i), whenOf(i)) + "</li>"; }).join("") : '<li class="leaf sub">Every open task belongs somewhere.</li>') + "</ul></details></li>";
    return html + "</ul></section>";
  };

  /* ---------- Backlog ---------- */
  V.backlog = function (S) {
    var open = S.items.filter(function (i) { return !i.date && !i.done && !i.archived && i.kind !== "event"; }), now = open.filter(function (i) { return !i.someday; }), later = open.filter(function (i) { return i.someday; });
    var asOcc = function (i) { return { item: i, date: S.today, key: i.id + "@", repeats: false, done: false }; }, groups = {};
    now.forEach(function (i) { (groups[i.area || "No area"] = groups[i.area || "No area"] || []).push(i); });
    var names = Object.keys(groups).sort(function (a, b) { return (a === "No area") - (b === "No area") || a.localeCompare(b); });
    var html = '<div class="head"><div><p class="eyebrow">Backlog</p><h1>' + now.length + (now.length === 1 ? " thing" : " things") + ' without a date</h1><p class="sub" style="margin-top:6px">Give one a date, park it under Someday, or archive it. Nothing here is late.</p></div></div>';
    html += '<section class="card">' + (names.length ? names.map(function (g) { return '<div class="grp"><h2><span>' + (g === "No area" ? "" : dot(g)) + esc(g) + '</span><span class="sub">' + groups[g].length + "</span></h2>" + groups[g].map(function (i) { var o = asOcc(i); return row(S, o, i.priority || "") + triage(o, true); }).join("") + "</div>"; }).join("") : '<p class="none">The backlog is empty.</p>') + "</section>";
    html += '<section class="card" style="margin-top:16px"><h2>Someday <span class="sub" style="font-weight:400">· ' + later.length + '</span></h2><p class="sub">Parked on purpose. These never show up as open or late.</p>' + (later.length ? '<div style="margin-top:8px">' + later.map(function (i) { var o = asOcc(i); return row(S, o, "") + triage(o, true); }).join("") + "</div>" : '<p class="none">Nothing parked.</p>') + "</section>";
    return html;
  };

  /* ---------- search ---------- */
  V.search = function (S) {
    var q = S.q.toLowerCase(), hit = S.items.filter(function (i) { return !i.archived && ((i.title || "").toLowerCase().indexOf(q) >= 0 || (i.notes || "").toLowerCase().indexOf(q) >= 0); }).sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
    return '<div class="head"><div><p class="eyebrow">Search</p><h1>' + hit.length + (hit.length === 1 ? " match" : " matches") + '</h1></div></div><section class="card">' + (hit.length ? hit.slice(0, 60).map(function (i) { return row(S, { item: i, date: i.date || S.today, key: i.id + "@" + (i.date || ""), repeats: !!i.recurrence, done: !!i.done }, i.date ? fmt(i.date, { day: "numeric", month: "short", year: "numeric" }) : i.someday ? "someday" : "no date"); }).join("") : '<p class="none">Nothing matches “' + esc(S.q) + "”.</p>") + "</section>";
  };

  /* ---------- overlays ---------- */
  var opt = function (list, cur) { return list.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (String(x[0]) === String(cur == null ? "" : cur) ? " selected" : "") + ">" + esc(x[1]) + "</option>"; }).join(""); };
  var REPEATS = [["", "Does not repeat"], ["FREQ=DAILY", "Every day"], ["FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "Every weekday"], ["FREQ=WEEKLY", "Every week"], ["FREQ=WEEKLY;INTERVAL=2", "Every 2 weeks"], ["FREQ=MONTHLY", "Every month"], ["FREQ=YEARLY", "Every year"]];
  var REM = [[0, "At the time"], [10, "10 min before"], [30, "30 min before"], [60, "1 hour before"], [1440, "1 day before"]];
  V.sheet = function (S, it, date, hist) {
    var ro = it.source === "google", key = it.id + "@" + (date || it.date || S.today), has = C.hasDone(it), done = it.recurrence ? (it.doneDates || []).indexOf(date) >= 0 : it.done, rep = REPEATS.slice(), dis = ro ? " disabled" : "";
    if (it.recurrence && !rep.some(function (r) { return r[0] === it.recurrence; })) rep.push([it.recurrence, C.ruleText(it.recurrence) || it.recurrence]);
    var deps = (it.dependsOn || []).map(function (id) { return S.byId[id]; }).filter(Boolean);
    var html = '<button class="btn sm ghost x" data-act="close" aria-label="Close">✕</button><p class="lab">' + KIND[it.kind] + (it.recurrence ? " · ↻ " + esc(C.ruleText(it.recurrence)) : "") + (ro ? " · from Google, read only" : "") + "</p><h2>" + esc(it.title || "Untitled") + "</h2>" +
      '<p class="sub">' + (it.someday ? "Someday" : it.date ? fmt(date || it.date, { weekday: "long", day: "numeric", month: "long" }) : "No date") + (it.time && !it.allDay ? " at " + it.time : "") + (it.parentLabel ? " · " + esc(it.parentLabel) : "") + "</p>";
    if (!ro) html += '<div class="acts">' + (has ? '<button class="btn pri" data-done="' + esc(key) + '">' + (done ? "Mark not done" : "Done") + "</button>" : "") + '<button class="btn" data-quick="tomorrow">Tomorrow</button><button class="btn" data-quick="nextweek">Next week</button>' + (it.kind !== "event" && !it.recurrence ? '<button class="btn" data-quick="someday">' + (it.someday ? "Back to backlog" : "Someday") + "</button>" : "") + (it.recurrence && date ? '<button class="btn" data-quick="skip">Skip this one</button>' : "") + (it.kind !== "event" && !it.recurrence ? '<button class="btn" data-quick="main">' + (S.mainId === it.id ? "Not the main thing" : "Make it the main thing") + "</button>" : "") + '<button class="btn" data-quick="archive">Archive</button></div>';
    html += '<div class="f"><label for="ccT">Title</label><input class="in" id="ccT" data-f="title" value="' + esc(it.title) + '"' + dis + "></div>" +
      '<div class="row2"><div class="f"><label for="ccK">Kind</label><select class="in" id="ccK" data-f="kind"' + (it.table === "events" || ro ? " disabled" : "") + ">" + opt(it.table === "events" ? [["event", "Event"]] : [["task", "Task"], ["deadline", "Deadline"], ["block", "Time block"]], it.kind) + '</select></div><div class="f"><label for="ccA">Area</label><select class="in" id="ccA" data-f="area"' + dis + ">" + opt([["", "No area"]].concat(AREAS.map(function (a) { return [a, a]; })), it.area) + "</select></div></div>" +
      '<div class="row3"><div class="f"><label for="ccD">Date</label><input class="in" id="ccD" type="date" data-f="date" value="' + esc(it.date || "") + '"' + dis + '></div><div class="f"><label for="ccH">Start</label><input class="in" id="ccH" type="time" data-f="time" value="' + esc(it.time || "") + '"' + dis + '></div><div class="f"><label for="ccL">Minutes</label><input class="in" id="ccL" type="number" min="0" step="5" data-f="dur" value="' + esc(it.dur == null ? "" : it.dur) + '"' + dis + "></div></div>" +
      '<div class="row2"><div class="f"><label for="ccR">Repeats</label><select class="in" id="ccR" data-f="recurrence"' + dis + ">" + opt(rep, it.recurrence || "") + '</select></div><div class="f"><label for="ccP">Priority</label><select class="in" id="ccP" data-f="priority"' + (it.table === "events" || ro ? " disabled" : "") + ">" + opt([["", "None"], ["P0", "P0"], ["P1", "P1"], ["P2", "P2"], ["P3", "P3"]], it.priority) + "</select></div></div>" +
      '<div class="f"><span class="l">Remind me</span><div class="opts">' + REM.map(function (r) { return '<button class="opt" data-rem="' + r[0] + '" aria-pressed="' + ((it.reminders || []).indexOf(r[0]) >= 0) + '"' + dis + ">" + r[1] + "</button>"; }).join("") + '<button class="opt" data-mute="1" aria-pressed="' + !!it.muted + '"' + dis + ">Muted</button></div>" + '<p class="sub" style="font-size:12px">Reminders are saved now and start reaching your phone once notifications are set up.</p></div>' +
      '<div class="f"><label for="ccN">Notes</label><textarea class="in" id="ccN" data-f="notes"' + dis + ">" + esc(it.notes || "") + '</textarea></div><div class="f"><label for="ccO">Place</label><input class="in" id="ccO" data-f="location" value="' + esc(it.location || "") + '"' + dis + "></div>";
    if ((it.people || []).length) html += '<div class="f"><span class="l">People</span><p>' + it.people.map(function (p) { return esc(p); }).join(", ") + "</p></div>";
    if (deps.length) html += '<div class="f"><span class="l">Waits for</span>' + deps.map(function (d) { return '<p><button class="link" data-open="' + esc(d.id) + '">' + esc(d.title) + "</button> " + (d.done ? "· done" : "· still open") + "</p>"; }).join("") + "</div>";
    if (!ro) html += '<div class="acts"><button class="btn sm" data-quick="full">Open the full editor</button><span class="sub" style="align-self:center">for goal, project, people and dependencies</span></div>';
    html += '<div class="f hist"><span class="l">History</span>' + (hist == null ? '<p>Loading…</p>' : hist.length ? hist.map(function (h) { return "<p>" + esc(h) + "</p>"; }).join("") : "<p>No changes recorded yet.</p>") + "</div>";
    return html;
  };
  V.daySheet = function (S, d) {
    var occ = C.expand(S.items, d, d), cap = C.capacity(occ, d, S.work);
    return '<button class="btn sm ghost x" data-act="close" aria-label="Close">✕</button><p class="lab">' + (d === S.today ? "Today" : C.diff(S.today, d) === 1 ? "Tomorrow" : "Day") + "</p><h2>" + fmt(d, { weekday: "long", day: "numeric", month: "long" }) + '</h2><p class="sub">' + hrs(cap.free) + " free" + (isWork(S, d) ? " · work " + S.work.start + " to " + S.work.end : "") + '</p><div style="margin-top:10px">' + (occ.length ? occ.map(function (o) { return row(S, o); }).join("") : '<p class="none">Nothing planned.</p>') + '</div><div class="acts"><button class="btn pri" data-addday="' + d + '">+ Add to this day</button></div>';
  };
  V.pick = function (S, it) {
    var t = S.today;
    return '<button class="btn sm ghost x" data-act="close" aria-label="Close">✕</button><p class="lab">Pick a date</p><h2>' + esc(it.title) + '</h2><div class="acts">' + [["Today", t], ["Tomorrow", C.add(t, 1)], ["Saturday", C.add(t, (6 - C.dow(t) + 7) % 7 || 7)], ["Next Monday", C.add(C.monday(t), 7)]].map(function (x) { return '<button class="btn" data-pickdate="' + x[1] + '">' + x[0] + ' <span class="sub">' + fmt(x[1], { day: "numeric", month: "short" }) + "</span></button>"; }).join("") + '</div><div class="f"><label for="ccPick">Or choose a day</label><input class="in" id="ccPick" type="date" min="' + t + '"></div><div class="acts"><button class="btn pri" data-act="pickok">Move it</button></div>';
  };
  V.quick = function (S, p) {
    var html = '<button class="btn sm ghost x" data-act="close" aria-label="Close">✕</button><p class="lab">Quick add</p><div class="f" style="margin-top:6px"><label for="ccQ">Type it the way you would say it</label><input class="qa-in" id="ccQ" autocomplete="off" placeholder="call the landlord Wed 10:00" value="' + esc(S.qa.text) + '"></div><p class="sub" style="margin-top:6px;font-size:13px">Try “gym every Mon Wed Fri 19:00”, “pay rent 1st monthly”, “dinner with Noor tomorrow 19:30-21:30”.</p>';
    html += '<div id="ccParsed">' + V.parsed(S, p) + "</div>";
    return html;
  };
  V.parsed = function (S, p) {
    if (!p || !p.title) return '<div class="parsed"><p class="sub">Nothing to save yet.</p></div>';
    return '<div class="parsed" aria-live="polite"><p class="lab">This is what will be saved</p><p class="pt">' + esc(p.title) + '</p><p class="sub" style="margin-top:4px">' + [KIND[p.kind], p.date ? fmt(p.date, { weekday: "long", day: "numeric", month: "long" }) : "no date (goes to the backlog)", p.time ? p.time + (p.dur ? " for " + dur(p.dur) : "") : "", p.recurrence ? "↻ " + C.ruleText(p.recurrence) : "", p.priority || "", p.area || ""].filter(Boolean).map(esc).join(" · ") + '</p><div class="opts" style="margin-top:10px">' + ["task", "event", "deadline", "block"].map(function (k) { return '<button class="opt" data-qkind="' + k + '" aria-pressed="' + (p.kind === k) + '">' + KIND[k] + "</button>"; }).join("") + '</div></div><div class="acts"><button class="btn pri" data-act="qsave">Save <kbd>Enter</kbd></button><button class="btn" data-act="qmore">Save and open details</button></div>' + (S.qa.msg ? '<p class="msg" role="alert">' + esc(S.qa.msg) + "</p>" : "");
  };
  V.review = function (S) {
    var start = C.monday(S.cursor), r = C.review(S.items, start, S.today), list = function (a, tri) { return a.length ? a.map(function (o) { return row(S, o, fmt(o.date, { weekday: "short", day: "numeric" })) + (tri ? triage(o) : ""); }).join("") : '<p class="none">Nothing here.</p>'; };
    var byDay = {}; r.next.forEach(function (o) { (byDay[o.date] = byDay[o.date] || []).push(o); });
    return '<button class="btn sm ghost x" data-act="close" aria-label="Close">✕</button><p class="lab">Weekly review</p><h2>Week of ' + fmt(start, { day: "numeric", month: "long" }) + '</h2><p class="sub">' + r.done.length + " done · " + r.slipped.length + " slipped · " + r.open.length + " still to come · " + r.happened + " events and blocks</p>" +
      '<div class="f"><span class="l">Done</span>' + list(r.done) + '</div><div class="f"><span class="l">Slipped (decide what happens to each)</span>' + list(r.slipped, true) + '</div><div class="f"><span class="l">Next week</span>' + (r.next.length ? Object.keys(byDay).sort().map(function (d) { return '<p class="sub" style="margin-top:8px">' + fmt(d, { weekday: "long", day: "numeric" }) + "</p>" + byDay[d].map(function (o) { return row(S, o); }).join(""); }).join("") : '<p class="none">Nothing planned yet.</p>') + '</div><p class="sub" style="margin-top:14px">Ask Claude to “prepare my weekly review” and it will draft next week for you to accept or change.</p>';
  };
})();
