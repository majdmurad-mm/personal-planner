/* Health page, part 1 of 3: helpers, loading, the SAMPLE generator and the calculations.
   Nothing in here touches the DOM. Missing values stay null and are never treated as zero. */
(function () {
  var H = window.PPH = window.PPH || {};
  var clamp = H.clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var pad2 = H.pad2 = function (n) { return String(n).padStart(2, "0"); };
  var iso = H.iso = function (d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); };
  var pd = H.pd = function (s) { var p = String(s).slice(0, 10).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); };
  var addDays = H.addDays = function (d, n) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); return x; };
  var dayDiff = H.dayDiff = function (a, b) { return Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(b.getFullYear(), b.getMonth(), b.getDate())) / 864e5); };
  H.dstr = function (d) { return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
  var wday = H.wday = function (d) { return d.toLocaleDateString("en-GB", { weekday: "short" }); };
  H.fmt = function (n) { return n == null || isNaN(n) ? "–" : Math.round(n).toLocaleString("en-GB"); };
  H.esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var hm = H.hm = function (t) { if (!t) return null; var p = String(t).split(":"); return +p[0] * 60 + +p[1]; };
  H.clock = function (t) { return t ? String(t).slice(0, 5) : "–"; };
  H.dur = function (m) { return m == null ? "–" : Math.floor(m / 60) + "h " + pad2(Math.round(m % 60)); };
  var num = function (v) { return v == null || v === "" || isNaN(+v) ? null : +v; };
  var vals = function (a) { return a.filter(function (x) { return x != null; }); };
  var med = H.med = function (a) { a = vals(a).sort(function (x, y) { return x - y; }); var n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null; };
  var quant = function (a, p) { a = vals(a).sort(function (x, y) { return x - y; }); if (!a.length) return null; var i = (a.length - 1) * p, l = Math.floor(i), h = Math.ceil(i); return a[l] + (a[h] - a[l]) * (i - l); };
  var avg = H.avg = function (a) { a = vals(a); return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; };

  H.MUSCLES = { chest: "Chest", shoulders: "Shoulders", rear: "Rear delts", traps: "Traps", lats: "Lats & upper back", lower_back: "Lower back", biceps: "Biceps", triceps: "Triceps", forearms: "Forearms", abs: "Abs", obliques: "Obliques", quads: "Quads", hamstrings: "Hamstrings", glutes: "Glutes", adductors: "Adductors", calves: "Calves" };
  /* Built-in fallback for the machines in the rotation; exercise_muscle_map rows win over it. */
  var EX = { "incline chest press": ["chest", ["shoulders", "triceps"]], "chest press": ["chest", ["triceps", "shoulders"]], "lat pulldown": ["lats", ["biceps"]], "shoulder press": ["shoulders", ["triceps"]], "leg press": ["quads", ["glutes", "hamstrings"]],
    "bicep curl": ["biceps", []], "ab crunch": ["abs", []], "crunch": ["abs", []], "seated row": ["lats", ["biceps", "rear"]], "lateral raise": ["shoulders", []], "leg curl": ["hamstrings", []], "triceps extension": ["triceps", []],
    "back extension": ["lower_back", ["glutes"]], "reverse butterfly": ["rear", ["traps"]], "reverse fly": ["rear", ["traps"]], "butterfly": ["chest", []], "pec deck": ["chest", []], "leg extension": ["quads", []], "hip thrust": ["glutes", ["hamstrings"]] };
  var EXK = Object.keys(EX);
  H.STATUS = { good: { label: "Fresh", word: "Recovered", icon: "●" }, watch: { label: "Recovering", word: "Take note", icon: "◐" }, low: { label: "Worked hard", word: "Strained", icon: "▲" }, none: { label: "No data", word: "No data", icon: "○" } };
  var st = H.st = function (s) { return s == null ? "none" : s >= 70 ? "good" : s >= 45 ? "watch" : "low"; };
  var DECAY = [1, 0.7, 0.4, 0.2, 0];
  H.loadSt = function (l) { return l >= 3.5 ? "low" : l >= 1 ? "watch" : "good"; };
  var ROT = ["Full Body A", "Full Body B", "Full Body C"];

  /* ---------- loading ---------- */
  var MISSING = { "42P01": 1, PGRST205: 1 };
  H.load = function (sb, userId, now) {
    var since = function (n) { return iso(addDays(now, -n)); }, missing = [];
    var run = function (name, q) { return q.then(function (r) { if (r.error) { if (MISSING[r.error.code]) { missing.push(name); return []; } throw r.error; } return r.data || []; }); };
    var t = function (name) { return sb.from(name).select("*").eq("user_id", userId); };
    return Promise.all([
      run("health_daily", t("health_daily").is("archived_at", null).gte("date", since(90)).order("date")),
      run("workouts", t("workouts").is("archived_at", null).gte("date", since(150)).order("date")),
      run("exercise_muscle_map", t("exercise_muscle_map")),
      run("activities", t("activities").is("archived_at", null).gte("date", since(90)).order("date")),
      run("body_metrics", t("body_metrics").is("archived_at", null).gte("date", since(120)).order("date")),
      run("health_status", t("health_status").is("archived_at", null).order("start_date")),
      run("health_flags", t("health_flags").is("archived_at", null)),
      run("health_briefs", t("health_briefs").is("archived_at", null).order("date", { ascending: false }).limit(3)),
      run("health_settings", t("health_settings").limit(1))
    ]).then(function (r) {
      var raw = { daily: r[0], workouts: r[1], sets: [], muscleMap: r[2], activities: r[3], metrics: r[4], status: r[5], flags: r[6], briefs: r[7], settings: r[8][0] || null, missingTables: missing };
      var ids = raw.workouts.map(function (w) { return w.id; }), chunks = [];
      for (var i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
      return Promise.all(chunks.map(function (c) { return run("workout_sets", sb.from("workout_sets").select("*").in("workout_id", c).is("superseded_at", null)); })).then(function (parts) {
        parts.forEach(function (p) { raw.sets = raw.sets.concat(p); });
        raw.empty = !raw.daily.length && !raw.workouts.length && !raw.metrics.length && !raw.activities.length;
        return raw;
      });
    });
  };

  /* ---------- SAMPLE data: invented, generated relative to today, never written anywhere ---------- */
  H.sample = function (now) {
    var seed = 4217, rnd = function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }, noise = function (a) { return (rnd() + rnd() - 1) * a; };
    var raw = { daily: [], workouts: [], sets: [], muscleMap: [], activities: [], metrics: [], status: [], flags: [], briefs: [], settings: null, missingTables: [], sample: true };
    var sickFrom = 29, sickTo = 24, beds = ["01:20", "01:55", "00:50", "02:10", "01:35", "01:42", "00:58"];
    for (var i = 89; i >= 0; i--) {
      var d = addDays(now, -i), sick = i <= sickFrom && i >= sickTo, worn = i !== 4, mins = Math.round(408 + noise(45) - (sick ? 20 : 0)), bed = beds[i % 7];
      var wake = hm(bed) + mins + 22, row = { date: iso(d), source: "sample",
        sleep_score: worn ? Math.round(clamp(72 + noise(10) - (sick ? 12 : 0), 30, 96)) : null, sleep_minutes: worn ? mins : null, bed_time: worn ? bed : null, wake_time: worn ? pad2(Math.floor(wake / 60) % 24) + ":" + pad2(wake % 60) : null,
        deep_minutes: worn ? Math.round(mins * 0.15) : null, light_minutes: worn ? Math.round(mins * 0.56) : null, rem_minutes: worn ? Math.round(mins * 0.24) : null, awake_minutes: worn ? 22 : null,
        resting_hr: Math.round(60 + noise(2.4) + (sick ? 6 : 0)), hrv_avg: worn ? Math.round(44 + noise(5) - (sick ? 11 : 0)) : null, hrv_status: worn ? "balanced" : null,
        body_battery_high: Math.round(clamp(72 + noise(12) - (sick ? 26 : 0), 20, 100)), body_battery_low: Math.round(30 + noise(8)), stress_avg: Math.round(33 + noise(7) + (sick ? 9 : 0)),
        steps: Math.round((4300 + noise(1800)) * (sick ? 0.3 : 1)), steps_goal: 3500, intensity_minutes: sick ? 0 : Math.round(clamp(14 + noise(16), 0, 60)), training_readiness: Math.round(clamp(70 + noise(14) - (sick ? 30 : 0), 5, 99)) };
      if (i === 0) {
        var hNow = now.getHours() + now.getMinutes() / 60, curve = [[0, 41], [2, 34], [4, 46], [6, 62], [8.5, 78], [10, 71], [13, 62], [16, 51], [19, 40], [22, 31]].filter(function (p) { return p[0] <= hNow; });
        row.body_battery_curve = curve; row.body_battery_now = curve.length ? curve[curve.length - 1][1] : 41; row.body_battery_high = Math.max.apply(0, curve.map(function (p) { return p[1]; }).concat(41));
        row.sleep_score = 74; row.resting_hr = 57; row.hrv_avg = 47; row.stress_avg = 22; row.steps = Math.round(1240 * clamp(hNow / 10, 0.2, 4)); row.intensity_minutes = 0; row.training_readiness = 74;
        row.synced_at = new Date(now.getTime() - 9 * 6e4).toISOString();
      }
      raw.daily.push(row);
      if (rnd() < 0.72 || i === 0) raw.metrics.push({ date: iso(d), metric: "weight_kg", value: +(101.6 - (89 - i) * 0.012 + noise(0.8)).toFixed(1), source: "sample" });
    }
    var R = { "Full Body A": [["Chest press", 47.5], ["Lat pulldown", 50], ["Shoulder press", 30], ["Leg press", 110], ["Bicep curl", 20], ["Ab crunch", 37.5]],
      "Full Body B": [["Incline chest press", 37.5], ["Seated row", 47.5], ["Lateral raise", 10], ["Leg curl", 40], ["Triceps extension", 25], ["Back extension", 27.5], ["Lat pulldown", 50]],
      "Full Body C": [["Butterfly", 42.5], ["Reverse butterfly", 32.5], ["Shoulder press", 30], ["Leg extension", 50], ["Hip thrust", 65], ["Ab crunch", 37.5]] };
    var cur = {}, best = {}, n = 0;
    for (var a = 56; a >= 1; a--) {
      if ([0, 1, 4].indexOf(a % 7) < 0 || (a <= sickFrom + 1 && a >= sickTo - 2)) continue;
      var day = addDays(now, -a), routine = ROT[n % 3], id = "sample-w" + n, vol = 0, prs = 0, start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 18, 30);
      R[routine].forEach(function (e, ei) {
        var w = cur[e[0]] == null ? e[1] : cur[e[0]], allTop = true;
        for (var s = 0; s < 3; s++) {
          var reps = Math.round(clamp(11.9 + noise(1.4) - s * 0.35, 8, 12)); if (reps < 12) allTop = false;
          var pr = best[e[0]] != null && w > best[e[0]] && s === 0; if (pr) prs++;
          raw.sets.push({ workout_id: id, exercise_index: ei, set_index: s, exercise: e[0], set_type: "normal", weight_kg: w, reps: reps, is_pr: pr }); vol += w * reps;
        }
        best[e[0]] = Math.max(best[e[0]] || 0, w); cur[e[0]] = allTop ? w + 2.5 : w;
      });
      raw.workouts.push({ id: id, source: "sample", source_id: id, date: iso(day), started_at: start.toISOString(), duration_minutes: Math.round(70 + noise(6)), routine: routine, title: routine, volume_kg: vol, pr_count: prs });
      raw.activities.push({ source: "sample", source_id: id + "-swim", date: iso(day), started_at: new Date(start.getTime() + 78 * 6e4).toISOString(), type: "swim", name: "Pool swim", duration_minutes: 9, distance_m: 200 + 25 * (n % 3) });
      raw.activities.push({ source: "sample", source_id: id + "-sauna", date: iso(day), started_at: new Date(start.getTime() + 95 * 6e4).toISOString(), type: "sauna", name: "Sauna", duration_minutes: 12 });
      n++;
    }
    if (now.getHours() >= 9) raw.activities.push({ source: "sample", source_id: "sample-walk", date: iso(now), started_at: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 50).toISOString(), type: "walk", name: "Morning walk", duration_minutes: 22, distance_m: 1700 });
    raw.status.push({ status: "sick", start_date: iso(addDays(now, -sickFrom)), end_date: iso(addDays(now, -sickTo)), note: "Cold. Targets paused." });
    raw.flags.push({ region: "lower_back", state: "recovering", note: "Sore in early autumn, improving and cleared to train.", since: iso(addDays(now, -42)) });
    raw.briefs.push({ date: iso(now), written_by: "claude", updated_at: new Date(now.getTime() - 8 * 6e4).toISOString(), headline: null, summary: null,
      recommendations: [{ kind: "move", title: "5,000 steps", why: "Your week averaged a little over 4,000. A 20-minute walk after lunch covers most of the gap." }, { kind: "sleep", title: "In bed by 00:30", why: "Bedtimes have drifted past 01:30. An hour earlier is plenty for now." }], next_session: null });
    return raw;
  };

  /* ---------- the model: everything the page shows, computed from the raw rows ---------- */
  H.build = function (raw, now) {
    var S = raw.settings || {}, M = { raw: raw, now: now, sample: !!raw.sample, missing: raw.missingTables || [] };
    var cfg = M.cfg = { steps: num(S.steps_target), perWeek: num(S.strength_target_per_week) || 3, bed: S.bedtime_target ? String(S.bedtime_target).slice(0, 5) : "00:30", intensity: num(S.intensity_target) || 150,
      rotation: S.rotation && S.rotation.length ? S.rotation : ROT, repTop: num(S.rep_top) || 12, step: num(S.weight_step_kg) || 2.5 };
    var byDate = {}; raw.daily.forEach(function (r) { byDate[String(r.date).slice(0, 10)] = r; });
    M.days = []; for (var i = 89; i >= 0; i--) { var d = addDays(now, -i); M.days.push({ d: d, iso: iso(d), r: byDate[iso(d)] || null }); }
    M.col = function (k, n) { return M.days.slice(-(n || 90)).map(function (x) { return x.r ? num(x.r[k]) : null; }); };
    var T = M.T = M.days[89].r || {}, Y = M.Y = M.days[88].r || {};
    M.hasToday = !!M.days[89].r;
    cfg.stepsGoal = cfg.steps || num(T.steps_goal) || 3500;
    M.base = function (k) { var a = vals(M.col(k).slice(-31, -1)); return a.length >= 5 ? { med: med(a), lo: quant(a, 0.25), hi: quant(a, 0.75), n: a.length } : null; };
    var B = M.B = {}; ["sleep_score", "resting_hr", "hrv_avg", "steps", "body_battery_high", "stress_avg"].forEach(function (k) { B[k] = M.base(k); });

    /* status periods */
    var todayIso = iso(now);
    M.periods = raw.status.map(function (p) { return { status: p.status, from: pd(p.start_date), to: p.end_date ? pd(p.end_date) : null, note: p.note }; });
    M.current = M.periods.filter(function (p) { return iso(p.from) <= todayIso && (!p.to || iso(p.to) >= todayIso); })[0] || null;
    M.paused = !!M.current;

    /* readiness: weighted, re-weighted over the inputs that arrived */
    var rel = function (v, b, word, unit) { if (v == null) return "no reading today"; if (!b) return "still learning your baseline"; var df = Math.round(v - b.med); return df === 0 ? "right at your usual " + Math.round(b.med) : Math.abs(df) + (unit || "") + (df > 0 ? " above" : " below") + " your usual " + Math.round(b.med); };
    var rhr = num(T.resting_hr), hrv = num(T.hrv_avg), sl = num(T.sleep_score), bb = num(T.body_battery_high), ys = num(Y.stress_avg);
    M.contrib = [
      { key: "sleep", name: "Sleep", w: 30, score: sl, val: sl, unit: "", note: rel(sl, B.sleep_score) },
      { key: "rhr", name: "Resting heart rate", w: 25, score: rhr != null && B.resting_hr ? clamp(75 + (B.resting_hr.med - rhr) * 6, 0, 100) : null, val: rhr, unit: "bpm", note: rel(rhr, B.resting_hr) },
      { key: "hrv", name: "HRV", w: 20, score: hrv != null && B.hrv_avg ? clamp(75 + (hrv - B.hrv_avg.med) / B.hrv_avg.med * 150, 0, 100) : null, val: hrv, unit: "ms", note: hrv != null && B.hrv_avg ? (hrv >= B.hrv_avg.lo && hrv <= B.hrv_avg.hi ? "within your usual range" : rel(hrv, B.hrv_avg)) : rel(hrv, B.hrv_avg) },
      { key: "bb", name: "Morning Body Battery", w: 15, score: bb, val: bb, unit: "", note: bb == null ? "no reading today" : bb >= 70 ? "charged well overnight" : bb >= 45 ? "partly charged overnight" : "low charge overnight" },
      { key: "stress", name: "Yesterday's stress", w: 10, score: ys == null ? null : 100 - ys, val: ys, unit: "avg", note: ys == null ? "no reading yesterday" : ys < 30 ? "calm day" : ys < 50 ? "ordinary day" : "a demanding day" }
    ];
    var have = M.contrib.filter(function (c) { return c.score != null; }), wsum = have.reduce(function (s, c) { return s + c.w; }, 0);
    M.ready = wsum >= 45 ? Math.round(have.reduce(function (s, c) { return s + c.score * c.w; }, 0) / wsum) : null;
    M.missingInputs = M.contrib.filter(function (c) { return c.score == null; }).map(function (c) { return c.name; });
    M.garmin = num(T.training_readiness);

    /* sessions */
    var mm = {}; raw.muscleMap.forEach(function (r) { mm[String(r.exercise_key).toLowerCase()] = [r.primary_muscle, r.secondary_muscles || []]; });
    M.musclesOf = function (name) { var k = String(name).toLowerCase().trim(); if (mm[k]) return mm[k]; for (var j = 0; j < EXK.length; j++) if (k.indexOf(EXK[j]) >= 0) return EX[EXK[j]]; return null; };
    var setsBy = {}; raw.sets.forEach(function (s) { (setsBy[s.workout_id] = setsBy[s.workout_id] || []).push(s); });
    M.sessions = raw.workouts.map(function (w) {
      var d = pd(w.date), ex = [], idx = {};
      (setsBy[w.id] || []).sort(function (a, b) { return a.exercise_index - b.exercise_index || a.set_index - b.set_index; }).forEach(function (s) {
        var e = idx[s.exercise_index]; if (!e) { e = idx[s.exercise_index] = { name: s.exercise, sets: [], work: [] }; ex.push(e); }
        e.sets.push(s); if (s.set_type !== "warmup") e.work.push(s);
      });
      ex.forEach(function (e) { var ws = vals(e.work.map(function (s) { return num(s.weight_kg); })); e.top = ws.length ? Math.max.apply(0, ws) : null; e.topReps = e.top == null ? null : Math.max.apply(0, e.work.filter(function (s) { return num(s.weight_kg) === e.top; }).map(function (s) { return num(s.reps) || 0; })); });
      return { w: w, d: d, ago: dayDiff(now, d), routine: w.routine || w.title || "Workout", ex: ex, vol: num(w.volume_kg), prs: num(w.pr_count), mins: num(w.duration_minutes), at: w.started_at ? new Date(w.started_at) : null };
    }).filter(function (s) { return s.ago >= 0; }).sort(function (a, b) { return a.d - b.d || ((a.at || 0) - (b.at || 0)); });
    M.last = M.sessions[M.sessions.length - 1] || null;
    M.trainedToday = !!M.last && M.last.ago === 0;

    /* muscle load (recovery layer) and sets in the last 7 days (week layer) */
    var LOAD = M.LOAD = {}, WEEK = M.WEEK = {}, DRIVER = M.DRIVER = {}; M.unmapped = [];
    Object.keys(H.MUSCLES).forEach(function (m) { LOAD[m] = 0; WEEK[m] = 0; });
    M.sessions.forEach(function (s) {
      if (s.ago > 6) return; var f = DECAY[s.ago] || 0;
      s.ex.forEach(function (e) {
        var map = M.musclesOf(e.name), n = e.work.length; if (!map) { if (M.unmapped.indexOf(e.name) < 0) M.unmapped.push(e.name); return; }
        var add = function (m, w) { if (LOAD[m] == null) return; LOAD[m] += n * w * f; WEEK[m] += n * w; if (f && w === 1) { var o = DRIVER[m] = DRIVER[m] || { sets: 0, top: null, day: wday(s.d), ago: s.ago }; o.sets += n; if (e.top != null) o.top = Math.max(o.top || 0, e.top); if (s.ago < o.ago) { o.ago = s.ago; o.day = wday(s.d); } } };
        add(map[0], 1); (map[1] || []).forEach(function (m) { add(m, 0.5); });
      });
    });
    M.readyDay = function (m) { var o = DRIVER[m]; if (!o) return "now"; var sets = LOAD[m] / (DECAY[o.ago] || 1); for (var n = 1; n < 6; n++) if (sets * (DECAY[o.ago + n] || 0) < 1) return wday(addDays(now, n)); return "soon"; };

    /* next session and its targets */
    var rot = cfg.rotation, lastIdx = -1;
    for (var k = M.sessions.length - 1; k >= 0 && lastIdx < 0; k--) lastIdx = rot.indexOf(M.sessions[k].routine);
    var brief = M.brief = raw.briefs.filter(function (b) { return String(b.date).slice(0, 10) === todayIso; })[0] || null;
    M.lastBrief = raw.briefs[0] || null;
    var bn = brief && brief.next_session;
    M.next = (bn && bn.routine) || rot[(lastIdx + 1) % rot.length];
    M.targets = [];
    if (bn && bn.targets && bn.targets.length) M.targets = bn.targets.map(function (t) { var w = num(t.weightKg != null ? t.weightKg : t.weight_kg), lw = num(t.lastWeightKg != null ? t.lastWeightKg : t.last_weight_kg); return { name: t.exercise, weight: w, last: lw, reps: t.reps, up: t.change ? /up|add|increase|\+/i.test(t.change) : (w != null && lw != null && w > lw), change: t.change }; });
    else { var prev = M.sessions.filter(function (s) { return s.routine === M.next; }).pop();
      if (prev) M.targets = prev.ex.filter(function (e) { return e.top != null; }).map(function (e) { var all = e.work.length > 0 && e.work.every(function (s) { return (num(s.reps) || 0) >= cfg.repTop; }); return { name: e.name, weight: all ? e.top + cfg.step : e.top, last: e.top, up: all }; });
      M.targetsFrom = prev ? prev.d : null; }

    /* training week (Monday-based), volume, PRs, top sets */
    var monday = addDays(now, -((now.getDay() + 6) % 7));
    M.weekDone = M.sessions.filter(function (s) { return s.d >= monday; }).length;
    M.lastWeekDone = M.sessions.filter(function (s) { return s.d >= addDays(monday, -7) && s.d < monday; }).length;
    var sickDay = function (d) { return M.periods.filter(function (p) { return d >= p.from && (!p.to || d <= p.to); })[0] || null; };
    M.statusOn = sickDay;
    M.volume = []; for (var wk = 7; wk >= 0; wk--) { var from = addDays(monday, -7 * wk), to = addDays(from, 7), ss = M.sessions.filter(function (s) { return s.d >= from && s.d < to; }), pz = null;
      for (var dd = 0; dd < 7 && !pz; dd++) pz = sickDay(addDays(from, dd));
      M.volume.push({ from: from, vol: ss.reduce(function (a, s) { return a + (s.vol || 0); }, 0), n: ss.length, paused: pz ? pz.status : null, current: wk === 0 }); }
    M.prs = []; M.sessions.slice().reverse().forEach(function (s) { s.ex.forEach(function (e) { e.sets.forEach(function (x) { if (x.is_pr && M.prs.length < 5) M.prs.push({ d: s.d, name: e.name, w: num(x.weight_kg), reps: num(x.reps) }); }); }); });
    var series = {}; M.sessions.forEach(function (s) { s.ex.forEach(function (e) { if (e.top != null) (series[e.name] = series[e.name] || []).push(e.top); }); });
    M.lifts = Object.keys(series).sort(function (a, b) { return series[b].length - series[a].length; }).slice(0, 4).map(function (n) { return { name: n, v: series[n].slice(-10) }; });

    /* vitals */
    var acts = M.acts = raw.activities.map(function (a) { return { a: a, d: pd(a.date), at: a.started_at ? new Date(a.started_at) : null, type: a.type, name: a.name || a.type, mins: num(a.duration_minutes), dist: num(a.distance_m) }; });
    var intens = M.col("intensity_minutes", 7), haveInt = vals(intens).length;
    M.intensityWeek = haveInt ? vals(intens).reduce(function (a, b) { return a + b; }, 0) : null;
    var heartS = have.filter(function (c) { return c.key === "rhr" || c.key === "hrv"; }), hs = heartS.length ? st(avg(heartS.map(function (c) { return c.score; }))) : "none";
    var cardio = acts.filter(function (a) { return dayDiff(now, a.d) <= 6 && a.type !== "sauna"; });
    var brainIn = vals([sl, ys == null ? null : 100 - ys]), bs = brainIn.length ? st(avg(brainIn)) : "none";
    M.vitals = {
      heart: { s: hs, label: hs === "none" ? "No data" : hs === "good" ? "Steady" : hs === "watch" ? "A little off" : "Under strain", text: (rhr == null ? "No resting heart rate today" : "RHR " + rhr + ", " + rel(rhr, B.resting_hr)) + " · " + (hrv == null ? "no HRV reading" : "HRV " + hrv + " ms" + (T.hrv_status ? ", " + T.hrv_status : "")) },
      lungs: { s: M.intensityWeek == null ? "none" : M.intensityWeek >= cfg.intensity ? "good" : "watch", label: M.intensityWeek == null ? "No data" : M.intensityWeek >= cfg.intensity ? "On target" : "Room to build", text: (M.intensityWeek == null ? "No intensity minutes reported" : M.intensityWeek + " of " + cfg.intensity + " intensity minutes in 7 days") + (cardio.length ? " · " + cardio.length + " cardio session" + (cardio.length > 1 ? "s" : "") : "") + " · VO₂ max " + (num(T.vo2_max) != null ? T.vo2_max : "not reported") },
      brain: { s: bs, label: bs === "none" ? "No data" : bs === "good" ? "Rested" : bs === "watch" ? "So-so" : "Run down", text: (sl == null ? "No sleep score" : "Sleep score " + sl) + " · " + (ys == null ? "no stress reading yesterday" : "yesterday's stress " + ys) }
    };
    M.energy = num(T.body_battery_now) != null ? num(T.body_battery_now) : bb;

    /* flags */
    var REG = { lower_back: ["back", 52.85, 37.2, "Lower back"], upper_back: ["back", 52.85, 24, "Upper back"], neck: ["back", 52.85, 14.5, "Neck"], shoulder: ["front", 9.5, 18.8, "Shoulder"], elbow: ["front", 6.2, 31.5, "Elbow"], wrist: ["front", 3.6, 42.5, "Wrist"], hip: ["front", 11.5, 44, "Hip"], knee: ["front", 12.2, 63, "Knee"], ankle: ["front", 12.6, 86, "Ankle"] };
    M.flags = raw.flags.map(function (f) {
      var key = String(f.region).toLowerCase(), left = /^left_/.test(key), baseK = key.replace(/^(left|right)_/, ""), g = REG[baseK];
      var label = (left ? "Left " : /^right_/.test(key) ? "Right " : "") + (g ? g[3] : key.replace(/_/g, " ")), lbl = left || /^right_/.test(key) ? label.charAt(0) + label.slice(1).toLowerCase() : label;
      return { region: key, label: lbl, state: f.state, s: f.state === "cleared" ? "good" : "watch", word: f.state === "cleared" ? "Cleared" : f.state === "recovering" ? "Recovering" : "Keep an eye on it", note: f.note || "", since: f.since ? pd(f.since) : null,
        view: g ? g[0] : null, cx: g ? (left && g[0] === "front" ? 31.7 - g[1] : g[1]) : null, cy: g ? g[2] : null };
    });

    /* weight */
    var wBy = {}; raw.metrics.forEach(function (m) { if (m.metric === "weight_kg") wBy[String(m.date).slice(0, 10)] = num(m.value); });
    M.weight = M.days.map(function (x) { return wBy[x.iso] == null ? null : wBy[x.iso]; });
    M.weightMA = M.weight.map(function (_, i) { var a = vals(M.weight.slice(Math.max(0, i - 6), i + 1)); return a.length >= 3 ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; });
    M.otherMetrics = {}; raw.metrics.forEach(function (m) { if (m.metric !== "weight_kg") M.otherMetrics[m.metric] = { v: num(m.value), d: pd(m.date) }; });

    /* steps */
    M.stepsAvg7 = avg(M.col("steps", 8).slice(0, 7));

    /* verdict */
    var good = M.ready != null && M.ready >= 70, trainedY = !!M.last && M.last.ago === 1;
    M.plan = M.paused ? "rest" : M.trainedToday ? "done" : M.ready == null ? "unknown" : M.ready < 45 ? "easy" : trainedY ? "between" : "train";
    M.verdict = brief && brief.headline ? brief.headline
      : M.paused ? "You're marked as " + (M.current.status === "break" ? "on a break" : M.current.status) + ". Rest is the plan, and targets and streaks are paused."
      : M.trainedToday ? "Session done. The rest of today is for recovery."
      : M.ready == null ? "Not enough of today's readings have arrived for a readiness score yet."
      : M.ready < 45 ? "Recovery is low today. An easy day now pays back tomorrow."
      : trainedY ? (good ? "Recovery is strong. You trained yesterday, so a walk is enough today, and " + M.next + " is up next." : "Still recovering from yesterday. A walk is enough today.")
      : good ? "Your recovery is strong. Good day for " + M.next + "." : "Recovery is middling. " + M.next + " is fine if you feel like it, with nothing forced.";
    M.synced = T.synced_at ? new Date(T.synced_at) : null;
    return M;
  };
})();
