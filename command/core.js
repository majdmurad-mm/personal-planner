/* Command Center logic with no DOM: dates, repeating items, free time, quick-add parsing, weekly review.
   Loaded by the page (window.PPCommandCore) and by node for tests (module.exports). */
(function (root) {
  var C = {};
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  C.pad = pad;
  // Dates are "YYYY-MM-DD" strings; maths is done in UTC so daylight saving never shifts a day.
  C.ms = function (s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); };
  C.iso = function (ms) { var d = new Date(ms); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); };
  C.localIso = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  C.add = function (s, n) { return C.iso(C.ms(s) + n * 864e5); };
  C.dow = function (s) { return new Date(C.ms(s)).getUTCDay(); };            // 0 = Sunday
  C.monday = function (s) { return C.add(s, -((C.dow(s) + 6) % 7)); };
  C.diff = function (a, b) { return Math.round((C.ms(b) - C.ms(a)) / 864e5); };
  C.mins = function (t) { return t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null; };
  C.hhmm = function (m) { m = Math.max(0, Math.min(1439, Math.round(m))); return pad(Math.floor(m / 60)) + ":" + pad(m % 60); };
  C.range = function (from, n) { var a = []; for (var i = 0; i < n; i++) a.push(C.add(from, i)); return a; };

  /* ---------- repeating items (a small, strict subset of RRULE) ---------- */
  C.parseRule = function (str) {
    if (!str) return null;
    var r = { freq: "", interval: 1, byday: [], bymonthday: [], until: null, count: null }, ok = true;
    String(str).replace(/^RRULE:/i, "").split(";").forEach(function (p) {
      var kv = p.split("="), k = (kv[0] || "").toUpperCase().trim(), v = (kv[1] || "").toUpperCase().trim();
      if (!k) return;
      if (k === "FREQ") r.freq = v;
      else if (k === "INTERVAL") r.interval = Math.max(1, parseInt(v, 10) || 1);
      else if (k === "BYDAY") r.byday = v.split(",").map(function (x) { return x.replace(/^[+-]?\d+/, ""); }).filter(function (x) { return DOW.indexOf(x) >= 0; });
      else if (k === "BYMONTHDAY") r.bymonthday = v.split(",").map(function (x) { return parseInt(x, 10); }).filter(function (x) { return x >= 1 && x <= 31; });
      else if (k === "UNTIL") r.until = v.length >= 8 ? v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6, 8) : null;
      else if (k === "COUNT") r.count = parseInt(v, 10) || null;
      else if (k !== "WKST") ok = false;
    });
    if (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].indexOf(r.freq) < 0 || !ok) return null;
    return r;
  };
  C.ruleError = function (str) { return !str || C.parseRule(str) ? "" : "This repeat rule is not supported. Use FREQ=DAILY, WEEKLY, MONTHLY or YEARLY with INTERVAL, BYDAY, BYMONTHDAY, UNTIL or COUNT."; };
  // Does the rule (anchored on `start`) land on `d`? Ignores COUNT, which the caller handles.
  function hits(r, start, d) {
    var n = C.diff(start, d); if (n < 0) return false;
    if (r.until && d > r.until) return false;
    if (r.freq === "DAILY") return n % r.interval === 0;
    if (r.freq === "WEEKLY") {
      var weeks = C.diff(C.monday(start), C.monday(d)) / 7;
      if (weeks % r.interval !== 0) return false;
      return r.byday.length ? r.byday.indexOf(DOW[C.dow(d)]) >= 0 : C.dow(d) === C.dow(start);
    }
    var months = (+d.slice(0, 4) - +start.slice(0, 4)) * 12 + (+d.slice(5, 7) - +start.slice(5, 7)), dom = +d.slice(8, 10);
    if (r.freq === "MONTHLY") {
      if (months % r.interval !== 0) return false;
      return r.bymonthday.length ? r.bymonthday.indexOf(dom) >= 0 : dom === +start.slice(8, 10);
    }
    return months % (12 * r.interval) === 0 && dom === +start.slice(8, 10);
  }
  // Dates on which an item falls between from and to (inclusive). Skipped dates are left out.
  C.dates = function (it, from, to) {
    if (!it.date) return [];
    var r = C.parseRule(it.recurrence);
    if (!r) return it.date >= from && it.date <= to ? [it.date] : [];
    var out = [], skip = it.exceptions || [], d = it.date, seen = 0, guard = 0;
    while (d <= to && guard++ < 4000) {
      if (hits(r, it.date, d)) { seen++; if (r.count && seen > r.count) break; if (d >= from && skip.indexOf(d) < 0) out.push(d); }
      d = C.add(d, 1);
    }
    return out;
  };
  // One entry per item per day. For a repeating task, "done" is per date.
  C.expand = function (items, from, to) {
    var out = [];
    items.forEach(function (it) {
      if (it.archived || it.someday) return;
      C.dates(it, from, to).forEach(function (d) {
        out.push({ item: it, date: d, key: it.id + "@" + d, repeats: !!it.recurrence, done: it.recurrence ? (it.doneDates || []).indexOf(d) >= 0 : !!it.done });
      });
    });
    return out.sort(C.byTime);
  };
  C.byTime = function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    var x = a.item.allDay ? null : a.item.time, y = b.item.allDay ? null : b.item.time;
    if (!x !== !y) return x ? 1 : -1;                 // all-day and untimed first
    if (x !== y) return x < y ? -1 : 1;
    return String(a.item.priority || "P9").localeCompare(String(b.item.priority || "P9")) || String(a.item.title).localeCompare(String(b.item.title));
  };
  C.hasDone = function (it) { return it.kind === "task" || it.kind === "deadline"; };
  C.ruleText = function (str) {
    var r = C.parseRule(str); if (!r) return "";
    var names = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" }, n = r.interval, ord = function (x) { return x + (x % 10 === 1 && x !== 11 ? "st" : x % 10 === 2 && x !== 12 ? "nd" : x % 10 === 3 && x !== 13 ? "rd" : "th"); };
    var t = r.freq === "DAILY" ? (n === 1 ? "Every day" : "Every " + n + " days")
      : r.freq === "WEEKLY" ? (n === 1 ? "Every week" : "Every " + n + " weeks") + (r.byday.length ? " on " + r.byday.map(function (d) { return names[d]; }).join(", ") : "")
      : r.freq === "MONTHLY" ? (n === 1 ? "Every month" : "Every " + n + " months") + (r.bymonthday.length ? " on the " + r.bymonthday.map(ord).join(", ") : "")
      : (n === 1 ? "Every year" : "Every " + n + " years");
    return t + (r.until ? " until " + r.until : "") + (r.count ? ", " + r.count + " times" : "");
  };

  /* ---------- free time ---------- */
  C.DAY_START = 7 * 60; C.DAY_END = 23 * 60;
  // work: { days:[1..5], start:"09:00", end:"18:00" } counts as booked. Returns minutes.
  C.capacity = function (occs, date, work) {
    var iv = [], w = work && work.days.indexOf(C.dow(date)) >= 0 ? [C.mins(work.start), C.mins(work.end)] : null;
    if (w) iv.push(w);
    occs.forEach(function (o) {
      var it = o.item; if (o.date !== date || it.allDay || !it.time || o.done) return;
      var s = C.mins(it.time), len = it.dur || it.est || (it.kind === "event" || it.kind === "block" ? 60 : 30);
      iv.push([s, s + len]);
    });
    iv = iv.map(function (x) { return [Math.max(C.DAY_START, x[0]), Math.min(C.DAY_END, x[1])]; }).filter(function (x) { return x[1] > x[0]; }).sort(function (a, b) { return a[0] - b[0]; });
    var booked = 0, end = -1, workMin = 0;
    iv.forEach(function (x) { if (x[0] > end) { booked += x[1] - x[0]; end = x[1]; } else if (x[1] > end) { booked += x[1] - end; end = x[1]; } });
    if (w) workMin = Math.max(0, Math.min(C.DAY_END, w[1]) - Math.max(C.DAY_START, w[0]));
    var total = C.DAY_END - C.DAY_START;
    return { total: total, booked: booked, work: Math.min(workMin, booked), other: Math.max(0, booked - workMin), free: Math.max(0, total - booked) };
  };

  /* ---------- quick add: "call MVGM Wed 10:00", "gym every Mon Wed Fri 19:00", "pay rent 1st monthly" ---------- */
  var DAYN = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  var MONN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  var nextDow = function (today, d) { return C.add(today, (d - C.dow(today) + 7) % 7); };
  var nextDom = function (today, dom) { var d = today; for (var i = 0; i < 62; i++) { if (+d.slice(8, 10) === dom) return d; d = C.add(d, 1); } return today; };
  C.parseQuick = function (text, today, areas) {
    var out = { title: "", kind: "task", date: null, time: null, dur: null, recurrence: null, priority: null, area: null, allDay: false }, used = [];
    var s = " " + String(text || "").replace(/\s+/g, " ").trim() + " ";
    var take = function (re, fn) { var m = re.exec(s); if (!m) return false; if (fn(m) === false) return false; s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length); used.push(m[0].trim()); return true; };
    // priority and area
    take(/\s[pP]([0-3])(?=\s)/, function (m) { out.priority = "P" + m[1]; });
    take(/\s#([A-Za-z]+)(?=\s)/, function (m) { var a = (areas || []).filter(function (x) { return x.toLowerCase().indexOf(m[1].toLowerCase()) === 0; })[0]; if (!a) return false; out.area = a; });
    // time range, then single time, then duration
    var tm = function (h, mi, ap) { h = +h; mi = +(mi || 0); if (ap) { ap = ap.toLowerCase(); if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; } return h > 23 || mi > 59 ? null : pad(h) + ":" + pad(mi); };
    take(/\s(\d{1,2})[:.](\d{2})\s?(?:-|–|to)\s?(\d{1,2})[:.](\d{2})(?=\s)/i, function (m) { var a = tm(m[1], m[2]), b = tm(m[3], m[4]); if (!a || !b || b <= a) return false; out.time = a; out.dur = C.mins(b) - C.mins(a); });
    if (!out.time) take(/\s(?:at\s)?(\d{1,2})[:.](\d{2})\s?(am|pm)?(?=\s)/i, function (m) { var t = tm(m[1], m[2], m[3]); if (!t) return false; out.time = t; });
    if (!out.time) take(/\s(?:at\s)?(\d{1,2})\s?(am|pm)(?=\s)/i, function (m) { var t = tm(m[1], 0, m[2]); if (!t) return false; out.time = t; });
    take(/\sfor\s(\d+(?:[.,]\d+)?)\s?(h|hr|hrs|hours?|m|min|mins|minutes?)(?=\s)/i, function (m) { var n = parseFloat(m[1].replace(",", ".")); out.dur = Math.round(/^h/i.test(m[2]) ? n * 60 : n); });
    // repeats
    var days = [];
    take(/\severy\s((?:(?:sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*(?:\s?,\s?|\s(?:and\s)?)?)+)(?=\s|$)/i, function (m) {
      m[1].toLowerCase().split(/[\s,]+/).forEach(function (w) { if (DAYN[w] != null && days.indexOf(DAYN[w]) < 0) days.push(DAYN[w]); });
      if (!days.length) return false;
      out.recurrence = "FREQ=WEEKLY;BYDAY=" + days.slice().sort(function (a, b) { return ((a + 6) % 7) - ((b + 6) % 7); }).map(function (d) { return DOW[d]; }).join(",");
    });
    if (!out.recurrence) take(/\severy\s(\d+)\s(day|week|month|year)s?(?=\s)/i, function (m) { out.recurrence = "FREQ=" + { day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" }[m[2].toLowerCase()] + ";INTERVAL=" + m[1]; });
    if (!out.recurrence) take(/\s(every\sday|daily|every\sweekday|weekdays|every\sweek|weekly|every\smonth|monthly|every\syear|yearly|annually)(?=\s)/i, function (m) {
      var w = m[1].toLowerCase();
      out.recurrence = /weekday/.test(w) ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" : /da/.test(w) ? "FREQ=DAILY" : /week/.test(w) ? "FREQ=WEEKLY" : /month/.test(w) ? "FREQ=MONTHLY" : "FREQ=YEARLY";
    });
    // dates
    take(/\s(\d{4})-(\d{2})-(\d{2})(?=\s)/, function (m) { out.date = m[1] + "-" + m[2] + "-" + m[3]; });
    if (!out.date) take(/\s(\d{1,2})\.(\d{1,2})\.(\d{4})?(?=\s)/, function (m) { var y = m[3] ? +m[3] : +today.slice(0, 4), d = y + "-" + pad(+m[2]) + "-" + pad(+m[1]); if (+m[2] > 12 || +m[1] > 31) return false; if (!m[3] && d < today) d = (y + 1) + d.slice(4); out.date = d; });
    if (!out.date) take(/\s(?:on\s)?(\d{1,2})(?:st|nd|rd|th)?\s(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*(?=\s)/i, function (m) { var y = +today.slice(0, 4), d = y + "-" + pad(MONN[m[2].toLowerCase()]) + "-" + pad(+m[1]); if (d < today) d = (y + 1) + d.slice(4); out.date = d; });
    if (!out.date) take(/\s(today|tonight|tomorrow|next week)(?=\s)/i, function (m) { var w = m[1].toLowerCase(); out.date = w === "tomorrow" ? C.add(today, 1) : w === "next week" ? C.add(C.monday(today), 7) : today; });
    if (!out.date) take(/\s(?:on\s|next\s)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|weds?|thu(?:rs?)?|fri|sat)(?=\s)/i, function (m) { out.date = nextDow(today, DAYN[m[1].toLowerCase()]); });
    if (!out.date) take(/\s(?:on\sthe\s|on\s)?(\d{1,2})(st|nd|rd|th)(?=\s)/i, function (m) { if (+m[1] < 1 || +m[1] > 31) return false; out.date = nextDom(today, +m[1]); if (/FREQ=MONTHLY/.test(out.recurrence || "")) out.recurrence += ";BYMONTHDAY=" + +m[1]; });
    // a repeating item needs a first date
    if (out.recurrence && !out.date) out.date = days.length ? C.range(today, 7).filter(function (d) { return days.indexOf(C.dow(d)) >= 0; })[0] : today;
    // kind
    var low = s.toLowerCase();
    if (take(/\s(deadline|due)(?=\s)/i, function () {})) out.kind = "deadline";
    else if (/\b(gym|workout|deep work|focus time|block)\b/.test(low)) out.kind = "block";
    else if (/\b(meeting|meet|dinner|lunch|breakfast|brunch|coffee|appointment|dentist|doctor|flight|train|birthday|party|concert|wedding|visit)\b/.test(low) && (out.time || out.date)) out.kind = "event";
    out.title = s.replace(/\s+/g, " ").replace(/\s(at|on|by)\s*$/i, "").trim();
    if (out.title) out.title = out.title.charAt(0).toUpperCase() + out.title.slice(1);
    out.understood = used;
    return out;
  };

  /* ---------- weekly review ---------- */
  C.review = function (items, start, today) {
    var end = C.add(start, 6), occ = C.expand(items, start, end), next = C.expand(items, C.add(start, 7), C.add(start, 13));
    var tasks = occ.filter(function (o) { return C.hasDone(o.item); });
    return {
      start: start, end: end,
      done: tasks.filter(function (o) { return o.done; }),
      slipped: tasks.filter(function (o) { return !o.done && o.date < today; }),
      open: tasks.filter(function (o) { return !o.done && o.date >= today; }),
      happened: occ.filter(function (o) { return !C.hasDone(o.item) && o.date <= today; }).length,
      next: next
    };
  };
  // Open, dated, in the past. Repeating tasks only count the latest missed date in the last 14 days.
  C.overdue = function (items, today) {
    var out = [];
    items.forEach(function (it) {
      if (it.archived || it.someday || !it.date || !C.hasDone(it)) return;
      if (!it.recurrence) { if (!it.done && it.date < today) out.push({ item: it, date: it.date, key: it.id + "@" + it.date, repeats: false, done: false }); return; }
      var ds = C.dates(it, C.add(today, -14), C.add(today, -1)).filter(function (d) { return (it.doneDates || []).indexOf(d) < 0; });
      if (ds.length) out.push({ item: it, date: ds[ds.length - 1], key: it.id + "@" + ds[ds.length - 1], repeats: true, done: false });
    });
    return out.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  };

  if (typeof module !== "undefined" && module.exports) module.exports = C; else root.PPCommandCore = C;
})(typeof window !== "undefined" ? window : this);
