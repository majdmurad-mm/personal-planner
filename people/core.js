/* People page, part 1 of 2: the data model and the constellation geometry. No DOM in here.
   The planner hands over its people plus the actions, events and notes that mention them;
   build() turns that into what the page draws. Signed out, or with nobody yet, sample() supplies
   invented people so the page can be seen. Every sample name is made up. */
(function () {
  "use strict";
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var RINGS = ["", "Inner", "Close", "Good", "Wider", "Outer"];
  var QL = { strong: "Strong", ok: "Steady", weak: "Faint", strained: "Strained", conflict: "In conflict", cut_off: "Cut off" };
  var EN = { nourishing: "Gives energy", neutral: "Even", draining: "Takes energy" };
  var KIND = { call: "Talked", met: "Met", message: "Messaged", other: "In touch" };
  var RHYTHMS = [[0, "No rhythm"], [7, "Weekly"], [14, "Every 2 weeks"], [30, "Monthly"], [60, "Every 2 months"], [90, "Every 3 months"], [180, "Twice a year"], [365, "Yearly"]];

  function dayNum(s) { if (!s) return null; var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : null; }
  function fmtDay(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? (+m[3]) + " " + MON[+m[2] - 1] : ""; }
  function ago(n) { return n <= 0 ? "today" : n === 1 ? "yesterday" : n < 14 ? n + " days ago" : n < 60 ? Math.round(n / 7) + " weeks ago" : n < 365 ? Math.round(n / 30) + " months ago" : "over a year ago"; }
  function inDays(n) { return n === 0 ? "today" : n === 1 ? "tomorrow" : "in " + n + " days"; }
  function rhythmText(n) { for (var i = 0; i < RHYTHMS.length; i++) if (RHYTHMS[i][0] === n) return RHYTHMS[i][1].toLowerCase(); return "every " + n + " days"; }
  /* a name can carry what you call someone in brackets, "[Nick] Full Name": that is the short label */
  function bare(name) { return String(name || "").replace(/^\s*[\[(][^\])]*[\])]\s*/, "").trim() || String(name || "?").replace(/[\[\]()]/g, "").trim() || "?"; }
  function shortName(name) { var m = /^\s*[\[(]([^\])]+)[\])]/.exec(String(name || "")); return m ? m[1].trim() : bare(name).split(/\s+/)[0]; }
  function initials(name) { return bare(name).split(/\s+/).map(function (w) { return w.charAt(0); }).join("").slice(0, 2).toUpperCase(); }
  /* group colours: the same rule as the Clusters view (alphabetical walk through one palette, a chosen colour wins) */
  // shades of the people blue (shared/areas.js); a group is told apart by its shade and its labelled arc
  var PALETTE = ["#4ADE80", "#5FA8FF", "#F15A22", "#A78BFA", "#FDE047", "#FB7185", "#2DD4BF", "#FB923C"];
  function groupColors(names, custom) { var o = {}; names.slice().sort().forEach(function (g, i) { o[g] = (custom && custom[g]) || PALETTE[i % PALETTE.length]; }); return o; }
  /* family roles for the Tree view; "side" only matters for the roles marked true */
  var KIN = { father: "Father", mother: "Mother", brother: "Brother", sister: "Sister", grandfather: "Grandfather", grandmother: "Grandmother", uncle: "Uncle", aunt: "Aunt", cousin: "Cousin",
    partner: "Partner", ex: "Ex-partner", son: "Son", daughter: "Daughter", nephew: "Nephew", niece: "Niece", inlaw: "In-law", relative: "Relative" };
  var KIN_SIDED = { grandfather: 1, grandmother: 1, uncle: 1, aunt: 1, cousin: 1 }, SIDE = { paternal: "Father's side", maternal: "Mother's side" };
  function isoAdd(today, n) { var d = new Date(dayNum(today) * 864e5 + n * 864e5); return d.toISOString().slice(0, 10); }

  /* raw: { people, actions, events, notes, sits, links, today }  ->  model */
  function build(raw) {
    var today = raw.today, t0 = dayNum(today), P = [], byId = {};
    (raw.people || []).forEach(function (r) {
      var last = r.lastContactAt ? Math.max(0, t0 - dayNum(r.lastContactAt)) : null, bday = null;
      if (r.birthdayMonth && r.birthdayDay) {
        var y = +today.slice(0, 4), n = Math.round(Date.UTC(y, r.birthdayMonth - 1, r.birthdayDay) / 864e5);
        if (n < t0) n = Math.round(Date.UTC(y + 1, r.birthdayMonth - 1, r.birthdayDay) / 864e5);
        bday = n - t0;
      }
      var p = {
        id: r.id, name: r.name || "Unnamed", ini: initials(r.name), circle: r.circle >= 1 && r.circle <= 5 ? r.circle : 4,
        quality: QL[r.quality] ? r.quality : "ok", energy: EN[r.energy] ? r.energy : "neutral", group: (r.group || "").trim(),
        rel: r.relationship || "", loc: r.location || "", yearMet: r.yearMet || null, notes: r.notes || "", contact: r.contact || "",
        last: last, lastDate: r.lastContactAt || null, kind: KIND[r.lastContactKind] ? r.lastContactKind : "other", rhythm: r.rhythmDays || null,
        bday: bday, bdayText: r.birthdayMonth && r.birthdayDay ? r.birthdayDay + " " + MON[r.birthdayMonth - 1] : "", bm: r.birthdayMonth || null, bd: r.birthdayDay || null,
        archived: !!r.archivedAt, inMemory: !!r.inMemory, sits: [], threads: [], up: [], mentions: [], links: [],
        first: shortName(r.name), kinRole: KIN[r.kinRole] ? r.kinRole : "", kinSide: SIDE[r.kinSide] ? r.kinSide : ""
      };
      p.off = p.archived || p.inMemory || p.quality === "cut_off";       // not on the map
      P.push(p); byId[p.id] = p;
    });
    (raw.sits || []).forEach(function (s) { var p = byId[s.person_id]; if (p && !s.archived_at) p.sits.push({ id: s.id, t: s.text, date: s.noted_on, by: s.author === "claude" ? "claude" : "me", at: s.created_at || "" }); });
    P.forEach(function (p) { p.sits.sort(function (a, b) { return a.date === b.date ? (a.at < b.at ? 1 : -1) : (a.date < b.date ? 1 : -1); }); });
    (raw.links || []).forEach(function (l) {
      var a = byId[l.person_a], b = byId[l.person_b]; if (!a || !b || l.archived_at) return;
      a.links.push({ id: b.id, linkId: l.id, quality: l.quality, kind: l.kind || null, parent: l.from_person || null }); b.links.push({ id: a.id, linkId: l.id, quality: l.quality, kind: l.kind || null, parent: l.from_person || null });
    });
    (raw.actions || []).forEach(function (a) { (a.people || []).forEach(function (id) { var p = byId[id]; if (p) p.threads.push({ id: a.id, t: a.title, date: a.date || null }); }); });
    (raw.events || []).forEach(function (e) {
      var n = dayNum(e.date); if (n == null || n < t0 || n > t0 + 30) return;
      (e.people || []).forEach(function (id) { var p = byId[id]; if (p) p.up.push({ t: e.title, date: e.date, n: n - t0 }); });
    });
    (raw.notes || []).forEach(function (j) { (j.people || []).forEach(function (id) { var p = byId[id]; if (p) p.mentions.push({ date: j.date, t: j.title || j.text || "" }); }); });
    P.forEach(function (p) {
      p.threads.sort(function (a, b) { return (a.date || "9") < (b.date || "9") ? -1 : 1; });
      p.mentions.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
      if (p.bday != null && p.bday <= 30) p.up.push({ t: "Birthday", date: isoAdd(today, p.bday), n: p.bday, bday: true });
      p.up.sort(function (a, b) { return a.n - b.n; });
      p.drift = !!(p.rhythm && p.last != null && p.last > p.rhythm);
      p.fresh = p.rhythm && p.last != null ? Math.max(0, 1 - p.last / (p.rhythm * 1.6)) : null;
      p.tense = p.quality === "strained" || p.quality === "conflict";
    });
    /* sectors: the largest groups get their own slice of the sky, everyone else shares "Other" */
    var cnt = {}, on = P.filter(function (p) { return !p.off; });
    on.forEach(function (p) { if (p.group) cnt[p.group] = (cnt[p.group] || 0) + 1; });
    var top = Object.keys(cnt).filter(function (g) { return cnt[g] >= 3; }).sort(function (a, b) { return cnt[b] - cnt[a] || (a < b ? -1 : 1); }).slice(0, 7);
    var groups = top.map(function (g) { return { id: g, label: g }; });
    P.forEach(function (p) { p.g = top.indexOf(p.group) >= 0 ? p.group : "~other"; });
    if (on.some(function (p) { return p.g === "~other"; }) || !groups.length) groups.push({ id: "~other", label: groups.length ? "Other" : "Everyone" });
    var allGroups = Object.keys(P.reduce(function (o, p) { if (p.group) o[p.group] = 1; return o; }, {})).sort();
    var colors = raw.colors || groupColors(allGroups);
    P.forEach(function (p) { p.color = colors[p.group] || ""; });
    return { today: today, P: P, byId: byId, groups: groups, allGroups: allGroups, on: on, colors: colors };
  }

  /* what the pulse rail says; gentle wording, no scores */
  function pulse(M) {
    var need = [];
    M.on.forEach(function (p) {
      if (p.threads.length) need.push({ p: p, w: p.tense ? 0 : 1, why: p.threads[0].t, tag: p.threads[0].date ? fmtDay(p.threads[0].date) : "" });
      else if (p.drift) need.push({ p: p, w: 2, why: "Last in touch " + ago(p.last) + ". You like " + rhythmText(p.rhythm) + ".", tag: "" });
    });
    need.sort(function (a, b) { return a.w - b.w || a.p.circle - b.p.circle; });
    var soon = [];
    M.on.forEach(function (p) { p.up.forEach(function (u) { soon.push({ p: p, n: u.n, why: u.t + " · " + (u.n < 2 ? inDays(u.n) : fmtDay(u.date)) }); }); });
    soon.sort(function (a, b) { return a.n - b.n; });
    var rec = [];
    M.P.forEach(function (p) { if (p.sits.length && !p.archived) rec.push({ p: p, s: p.sits[0] }); });
    rec.sort(function (a, b) { return a.s.date === b.s.date ? (a.s.at < b.s.at ? 1 : -1) : (a.s.date < b.s.date ? 1 : -1); });
    return { need: need, soon: soon.slice(0, 8), rec: rec.slice(0, 5) };
  }

  /* ---------- geometry (viewBox units; K = units per CSS pixel) ---------- */
  var BAND = { 1: [104, 124], 2: [188, 246], 3: [288, 362], 4: [392, 440], 5: [464, 488] }, RLINE = [0, 154, 266, 376, 451, 496];
  function nodeR(c, K, narrow) { var px = narrow ? [0, 12, 9.5, 4.6, 3.2, 2.4][c] : [0, 17, 13, 8, 5.5, 4][c], u = [0, 19, 14, 9, 6, 4.2][c]; return Math.max(c > 2 ? u * .72 : u, px * K * (c > 2 ? .8 : 1)); }
  function layout(M, K, narrow) {
    var secs = M.groups.map(function (g) { var m = M.on.filter(function (p) { return p.g === g.id; }); return { g: g, m: m, w: Math.pow(Math.max(m.length, 5), .82) }; }).filter(function (s) { return s.m.length; });
    var gap = secs.length > 1 ? 3.2 : 0, top = secs.length > 1 ? 13 : 0, tot = 360 - top - gap * (secs.length - 1), sum = secs.reduce(function (a, s) { return a + s.w; }, 0), a = -90 + top / 2;
    secs.forEach(function (s) {
      s.a0 = a; s.a1 = a + tot * s.w / sum; a = s.a1 + gap;
      for (var c = 1; c <= 5; c++) {
        var m = s.m.filter(function (p) { return p.circle === c; }); if (!m.length) continue;
        m.sort(function (x, y) { return x.name < y.name ? -1 : 1; });
        var b = BAND[c], r = nodeR(c, K, narrow), pad = Math.min(3, (s.a1 - s.a0) * .15), span = (s.a1 - s.a0 - 2 * pad) * Math.PI / 180, rm = (b[0] + b[1]) / 2,
          per = Math.max(1, Math.floor(span * rm / (r * 2 + (c <= 2 ? 26 * K + 10 : 5)))), rows = Math.min(Math.ceil(m.length / per), Math.max(1, Math.floor((b[1] - b[0]) / (r * 1.7)) + 1));
        m.forEach(function (p, i) {
          var row = i % rows, col = Math.floor(i / rows), cols = Math.ceil((m.length - row) / rows), rr = rows === 1 ? rm : b[0] + (b[1] - b[0]) * row / (rows - 1),
            t = (col + .5 + (rows > 1 && row % 2 ? .25 : rows > 1 ? -.25 : 0)) / Math.max(cols, 1), ang = (s.a0 + pad + (s.a1 - s.a0 - 2 * pad) * Math.min(.97, Math.max(.03, t))) * Math.PI / 180;
          p.x = Math.cos(ang) * rr; p.y = Math.sin(ang) * rr; p.r = r; p.ang = ang;
        });
      }
    });
    return secs;
  }
  /* ecomap line styles: straight = steady or strong, dashed = faint, wavy = strained, zigzag = conflict, barred = cut off */
  function linePath(x1, y1, x2, y2, q) {
    var dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux, f = function (n) { return n.toFixed(1); }, i, d = "M" + f(x1) + "," + f(y1);
    if (q === "conflict") { var n = Math.max(4, Math.round(L / 7)); for (i = 1; i < n; i++) { var s = (i % 2 ? 1 : -1) * 4.5; d += "L" + f(x1 + dx * i / n + nx * s) + "," + f(y1 + dy * i / n + ny * s); } return d + "L" + f(x2) + "," + f(y2); }
    if (q === "strained") { var m = Math.max(2, Math.round(L / 16)); for (i = 0; i < m; i++) { var s2 = (i % 2 ? 1 : -1) * 7, t0 = (i + .5) / m, t1 = (i + 1) / m; d += "Q" + f(x1 + dx * t0 + nx * s2) + "," + f(y1 + dy * t0 + ny * s2) + " " + f(x1 + dx * t1) + "," + f(y1 + dy * t1); } return d; }
    if (q === "cut_off") { var g = 6, ax = x1 + ux * (L / 2 - g), ay = y1 + uy * (L / 2 - g), bx = x1 + ux * (L / 2 + g), by = y1 + uy * (L / 2 + g); return d + "L" + f(ax) + "," + f(ay) + "M" + f(ax + nx * 6) + "," + f(ay + ny * 6) + "L" + f(ax - nx * 6) + "," + f(ay - ny * 6) + "M" + f(bx + nx * 6) + "," + f(by + ny * 6) + "L" + f(bx - nx * 6) + "," + f(by - ny * 6) + "M" + f(bx) + "," + f(by) + "L" + f(x2) + "," + f(y2); }
    return d + "L" + f(x2) + "," + f(y2);
  }
  function arc(r, a0, a1, rev) { var p = function (a) { a = a * Math.PI / 180; return (Math.cos(a) * r).toFixed(1) + "," + (Math.sin(a) * r).toFixed(1); }; return rev ? "M" + p(a1) + "A" + r + "," + r + " 0 " + (a1 - a0 > 180 ? 1 : 0) + " 0 " + p(a0) : "M" + p(a0) + "A" + r + "," + r + " 0 " + (a1 - a0 > 180 ? 1 : 0) + " 1 " + p(a1); }

  /* ---------- SAMPLE: invented people, shown only when signed out or when nobody has been added ---------- */
  function sample(today) {
    var seed = 90217, rnd = function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }, pick = function (a) { return a[Math.floor(rnd() * a.length)]; };
    var people = [], sits = [], links = [], actions = [], events = [], notes = [], d = function (n) { return isoAdd(today, -n); };
    function add(o) { o.id = "s" + people.length; people.push(o); return o; }
    function sit(p, n, by, t) { sits.push({ id: "t" + sits.length, person_id: p.id, text: t, noted_on: d(n), author: by, created_at: d(n) }); }
    function link(a, b, q) { if (a === b) return; var x = a.id < b.id ? a : b, y = x === a ? b : a; if (links.some(function (l) { return l.person_a === x.id && l.person_b === y.id; })) return; links.push({ id: "l" + links.length, person_a: x.id, person_b: y.id, quality: q || "ok" }); }
    var lena = add({ name: "Lena Hartwig", group: "Partner", relationship: "Partner", kinRole: "partner", circle: 1, quality: "strong", energy: "nourishing", location: "Leipzig", yearMet: 2023, lastContactAt: d(0), lastContactKind: "met" });
    sit(lena, 1, "claude", "A heavy month for both of us. She has her thesis defence on the 20th and I've been cooking so she can write."); sit(lena, 16, "me", "Talked about spending Christmas with her parents this year.");
    var jonas = add({ name: "Jonas Albrecht", group: "Hometown", relationship: "Friend", circle: 1, quality: "strong", energy: "nourishing", location: "Hamburg", yearMet: 2003, lastContactAt: d(37), lastContactKind: "call", rhythmDays: 14 });
    sit(jonas, 6, "claude", "Nothing wrong, just a busy stretch on both sides. He started the new job in October and we keep missing each other's calls.");
    var mira = add({ name: "Mira Solberg", group: "Family", relationship: "Family", kinRole: "sister", circle: 1, quality: "strong", energy: "nourishing", location: "Oslo", lastContactAt: d(3), lastContactKind: "call", rhythmDays: 14, birthdayMonth: +isoAdd(today, 6).slice(5, 7), birthdayDay: +isoAdd(today, 6).slice(8, 10) });
    sit(mira, 3, "me", "She's settling into the new flat. Wants us all there in spring.");
    var omar = add({ name: "Omar Vidal", group: "Hometown", relationship: "Friend", circle: 1, quality: "strained", location: "Leipzig", lastContactAt: d(12), lastContactKind: "message" });
    sit(omar, 2, "claude", "The rift after the summer trip is settling. We've exchanged a few easy messages. A quiet coffee feels right before anything bigger."); sit(omar, 41, "me", "Still sore about how the trip ended. Giving it some room.");
    var nadia = add({ name: "Nadia Keller", group: "Family", relationship: "Family", kinRole: "aunt", kinSide: "maternal", circle: 2, quality: "strained", location: "Munich", lastContactAt: d(48), lastContactKind: "message" });
    sit(nadia, 1, "claude", "There's still tension from the spring, but I'd like her at Christmas anyway. A warm, short invitation.");
    var tomas = add({ name: "Tomas Brandt", group: "Family", relationship: "Family", kinRole: "father", circle: 2, quality: "ok", location: "Prague", lastContactAt: d(5), lastContactKind: "call" });
    sit(tomas, 5, "claude", "I'm handling his residence paperwork. It still needs his signature and a certified copy of his passport.");
    var ada = add({ name: "Ada Lindqvist", group: "Work", relationship: "Mentor", circle: 2, quality: "strong", energy: "nourishing", location: "Berlin", lastContactAt: d(20), lastContactKind: "met", rhythmDays: 60 });
    add({ name: "Viktor Rann", group: "Work", relationship: "Colleague", circle: 4, quality: "conflict", energy: "draining", location: "Leipzig", lastContactAt: d(30), lastContactKind: "met" });
    add({ name: "Elias Roth", group: "", relationship: "Other", circle: 5, quality: "cut_off" });
    actions.push({ id: "a1", title: "Call Jonas, no agenda", date: isoAdd(today, 2), people: [jonas.id] }, { id: "a2", title: "Coffee with Omar, just the two of us", date: isoAdd(today, 5), people: [omar.id] }, { id: "a3", title: "Invite Nadia for Christmas", date: isoAdd(today, 22), people: [nadia.id] }, { id: "a4", title: "Post the signed residence form", date: isoAdd(today, 4), people: [tomas.id] });
    events.push({ id: "e1", title: "Thesis defence", date: isoAdd(today, 11), people: [lena.id] }, { id: "e2", title: "Lunch with Ada", date: isoAdd(today, 16), people: [ada.id] });
    notes.push({ id: "n1", date: d(1), text: "Long walk with Lena, talked about January", people: [lena.id] }, { id: "n2", date: d(2), text: "Omar sent a photo from the old flat", people: [omar.id] });
    var FN = ["Anna", "Ben", "Clara", "David", "Emil", "Freya", "Goran", "Hana", "Ivo", "Julia", "Karim", "Lotte", "Marek", "Nora", "Oskar", "Petra", "Rosa", "Sami", "Tilda", "Vera", "Willem", "Yara", "Zeno", "Alma", "Bruno", "Celia", "Dario", "Edda", "Finn", "Greta"],
      LN = ["Aalto", "Berger", "Castell", "Dahl", "Ekman", "Falk", "Gruber", "Holm", "Ivers", "Jansen", "Koller", "Lund", "Moreau", "Nyberg", "Olsen", "Pohl", "Quist", "Rieger", "Sander", "Thorn"], used = {};
    add({ name: "Ines Marlow", group: "", relationship: "Partner", circle: 5, quality: "ok" }); add({ name: "Rahel Stone", group: "", relationship: "Partner", circle: 5, quality: "ok" });
    [["Family", 9], ["Hometown", 12], ["University", 9], ["Work", 12], ["Climbing", 5], ["", 6]].forEach(function (gc) {
      var first = people.length, KR = [["mother"], ["brother"], ["grandmother", "maternal"], ["grandfather", "paternal"], ["uncle", "paternal"], ["cousin", "paternal"], ["cousin", "paternal"], ["cousin", "maternal"], []];
      for (var i = 0; i < gc[1]; i++) {
        var nm; do { nm = pick(FN) + " " + pick(LN); } while (used[nm]); used[nm] = 1;
        var r = rnd(), c = r < .08 ? 2 : r < .48 ? 3 : r < .88 ? 4 : 5, q = rnd();
        add({ name: nm, group: gc[0], kinRole: gc[0] === "Family" ? KR[i][0] || "" : "", kinSide: gc[0] === "Family" ? KR[i][1] || "" : "", relationship: gc[0] === "Family" ? "Family" : gc[0] === "Work" ? "Colleague" : "Friend", circle: c, quality: c <= 3 ? (q < .2 ? "strong" : q < .88 ? "ok" : "weak") : (q < .7 ? "ok" : "weak"), location: pick(["Leipzig", "Berlin", "Vienna", "Oslo", "Hamburg"]), lastContactAt: d(Math.round(c * c * 9 * (.3 + rnd() * 1.6))), lastContactKind: pick(["call", "met", "message"]) });
      }
      for (i = first; i < people.length; i++) if (rnd() < .7) link(people[i], people[first + Math.floor(rnd() * (people.length - first))]);
    });
    [lena, mira, omar, ada].forEach(function (x) { link(jonas, x, "strong"); }); link(lena, mira); link(nadia, tomas); link(nadia, mira, "strained");
    return { people: people, sits: sits, links: links, actions: actions, events: events, notes: notes, today: today };
  }

  window.PPPeopleCore = { RINGS: RINGS, QL: QL, EN: EN, KIND: KIND, RHYTHMS: RHYTHMS, MON: MON, RLINE: RLINE, build: build, pulse: pulse, layout: layout, linePath: linePath, arc: arc,
    sample: sample, KIN: KIN, KIN_SIDED: KIN_SIDED, SIDE: SIDE, groupColors: groupColors, fmtDay: fmtDay, ago: ago, inDays: inDays, rhythmText: rhythmText, dayNum: dayNum };
})();
