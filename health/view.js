/* Health page, part 3 of 4: the page as HTML, built from the model. No state, no events. */
(function () {
  var H = window.PPH = window.PPH || {};
  var fmt = H.fmt, esc = H.esc, dstr = H.dstr, wday = H.wday, st = H.st, STATUS = H.STATUS, clock = H.clock, hm = H.hm;
  var wd = function (d) { return wday(d) + " " + dstr(d); };
  var ic = function (s) { return '<b class="ic ' + s + '">' + STATUS[s].icon + "</b> "; };
  var kv = function (a) { return '<dl class="kv">' + a.map(function (x) { return "<div><dt>" + x[0] + "</dt><dd>" + x[1] + "</dd></div>"; }).join("") + "</dl>"; };
  var kg = function (v) { return v == null ? "–" : (Math.round(v * 10) / 10) + " kg"; };
  var psec = function (id, n, title, inner, sub) { return '<section class="sec psec" id="' + id + '"><div class="sec-h pillar-h"><span class="pn">' + n + '</span><h2>' + title + "</h2>" + (sub ? '<p class="sec-sub">' + sub + "</p>" : "") + "</div>" + inner + "</section>"; };
  var sec = function (id, title, inner, sub) { return '<section class="sec" id="' + id + '"><div class="sec-h"><h2>' + title + "</h2>" + (sub ? '<p class="sec-sub">' + sub + "</p>" : "") + "</div>" + inner + "</section>"; };
  var hours = function (d) { return d.getHours() + d.getMinutes() / 60; };
  var tag = function (M) { return M.sample ? ' <span class="tag">SAMPLE</span>' : ""; };

  function header(M) {
    var c = M.current, status = c ? '<b class="ic watch">◐</b> ' + ({ sick: "Sick", injured: "Injured", "break": "On a break" }[c.status]) + " since " + dstr(c.from) : '<b class="ic good">●</b> Normal';
    var g = M.synced ? "Garmin synced " + (H.dayDiff(M.now, M.synced) === 0 ? H.pad2(M.synced.getHours()) + ":" + H.pad2(M.synced.getMinutes()) : dstr(M.synced)) : M.hasToday ? "Garmin data in for today" : "No Garmin data for today yet";
    var w = M.last ? "Last workout " + (M.last.ago === 0 ? "today" : M.last.ago === 1 ? "yesterday" : wd(M.last.d)) : "No workouts logged yet";
    return '<header class="top"><div class="title"><p class="eyebrow">Health</p><h1>' + M.now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) + '</h1></div><div class="meta"><span class="status">' + status + '</span><span class="fresh">' + g + " · " + w + '</span></div>' +
      '<div class="tools"><div class="seg small" role="group" aria-label="Appearance">' + [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(function (t) { return '<button class="chip-t" data-t="' + t[0] + '" aria-pressed="false">' + t[1] + "</button>"; }).join("") + '</div><button id="refresh" class="ghost" aria-label="Reload health data" title="Reload">↻</button></div></header>';
  }

  function halo(M) {
    var W = 184, Hh = 444, r = W / 2, d = "M" + r + " 0A" + r + " " + r + " 0 0 1 " + W + " " + r + "V" + (Hh - r) + "A" + r + " " + r + " 0 0 1 0 " + (Hh - r) + "V" + r + "A" + r + " " + r + " 0 0 1 " + r + " 0", at = 0, out = "";
    M.contrib.forEach(function (c) {
      var len = c.w - 1.4;
      out += '<path class="h-track" d="' + d + '" pathLength="100" stroke-dasharray="' + len + ' 100" stroke-dashoffset="' + (-at - 0.7) + '"/>' + (c.score == null ? "" : '<path class="h-seg ' + st(c.score) + '" d="' + d + '" pathLength="100" stroke-dasharray="' + (len * c.score / 100).toFixed(2) + ' 100" stroke-dashoffset="' + (-at - 0.7) + '"/>');
      at += c.w;
    });
    return '<svg class="halo" viewBox="-8 -8 200 460" aria-hidden="true">' + out + "</svg>";
  }
  function contrib(M) {
    var miss = M.missingInputs, fine = M.ready == null ? "Too few of today's inputs have arrived to score the day, so no number is shown rather than a guess." : miss.length ? "Missing today: " + miss.join(", ").toLowerCase() + ". The other inputs were re-weighted to fill the gap." : "All five inputs arrived today. When one is missing, the others are re-weighted and this line says which.";
    return '<ul class="contrib">' + M.contrib.map(function (c) {
      var s = st(c.score), sc = c.score == null ? 0 : Math.round(c.score);
      return '<li class="' + s + '"><span class="c-name">' + c.name + '</span><span class="c-val">' + (c.val == null ? "–" : c.val + (c.unit ? "<small> " + c.unit + "</small>" : "")) + '</span><span class="meter" role="img" aria-label="' + (c.score == null ? "no data" : sc + " of 100") + '"><i style="width:' + sc + '%"></i></span><span class="c-note">' + ic(s) + c.note + '</span><span class="c-w">' + c.w + "%</span></li>";
    }).join("") + '</ul><p class="fine">' + fine + "</p>";
  }
  function hero(M) {
    var s = M.paused ? "none" : st(M.ready), word = M.paused ? "Paused" : M.ready == null ? "No score yet" : STATUS[s].word;
    var fig = '<div class="figure">' + halo(M) + '<div class="breath"><div id="flipper"><div id="faceF" class="face"></div><div id="faceB" class="face"></div></div></div></div>';
    var score = '<div class="score"><p class="lab">Readiness</p><p class="num' + (M.ready == null ? " nil" : "") + '">' + (M.ready == null ? "–" : '<span data-count="' + M.ready + '">' + M.ready + "</span>") + '</p><p class="word">' + ic(s) + word + '</p><p class="verdict">' + esc(M.verdict) + '</p><p class="fine">' + (M.garmin != null ? "Garmin's training readiness says " + M.garmin + ". Ours compares you with your own last 30 days." : "Garmin's own training readiness wasn't reported today. Ours compares you with your own last 30 days.") + "</p></div>";
    var chips = '<div class="controls"><div class="seg" role="group" aria-label="Body layer">' + [["recovery", "Recovery"], ["week", "Week"], ["vitals", "Vitals"], ["flags", "Flags"]].map(function (l) { return '<button class="chip-l" data-l="' + l[0] + '" aria-pressed="false">' + l[1] + "</button>"; }).join("") +
      '</div><div class="seg" role="group" aria-label="View"><button class="chip-v" data-v="front" aria-pressed="true">Front</button><button class="chip-v" data-v="back" aria-pressed="false">Back</button></div></div><div id="legend" class="legend"></div>';
    return '<section class="hero" id="stage" aria-label="Readiness and body"><div class="duo">' + fig + '<div class="side">' + score + "</div></div>" + chips + '<details class="listview"><summary>Read the body as a list</summary><ul id="a11y"></ul></details><div class="why"><p class="lab">Inputs · halo segments are sized by weight</p>' + contrib(M) + '</div><div id="pop" class="pop" role="status" hidden></div></section>';
  }

  function plan(M) {
    var b = M.brief, recs = (b && b.recommendations) || [], tr = recs.filter(function (r) { return r.kind === "train" || r.kind === "recover"; })[0], rest = recs.filter(function (r) { return r !== tr; }).slice(0, 2);
    var p = M.plan, title = p === "rest" ? "Rest today" : p === "done" ? "Done for today" : p === "easy" ? "Easy day" : p === "train" ? M.next + " today" : "Next up: " + M.next;
    var why = p === "rest" ? "Targets and streaks are paused while you're marked as " + (M.current.status === "break" ? "on a break" : M.current.status) + ". They pick up where you left off."
      : p === "done" ? M.last.routine + " is logged" + (M.last.vol ? ", " + fmt(M.last.vol) + " kg moved" : "") + ". Eat, wind down, sleep."
      : p === "easy" ? "Readiness is low, so nothing is scheduled. A walk counts. " + M.next + " waits until you feel better."
      : p === "between" ? "You trained yesterday. Your weeks have room for a day off between sessions."
      : p === "unknown" ? "No readiness score yet, so go by how you feel." : "Recovery supports a full session.";
    var showT = p !== "rest" && p !== "done" && p !== "easy", t = "";
    if (showT) t = M.targets.length ? '<ul class="targets">' + M.targets.map(function (x) { return "<li><span>" + esc(x.name) + "</span><b>" + kg(x.weight) + (x.reps ? " × " + esc(x.reps) : "") + "</b>" + (x.up ? '<i class="up">↑ from ' + (x.last == null ? "last time" : (Math.round(x.last * 10) / 10)) + "</i>" : '<i class="hold">hold</i>') + "</li>"; }).join("") + '</ul><p class="rule">Hit ' + M.cfg.repTop + " reps on every set → add " + M.cfg.step + " kg next time." + (M.targetsFrom ? " Based on " + wd(M.targetsFrom) + "." : "") + "</p>"
      : '<p class="rule">No earlier ' + esc(M.next) + " session is logged, so there are no targets yet.</p>";
    var card = function (kind, ti, wy, extra, cls) { return '<article class="rec' + (cls || "") + '"><header><span class="kind">' + esc(kind) + "</span><h3>" + esc(ti) + '</h3></header><p class="why">' + esc(wy) + "</p>" + (extra || "") + "</article>"; };
    var out = card(tr ? tr.kind : p === "rest" || p === "easy" ? "Recover" : "Train", tr ? tr.title : title, tr ? tr.why : why, t, " train");
    if (rest.length) out += rest.map(function (r) { return card(r.kind || "Note", r.title, r.why); }).join("");
    else {
      var a = M.stepsAvg7, goal = M.cfg.stepsGoal, lastBed = M.T.bed_time || null;
      out += M.paused ? card("Move", "Gentle movement only", "A short walk if you feel up to it. There is no step target while you're " + (M.current.status === "break" ? "on a break" : M.current.status) + ".")
        : card("Move", fmt(goal) + " steps", a == null ? "No step data from the last week yet." : a >= goal ? "Your 7-day average is " + fmt(a) + ", above your goal. Keep it there." : "Your 7-day average is " + fmt(a) + ". A 20-minute walk covers most of the gap.");
      out += card("Sleep", "Asleep by " + M.cfg.bed, lastBed ? "Last night it was " + clock(lastBed) + ". Earlier by even half an hour helps." : "No sleep data from last night, so this is just your standing target.");
    }
    var at = b && (b.updated_at || b.created_at) ? new Date(b.updated_at || b.created_at) : null;
    var by = b ? "Written by " + esc(b.written_by === "claude" || !b.written_by ? "Claude" : b.written_by) + (at ? " at " + H.pad2(at.getHours()) + ":" + H.pad2(at.getMinutes()) : "") + (b.summary ? " · " + esc(b.summary) : "") : "Rule-based suggestion — Claude hasn't written today's brief yet.";
    return '<div class="recs">' + out + '</div><p class="byline">' + by + tag(M) + "</p>";
  }

  function pillar(key, title, s, label, big, unit, delta, body) {
    return '<article class="pillar" data-pillar="' + key + '"><header><h3>' + title + '</h3><span class="state">' + ic(s) + label + '</span></header><p class="big' + (big == null ? " nil" : "") + '"><span' + (big == null ? "" : ' data-count="' + big + '"') + ">" + fmt(big) + "</span><small>" + unit + '</small></p><p class="delta">' + delta + '</p><div class="pbody">' + body + '</div><button class="expand" aria-expanded="false">See trend</button><div class="deep"></div></article>';
  }
  var hint = function (s, t) { return '<p class="hint">' + ic(s) + t + "</p>"; };
  function pillars(M) {
    var T = M.T, B = M.B, n = function (k) { return T[k] == null ? null : +T[k]; };
    var rel = function (v, b) { if (v == null) return "No reading today"; if (!b) return "Still learning your baseline"; var d = Math.round(v - b.med); return (d === 0 ? "Right at" : Math.abs(d) + (d > 0 ? " above" : " below")) + " your usual " + Math.round(b.med); };
    var band = function (b) { return b ? [b.lo, b.hi] : null; };
    /* sleep */
    var sl = n("sleep_score"), ss = st(sl), bedHint = "";
    if (T.bed_time) { var nb = function (m) { return m < 720 ? m + 1440 : m; }, late = nb(hm(T.bed_time)) - nb(hm(M.cfg.bed)); bedHint = late > 15 ? hint("watch", "Asleep " + (late >= 60 ? Math.floor(late / 60) + "h " + H.pad2(late % 60) : late + " min") + " past your " + M.cfg.bed + " target") : hint("good", "Asleep by your " + M.cfg.bed + " target"); }
    var week = M.days.slice(-7), gaps = week.filter(function (x) { return !x.r || x.r.sleep_score == null; });
    var sleepBody = (sl == null ? '<p class="empty">No sleep was recorded last night. If the watch was off, that is all this means.</p>' : kv([["Asleep", H.dur(n("sleep_minutes"))], ["From", clock(T.bed_time)], ["Up", clock(T.wake_time)]]) + bedHint + H.stages(T)) +
      '<p class="lab">Last 7 nights</p>' + H.nights(week) + (gaps.length ? hint("none", gaps.map(function (x) { return wday(x.d); }).join(", ") + ": no sleep data, watch probably not worn. Nothing is guessed.") : "");
    /* energy */
    var rhr = n("resting_hr"), hs = M.vitals.heart.s, bbn = n("body_battery_now"), bbh = n("body_battery_high"), sa = n("stress_avg"), ys = M.Y.stress_avg;
    var energyBody = '<div class="row">' + H.spark(M.col("resting_hr", 7), { band: band(B.resting_hr), label: "Resting heart rate, last 7 days", w: 300, h: 64, wide: true }) + '<span class="cap">7 days' + (B.resting_hr ? " · band is your usual range" : "") + "</span></div>" +
      kv([["HRV", n("hrv_avg") == null ? "no reading" : n("hrv_avg") + " ms" + (T.hrv_status ? " · " + esc(T.hrv_status) : "")], ["Body Battery", bbn == null && bbh == null ? "no reading" : (bbn != null ? bbn + " now" : "") + (bbn != null && bbh != null ? " · " : "") + (bbh != null ? "high " + bbh : "")], ["Stress", sa == null && ys == null ? "no reading" : (sa != null ? sa + " so far" : "") + (sa != null && ys != null ? " · " : "") + (ys != null ? ys + " yesterday" : "")]]) +
      '<p class="lab">Body Battery since midnight</p>' + H.bbCurve(T.body_battery_curve);
    /* movement */
    var steps = n("steps"), goal = M.cfg.stepsGoal, ms = steps == null ? "none" : steps >= goal ? "good" : "watch", iw = M.intensityWeek, it = M.cfg.intensity;
    var today = M.acts.filter(function (a) { return H.dayDiff(M.now, a.d) === 0; }).map(function (a) { return esc(a.name) + (a.mins ? " " + Math.round(a.mins) + " min" : ""); });
    var pct = steps == null ? 0 : Math.min(100, Math.round(steps / goal * 100));
    var moveBody = '<div class="goal" role="img" aria-label="' + (steps == null ? "No steps reported" : pct + "% of the steps goal") + '"><i style="width:' + pct + '%"></i></div><div class="row">' + H.spark(M.col("steps", 8).slice(0, 7), { band: band(B.steps), label: "Steps, last 7 full days", w: 300, h: 64, wide: true }) + '<span class="cap">Last 7 full days</span></div>' +
      '<p class="lab">Intensity minutes, 7 days</p><div class="goal" role="img" aria-label="' + (iw == null ? "not reported" : iw + " of " + it + " minutes") + '"><i style="width:' + (iw == null ? 0 : Math.min(100, Math.round(iw / it * 100))) + '%"></i></div>' + kv([["Intensity", iw == null ? "not reported" : iw + " of " + it + " min"], ["Today", today.length ? today.join(", ") : "nothing logged yet"]]);
    return { sleep:
      pillar("sleep", "Last night", ss, { good: "Good night", watch: "Fair night", low: "Rough night", none: "No data" }[ss], sl, "score", rel(sl, B.sleep_score), sleepBody), vitals:
      pillar("energy", "Heart, recovery and stress", hs, hs === "none" ? "No data" : M.paused ? "Resting" : M.vitals.heart.label, rhr, "bpm resting", rel(rhr, B.resting_hr), energyBody), move:
      pillar("move", "Everyday movement", ms, ms === "none" ? "No data" : ms === "good" ? "Goal reached" : M.paused ? "No target today" : "Room to build", steps, "steps so far", "7-day average " + fmt(M.stepsAvg7) + " · goal " + fmt(goal), moveBody) };
  }

  /* Training calendar: the days a strength session or a gym-type activity was actually logged.
     Other sport (a swim, a run) is marked differently; walks are left out. Nothing is inferred. */
  function trainCal(M) {
    var key = function (d) { return d.getFullYear() + "-" + H.pad2(d.getMonth() + 1) + "-" + H.pad2(d.getDate()); }, days = {}, GYM = /strength|gym|fitness|weight|hiit|workout|crossfit|cardio/i, SKIP = /walk|steps|hike|commute/i;
    M.sessions.forEach(function (s) { var k = key(s.d); (days[k] = days[k] || { gym: [], other: [] }).gym.push(s.routine || "Strength session"); });
    M.acts.forEach(function (a) { var label = (a.name || a.type || "Activity") + (a.mins ? " " + Math.round(a.mins) + " min" : ""), k = key(a.d), t = (a.type || "") + " " + (a.name || ""); if (SKIP.test(t)) return; var o = days[k] = days[k] || { gym: [], other: [] }; if (GYM.test(t)) { if (!o.gym.length) o.gym.push(label); } else o.other.push(label); });
    var now = M.now, today = key(now), months = [], inPeriod = function (d) { return M.periods.some(function (p) { return d >= p.from && (!p.to || d <= p.to); }); };
    for (var m = 2; m >= 0; m--) months.push(new Date(now.getFullYear(), now.getMonth() - m, 1));
    var total30 = 0, total90 = 0; Object.keys(days).forEach(function (k) { if (!days[k].gym.length) return; var age = Math.round((new Date(today + "T12:00:00") - new Date(k + "T12:00:00")) / 864e5); if (age >= 0 && age < 30) total30++; if (age >= 0 && age < 90) total90++; });
    var grid = months.map(function (first) {
      var lead = (first.getDay() + 6) % 7, n = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(), cells = "", count = 0;
      for (var i = 0; i < lead; i++) cells += '<span class="tcd blank"></span>';
      for (var d = 1; d <= n; d++) {
        var dt = new Date(first.getFullYear(), first.getMonth(), d), k = key(dt), o = days[k], future = k > today, cls = "tcd" + (o && o.gym.length ? " gym" : o && o.other.length ? " other" : "") + (k === today ? " today" : "") + (future ? " future" : "") + (!future && inPeriod(dt) ? " paused" : "");
        if (o && o.gym.length) count++;
        var what = o && o.gym.length ? o.gym.concat(o.other).join(", ") : o && o.other.length ? o.other.join(", ") : future ? "" : inPeriod(dt) ? "sick, injured or on a break" : "no training logged";
        cells += '<span class="' + cls + '" role="img" aria-label="' + esc(wday(dt) + " " + d + " " + first.toLocaleDateString("en-GB", { month: "long" }) + (what ? ": " + what : "")) + '" title="' + esc(what) + '">' + d + (o && o.gym.length ? '<i aria-hidden="true">●</i>' : o && o.other.length ? '<i aria-hidden="true">○</i>' : "") + "</span>";
      }
      return '<div class="tcm"><p class="lab">' + first.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) + ' <span class="tcn">' + count + (count === 1 ? " day" : " days") + '</span></p><div class="tcw">' + ["M", "T", "W", "T", "F", "S", "S"].map(function (x) { return "<b>" + x + "</b>"; }).join("") + "</div>" + '<div class="tcg">' + cells + "</div></div>";
    }).join("");
    return '<div class="panel tcal"><div class="tch"><p class="lab">Training calendar</p><p class="sub">' + total30 + (total30 === 1 ? " training day" : " training days") + " in the last 30 days · " + total90 + ' in the last 90</p></div><div class="tcms">' + grid + '</div><p class="hint"><span class="tck gym">●</span> strength or gym session &nbsp; <span class="tck">○</span> other sport &nbsp; <span class="tck pz">▒</span> sick, injured or a break. A day counts only if something was logged for it.</p></div>';
  }

  /* Nutrition is shown when it is known: meals Claude or you logged. Nothing is estimated. */
  function nutrition(M) {
    var meals = (M.raw.meals || []), iso = function (d) { return d.getFullYear() + "-" + H.pad2(d.getMonth() + 1) + "-" + H.pad2(d.getDate()); }, today = iso(M.now), T = M.T;
    var day = function (d) { var list = meals.filter(function (m) { return String(m.date).slice(0, 10) === d; }), p = 0, c = 0, hasC = false; list.forEach(function (m) { p += +m.protein_g || 0; if (m.calories != null) { c += +m.calories; hasC = true; } }); return { list: list, protein: Math.round(p), calories: hasC ? c : null }; };
    var burned = T.active_calories != null ? kv([["Active calories burned today", fmt(+T.active_calories) + " kcal"]]) : "";
    if (!meals.length) return '<div class="panel"><p class="empty">Nothing about food is known yet, so nothing is shown or guessed. Tell Claude what you ate, even roughly, and protein and calories appear here.</p>' + burned + "</div>";
    var t = day(today), week = [], mx = 1;
    for (var i = 6; i >= 0; i--) { var d = new Date(M.now); d.setDate(d.getDate() - i); var x = day(iso(d)); week.push({ d: d, protein: x.list.length ? x.protein : null }); if (x.protein > mx) mx = x.protein; }
    var bars = '<div class="nbars" role="img" aria-label="Protein per day, last 7 days">' + week.map(function (w) { return '<div class="nbar"><i style="height:' + (w.protein == null ? 0 : Math.max(4, Math.round(w.protein / mx * 100))) + '%"></i><b>' + (w.protein == null ? "–" : w.protein) + "</b><span>" + wday(w.d) + "</span></div>"; }).join("") + "</div>";
    var list = t.list.length ? '<ul class="nl">' + t.list.map(function (m) { return "<li><time>" + (m.time_of_day ? String(m.time_of_day).slice(0, 5) + " · " : "") + esc(m.label || "meal") + (m.planned === false ? " · unplanned" : "") + "</time>" + esc(m.description || "No description") + " · " + Math.round(+m.protein_g || 0) + " g protein" + (m.calories != null ? " · " + m.calories + " kcal" : "") + "</li>"; }).join("") + "</ul>" : '<p class="empty">Nothing logged for today yet.</p>';
    return '<div class="nutri"><div class="panel"><p class="lab">Today</p><p class="num-m"><span>' + (t.list.length ? t.protein : "–") + '</span><small>g protein</small></p><p class="sub">' + (t.calories != null ? fmt(t.calories) + " kcal logged" : "Calories not logged") + "</p>" + burned + '</div><div class="panel"><p class="lab">Today’s meals</p>' + list + '</div><div class="panel"><p class="lab">Protein, last 7 days (g)</p>' + bars + '<p class="hint">Days without a bar had nothing logged. They are not counted as zero.</p></div></div>';
  }
  function extras(M) {
    var T = M.T, more = [];
    if (T.vo2_max != null) more.push(["VO₂ max", T.vo2_max]); if (T.training_readiness != null) more.push(["Training readiness (watch)", T.training_readiness]); if (T.active_calories != null) more.push(["Active calories", fmt(+T.active_calories) + " kcal"]);
    var block = function (title, inner) { return '<div class="xblock"><h3 class="xh">' + title + "</h3>" + inner + "</div>"; };
    return block("Body and weight", comp(M)) + (more.length ? block("Other readings from the watch", '<div class="panel">' + kv(more) + "</div>") : "") + block("Today so far", day(M)) + block("Notes and status", notes(M));
  }

  function training(M) {
    var n = M.cfg.perWeek, done = M.weekDone, dots = ""; for (var i = 0; i < n; i++) dots += '<i class="' + (i < done ? "done" : i === done && !M.paused ? "next" : "") + '"></i>';
    var sub = M.paused ? "Paused while you're " + (M.current.status === "break" ? "on a break" : M.current.status) + ". Nothing to catch up on." : done >= n ? "Week complete." : M.sessions.length ? "Last week was " + M.lastWeekDone + " of " + n + "." : "Nothing logged yet.";
    var l = M.last, swim = l ? M.acts.filter(function (a) { return a.type === "swim" && H.dayDiff(a.d, l.d) === 0; })[0] : null;
    var last = l ? '<p class="lab">Last session · ' + wd(l.d) + '</p><p class="big-s">' + esc(l.routine) + "</p>" + kv([["Time", l.mins == null ? "–" : l.mins + " min"], ["Volume", l.vol == null ? "–" : fmt(l.vol) + " kg"], ["PRs", l.prs == null ? "–" : l.prs], ["Swim", swim && swim.dist ? fmt(swim.dist) + " m" : "–"]]) : '<p class="lab">Last session</p><p class="empty">No sessions logged yet. Once Claude syncs Hevy, they appear here.</p>';
    var prs = M.prs.length ? '<ul class="prs">' + M.prs.map(function (p) { return "<li><span>" + esc(p.name) + "</span><b>" + kg(p.w) + (p.reps ? " × " + p.reps : "") + "</b><i>" + wd(p.d) + "</i></li>"; }).join("") + "</ul>" : '<p class="empty">No PRs flagged yet.</p>';
    var lifts = M.lifts.length ? '<div class="lifts">' + M.lifts.map(function (x) { var v = x.v, df = Math.round((v[v.length - 1] - v[0]) * 10) / 10; return '<div class="lift"><span>' + esc(x.name) + "</span><b>" + kg(v[v.length - 1]) + "</b><em>" + (v.length < 2 ? "first session" : (df > 0 ? "+" : "") + df + " kg in " + v.length + " sessions") + "</em>" + (v.length > 1 ? H.spark(v) : "") + "</div>"; }).join("") + "</div>" : '<p class="empty">Top sets appear after the first synced session.</p>';
    return '<div class="tr-grid"><div class="tr-week"><p class="lab">This week</p><div class="dots" role="img" aria-label="' + done + " of " + n + ' sessions this week">' + dots + '</div><p class="big-s">' + done + " of " + n + '</p><p class="sub">' + sub + '</p></div><div class="tr-last">' + last + '</div><div class="tr-vol"><p class="lab">Volume per week</p>' + H.volumeBars(M.volume) + '</div><div class="tr-pr"><p class="lab">Recent PRs</p>' + prs + '</div><div class="tr-lifts"><p class="lab">Top set over time</p>' + lifts + "</div></div>";
  }

  function comp(M) {
    var w = M.weight, m = M.weightMA, have = w.filter(function (x) { return x != null; });
    if (!have.length) return '<div class="comp"><p class="empty">No weigh-ins yet. Tell Claude your weight and it shows up here, with a 7-day average so daily swings don’t mislead.</p></div>';
    var mi = 89; while (mi > 82 && m[mi] == null) mi--; var mnow = m[mi], latest = have[have.length - 1], m30 = m[59], lab = mnow != null ? "7-day average" : "Latest reading", v = mnow != null ? mnow : latest;
    var sub = mnow != null && m30 != null ? (Math.abs(mnow - m30) < 0.15 ? "Steady" : mnow < m30 ? "Down " + (m30 - mnow).toFixed(1) + " kg" : "Up " + (mnow - m30).toFixed(1) + " kg") + " over 30 days. Daily swings of 1–2 kg are normal." : "A 7-day average needs at least three weigh-ins in a week. Daily swings of 1–2 kg are normal.";
    var other = Object.keys(M.otherMetrics).map(function (k) { var o = M.otherMetrics[k]; return [({ body_fat_pct: "Body fat", muscle_mass_kg: "Muscle", waist_cm: "Waist" }[k] || k), o.v + ({ body_fat_pct: " %", muscle_mass_kg: " kg", waist_cm: " cm" }[k] || "") + " · " + dstr(o.d)]; });
    return '<div class="comp"><div><p class="lab">' + lab + '</p><p class="num-m"><span>' + v.toFixed(1) + "</span><small>kg</small></p><p class=\"sub\">" + sub + "</p>" + (other.length ? kv(other) : "") + "</div>" +
      H.trend(w.slice(-60), M.days.slice(-60).map(function (x) { return x.d; }), { smooth: m.slice(-60), dots: true, dec: 1, unit: "kg", periods: M.periods, label: "Weight, daily points and 7-day average, last 60 days", empty: "One weigh-in so far. The trend appears with the second." }) + "</div>";
  }

  function day(M) {
    var T = M.T, blocks = [], parts = [], nowH = hours(M.now);
    if (T.bed_time && T.wake_time) { var b = hm(T.bed_time) / 60, wk = hm(T.wake_time) / 60; blocks.push({ from: b > wk ? 0 : b, to: wk, cls: "sleep", label: "Sleep " + H.dur(T.sleep_minutes), title: "Sleep " + clock(T.bed_time) + "–" + clock(T.wake_time) }); parts.push("slept " + clock(T.bed_time) + " to " + clock(T.wake_time)); }
    M.acts.forEach(function (a) { if (H.dayDiff(M.now, a.d) !== 0 || !a.at) return; var h0 = hours(a.at), lab = a.name + (a.mins ? " " + Math.round(a.mins) + " min" : ""); blocks.push({ from: h0, to: h0 + (a.mins || 10) / 60, cls: "act", label: lab }); parts.push(lab); });
    M.sessions.forEach(function (s) { if (s.ago !== 0 || !s.at) return; var h0 = hours(s.at); blocks.push({ from: h0, to: h0 + (s.mins || 60) / 60, cls: "lift", label: s.routine }); parts.push(s.routine); });
    blocks.sort(function (x, y) { return x.from - y.from; });
    if (!blocks.length && !(T.body_battery_curve && T.body_battery_curve.length > 1)) return '<div class="panel"><p class="empty">Nothing recorded for today yet. Sleep, activities and Body Battery land here after the next sync.</p></div>';
    return H.timeline(blocks, T.body_battery_curve, nowH, "Today so far: " + (parts.join(", ") || "Body Battery only"));
  }

  function notes(M) {
    var per = M.periods.slice().reverse().slice(0, 5), names = { sick: "Sick", injured: "Injured", "break": "Break" };
    var log = per.length ? per.map(function (p) { return "<li><time>" + dstr(p.from) + (p.to ? (+p.to === +p.from ? "" : " – " + dstr(p.to)) : " – ongoing") + "</time>" + names[p.status] + ". " + esc(p.note || "Targets paused.") + "</li>"; }).join("") : '<li class="empty">No sick days, injuries or breaks logged.</li>';
    var flags = M.flags.length ? M.flags.map(function (f) { return "<li><time>" + (f.since ? "Since " + dstr(f.since) : "Flag") + "</time>" + ic(f.s) + esc(f.label) + ": " + f.word.toLowerCase() + "." + (f.note ? " " + esc(f.note) : "") + "</li>"; }).join("") : '<li class="empty">No flags. Tell Claude if something aches and it is tracked here.</li>';
    var gaps = []; M.days.slice(-14, -1).reverse().forEach(function (x) { if (!x.r) gaps.push([x.d, "no data at all"]); else if (x.r.sleep_score == null) gaps.push([x.d, "no sleep data"]); });
    var gl = gaps.length ? gaps.slice(0, 5).map(function (g) { return "<li><time>" + wd(g[0]) + "</time>" + g[1] + "</li>"; }).join("") + (gaps.length > 5 ? '<li class="empty">and ' + (gaps.length - 5) + " more</li>" : "") : '<li class="empty">No gaps in the last two weeks.</li>';
    return '<div class="notes"><div><p class="lab">Status log</p><ul class="nl">' + log + '</ul></div><div><p class="lab">Flags</p><ul class="nl">' + flags + '</ul></div><div><p class="lab">Data gaps</p><ul class="nl">' + gl + '</ul><p class="hint">Gaps are left empty and never filled with zeros.</p></div></div>';
  }

  /* pieces the overview and detail views (today.js) reuse */
  H.pillarsHTML = pillars; H.contribHTML = contrib; H.planHTML = plan; H.trainingHTML = training; H.nutritionHTML = nutrition; H.extrasHTML = extras;
  H.layerControls = function () {
    return '<div class="controls"><div class="seg" role="group" aria-label="Body layer">' + [["recovery", "Recovery"], ["week", "Week"], ["vitals", "Vitals"], ["flags", "Pains"]].map(function (l) { return '<button class="chip-l" data-l="' + l[0] + '" aria-pressed="false">' + l[1] + "</button>"; }).join("") +
      '</div><div class="seg" role="group" aria-label="View"><button class="chip-v" data-v="front" aria-pressed="true">Front</button><button class="chip-v" data-v="back" aria-pressed="false">Back</button></div></div><div id="legend" class="legend"></div><details class="listview"><summary>Read the body as a list</summary><ul id="a11y"></ul></details><div id="pop" class="pop" role="status" hidden></div>';
  };
  H.figureHTML = function (M) { return '<div class="figure">' + halo(M) + '<div class="breath"><div id="flipper"><div id="faceF" class="face"></div><div id="faceB" class="face"></div></div></div></div>'; };
  /* Concept A: Today beside the body and a row of tiles; everything else one click deeper. */
  H.pageHTML = function (M, ui) {
    ui = ui || {};
    var ribbon = M.sample ? '<div class="sample" role="note"><b>SAMPLE DATA</b> · ' + (M.missing.length ? "the health tables are not set up yet (run migration_health_v2.sql)" : "no health data has been synced yet") + " · nothing below is yours</div>" : "";
    var foot = '<footer class="foot"><p>These are wellness signals from your watch and training log, not medical advice.</p>' + (M.unmapped.length ? "<p>Not yet mapped to a muscle, so missing from the body figure: " + esc(M.unmapped.join(", ")) + ".</p>" : "") +
      '<p>Body figure adapted from <a href="https://github.com/vulovix/body-muscles" target="_blank" rel="noopener">body-muscles</a> by Ivan Vulović, Apache-2.0. Exercise pictures from <a href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noopener">free-exercise-db</a>, public domain.</p></footer>';
    if (!ui.legacy) return ribbon + '<div class="wrap">' + header(M) + (ui.detail ? H.detailHTML(M, ui.detail, ui) : H.overviewHTML(M, ui, H.figureHTML(M))) + foot + '</div><div id="tip" class="tip" hidden></div>';
    return ribbon + '<div class="wrap">' + header(M) + hero(M) + '<div class="rest">' +
      sec("plan", "Today's plan", plan(M)) +
      '<nav class="pnav" aria-label="Pillars">' + [["sleep", "Sleep"], ["workout", "Workout"], ["nutrition", "Nutrition"], ["vitals", "Vitals"], ["extras", "Extras"]].map(function (p, i) { return '<button data-go="' + p[0] + '"><b>' + (i + 1) + "</b>" + p[1] + "</button>"; }).join("") + "</nav>" +
      (function () { var P = pillars(M); return psec("sleep", 1, "Sleep", '<div class="pillars solo">' + P.sleep + "</div>", "Target: asleep by " + esc(M.cfg.bed)) +
        psec("workout", 2, "Workout", trainCal(M) + '<div style="height:12px"></div>' + training(M) + '<div class="pillars solo" style="margin-top:12px">' + P.move + "</div>", esc(M.cfg.rotation.join(" → ")) + " · " + M.cfg.perWeek + " times a week") +
        psec("nutrition", 3, "Nutrition", nutrition(M), "Shown when it is known") +
        psec("vitals", 4, "Vitals", '<div class="pillars solo">' + P.vitals + "</div>", "Resting heart rate, HRV, Body Battery, stress") +
        psec("extras", 5, "Extras", extras(M), "Everything else: weight, the day so far, notes, flags and gaps"); })() +
      '<footer class="foot"><p>These are wellness signals from your watch and training log, not medical advice.</p>' + (M.unmapped.length ? "<p>Not yet mapped to a muscle, so missing from the body figure: " + esc(M.unmapped.join(", ")) + ".</p>" : "") +
      '<p>Body figure adapted from <a href="https://github.com/vulovix/body-muscles" target="_blank" rel="noopener">body-muscles</a> by Ivan Vulović, Apache-2.0.</p></footer></div></div><div id="tip" class="tip" hidden></div>';
  };
})();
