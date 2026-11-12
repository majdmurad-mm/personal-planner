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
  var cvar = function (a) { return ' style="' + C.areaVars(a) + '"'; };
  var ICON = { task: '<path d="M3 4h8v8H3z"/><path d="M5 8l1.5 1.5L10 6"/>', work: '<path d="M2.5 5h9v6.5h-9z"/><path d="M5 5V3.5h4V5"/>', health: '<path d="M7 11.5S2.5 8.6 2.5 5.6A2.2 2.2 0 0 1 7 4.4a2.2 2.2 0 0 1 4.5 1.2C11.5 8.6 7 11.5 7 11.5z"/>', growth: '<path d="M2.5 3.5h4a1 1 0 0 1 1 1v7a1 1 0 0 0-1-1h-4zM11.5 3.5h-4"/><path d="M11.5 3.5v7h-3"/>', people: '<circle cx="7" cy="5" r="2.2"/><path d="M3 11.5c.5-2 2-3 4-3s3.5 1 4 3"/>', sol: '<circle cx="7" cy="7" r="2.6"/><path d="M7 1.5v1.6M7 10.9v1.6M1.5 7h1.6M10.9 7h1.6M3.1 3.1l1.1 1.1M9.8 9.8l1.1 1.1M3.1 10.9l1.1-1.1M9.8 4.2l1.1-1.1"/>', none: '<circle cx="7" cy="7" r="4.5"/>' };
  var icon = function (k) { return '<svg class="ico" viewBox="0 0 14 14" aria-hidden="true">' + ICON[k] + "</svg>"; };
  V.icon = icon;
  /* the area label every row carries: icon + name, so colour is never the only signal */
  var areaTag = function (it) { var k = C.areaKey(it.area); return '<span class="ar' + (k === "none" ? " na" : "") + '">' + icon(k) + esc(it.area ? (k === "none" ? it.area + " · no colour yet" : it.area) : "no area") + "</span>" + ((it.secondary || []).length ? '<span class="sec" title="Also: ' + esc(it.secondary.join(", ")) + '">' + it.secondary.map(function (a) { var k2 = C.areaKey(a); return '<i style="--c2:var(--area-' + k2 + ')' + (k2 === "sol" ? ";--co:var(--area-sol-line)" : "") + '" title="' + esc(a) + '"></i>'; }).join("") + "</span>" : ""); };
  var dot = function (a) { return '<i class="dot"' + cvar(a) + "></i>"; };
  var dur = function (m) { return m >= 60 ? (m % 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : m / 60 + " h") : m + " min"; };
  var hrs = function (m) { var h = Math.round(m / 6) / 10; return String(h).replace(".", ",") + " h"; };
  var hm = function (m) { m = Math.round(m || 0); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + C.pad(m % 60); };
  var KIND = { task: "Task", event: "Event", deadline: "Deadline", block: "Time block" };
  V.KIND = KIND;
  var when = function (o) { var it = o.item; return it.allDay || !it.time ? (it.kind === "deadline" ? "due" : it.est ? dur(it.est) : "") : it.time + (it.dur ? "–" + C.hhmm(C.mins(it.time) + it.dur) : ""); };
  var blocked = function (S, it) { return (it.dependsOn || []).some(function (id) { var d = S.byId[id]; return d && !d.done && !d.archived; }); };
  var weekNo = function (s) { var d = new Date(C.ms(s)), day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); var first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d - first) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7); };
  var isWork = function (S, d) { return S.work && S.work.days.indexOf(C.dow(d)) >= 0; };

  /* one line for an item on a day */
  function row(S, o, extra) {
    var it = o.item, has = C.hasDone(it), w = when(o);
    return '<div class="it' + (o.done ? " done" : "") + '"' + cvar(it.area) + ">" +
      (has ? '<button class="box" role="checkbox" aria-checked="' + !!o.done + '" data-done="' + esc(o.key) + '" aria-label="' + (o.done ? "Mark not done: " : "Mark done: ") + esc(it.title) + '"><i>' + (o.done ? "✓" : "") + "</i></button>"
        : '<span class="mark"' + cvar(it.area) + ' title="' + KIND[it.kind] + '"><i></i></span>') +
      '<span class="ti"><button data-open="' + esc(it.id) + '" data-date="' + o.date + '">' + esc(it.title || "Untitled") + "</button>" +
      areaTag(it) +
      (it.kind === "deadline" ? '<span class="tag">◆ deadline</span>' : "") + (it.priority && it.priority <= "P1" ? '<span class="tag">' + esc(it.priority) + "</span>" : "") +
      (o.repeats ? '<span class="tag" title="' + esc(C.ruleText(it.recurrence)) + '">↻ repeats</span>' : "") + (blocked(S, it) ? '<span class="tag">waiting on another task</span>' : "") + (it.source === "google" ? '<span class="tag">Google</span>' : "") +
      '</span><span class="when">' + esc(extra != null ? extra : w) + "</span></div>";
  }
  V.row = row; V.triage = function (o, b) { return triage(o, b); };
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
    V.sleepParts(S, date).forEach(function (p) {
      var tall = p.e - p.s >= 50, tt = "Sleep " + sleepText(p.x);
      out += '<div class="blk sleep' + (p.cut ? " cut-" + p.cut : "") + '" role="note" aria-label="' + esc(tt) + '" title="' + esc(tt) + '" style="top:calc(' + ((p.s - H0 * 60) / 60).toFixed(3) + "*var(--hh) + 1px);height:calc(" + ((p.e - p.s) / 60).toFixed(3) + "*var(--hh) - 2px);left:" + left + "px;width:calc(100% - " + (left + 6) + 'px)">' + esc(p.label) + (p.sub ? (tall ? "<small>" + esc(p.sub) + "</small>" : '<span class="ss"> · ' + esc(p.sub) + "</span>") : "") + "</div>";
    });
    var wos = actualOn(S, date), planned = false;
    occs.filter(function (o) { return o.date === date && o.item.time && !o.item.allDay; }).forEach(function (o) {
      var it = o.item, s = Math.max(H0 * 60, C.mins(it.time)), len = it.dur || it.est || (it.kind === "task" || it.kind === "deadline" ? 30 : 60), e = Math.min((H0 + HRS) * 60, s + len);
      if (e <= s) return;
      var inW = w && s >= w[0] && e <= w[1], gym = isGym(it), st2 = "";
      if (gym && S.showActual !== false && S.actual) { planned = true; st2 = wos.length ? " met planned-side" : (date < S.today || (date === S.today && e < S.nowMin)) ? " missed" : ""; }
      out += '<button class="blk' + (inW ? " inw" : "") + (o.done ? " dn" : "") + st2 + '"' + (st2 === " missed" ? ' aria-label="' + esc(it.title + ", planned, no workout logged") + '"' : "") + ' data-open="' + esc(it.id) + '" data-date="' + date + '" style="top:calc(' + ((s - H0 * 60) / 60).toFixed(3) + "*var(--hh) + 1px);height:calc(" + ((e - s) / 60).toFixed(3) + "*var(--hh) - 2px);" + C.areaVars(it.people && it.people.length && it.kind === "event" ? "Relationships" : it.area) + (st2.indexOf("planned-side") >= 0 ? (withHours ? "left:52px;width:calc(48% - 30px)" : "left:4px;width:calc(48% - 6px)") : withHours ? (inW ? "left:45%;width:calc(55% - 6px)" : "left:52px;width:calc(100% - 58px)") : "") + '" title="' + esc(it.title + " · " + when(o)) + '">' + esc(it.title) + (e - s >= 60 ? "<small>" + esc(when(o)) + "</small>" : "") + "</button>";
    });
    /* what actually happened: synced workouts, read-only, at their real time */
    wos.filter(function (x) { return x.start != null; }).forEach(function (x) {
      var s = Math.max(H0 * 60, x.start), e = Math.min((H0 + HRS) * 60, s + (x.mins || 60)); if (e <= s) return;
      out += '<button class="blk actual' + (planned ? " beside" : "") + '" data-workout="' + date + '" style="top:calc(' + ((s - H0 * 60) / 60).toFixed(3) + "*var(--hh) + 1px);height:calc(" + ((e - s) / 60).toFixed(3) + "*var(--hh) - 2px);" + (withHours && !planned ? "left:52px;width:calc(100% - 58px)" : "") + '" title="' + esc(x.title + (x.mins ? " · " + hm(x.mins) : "") + (x.volume ? " · " + Math.round(x.volume) + " kg" : "") + (x.exercises ? " · " + x.exercises + " exercises" : "")) + '" aria-label="' + esc("Workout done: " + x.title + (x.mins ? ", " + x.mins + " minutes" : "") + ". Open it on the Health page") + '">✓ ' + esc(x.title) + (x.mins ? " — " + hm(x.mins) : "") + (e - s >= 60 ? "<small>" + (x.volume ? Math.round(x.volume) + " kg" : "") + (x.exercises ? " · " + x.exercises + " exercises" : "") + "</small>" : "") + "</button>";
    });
    if (date === S.today && S.nowMin >= H0 * 60 && S.nowMin <= (H0 + HRS) * 60) out += '<div class="nowline" style="top:' + top(S.nowMin) + '"></div>';
    return out;
  }
  var GYM = /gym|workout|training|lift|strength|full body/i;
  var isGym = function (it) { return it.kind === "block" && (GYM.test(it.title || "") || it.area === "Health"); };
  var actualOn = function (S, d) { return S.showActual !== false && S.actual && S.actual.workoutsBy ? (S.actual.workoutsBy[d] || []) : []; };
  /* last night's sleep, from the watch or the owner's correction */
  var sleepOf = function (S, d) { return S.showActual !== false && S.actual && S.actual.sleepBy ? S.actual.sleepBy[d] || null : null; };
  var sleepText = function (x) { return (x.mins ? hm(x.mins) + " asleep" : "") + (x.bed ? " · " + x.bed + "–" + x.wake : "") + (x.score != null ? " · score " + x.score : "") + (x.corrected ? " · corrected" : ""); };
  /* sleep as blocks on the timeline: the morning part (until waking) at the top of the day,
     and that evening's bedtime (from the next morning's record) at the bottom. Sleep outside 07:00–23:00
     shows as a short strip at the edge, labelled with the real times. */
  V.sleepParts = function (S, date) {
    var out = [], top0 = H0 * 60, bot = (H0 + HRS) * 60, edge = 24, a = sleepOf(S, date), b = sleepOf(S, C.add(date, 1));
    if (a && a.wake) { var w = C.mins(a.wake); if (w < 15 * 60) out.push({ s: top0, e: Math.max(top0 + edge, Math.min(bot, w)), cut: w <= top0 + edge ? "top" : "", label: "☾ " + (a.mins ? "Slept " + hm(a.mins) : "Asleep"), sub: (a.bed ? a.bed + "–" : "until ") + a.wake, x: a }); }
    if (b && b.bed) { var m = C.mins(b.bed); if (m < 12 * 60) m += 1440; out.push({ s: Math.min(m, bot - edge), e: bot, cut: m >= bot - edge ? "bottom" : "", label: "☾ Bed " + b.bed, sub: b.mins ? hm(b.mins) + " asleep" : "", x: b }); }
    return out;
  };
  var planGym = function (S, d) { var p = C.expand(S.items, d, d).filter(function (o) { return o.item.time && !o.item.allDay && isGym(o.item); })[0]; return p ? p.item.time : "18:00"; };
  var woEdit = function (S, x, d) { return '<span class="woedit"><label>Gym from <input type="time" id="ccWoT" value="' + esc(planGym(S, d)) + '"></label><button class="btn sm pri" data-wosave="' + esc(x.id) + '" data-date="' + d + '">Save</button><button class="btn sm ghost" data-wocancel="1">Cancel</button></span>'; };
  /* a workout whose start time did not come through: a chip on its day, never a guessed hour; the owner can set the time */
  var untimed = function (S, d) { return actualOn(S, d).filter(function (x) { return x.start == null; }); };
  var woChip = function (x, d, small, S) { if (S && x.id && S.woEdit === x.id) return woEdit(S, x, d); return '<span class="wogrp">' + woBtn(x, d, small) + (x.id ? '<button class="wot" data-wotime="' + esc(x.id) + '" title="Set the time you were at the gym" aria-label="' + esc("Set the time for " + x.title) + '">⏱</button>' : "") + "</span>"; };
  var woBtn = function (x, d, small) { return '<button class="wochip' + (small ? " sm" : "") + '" data-workout="' + d + '" title="' + esc(x.title + (x.mins ? " · " + hm(x.mins) : "") + (x.volume ? " · " + Math.round(x.volume) + " kg" : "") + (x.exercises ? " · " + x.exercises + " exercises" : "") + " · start time not synced") + '" aria-label="' + esc("Workout done: " + x.title + (x.mins ? ", " + hm(x.mins) : "") + ", start time not synced. Open it on the Health page") + '">✓ ' + esc(x.title) + (x.mins ? " · " + hm(x.mins) : "") + (small ? "" : ' <span class="nt">time not synced</span>') + "</button>"; };
  V.untimedWorkouts = function (S, d) { var u = untimed(S, d); return u.length ? '<div class="wochips">' + u.map(function (x) { return woChip(x, d, false, S); }).join("") + "</div>" : ""; };
  V.sleepBand = function (S, d) { if (S.showActual === false || !S.actual) return ""; var x = sleepOf(S, d); return x && (x.mins || x.bed) ? '<p class="sleepband" role="note"><svg class="ico" viewBox="0 0 14 14" aria-hidden="true"><path d="M9.5 2.5a4.5 4.5 0 1 0 2 6.5A3.6 3.6 0 0 1 9.5 2.5z"/></svg>Last night ' + esc(sleepText(x)) + "</p>" : '<p class="sleepband none" role="note">No sleep data for last night</p>'; };
  /* minutes booked per area between 07:00 and 23:00: the work block first, items on top of it */
  V.dayLoad = function (S, occs, date) {
    var slot = new Array(192), w = isWork(S, date) ? [C.mins(S.work.start), C.mins(S.work.end)] : null, i, by = {}, total = 0;
    var fill = function (a, b, k) { for (var j = Math.max(0, Math.floor((a - 420) / 5)); j < Math.min(192, Math.ceil((b - 420) / 5)); j++) slot[j] = k; };
    if (w) fill(w[0], w[1], "work");
    occs.forEach(function (o) { var it = o.item; if (o.date !== date || it.allDay || !it.time || it.kind === "deadline") return; var s = C.mins(it.time); fill(s, s + (it.dur || it.est || (it.kind === "task" ? 30 : 60)), C.areaKey(it.kind === "event" && it.people && it.people.length ? "Relationships" : it.area)); });
    (S.showActual !== false && S.actual && S.actual.workoutsBy && S.actual.workoutsBy[date] || []).forEach(function (x) { if (x.start != null) fill(x.start, x.start + (x.mins || 60), "health"); });
    for (i = 0; i < 192; i++) if (slot[i]) { by[slot[i]] = (by[slot[i]] || 0) + 5; total += 5; }
    return { by: by, booked: total, free: 960 - total };
  };
  function loadBar(S, occs, date, most) {
    var L = V.dayLoad(S, occs, date), order = ["work", "task", "health", "growth", "people", "sol", "none"];
    return '<div class="load" role="img" aria-label="' + hm(L.booked) + " booked, " + hm(L.free) + ' free">' + order.filter(function (k) { return L.by[k]; }).map(function (k) { return '<i style="width:' + (L.by[k] / 960 * 100).toFixed(1) + "%;background:var(--area-" + k + ')" title="' + C.AREA_NAME[k] + " " + hm(L.by[k]) + '"></i>'; }).join("") + '</div><div class="capt">' + hm(L.free) + " free" + (most ? ' <span class="room">most room</span>' : "") + "</div>";
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
    html += '<section class="card main" aria-label="The main thing"' + (main ? cvar(main.area) : "") + '><p class="lab acc">★ The main thing' + (main ? " · " + esc(main.area || "no area") : "") + "</p>";
    if (main) html += '<p class="t">' + esc(main.title) + '</p><p class="sub">' + (main.area ? dot(main.area) + esc(main.area) + " · " : "") + (main.date === t ? "today" : main.date ? fmt(main.date) : "no date") + (main.time ? " at " + main.time : "") + (main.est ? " · about " + dur(main.est) : "") + '</p><div class="acts"><button class="btn pri" data-done="' + esc(main.id + "@" + (main.date || t)) + '">Done</button><button class="btn" data-main-tomorrow="' + esc(main.id) + '">Tomorrow</button><button class="btn" data-act="picker">Change</button><button class="btn ghost" data-open="' + esc(main.id) + '">Details</button></div>';
    else html += '<p class="t">Nothing pressing today.</p><div class="acts"><button class="btn" data-act="picker">Pick a main thing</button></div>';
    if (S.pickerOpen) {
      var opts = S.items.filter(function (i) { return i.kind !== "event" && !i.done && !i.archived && !i.someday && !i.recurrence && i.id !== S.mainId; }).sort(function (a, b) { return (!!b.date - !!a.date) || String(a.priority || "P9").localeCompare(String(b.priority || "P9")) || String(a.date || "").localeCompare(String(b.date || "")); }).slice(0, 10);
      html += '<div class="picker">' + (opts.length ? opts.map(function (i) { return '<button data-main="' + esc(i.id) + '"><span>' + esc(i.title) + '</span><span class="sub">' + (i.date ? fmt(i.date, { day: "numeric", month: "short" }) : esc(i.priority || "")) + "</span></button>"; }).join("") : '<p class="none">Nothing else is open.</p>') + "</div>";
    }
    html += '</section><section class="card"><h2>Today</h2><div style="margin-top:6px">' + (occ.length ? occ.map(function (o) { return row(S, o); }).join("") : '<p class="none">Nothing planned. Add something with the + button, or enjoy the room.</p>') + "</div></section>";
    if (over.length) html += '<section class="card"><div class="over"><div><h2><span class="attn">' + over.length + "</span> " + (over.length === 1 ? "thing from earlier is" : "things from earlier are") + ' still open</h2><p class="sub">No rush. Look when you have a minute.</p></div><button class="btn" data-act="overdue" aria-expanded="' + !!S.overdueOpen + '">' + (S.overdueOpen ? "Close" : "Go through them") + "</button></div>" +
      (S.overdueOpen ? '<div style="margin-top:10px">' + over.map(function (o) { return row(S, o, fmt(o.date, { day: "numeric", month: "short" })) + triage(o); }).join("") + "</div>" : "") + "</section>";
    var nx = C.expand(S.items, C.add(t, 1), C.add(t, 3));
    html += '<div class="grid two"><section class="card"><h2>Next three days</h2><div class="days3">' + [1, 2, 3].map(function (n) {
      var d = C.add(t, n), day = nx.filter(function (o) { return o.date === d; }), fixed = day.filter(function (o) { return o.item.kind !== "task"; }), tasks = day.length - fixed.length;
      return '<button data-day="' + d + '"><b>' + fmt(d, { weekday: "short", day: "numeric" }) + "</b>" + fixed.slice(0, 2).map(function (o) { return "<p>" + (o.item.kind === "deadline" ? "◆ " : "") + esc(o.item.title) + (o.item.time ? " " + o.item.time : "") + "</p>"; }).join("") + '<p class="sub">' + (day.length ? (fixed.length > 2 ? "+" + (fixed.length - 2) + " more · " : "") + (tasks ? tasks + (tasks === 1 ? " task" : " tasks") : "no tasks") : "free") + "</p></button>";
    }).join("") + "</div></section>" +
      '<section class="card feed"><h2>What Claude changed</h2><div style="margin-top:4px">' + (feed.length ? feed.slice(0, 6).map(function (f) { return "<p><span>" + esc(f.text) + ' <i>· ' + (f.src ? '<b class="src">' + esc(f.src) + "</b> · " : "") + esc(f.when) + "</i></span>" + (f.canUndo === false ? "" : '<button class="link" data-undo="' + esc(f.id) + '">undo</button>') + "</p>"; }).join("") : '<p class="none">' + esc(S.feedNote || "No changes in the last 24 hours.") + "</p>") + "</div></section></div>";
    html += '</div><aside class="card wide" style="--hh:30px;--hrs:' + HRS + '" aria-label="Today by the hour"><h2>Today’s time</h2><p class="sub" style="margin-bottom:12px">' + hrs(cap.free) + ' free between 07:00 and 23:00</p>' + V.sleepBand(S, t) + V.untimedWorkouts(S, t) + '<div class="col" style="border-left:0">' + timecol(S, t, occ, true) + "</div></aside></div>";
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
      return '<div class="hd' + (d === t ? " today" : "") + '" data-dropday="' + d + '"><button data-day="' + d + '" style="display:block;width:100%">' + fmt(d, { weekday: "short" }) + (d === t ? " · today" : "") + "<b>" + +d.slice(8) + "</b></button>" + loadBar(S, occ, d, d === days[hi] && lo !== hi) + (S.showActual !== false && S.actual ? (function () { var x = S.actual.sleepBy && S.actual.sleepBy[d]; return x && (x.mins || x.bed) ? '<span class="sl" title="' + esc("Sleep " + (x.bed ? x.bed + "–" + x.wake : "") + (x.score != null ? ", score " + x.score : "") + (x.corrected ? ", corrected" : "")) + '">☾ ' + hm(x.mins || 0) + (x.score != null ? " · " + x.score : "") + "</span>" : '<span class="sl none">☾ no data</span>'; })() : "") + untimed(S, d).map(function (x) { return woChip(x, d, true, S); }).join("") + '<div class="allday">' + l.slice(0, 3).map(function (o) { return '<button data-open="' + esc(o.item.id) + '" data-date="' + d + '" class="' + (o.item.kind === "deadline" ? "due" : "") + '"' + (o.done ? ' style="text-decoration:line-through;opacity:.6"' : "") + ">" + (o.item.kind === "deadline" ? "◆ " : C.hasDone(o.item) ? (o.done ? "☑ " : "☐ ") : "") + esc(o.item.title) + "</button>"; }).join("") + (l.length > 3 ? '<button data-day="' + d + '" class="sub">+' + (l.length - 3) + " more</button>" : "") + "</div></div>";
    }).join("") + '<div class="axis">' + [0, 2, 4, 6, 8, 10, 12, 14].map(function (h) { return '<span style="top:calc(' + h + '*var(--hh))">' + C.pad(H0 + h) + ":00</span>"; }).join("") + "</div>" + days.map(function (d) { return '<div class="col" data-dropcol="' + d + '">' + timecol(S, d, occ, false) + "</div>"; }).join("") + "</div></div>";
    html += '<div class="narrow agenda">' + days.map(function (d) {
      var day = occ.filter(function (o) { return o.date === d; });
      var slx = sleepOf(S, d), done = actualOn(S, d);
      return '<div class="day"><div class="dh"><button data-day="' + d + '"><b' + (d === t ? ' class="acc"' : "") + ">" + fmt(d, { weekday: "short", day: "numeric" }) + (d === t ? " · today" : "") + "</b></button><span>" + capBar(S, occ, d) + "</span></div>" +
        (S.showActual !== false && S.actual ? (slx && (slx.mins || slx.bed) ? '<div class="r act"><span>☾</span><span class="sub">' + esc(sleepText(slx)) + "</span></div>" : "") + done.map(function (x) { return '<button class="r act" data-workout="' + d + '"><span>' + (x.start != null ? C.hhmm(x.start) : "✓") + "</span><span>✓ " + esc(x.title) + (x.mins ? " · " + hm(x.mins) : "") + (x.start == null ? ' <small class="sub">time not synced</small>' : "") + "</span></button>"; }).join("") : "") +
        (isWork(S, d) ? '<div class="r"><span>' + S.work.start + '</span><span class="sub">Work until ' + S.work.end + "</span></div>" : "") +
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
    var html = '<div class="head"><div><p class="eyebrow">Month</p><h1>' + fmt(first, { month: "long", year: "numeric" }) + '</h1></div><div class="nav"><button class="btn sm" data-pattern="gym" aria-pressed="' + (S.pattern === "gym") + '">Gym days</button><button class="btn sm" data-pattern="busy" aria-pressed="' + (S.pattern === "busy") + '">Busy days</button><button class="btn sm" data-movem="-1" aria-label="Previous month">←</button><button class="btn sm" data-act="now">This month</button><button class="btn sm" data-movem="1" aria-label="Next month">→</button></div></div>';
    html += '<div class="mo">' + ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(function (w) { return '<div class="wd">' + w + "</div>"; }).join("") + days.map(function (d) {
      var day = occ.filter(function (o) { return o.date === d; }), fixed = day.filter(function (o) { return o.item.kind === "event" || o.item.kind === "block"; }), dls = day.filter(function (o) { return o.item.kind === "deadline"; }), tasks = day.filter(function (o) { return o.item.kind === "task" && !o.done; }).length;
      var label = fmt(d, { weekday: "long", day: "numeric", month: "long" }) + ": " + fixed.length + " events, " + dls.length + " deadlines, " + tasks + " open tasks";
      var wo = S.actual && S.actual.workoutsBy && (S.actual.workoutsBy[d] || []).length, ld = S.pattern === "busy" ? V.dayLoad(S, occ, d).booked / 960 : 0, sl = S.showActual !== false && S.actual && S.actual.sleepBy && S.actual.sleepBy[d];
      return '<button class="dy' + (d.slice(0, 7) !== mon ? " out" : "") + (d === t ? " today" : "") + (S.pattern === "gym" && wo ? " gymday" : "") + '"' + (S.pattern === "busy" ? ' style="--load:' + Math.round(Math.min(1, ld) * 100) + '%"' : "") + ' data-day="' + d + '" aria-label="' + esc(label + (wo ? ", workout done" : "")) + '"><b>' + +d.slice(8) + "</b>" + (sl && sl.mins ? '<span class="slbar" title="Sleep ' + hm(sl.mins) + '"><i style="width:' + Math.min(100, Math.round(sl.mins / 600 * 100)) + '%"></i></span>' : "") + dls.slice(0, 1).map(function (o) { return '<p class="acc">◆ ' + esc(o.item.title) + "</p>"; }).join("") + fixed.slice(0, 2).map(function (o) { return "<p>" + esc(o.item.title) + "</p>"; }).join("") +
        (S.showActual !== false && S.actual && S.actual.sleepBy && S.actual.sleepBy[d] && S.actual.sleepBy[d].mins ? '<span class="slp" title="Sleep">☾ ' + hm(S.actual.sleepBy[d].mins) + "</span>" + (untimed(S, d).length || (S.actual.workoutsBy && (S.actual.workoutsBy[d] || []).length) ? '<span class="slp">✓ workout</span>' : "") : "") + '<span class="dots">' + dls.map(function () { return '<i class="d"></i>'; }).join("") + (function () { var seen = []; day.forEach(function (o) { var k = C.areaKey(o.item.area); if (seen.indexOf(k) < 0) seen.push(k); }); return seen.map(function (k) { return '<i class="e" style="--c:var(--area-' + k + ')' + (k === "sol" ? ";--co:var(--area-sol-line)" : "") + '" title="' + C.AREA_NAME[k] + '"></i>'; }).join(""); })() + (tasks ? "<span>" + tasks + (tasks === 1 ? " task" : " tasks") + "</span>" : "") + "</span></button>";
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
    if (S.smode !== "board") return V.strategyOutline(S);
    return '<div class="head"><div><p class="eyebrow">Strategy</p><h1>How it all connects</h1><p class="sub" style="margin-top:6px">Every goal is a tree of its projects and tasks. Move things around, fold branches, and connect any two cards.</p></div><div class="nav"><button class="btn sm" data-act="smode">Outline view</button><button class="btn sm" data-act="btidy">Tidy up</button>' + (S.board.undo ? '<button class="btn sm" data-act="bundo">Undo</button>' : "") + '<button class="btn sm" data-act="newgoal">+ Goal</button><button class="btn sm" data-act="newproject">+ Project</button></div></div>' + window.PPCommandBoard.html(S);
  };
  V.strategyOutline = function (S) {
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
    var html = '<div class="head"><div><p class="eyebrow">Strategy</p><h1>How it all connects</h1><p class="sub" style="margin-top:6px">Each goal with its projects, and each project with its tasks. Tasks that belong to nothing are listed at the end.</p></div><div class="nav"><button class="btn sm" data-act="smode">Board view</button><button class="btn sm" data-act="treeall">' + (S.treeAll ? "Close all" : "Open all") + '</button><button class="btn sm" data-act="newgoal">+ Goal</button><button class="btn sm" data-act="newproject">+ Project</button></div></div>';
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

  /* ---------- command palette: jump, find, or do ---------- */
  V.paletteResults = function (S, q) {
    q = String(q || "").trim(); var ql = q.toLowerCase(), out = [];
    var VW = [["today", "Today", "t"], ["week", "Week", "w"], ["month", "Month", "m"], ["horizon", "Horizon", "h"], ["strategy", "Strategy", ""], ["backlog", "Backlog", ""]];
    var mv = /^move (.+?) to (\d{1,2})[:.](\d{2})$/i.exec(q) || /^move (.+?) to (\d{1,2})()$/i.exec(q);
    if (mv) { var hit = S.items.filter(function (i) { return !i.archived && !i.done && (i.title || "").toLowerCase().indexOf(mv[1].toLowerCase()) >= 0; }).sort(function (a, b) { return (a.date === S.today ? 0 : 1) - (b.date === S.today ? 0 : 1); })[0], tm = C.pad(+mv[2]) + ":" + (mv[3] || "00");
      if (hit && +mv[2] < 24) out.push({ kind: "move", id: hit.id, time: tm, label: "Move “" + hit.title + "” to " + tm, hint: hit.date ? fmt(hit.date) : "today" }); }
    VW.forEach(function (v) { if (!ql || v[1].toLowerCase().indexOf(ql) === 0) out.push({ kind: "view", view: v[0], label: "Go to " + v[1], hint: v[2] }); });
    if (ql.length >= 2) S.items.filter(function (i) { return !i.archived && (i.title || "").toLowerCase().indexOf(ql) >= 0; }).sort(function (a, b) { return (!!a.done - !!b.done) || String(b.date || "").localeCompare(String(a.date || "")); }).slice(0, 7).forEach(function (i) { out.push({ kind: "item", id: i.id, area: i.area, label: i.title, hint: (i.done ? "done · " : "") + (i.date ? fmt(i.date, { day: "numeric", month: "short" }) : "no date") + (i.time ? " " + i.time : "") }); });
    if (q.length >= 2 && !mv) { var p = C.parseQuick(q.replace(/^new (task|event)?\s*/i, ""), S.today, S.areas); if (p.title) out.push({ kind: "add", text: q.replace(/^new (task|event)?\s*/i, ""), label: "Add “" + p.title + "”", hint: [KIND[p.kind], p.date ? fmt(p.date, { day: "numeric", month: "short" }) : "", p.time || ""].filter(Boolean).join(" · ") }); }
    return out.slice(0, 12);
  };
  V.palette = function (S) {
    var res = V.paletteResults(S, S.pq), sel = Math.min(S.psel || 0, Math.max(0, res.length - 1));
    return '<input class="qa-in" id="ccPal" placeholder="Search, jump, or do: “week”, “dentist”, “move gym to 18:00”, “call Dana tomorrow 10:00”" aria-label="Command palette" value="' + esc(S.pq || "") + '" autocomplete="off"><div id="ccPalList" class="pal" role="listbox">' + V.paletteList(res, sel) + '</div><p class="sub" style="margin-top:8px;font-size:12.5px">↑ ↓ to choose · Enter to run · Esc to close</p>';
  };
  V.paletteList = function (res, sel) { return res.length ? res.map(function (r, i) { return '<button role="option" aria-selected="' + (i === sel) + '" data-pal="' + i + '"' + (r.kind === "item" ? ' style="' + C.areaVars(r.area) + '" class="pi"' : "") + "><span>" + esc(r.label) + '</span><span class="sub">' + esc(r.hint || "") + "</span></button>"; }).join("") : '<p class="none">Type to search, or write a new item.</p>'; };

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
  /* reminders on this device */
  V.push = function (S) {
    var p = S.push || {}, st = p.settings || {}, t5 = function (v, d) { return esc(String(v || d).slice(0, 5)); }, on = !!p.subscribed;
    var status = !p.supported ? "This browser cannot show reminders. On Android use Chrome; on an iPhone the app has to be added to the home screen first."
      : p.permission === "denied" ? "Notifications are blocked for this site in the browser. Allow them in the site settings (the lock icon next to the address), then come back."
      : on ? "Reminders are on for this device." : "Reminders are off for this device.";
    var chk = function (key, label, val) { return '<label class="pf"><input type="checkbox" data-pf="' + key + '"' + (val !== false ? " checked" : "") + "> " + label + "</label>"; };
    return '<button class="btn sm ghost x" data-act="close" aria-label="Close">✕</button><p class="lab">Reminders</p><h2>On your phone</h2><p class="sub">' + status + (p.devices != null ? " " + p.devices + (p.devices === 1 ? " device is" : " devices are") + " switched on in total." : "") + "</p>" +
      (p.msg ? '<p class="msg" role="alert">' + esc(p.msg) + "</p>" : "") +
      '<div class="acts">' + (p.supported && p.permission !== "denied" ? (on ? '<button class="btn" data-act="pushoff"' + (p.busy ? " disabled" : "") + '>Turn off on this device</button><button class="btn pri" data-act="pushtest"' + (p.busy ? " disabled" : "") + ">Send a test</button>" : '<button class="btn pri" data-act="pushon"' + (p.busy ? " disabled" : "") + ">" + (p.busy ? "Working…" : "Turn on for this device") + "</button>") : "") + "</div>" +
      '<div class="f"><span class="l">What gets sent</span>' + chk("enabled", "Reminders are on (untick to pause everything)", st.enabled) + chk("digest_on", "A short morning summary: the main thing and today’s events", st.digest_on) + chk("deadline_on", "A heads-up the evening before a deadline", st.deadline_on) + '<p class="sub" style="font-size:12.5px">Each item also has its own “Remind me” choices and a Mute switch in its details.</p></div>' +
      '<div class="row3"><div class="f"><label for="ccPd">Morning summary at</label><input class="in" id="ccPd" type="time" data-pf="digest_time" value="' + t5(st.digest_time, "08:00") + '"></div><div class="f"><label for="ccPq">Quiet from</label><input class="in" id="ccPq" type="time" data-pf="quiet_from" value="' + t5(st.quiet_from, "23:00") + '"></div><div class="f"><label for="ccPr">Quiet until</label><input class="in" id="ccPr" type="time" data-pf="quiet_to" value="' + t5(st.quiet_to, "08:00") + '"></div></div>' +
      '<p class="sub" style="font-size:12.5px;margin-top:6px">Nothing is sent during quiet hours. A reminder that falls inside them is skipped, not delivered late.</p>' +
      '<div class="f"><span class="l">Install on an Android phone</span><ol class="steps"><li>Open the planner in Chrome on the phone and sign in.</li><li>Tap the ⋮ menu, then “Add to Home screen” (or “Install app”).</li><li>Open the planner from its new home-screen icon.</li><li>Go to Command Center → Reminders and tap “Turn on for this device”, then “Allow”.</li><li>Tap “Send a test” to check that a notification arrives.</li></ol>' + (p.standalone ? '<p class="sub">This device is running the installed app.</p>' : "") + "</div>";
  };
  V.review = function (S) {
    var start = C.monday(S.cursor), r = C.review(S.items, start, S.today), list = function (a, tri) { return a.length ? a.map(function (o) { return row(S, o, fmt(o.date, { weekday: "short", day: "numeric" })) + (tri ? triage(o) : ""); }).join("") : '<p class="none">Nothing here.</p>'; };
    var byDay = {}; r.next.forEach(function (o) { (byDay[o.date] = byDay[o.date] || []).push(o); });
    return '<button class="btn sm ghost x" data-act="close" aria-label="Close">✕</button><p class="lab">Weekly review</p><h2>Week of ' + fmt(start, { day: "numeric", month: "long" }) + '</h2><p class="sub">' + r.done.length + " done · " + r.slipped.length + " slipped · " + r.open.length + " still to come · " + r.happened + " events and blocks</p>" +
      '<div class="f"><span class="l">Done</span>' + list(r.done) + '</div><div class="f"><span class="l">Slipped (decide what happens to each)</span>' + list(r.slipped, true) + '</div><div class="f"><span class="l">Next week</span>' + (r.next.length ? Object.keys(byDay).sort().map(function (d) { return '<p class="sub" style="margin-top:8px">' + fmt(d, { weekday: "long", day: "numeric" }) + "</p>" + byDay[d].map(function (o) { return row(S, o); }).join(""); }).join("") : '<p class="none">Nothing planned yet.</p>') + '</div><p class="sub" style="margin-top:14px">Ask Claude to “prepare my weekly review” and it will draft next week for you to accept or change.</p>';
  };
})();
