/* One day, put together from the planner's own tables. Shared by the Day page (browser) and the connector
   (get_day / get_days), so both always say the same thing. Pure functions: rows in, a day out. Nothing is
   stored; a day is computed fresh every time. Missing values are null (shown as "—"), never 0.
   Day boundaries are Europe/Berlin. Sleep is stored on the morning you wake, so it belongs to that day. */
(function (g) {
  var TZ = "Europe/Berlin", D = {};
  var fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  D.berlinDate = function (ts) { try { return fmt.format(new Date(ts)); } catch (e) { return null; } };
  D.add = function (d, n) { var x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  D.range = function (from, to) { var out = []; for (var d = from; d <= to && out.length < 400; d = D.add(d, 1)) out.push(d); return out; };
  var num = function (v) { return v == null || v === "" || isNaN(+v) ? null : +v; };
  var hhmm = function (t) { return t ? String(t).slice(0, 5) : null; };

  /* When was each task ticked? From the change log: the latest not-done → done change, as a Berlin date.
     Rows: { table_name, row_id, op, before, after, created_at, undone_at }. */
  D.tickDates = function (log) {
    var out = {}, at = {};
    (log || []).forEach(function (r) {
      if (r.table_name !== "actions" || r.op !== "update" || r.undone_at || !r.after) return;
      var was = !!(r.before && r.before.done), is = !!r.after.done; if (was === is) return;
      if (at[r.row_id] && at[r.row_id] > r.created_at) return;
      at[r.row_id] = r.created_at; out[r.row_id] = is ? D.berlinDate(r.created_at) : null;
    });
    Object.keys(out).forEach(function (k) { if (!out[k]) delete out[k]; });
    return out;
  };
  /* Who was contacted when? Each time a person's "last contact" changed: [{ date, name, kind }]. */
  D.contacts = function (log) {
    var seen = {}, out = [];
    (log || []).forEach(function (r) {
      if (r.table_name !== "people" || r.op !== "update" || r.undone_at || !r.after || !r.after.last_contact_at) return;
      if (r.before && r.before.last_contact_at === r.after.last_contact_at) return;
      var d = String(r.after.last_contact_at).slice(0, 10), k = r.row_id + "@" + d; if (seen[k]) return; seen[k] = 1;
      out.push({ date: d, name: r.after.name || "Someone", kind: r.after.last_contact_kind || "other" });
    });
    return out;
  };

  /* Mood, 0–100: an aggregate, never typed in. Notes' sentiment tags, what was said to Claude (Claude's own
     check-in), your check-in, last night's sleep and the day's stress, weighted and averaged over what exists. */
  var VALENCE = { joyful: 95, grateful: 90, motivated: 85, proud: 85, hopeful: 80, calm: 75, reflective: 60, neutral: 50, tired: 35, anxious: 25, stressed: 22, frustrated: 20, sad: 15, angry: 10 };
  D.VALENCE = VALENCE;
  D.mood = function (x) {
    var parts = [], avg = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };
    var tags = (x.sentiments || []).filter(function (t) { return VALENCE[t] != null; });
    if (tags.length) parts.push({ k: "Notes", w: 0.35, v: Math.round(avg(tags.map(function (t) { return VALENCE[t]; }))), t: tags.length + (tags.length === 1 ? " feeling tagged in your notes" : " feelings tagged in your notes") });
    var five = function (n) { return (Math.max(1, Math.min(5, n)) - 1) / 4 * 100; };
    var conv = (x.checkins || []).filter(function (c) { return c.source === "claude"; }).map(function (c) { return num(c.mood) != null ? five(+c.mood) : num(c.energy) != null ? five(+c.energy) : null; }).filter(function (v) { return v != null; });
    if (conv.length) parts.push({ k: "With Claude", w: 0.25, v: Math.round(avg(conv)), t: "how you sounded in conversation" });
    var mine = (x.checkins || []).filter(function (c) { return c.source !== "claude"; }).map(function (c) { return num(c.energy) != null ? five(+c.energy) : null; }).filter(function (v) { return v != null; });
    if (mine.length) parts.push({ k: "Check-in", w: 0.2, v: Math.round(avg(mine)), t: "your own energy check-in" });
    if (num(x.sleepScore) != null) parts.push({ k: "Sleep", w: 0.15, v: Math.round(+x.sleepScore), t: "sleep score" });
    if (num(x.stressAvg) != null) parts.push({ k: "Stress", w: 0.15, v: Math.round(100 - +x.stressAvg), t: "average stress, turned around" });
    if (!parts.length) return null;
    var w = parts.reduce(function (s, p) { return s + p.w; }, 0), score = Math.round(parts.reduce(function (s, p) { return s + p.v * p.w; }, 0) / w);
    var felt = parts.some(function (p) { return p.k === "Notes" || p.k === "With Claude" || p.k === "Check-in"; });
    return { score: score, label: score >= 80 ? "Great" : score >= 65 ? "Good" : score >= 50 ? "Okay" : score >= 35 ? "Mixed" : "Low", parts: parts.map(function (p) { return { k: p.k, v: p.v, t: p.t }; }), basis: felt ? "notes, conversations and body" : "sleep and stress only" };
  };

  /* A workout's exercises with their top set (heaviest normal set; longest or most reps when there is no weight). */
  D.exercises = function (sets) {
    var by = {}, order = [];
    (sets || []).filter(function (s) { return !s.superseded_at && s.set_type !== "warmup"; }).forEach(function (s) {
      var k = s.exercise_index + "|" + s.exercise; if (!by[k]) { by[k] = { name: s.exercise, i: s.exercise_index, sets: 0, top: null }; order.push(k); }
      var e = by[k]; e.sets++;
      var w = num(s.weight_kg), r = num(s.reps), t = e.top;
      var better = !t || (w || 0) > (t.w || 0) || ((w || 0) === (t.w || 0) && (r || 0) > (t.r || 0));
      if (better) e.top = { w: w, r: r, sec: num(s.duration_seconds), m: num(s.distance_m) };
    });
    return order.map(function (k) { return by[k]; }).sort(function (a, b) { return a.i - b.i; }).map(function (e) {
      var t = e.top || {}, top = t.w ? t.w + " kg × " + (t.r || "?") : t.r ? t.r + " reps" : t.sec ? Math.round(t.sec / 60 * 10) / 10 + " min" : t.m ? t.m + " m" : null;
      return { name: e.name, sets: e.sets, topSet: top };
    });
  };

  /* raw (all optional, already limited to what the caller is allowed to see):
     health: [health_daily rows]   workouts, sets, activities, checkins, transactions: table rows
     occ: [{ date, id, title, kind, area, time, done }]  every task/event occurrence in the range (repeats expanded)
     actions: [{ id, title, date, done, recurring, doneDates, area }]   notes: [{ id, date, title, text, sentiment }]
     tracker: [{ date, name, value }]   log: change-log rows for actions and people */
  D.build = function (date, raw) {
    raw = raw || {};
    var on = function (list, key) { return (list || []).filter(function (r) { return String(r[key || "date"] || "").slice(0, 10) === date; }); };
    var h = on(raw.health)[0] || null;
    var health = h ? { sleepScore: num(h.sleep_score), sleepMinutes: num(h.sleep_minutes), bed: hhmm(h.bed_time), wake: hhmm(h.wake_time), restingHr: num(h.resting_hr), stressAvg: num(h.stress_avg), bodyBattery: num(h.body_battery_high), steps: num(h.steps) } : null;
    if (health && Object.keys(health).every(function (k) { return health[k] == null; })) health = null;
    var workouts = on(raw.workouts).map(function (w) { return { id: w.id, title: w.title || w.routine || "Workout", minutes: num(w.duration_minutes), volumeKg: num(w.volume_kg), start: w.started_at ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(w.started_at)) : null, exercises: D.exercises((raw.sets || []).filter(function (s) { return s.workout_id === w.id; })) }; });
    var activities = on(raw.activities).map(function (a) { return { name: a.name || a.type, type: a.type, minutes: num(a.duration_minutes), km: num(a.distance_m) != null ? Math.round(a.distance_m / 100) / 10 : null, avgHr: num(a.avg_hr) }; });
    // tasks: done that day (the real tick date when the change log has it, else the due date), and due but not done
    var tick = raw._tick || (raw._tick = D.tickDates(raw.log)), done = [], dueNot = [];
    (raw.actions || []).forEach(function (a) {
      if (a.recurring) { if ((a.doneDates || []).indexOf(date) >= 0) done.push({ id: a.id, title: a.title, area: a.area || "", repeats: true }); return; }
      if (!a.done) return;
      var d = tick[a.id] || a.date; if (d === date) done.push({ id: a.id, title: a.title, area: a.area || "", exact: !!tick[a.id] });
    });
    on(raw.occ).forEach(function (o) {
      if (o.kind !== "task" && o.kind !== "deadline") return;
      if (!o.done) { dueNot.push({ id: o.id, title: o.title, area: o.area || "", kind: o.kind }); return; }
      var t = tick[o.id]; if (t && t > date && !o.repeats) dueNot.push({ id: o.id, title: o.title, area: o.area || "", kind: o.kind, doneLater: t });
    });
    var events = on(raw.occ).filter(function (o) { return o.kind === "event" || o.kind === "block"; }).map(function (o) { return { id: o.id, title: o.title, time: o.time || null, minutes: num(o.dur), area: o.area || "", kind: o.kind }; }).sort(function (a, b) { return String(a.time || "99").localeCompare(String(b.time || "99")); });
    var notes = on(raw.notes).map(function (n) { var text = String(n.text || "").replace(/\s+/g, " ").trim(); return { id: n.id, title: n.title || text.slice(0, 60) || "Note", firstLines: text.slice(0, 220) + (text.length > 220 ? "…" : ""), sentiment: n.sentiment || [] }; });
    var cks = on(raw.checkins), ticks = on(raw.tracker).filter(function (t) { return t.value === "true" || t.value === true; }).map(function (t) { return t.name; });
    var mood = D.mood({ sentiments: [].concat.apply([], notes.map(function (n) { return n.sentiment; })), checkins: cks, sleepScore: health && health.sleepScore, stressAvg: health && health.stressAvg });
    var en = cks.map(function (c) { return num(c.energy); }).filter(function (v) { return v != null; });
    var checkin = cks.length || ticks.length || mood ? { energy: en.length ? Math.round(en.reduce(function (s, v) { return s + v; }, 0) / en.length * 10) / 10 : null, note: (cks.filter(function (c) { return c.note; })[0] || {}).note || null, dailyLog: ticks, mood: mood } : null;
    var tx = on(raw.transactions).map(function (t) { return { description: t.description || "", amount: num(t.amount), area: t.area || "" }; });
    var spent = tx.filter(function (t) { return t.amount != null && t.amount < 0; });
    var money = tx.length ? { spent: spent.length ? Math.round(-spent.reduce(function (s, t) { return s + t.amount; }, 0) * 100) / 100 : 0, transactions: tx } : null;
    var people = (raw._contacts || (raw._contacts = D.contacts(raw.log))).filter(function (c) { return c.date === date; }).map(function (c) { return { name: c.name, kind: c.kind }; });
    // conversations with Claude: summaries saved for this date, newest first (their own table, never Notes)
    var conv = on(raw.summaries).filter(function (c) { return !c.archived_at; }).sort(function (a, b) { return String(b.created_at || "").localeCompare(String(a.created_at || "")); }).map(function (c) {
      return { id: c.id, bullets: (Array.isArray(c.summary) ? c.summary : String(c.summary || "").split(/\n+/)).map(function (x) { return String(x).replace(/^[\s•*-]+/, "").trim(); }).filter(Boolean), topics: c.topics || [], source: c.source === "voice" ? "voice" : "chat", time: c.created_at ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(c.created_at)) : null };
    });
    var vol = workouts.map(function (w) { return w.volumeKg; }).filter(function (v) { return v != null; });
    return {
      date: date, weekday: new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
      summary: { sleepScore: health ? health.sleepScore : null, stressAvg: health ? health.stressAvg : null, mood: mood ? mood.score : null, workout: workouts.length + activities.length > 0, tasksDone: done.length, spending: money ? money.spent : null },
      health: health, sport: workouts.length || activities.length ? { workouts: workouts, activities: activities, volumeKg: vol.length ? vol.reduce(function (s, v) { return s + v; }, 0) : null } : null,
      tasks: done.length || dueNot.length ? { done: done, dueNotDone: dueNot } : null,
      events: events.length ? events : null, notes: notes.length ? notes : null, checkin: checkin, money: money, people: people.length ? people : null, conversations: conv.length ? conv : null
    };
  };
  /* one number per day for trends; null where there is no data */
  D.METRICS = { sleepScore: "Sleep score", mood: "Mood", stressAvg: "Stress", steps: "Steps", restingHr: "Resting heart rate", workoutVolume: "Workout volume (kg)", tasksDone: "Tasks done", spending: "Spending" };
  D.metric = function (day, m) {
    if (m === "steps" || m === "restingHr") return day.health ? day.health[m] : null;
    if (m === "workoutVolume") return day.sport ? day.sport.volumeKg : null;
    if (m === "tasksDone") return day.tasks ? day.tasks.done.length : (day.health || day.sport || day.notes ? 0 : null);
    return day.summary[m] == null ? null : day.summary[m];
  };
  /* a short form for Claude: titles and numbers, no ids */
  D.brief = function (day) {
    var o = { date: day.date, weekday: day.weekday, summary: day.summary };
    if (day.health) o.health = day.health;
    if (day.sport) o.sport = { workouts: day.sport.workouts.map(function (w) { return { title: w.title, minutes: w.minutes, volumeKg: w.volumeKg, exercises: w.exercises.slice(0, 6).map(function (e) { return e.name + (e.topSet ? " " + e.topSet : ""); }) }; }), activities: day.sport.activities };
    if (day.tasks) o.tasks = { done: day.tasks.done.map(function (t) { return t.title; }), dueNotDone: day.tasks.dueNotDone.map(function (t) { return t.title + (t.doneLater ? " (done " + t.doneLater + ")" : ""); }) };
    if (day.events) o.events = day.events.map(function (e) { return (e.time ? e.time + " " : "") + e.title; });
    if (day.notes) o.notes = day.notes.map(function (n) { return { title: n.title, firstLines: n.firstLines }; });
    if (day.checkin) o.checkin = { energy: day.checkin.energy, note: day.checkin.note, dailyLog: day.checkin.dailyLog, mood: day.checkin.mood ? { score: day.checkin.mood.score, label: day.checkin.mood.label, basis: day.checkin.mood.basis } : null };
    if (day.money) o.money = { spent: day.money.spent, transactions: day.money.transactions.map(function (t) { return t.description + " " + t.amount; }) };
    if (day.people) o.people = day.people.map(function (p) { return p.name + " (" + p.kind + ")"; });
    if (day.conversations) o.conversations = day.conversations.map(function (c) { return { source: c.source, time: c.time, topics: c.topics, summary: c.bullets }; });
    return o;
  };
  /* one or two spoken sentences */
  D.say = function (day) {
    var s = day.summary, bits = [];
    if (s.sleepScore != null) bits.push("sleep score " + s.sleepScore);
    if (s.mood != null) bits.push("mood " + s.mood + " out of 100");
    if (s.stressAvg != null) bits.push("stress " + s.stressAvg);
    bits.push(day.sport && day.sport.workouts.length ? "a workout, " + day.sport.workouts[0].title : "no workout");
    bits.push(s.tasksDone + (s.tasksDone === 1 ? " task done" : " tasks done"));
    if (s.spending != null) bits.push("spent " + s.spending);
    var extra = day.notes ? " " + day.notes.length + (day.notes.length === 1 ? " note: " : " notes, the first: ") + day.notes[0].title + "." : "";
    return day.weekday + ": " + bits.join(", ") + "." + extra;
  };
  g.PPDay = D;
})(typeof globalThis !== "undefined" ? globalThis : this);
