/* Command Center, Today as "the Sundial": a 24-hour Day Ring (midnight at the bottom, noon at the top)
   beside what matters now. Filled = it happened, dashed outline = planned. HTML only; command.js wires it.
   The earlier card layout stays available as V.todayClassic (state flag classicToday). */
(function () {
  var C = window.PPCommandCore, V = window.PPCommandView, esc = V.esc;
  V.todayClassic = V.today;
  var TAU = Math.PI * 2, P = function (r, h) { var a = h / 24 * TAU + Math.PI; return [(r * Math.sin(a)).toFixed(1), (-r * Math.cos(a)).toFixed(1)]; };
  function sector(h1, h2, r1, r2) { h2 = Math.max(h2, h1 + 0.08); var big = h2 - h1 > 12 ? 1 : 0, a = P(r2, h1), b = P(r2, h2), c = P(r1, h2), d = P(r1, h1); return "M" + a + "A" + r2 + " " + r2 + " 0 " + big + " 1 " + b + "L" + c + "A" + r1 + " " + r1 + " 0 " + big + " 0 " + d + "Z"; }
  var hm = function (m) { m = Math.round(m || 0); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + C.pad(m % 60); };
  var GYM = /gym|workout|training|lift|strength|full body/i, isGym = function (it) { return it.kind === "block" && (GYM.test(it.title || "") || it.area === "Health"); };
  var lenOf = function (it) { return it.dur || it.est || (it.kind === "task" || it.kind === "deadline" ? 30 : 60); };
  var areaOf = function (it) { return it.kind === "event" && it.people && it.people.length ? "Relationships" : it.area; };

  /* open tasks due today or earlier: the Today list and the area counts read the same set */
  V.openDue = function (S) { var t = S.today; return C.overdue(S.items, t).concat(C.expand(S.items, t, t).filter(function (o) { return !o.done && C.hasDone(o.item); })); };
  /* everything the ring and the centre need for one day */
  V.dayModel = function (S) {
    var t = S.today, now = S.nowMin, occ = C.expand(S.items, t, t), act = S.showActual !== false && S.actual ? S.actual : null;
    var sleep = act && act.sleepBy ? act.sleepBy[t] : null, wos = act && act.workoutsBy ? (act.workoutsBy[t] || []) : [], energy = act && act.energyBy ? (act.energyBy[t] || []) : [];
    var work = S.work && S.work.days.indexOf(C.dow(t)) >= 0 ? [C.mins(S.work.start), C.mins(S.work.end)] : null;
    var wake = sleep && sleep.wake ? C.mins(sleep.wake) : null, bed = sleep && sleep.bed ? C.mins(sleep.bed) : null;
    var timed = occ.filter(function (o) { return o.item.time && !o.item.allDay; }).map(function (o) { var s = C.mins(o.item.time), e = Math.min(1440, s + lenOf(o.item)); return { o: o, it: o.item, s: s, e: e, gym: isGym(o.item) }; });
    timed.forEach(function (x) {
      var it = x.it, has = C.hasDone(it);
      x.state = has ? (x.o.done ? "done" : "plan") : x.gym && act ? (wos.length ? "met" : x.e < now ? "missed" : "plan") : x.e <= now ? "done" : "plan";
    });
    /* free time from now (today) or from waking / 07:00, until 23:00: the same function as the voice connector */
    var iv = [];
    if (work) iv.push(work); timed.forEach(function (x) { if (x.it.kind !== "deadline") iv.push([x.s, x.e]); }); wos.forEach(function (w) { if (w.start != null) iv.push([w.start, w.start + (w.mins || 60)]); });
    var F = (window.PPFree || { compute: function (o) { var st = Math.max(o.wake != null && o.wake < 720 ? o.wake : o.dayStart, Math.ceil(o.nowMin / 5) * 5), cur = st, g = []; o.busy.slice().sort(function (a, b) { return a[0] - b[0]; }).forEach(function (x) { if (x[0] - cur >= o.minGap) g.push([cur, Math.min(x[0], o.dayEnd)]); cur = Math.max(cur, x[1]); }); if (o.dayEnd - cur >= o.minGap) g.push([cur, o.dayEnd]); return { from: st, to: o.dayEnd, gaps: g, minutes: g.reduce(function (a, x) { return a + Math.max(0, x[1] - x[0]); }, 0), fromNow: true }; } }).compute({ nowMin: now, isToday: true, wake: wake, busy: iv, dayStart: 420, dayEnd: 1380, minGap: 15 });
    var d0 = F.from, d1 = F.to, free = F.gaps, freeMin = F.minutes, fromNow = F.fromNow;
    var current = timed.filter(function (x) { return x.s <= now && x.e > now && x.state !== "missed"; })[0], next = timed.filter(function (x) { return x.s > now && !(C.hasDone(x.it) && x.o.done); }).sort(function (a, b) { return a.s - b.s; })[0];
    var untimed = occ.filter(function (o) { return !o.done && C.hasDone(o.item) && (!o.item.time || o.item.allDay); });
    return { occ: occ, timed: timed, sleep: sleep, wake: wake, bed: bed, work: work, wos: wos, energy: energy, free: free, freeMin: freeMin, d0: d0, d1: d1, fromNow: fromNow, current: current, next: next, untimed: untimed, open: occ.filter(function (o) { return !o.done && C.hasDone(o.item); }) };
  };
  /* greedy proposal: untimed tasks into the free gaps that are still ahead */
  V.proposePlan = function (S) {
    var D = V.dayModel(S), start = Math.ceil((S.nowMin + 5) / 15) * 15, gaps = D.free.map(function (f) { return [Math.max(f[0], start), f[1]]; }).filter(function (f) { return f[1] - f[0] >= 15; }), out = [];
    D.untimed.slice().sort(function (a, b) { return String(a.item.priority || "P9").localeCompare(String(b.item.priority || "P9")); }).forEach(function (o) {
      var need = o.item.est || 30; for (var i = 0; i < gaps.length; i++) { if (gaps[i][1] - gaps[i][0] >= need) { out.push({ id: o.item.id, time: C.hhmm(gaps[i][0]), mins: need }); gaps[i][0] += need + 10; break; } }
    });
    return out;
  };

  function ring(S, D) {
    var s = '<circle class="rface" r="232"/>', i, now = S.nowMin / 60, T = function (x) { return "<title>" + esc(x) + "</title>"; };
    for (i = 0; i < 24; i++) { var a = P(232, i), b = P(i % 6 ? 226 : 220, i); s += '<line class="rtick' + (i % 6 ? "" : " maj") + '" x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '"/>'; }
    [[0, "00"], [6, "06"], [12, "12"], [18, "18"]].forEach(function (t) { var p = P(247, t[0]); s += '<text class="rhr" x="' + p[0] + '" y="' + (+p[1] + 3.5) + '" text-anchor="middle">' + t[1] + "</text>"; });
    /* inner ring: free time (also the drop targets) */
    D.free.forEach(function (f) { s += '<path class="rfree" d="' + sector(f[0] / 60, f[1] / 60, 104, 128) + '">' + T("Free " + C.hhmm(f[0]) + "–" + C.hhmm(f[1]) + " · " + hm(f[1] - f[0])) + "</path>"; if (f[1] - f[0] >= 45) { var p = P(116, (f[0] + f[1]) / 120); s += '<text class="rgap" x="' + p[0] + '" y="' + (+p[1] + 3.5) + '" text-anchor="middle">' + hm(f[1] - f[0]) + "</text>"; } });
    /* middle ring: energy through the day */
    s += '<circle class="rguide" r="150"/>';
    if (D.energy.length > 1) s += '<path class="renergy" d="' + D.energy.map(function (e, k) { return (k ? "L" : "M") + P(138 + Math.max(0, Math.min(100, e[1])) / 100 * 24, e[0]); }).join("") + '">' + T("Body Battery through the day") + "</path>";
    /* outer ring, frame track: sleep and work */
    var arc = function (area, h1, h2, r1, r2, filled, title, extra) { var k = C.areaKey(area); return '<path class="rarc' + (filled ? " on" : "") + (extra || "") + '" style="--c:var(--area-' + k + ");--cs:var(--area-" + k + '-soft)" d="' + sector(h1, h2, r1, r2) + '"' + ">" + T(title) + "</path>"; };
    if (D.sleep && D.wake != null) {
      var st = "Sleep " + (D.sleep.mins ? hm(D.sleep.mins) : "") + (D.sleep.bed ? " · " + D.sleep.bed + "–" + D.sleep.wake : "") + (D.sleep.score != null ? " · score " + D.sleep.score : "") + (D.sleep.corrected ? " · corrected" : "");
      s += arc("Health", D.bed != null && D.bed < D.wake ? D.bed / 60 : 0, D.wake / 60, 206, 220, true, st, " soft");
    }
    if (D.work) s += arc("Career", D.work[0] / 60, D.work[1] / 60, 206, 220, true, "Work block · " + C.hhmm(D.work[0]) + "–" + C.hhmm(D.work[1]), " soft");
    /* outer ring, item track */
    D.timed.forEach(function (x) {
      var it = x.it, ttl = it.title + " · " + C.hhmm(x.s) + (it.kind === "deadline" ? " · deadline" : "–" + C.hhmm(x.e)) + ({ done: C.hasDone(it) ? " · done" : "", plan: " · planned", met: " · done", missed: " · planned, no workout logged" })[x.state];
      if (it.kind === "deadline") { var p = P(188, x.s / 60); s += '<path class="rflag' + (x.o.done ? " on" : "") + '" data-ropen="' + esc(it.id) + '" style="--c:var(--area-' + C.areaKey(areaOf(it)) + ')" transform="translate(' + p[0] + "," + p[1] + ') rotate(45)" d="M-5.5-5.5h11v11h-11z">' + T(ttl) + "</path>"; return; }
      var k = C.areaKey(areaOf(it));
      s += '<path class="rarc' + (x.state === "done" ? " on" : "") + (x.state === "missed" ? " missed" : "") + (x.state === "met" ? " met" : "") + '" data-ropen="' + esc(it.id) + '" tabindex="0" role="button" aria-label="' + esc(ttl) + '" style="--c:var(--area-' + k + ");--cs:var(--area-" + k + '-soft)" d="' + sector(x.s / 60, x.e / 60, 176, 200) + '">' + T(ttl) + "</path>";
    });
    D.wos.forEach(function (w) { if (w.start == null) return; var ttl = "Workout done: " + w.title + (w.mins ? " · " + hm(w.mins) : "") + (w.volume ? " · " + Math.round(w.volume) + " kg" : ""); s += '<path class="rarc on" data-workout="' + S.today + '" tabindex="0" role="button" aria-label="' + esc(ttl) + '" style="--c:var(--area-health)" d="' + sector(w.start / 60, (w.start + (w.mins || 60)) / 60, 182, 194) + '">' + T(ttl) + "</path>"; });
    /* a proposed plan shows as ghost arcs */
    (S.plan || []).forEach(function (p) { var it = S.byId[p.id]; if (!it) return; var m = C.mins(p.time); s += '<path class="rarc ghost" style="--c:var(--area-' + C.areaKey(it.area) + ')" d="' + sector(m / 60, (m + p.mins) / 60, 176, 200) + '">' + T("Proposed: " + it.title + " at " + p.time) + "</path>"; });
    var n1 = P(132, now), n2 = P(236, now);
    s += '<line class="rhand" x1="' + n1[0] + '" y1="' + n1[1] + '" x2="' + n2[0] + '" y2="' + n2[1] + '"/><circle class="rhub" cx="' + n2[0] + '" cy="' + n2[1] + '" r="3.5"/>';
    return '<svg class="ring" id="ccRing" data-dropring="1" viewBox="-262 -262 524 524" role="img" aria-label="Today as a 24-hour dial. Midnight at the bottom, noon at the top. ' + esc(hm(D.freeMin)) + ' free.">' + s + "</svg>";
  }
  function centre(S, D, main) {
    var x = D.current || D.next, now = S.nowMin, lab, name, cd;
    if (D.current) { lab = "now"; name = x.it.title; cd = "until " + C.hhmm(x.e); }
    else if (D.next) { lab = "next"; name = x.it.title; cd = "in " + hm(x.s - now) + " · " + C.hhmm(x.s); }
    else { lab = now < 720 ? "the day ahead" : "today"; name = D.timed.length ? "Nothing else scheduled" : "Open day"; cd = hm(D.freeMin) + " free"; }
    return '<div class="rcentre"><p class="mono">' + lab + '</p><p class="rnext">' + esc(name) + '</p><p class="mono rcd">' + esc(cd) + "</p>" + (main ? '<div class="rmt"><span class="mono">main thing</span><b>' + esc(main.title) + "</b></div>" : "") + "</div>";
  }
  var drow = function (S, o) { return '<div class="dr" draggable="true" data-drag="' + esc(o.item.id) + '" title="Drag onto the ring to give it a time">' + V.row(S, o) + "</div>"; };

  V.today = function (S) {
    if (S.classicToday) return V.todayClassic(S);
    var t = S.today, D = V.dayModel(S), main = S.byId[S.mainId], over = C.overdue(S.items, t), feed = S.feed || [], hour = Math.floor(S.nowMin / 60), pulse = S.pulse || {};
    if (main && (main.done || main.archived)) main = null;
    var morning = hour >= 4 && hour < 12, evening = hour >= 19 || hour < 4;
    /* left: the ring */
    var chips = D.wos.filter(function (w) { return w.start == null; }).map(function (w) { return '<button class="wochip" data-workout="' + t + '">✓ ' + esc(w.title) + (w.mins ? " · " + hm(w.mins) : "") + ' <span class="nt">time not synced</span></button>'; }).join("");
    var openLine = D.d0 >= D.d1 ? "The day is over. Rest well." : (D.fromNow ? hm(D.freeMin) + " free from now until 23:00" : (!D.timed.length ? "Open day. " : "") + hm(D.freeMin) + " free between " + C.hhmm(D.d0) + " and 23:00") + ".";
    var left = '<div class="sun-l"><div class="ringwrap">' + ring(S, D) + centre(S, D, main) + '</div><p class="ropen">' + openLine + "</p>" + (chips ? '<div class="wochips" style="max-width:420px;margin:8px auto 0">' + chips + "</div>" : "") +
      '<p class="rlegend mono"><span><i class="k1"></i>filled = happened</span><span><i class="k2"></i>outlined = planned</span><span><i class="k3"></i>free time</span>' + (D.energy.length > 1 ? '<span><i class="k4"></i>energy</span>' : "") + "</p>" +
      (morning && D.untimed.length && !S.plan ? '<p class="rplan"><button class="btn" data-act="planday">✦ Plan my day <span class="mono">times for ' + D.untimed.length + " untimed " + (D.untimed.length === 1 ? "task" : "tasks") + "</span></button></p>" : "") + "</div>";
    /* right: what matters now */
    var r = '<p class="mono eyebrow2">' + V.fmt(t, { weekday: "long", day: "numeric", month: "long" }) + "</p>";
    if (main) r += '<section class="smain" style="' + C.areaVars(main.area) + '" aria-label="The main thing"><p class="mono" style="color:var(--ct)">★ main thing · ' + esc(main.area || "no area") + '</p><p class="t">' + esc(main.title) + '</p><div class="acts"><button class="btn pri" data-done="' + esc(main.id + "@" + (main.date || t)) + '">Done</button><button class="btn" data-main-tomorrow="' + esc(main.id) + '">Tomorrow</button><button class="btn" data-act="picker">Change</button><button class="btn ghost" data-open="' + esc(main.id) + '">Details</button></div>';
    else {
      var sug = S.items.filter(function (i) { return i.kind !== "event" && !i.done && !i.archived && !i.someday && !i.recurrence; }).sort(function (a, b) { return String(a.priority || "P9").localeCompare(String(b.priority || "P9")) || String(a.date || "9999").localeCompare(String(b.date || "9999")); }).slice(0, 3);
      r += '<section class="smain" aria-label="The main thing"><p class="mono">★ main thing</p><p class="t dim">Pick a main thing</p>' + (sug.length ? '<div class="sug">' + sug.map(function (i) { return '<button data-main="' + esc(i.id) + '" style="' + C.areaVars(i.area) + '">' + esc(i.title) + "</button>"; }).join("") + "</div>" : "") + '<div class="acts" style="margin-top:8px"><button class="btn" data-act="picker">Choose another</button></div>';
    }
    if (S.pickerOpen) {
      var opts = S.items.filter(function (i) { return i.kind !== "event" && !i.done && !i.archived && !i.someday && !i.recurrence && i.id !== S.mainId; }).sort(function (a, b) { return (!!b.date - !!a.date) || String(a.priority || "P9").localeCompare(String(b.priority || "P9")); }).slice(0, 12);
      r += '<div class="picker">' + (opts.length ? opts.map(function (i) { return '<button data-main="' + esc(i.id) + '"><span>' + esc(i.title) + '</span><span class="sub">' + (i.date ? V.fmt(i.date, { day: "numeric", month: "short" }) : esc(i.priority || "")) + "</span></button>"; }).join("") : '<p class="none">Nothing else is open.</p>') + "</div>";
    }
    r += "</section>";
    if (S.plan) r += '<section class="card plan"><p class="mono">Proposed times · from your free gaps</p>' + (S.plan.length ? S.plan.map(function (p) { var it = S.byId[p.id]; return it ? '<div class="prow" style="' + C.areaVars(it.area) + '"><b class="mono">' + p.time + "</b><span>" + esc(it.title) + ' <small class="mono">' + hm(p.mins) + '</small></span><button class="btn sm" data-planone="' + esc(p.id) + '">Accept</button></div>' : ""; }).join("") + '<div class="acts"><button class="btn pri" data-act="planok">Accept all</button><button class="btn" data-act="planno">Dismiss</button></div>' : '<p class="none">No gap is long enough for the untimed tasks today.</p><div class="acts"><button class="btn" data-act="planno">Close</button></div>') + "</section>";
    if (evening && D.open.length) {
      var tm = C.expand(S.items, C.add(t, 1), C.add(t, 1)).filter(function (o) { return o.item.time; })[0];
      r += '<section class="card eve"><p class="mono">Evening check-in · one tap each</p>' + D.open.map(function (o) { return '<div class="erow" style="' + C.areaVars(o.item.area) + '"><span>' + esc(o.item.title) + '</span><span class="seg3"><button data-eve="done" data-key="' + esc(o.key) + '">Done</button><button data-eve="moved" data-key="' + esc(o.key) + '">Moved</button><button data-eve="dropped" data-key="' + esc(o.key) + '">Dropped</button></span></div>'; }).join("") + '<p class="sub" style="margin-top:6px">Moved goes to tomorrow; Dropped archives it (it can be restored).' + (tm ? " Tomorrow starts with <b>" + esc(tm.item.title) + " · " + tm.item.time + "</b>." : "") + "</p></section>";
    } else {
      r += '<section aria-label="Today"><p class="mono">Today' + (D.untimed.length ? " · drag a task onto the ring to give it a time" : "") + '</p><div class="tlist">' + (over.length || D.occ.length ? over.map(function (o) { return '<div class="dr od" draggable="true" data-drag="' + esc(o.item.id) + '">' + V.row(S, o, "overdue · " + V.fmt(o.date, { day: "numeric", month: "short" })) + "</div>"; }).join("") + D.occ.map(function (o) { return C.hasDone(o.item) && !o.done ? drow(S, o) : V.row(S, o); }).join("") : '<p class="none">Nothing planned. Add something with N, or enjoy the room.</p>') + "</div>";
      r += "</section>";
    }
    if (over.length) r += '<section class="fold"><div class="over"><span><span class="attn">' + over.length + "</span> overdue · sort them in one go</span><button class=\"btn\" data-act=\"overdue\" aria-expanded=\"" + !!S.overdueOpen + '">' + (S.overdueOpen ? "Close" : "Go through them") + "</button></div>" + (S.overdueOpen ? '<div style="margin-top:8px">' + over.map(function (o) { return V.row(S, o, V.fmt(o.date, { day: "numeric", month: "short" })) + V.triage(o); }).join("") + "</div>" : "") + "</section>";
    /* area pulse */
    var wdl = D.occ.filter(function (o) { return o.item.kind === "deadline" && !o.done && C.areaKey(o.item.area) === "work"; }).length, wopen = V.openDue(S).filter(function (o) { return C.areaKey(o.item.area) === "work"; }), wtasks = wopen.length, wlate = wopen.filter(function (o) { return o.date < t; }).length;
    var tiles = [["health", "Health", pulse.health, "health"], ["people", "People", pulse.people, "people"], ["task", "Money", pulse.money, "finance"], ["work", "Work", { big: wdl ? String(wdl) : String(wtasks), sub: wdl ? (wdl === 1 ? "deadline today" : "deadlines today") : (wtasks === 1 ? "open task" : "open tasks") + (wlate ? " · " + wlate + " overdue" : " due today") }, "work"], ["growth", "Growth", pulse.growth, "knowledge"]];
    r += '<section aria-label="Area pulse"><div class="pulse">' + tiles.map(function (p) { var d = p[2] || { big: "–", sub: "no data yet" }; return '<button class="ptile" data-go="' + p[3] + '" style="--c:var(--area-' + p[0] + ");--ct:var(--area-" + p[0] + '-text)"><span class="mono">' + p[1] + '</span><b' + (d.blur && !S.unblur ? ' class="blur" data-blur="1"' : "") + ">" + esc(d.big) + "</b><span>" + esc(d.sub || "") + "</span></button>"; }).join("") + "</div></section>";
    /* what Claude changed: the last three */
    r += '<section class="feed" aria-label="What Claude changed"><p class="mono">What Claude changed</p>' + (feed.length ? feed.slice(0, 3).map(function (f) { return "<p><span>" + esc(f.text) + " <i>· " + (f.src ? '<b class="src">' + esc(f.src) + "</b> · " : "") + esc(f.when) + "</i></span>" + (f.canUndo === false ? "" : '<button class="link" data-undo="' + esc(f.id) + '">undo</button>') + "</p>"; }).join("") : '<p class="none">' + esc(S.feedNote || "No changes in the last 24 hours.") + "</p>") + "</section>";
    /* the next three days, one line each */
    var nx = C.expand(S.items, C.add(t, 1), C.add(t, 3));
    r += '<section class="next3" aria-label="Next three days">' + [1, 2, 3].map(function (n) { var d = C.add(t, n), day = nx.filter(function (o) { return o.date === d; }), seen = [], fixed = day.filter(function (o) { return o.item.kind !== "task"; }); day.forEach(function (o) { var k = C.areaKey(o.item.area); if (seen.indexOf(k) < 0) seen.push(k); });
      return '<button data-day="' + d + '"><b>' + V.fmt(d, { weekday: "short", day: "numeric" }) + '</b><span class="ndots">' + seen.map(function (k) { return '<i style="--c:var(--area-' + k + ')"></i>'; }).join("") + '</span><span class="sub">' + (day.length ? esc(fixed.slice(0, 2).map(function (o) { return o.item.title; }).join(" · ") || (day.length + (day.length === 1 ? " task" : " tasks"))) : "open") + "</span></button>"; }).join("") + "</section>";
    return '<div class="sun">' + left + '<div class="sun-r">' + r + "</div></div>";
  };
})();

/* Horizon: the Terrain (3D) with the roadmap (2D) as the other face of the same view */
(function () {
  var C = window.PPCommandCore, V = window.PPCommandView, LANES = [["work", "Work"], ["task", "Tasks & money"], ["health", "Health"], ["growth", "Growth"], ["people", "People"]];
  V.roadmap = V.horizon;
  /* weekly hours per area: four weeks back (what was done or happened), 26 ahead (what is booked) */
  V.terrainData = function (S) {
    var start = C.add(C.monday(S.today), -28), WEEKS = 30, occ = C.expand(S.items, start, C.add(start, WEEKS * 7 - 1)), byDate = {};
    occ.forEach(function (o) { (byDate[o.date] = byDate[o.date] || []).push(o); });
    var lanes = LANES.map(function (l) { return { key: l[0], name: l[1], hours: [] }; }), total = [], weeks = [];
    for (var w = 0; w < WEEKS; w++) {
      var sum = {}, ws = C.add(start, w * 7); weeks.push(ws);
      for (var d = 0; d < 7; d++) { var date = C.add(ws, d), list = byDate[date] || []; if (date < S.today) list = list.filter(function (o) { return o.done || !C.hasDone(o.item); });
        var L = V.dayLoad(S, list, date); Object.keys(L.by).forEach(function (k) { sum[k] = (sum[k] || 0) + L.by[k]; });
        list.forEach(function (o) { var it = o.item; if ((!it.time || it.allDay) && it.est && C.hasDone(it)) { var k = C.areaKey(it.area); sum[k] = (sum[k] || 0) + it.est; } }); }
      var tot = 0; lanes.forEach(function (l) { var h = Math.round((sum[l.key] || 0) / 6) / 10; l.hours.push(h); tot += h; }); total.push(Math.round(tot * 10) / 10);
    }
    var end = C.add(start, WEEKS * 7 - 1), laneOf = function (a) { var k = C.areaKey(a); return LANES.some(function (l) { return l[0] === k; }) ? k : "task"; }, wk = function (d) { return C.diff(start, d) / 7; };
    return { weeks: weeks, today: 4 + ((C.dow(S.today) + 6) % 7) / 7, lanes: lanes, total: total, ceiling: S.sustain || 50,
      deadlines: S.items.filter(function (i) { return i.kind === "deadline" && !i.done && !i.archived && i.date && i.date >= S.today && i.date <= end; }).slice(0, 14).map(function (i) { return { lane: laneOf(i.area), week: wk(i.date), title: i.title, date: i.date }; }),
      goals: (S.goals || []).filter(function (g) { return g.due && g.due > S.today && g.area; }).slice(0, 8).map(function (g) { return { lane: laneOf(g.area), from: 4, to: Math.min(WEEKS - 1, wk(g.due)), title: g.title, progress: (g.progress || 0) / 100 }; }) };
  };
  V.horizon = function (S) {
    var seg = '<div class="hzbar"><div class="seg" role="group" aria-label="Horizon view"><button data-act="hz3d" aria-pressed="' + !!S.hz3d + '">Terrain</button><button data-act="hz2d" aria-pressed="' + !S.hz3d + '">Roadmap</button></div>' + (S.hz3d ? '<button class="btn sm" data-act="hzflat">Flatten to roadmap</button>' : "") + (S.hzNote ? '<span class="sub">' + V.esc(S.hzNote) + "</span>" : "") + "</div>";
    if (!S.hz3d) return seg + V.roadmap(S);
    return '<div class="head"><div><p class="eyebrow">Horizon</p><h1>The next six months</h1><p class="sub" style="margin-top:6px">Height is booked hours per week in each area; the grey ridge at the back is everything together, under your sustainable week. Drag to orbit, scroll to move along time, click a week to open it.</p></div></div>' + seg +
      '<div class="terrain" id="ccTerrain" role="img" aria-label="Workload over the next six months as a landscape. The Roadmap button shows the same period as a list."><p class="tr-wait mono">Loading the terrain…</p></div>';
  };
})();
