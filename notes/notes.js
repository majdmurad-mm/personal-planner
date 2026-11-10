/* Notes page: a reading list with a reader, filters, and a small overview. The app owns the data and the
   saving; this file only draws and reports what the user did through the callbacks passed to mount(). */
(function () {
  var N = window.PPNotes = window.PPNotes || {};
  var HUES = { angry: 0, sad: 11, frustrated: 22, stressed: 33, anxious: 44, tired: 55, neutral: 65, reflective: 76, calm: 87, hopeful: 98, proud: 109, grateful: 120, motivated: 132, joyful: 145 };
  var TYPES = [["reflection", "Reflections", "☼"], ["reference", "References", "§"], ["idea", "Ideas", "✦"], ["decision", "Decisions", "◆"]], AREAS = ["Health", "Finance", "Career", "Maintenance", "Growth", "Relationships", "Sol"], WEEKS = 26;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var pad = function (x) { return (x < 10 ? "0" : "") + x; };
  var iso = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  var day = function (s) { return new Date(s + "T00:00:00"); };
  var monday = function (d) { var x = new Date(d); x.setDate(x.getDate() - (x.getDay() + 6) % 7); x.setHours(0, 0, 0, 0); return x; };
  var fmtD = function (s, o) { return day(s).toLocaleDateString("en-GB", o || { weekday: "short", day: "numeric", month: "short" }); };
  var tip = function (t) { return ' data-tip="' + esc(t) + '"'; };
  /* 0 = most negative, 1 = most positive; null when a note has no mood tags (nothing is guessed) */
  N.valence = function (n) { var t = (n.sentiment || []).filter(function (x) { return HUES[x] != null; }); return t.length ? t.reduce(function (a, x) { return a + HUES[x]; }, 0) / t.length / 145 : null; };
  var moodWord = function (v) { return v == null ? "no mood tagged" : v < 0.3 ? "low" : v < 0.45 ? "rather low" : v <= 0.6 ? "even" : v <= 0.78 ? "rather good" : "good"; };
  var moodCss = function (v) { return v == null ? "background:none;border:1.5px dashed var(--mid)" : "background:color-mix(in oklab," + (v < 0.5 ? "var(--neg) " + Math.round((0.5 - v) * 200) : "var(--pos) " + Math.round((v - 0.5) * 200)) + "%,var(--mid))"; };
  var moodDot = function (n) { var v = N.valence(n); return n.type !== "reflection" && v == null ? "" : '<i class="mood" style="' + moodCss(v) + '" title="Mood: ' + moodWord(v) + '"></i>'; };
  var plain = function (t) { return String(t || "").replace(/[@#]\[([^\]]+)\]/g, "$1").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_`>~]/g, "").replace(/\s+/g, " ").trim(); };
  var typeOf = function (k) { return TYPES.filter(function (t) { return t[0] === k; })[0] || TYPES[0]; };
  var count = function (list, f) { var m = {}; list.forEach(function (n) { [].concat(f(n) || []).forEach(function (k) { if (k) m[k] = (m[k] || 0) + 1; }); }); return m; };

  /* ---------- filtering ---------- */
  function visible(S) {
    var q = S.q.trim().toLowerCase();
    return S.notes.filter(function (n) {
      if (S.type && n.type !== S.type) return false;
      if (S.area && (n.areas || []).indexOf(S.area) < 0) return false;
      if (S.link && !(n.links || []).some(function (l) { return l.label === S.link; })) return false;
      if (S.day && n.date !== S.day) return false;
      if (S.week && iso(monday(day(n.date))) !== S.week) return false;
      if (q && (n.title + " " + n.text + " " + (n.links || []).map(function (l) { return l.label; }).join(" ") + " " + (n.sentiment || []).join(" ")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  /* ---------- overview charts ---------- */
  function calendar(S) {
    var end = monday(S.now), start = new Date(end); start.setDate(start.getDate() - (WEEKS - 1) * 7);
    var per = count(S.notes, function (n) { return n.date; }), c = 13, g = 3, L = 22, T = 14, out = "", mlab = "", lastM = -1;
    for (var w = 0; w < WEEKS; w++) for (var d = 0; d < 7; d++) {
      var dt = new Date(start); dt.setDate(dt.getDate() + w * 7 + d); if (dt > S.now) continue;
      var k = iso(dt), nn = per[k] || 0;
      if (d === 0 && dt.getMonth() !== lastM) { lastM = dt.getMonth(); mlab += '<text class="ax" x="' + (L + w * (c + g)) + '" y="9">' + dt.toLocaleDateString("en-GB", { month: "short" }) + "</text>"; }
      out += '<rect class="day d' + Math.min(3, nn) + (S.day === k ? " on" : "") + '" data-day="' + k + '" tabindex="0" role="button" aria-label="' + fmtD(k) + ", " + nn + ' notes" x="' + (L + w * (c + g)) + '" y="' + (T + d * (c + g)) + '" width="' + c + '" height="' + c + '" rx="3"' + tip(fmtD(k, { weekday: "long", day: "numeric", month: "long" }) + "\n" + (nn ? nn + " note" + (nn > 1 ? "s" : "") : "nothing written")) + "/>";
    }
    var wd = ["M", "", "W", "", "F", "", "S"].map(function (x, i) { return x ? '<text class="ax" x="0" y="' + (T + i * (c + g) + 10) + '">' + x + "</text>" : ""; }).join("");
    return '<div class="viz"><p class="lab">When you wrote · ' + WEEKS + ' weeks</p><svg class="ch" viewBox="0 0 ' + (L + WEEKS * (c + g)) + " " + (T + 7 * (c + g)) + '" role="group" aria-label="Notes per day">' + mlab + wd + out + '</svg><div class="key"><span>Notes a day:</span><span><i style="background:var(--inset)"></i>0</span><span><i class="b3"></i>1</span><span><i class="b2"></i>2</span><span><i class="b1"></i>3+</span></div></div>';
  }
  N.moodByWeek = function (notes) { var w = {}; notes.forEach(function (n) { var v = N.valence(n); if (v == null) return; var k = iso(monday(day(n.date))); (w[k] = w[k] || []).push(v); }); return w; };
  function moodChart(S) {
    var end = monday(S.now), W = 412, H = 119, L = 22, R = 6, T = 14, B = 16, by = N.moodByWeek(S.notes), pts = [], path = "", pen = false;
    var x = function (i) { return L + 8 + i * (W - L - R - 16) / (WEEKS - 1); }, y = function (v) { return T + (1 - v) * (H - T - B); };
    for (var i = 0; i < WEEKS; i++) { var dt = new Date(end); dt.setDate(dt.getDate() - (WEEKS - 1 - i) * 7); var k = iso(dt), a = by[k]; if (!a) { pen = false; continue; } var v = a.reduce(function (p, q) { return p + q; }, 0) / a.length; path += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); pen = true; pts.push({ k: k, v: v, n: a.length, x: x(i), y: y(v) }); }
    if (!pts.length) return '<div class="viz"><p class="lab">Mood by week</p><p class="sub">No reflections with mood tags in the last ' + WEEKS + " weeks.</p></div>";
    return '<div class="viz"><p class="lab">Mood by week · reflections only</p><svg class="ch" viewBox="0 0 ' + W + " " + H + '" role="group" aria-label="Average mood of reflections per week">' +
      '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0.5) + '" y2="' + y(0.5) + '"/><text class="ax" x="0" y="' + (y(1) + 8) + '">good</text><text class="ax" x="0" y="' + (y(0.5) + 3.5) + '">even</text><text class="ax" x="0" y="' + y(0) + '">low</text><path class="mline" d="' + path + '"/>' +
      pts.map(function (p) { return '<circle class="mdot" data-week="' + p.k + '" tabindex="0" role="button" aria-label="Week of ' + fmtD(p.k) + ", mood " + moodWord(p.v) + '" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + (p.n > 2 ? 6.5 : p.n > 1 ? 5.5 : 4.5) + '" style="' + moodCss(p.v).replace("background", "fill") + '"' + tip("Week of " + fmtD(p.k, { day: "numeric", month: "long" }) + "\nMood: " + moodWord(p.v) + "\nFrom " + p.n + " reflection" + (p.n > 1 ? "s" : "")) + "/>"; }).join("") +
      '</svg><div class="key"><span><i class="mood" style="' + moodCss(0.1) + '"></i>low</span><span><i class="mood" style="' + moodCss(0.5) + '"></i>even</span><span><i class="mood" style="' + moodCss(0.95) + '"></i>good</span><span>Weeks without tagged reflections stay empty.</span></div></div>';
  }
  function ranked(m, attr, cur, max) {
    var rows = Object.keys(m).map(function (k) { return [k, m[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, max || 7), mx = rows.length ? rows[0][1] : 1;
    return rows.length ? '<div class="bars">' + rows.map(function (r) { return '<button class="bar" data-' + attr + '="' + esc(r[0]) + '" aria-pressed="' + (cur === r[0]) + '"><span class="n">' + esc(r[0]) + '</span><span class="tr"><i style="width:' + (r[1] / mx * 100).toFixed(0) + '%"></i></span><span class="c">' + r[1] + "</span></button>"; }).join("") + "</div>" : '<p class="sub">Nothing yet.</p>';
  }
  function mix(S) {
    var tc = count(S.notes, function (n) { return n.type; }), tot = S.notes.length || 1;
    var bar = TYPES.map(function (t, i) { return tc[t[0]] ? '<i class="b' + (i + 1) + '" style="flex:' + tc[t[0]] + '"' + tip(t[1] + "\n" + tc[t[0]] + " of " + tot + " notes") + "></i>" : ""; }).join("");
    return '<div class="viz"><p class="lab">Kinds of note</p><div class="stackbar" role="img" aria-label="Notes by type">' + bar + '</div><div class="key">' + TYPES.map(function (t, i) { return '<span><i class="b' + (i + 1) + '"></i>' + t[1] + " " + (tc[t[0]] || 0) + "</span>"; }).join("") + "</div></div>";
  }
  function linked(S) { return '<div class="viz"><p class="lab">Most linked</p>' + ranked(count(S.notes, function (n) { return (n.links || []).map(function (l) { return l.label; }); }), "link", S.link, 5) + "</div>"; }

  /* ---------- workspace ---------- */
  function rail(S) {
    var tc = count(S.notes, function (n) { return n.type; }), ac = count(S.notes, function (n) { return n.areas; });
    var f = function (attr, val, label, c, cur) { return '<button class="f" data-' + attr + '="' + esc(val) + '" aria-pressed="' + (cur === val) + '"><span>' + label + '</span><span class="c">' + c + "</span></button>"; };
    return '<aside class="rail"><input class="search" id="npQ" type="search" placeholder="Search notes" aria-label="Search notes" value="' + esc(S.q) + '">' +
      '<div class="fgroup"><p class="lab">Kind</p>' + f("type", "", "All notes", S.notes.length, S.type) + TYPES.map(function (t) { return f("type", t[0], t[2] + " " + t[1], tc[t[0]] || 0, S.type); }).join("") + "</div>" +
      '<div class="fgroup"><p class="lab">Area</p>' + AREAS.filter(function (a) { return ac[a]; }).map(function (a) { return f("area", a, a, ac[a], S.area); }).join("") + "</div></aside>";
  }
  function activeFilters(S) {
    var a = []; if (S.type) a.push(["type", typeOf(S.type)[1]]); if (S.area) a.push(["area", S.area]); if (S.link) a.push(["link", S.link]); if (S.day) a.push(["day", fmtD(S.day)]); if (S.week) a.push(["week", "Week of " + fmtD(S.week, { day: "numeric", month: "short" })]);
    return a.length ? '<div class="active">' + a.map(function (x) { return '<button class="pill" data-clear="' + x[0] + '" aria-label="Remove filter ' + esc(x[1]) + '">' + esc(x[1]) + " ✕</button>"; }).join("") + (a.length > 1 ? '<button class="pill" data-clear="all">Clear all</button>' : "") + "</div>" : "";
  }
  function list(S, V) {
    if (!V.length) return '<div class="list"><p class="none">' + (S.notes.length ? "No notes match these filters." : "No notes yet. Write the first one above.") + "</p></div>";
    var out = "", cur = "";
    V.forEach(function (n) {
      var m = n.date.slice(0, 7); if (m !== cur) { cur = m; out += '<div class="mon lab"><span>' + fmtD(m + "-01", { month: "long", year: "numeric" }) + "</span><span>" + V.filter(function (x) { return x.date.slice(0, 7) === m; }).length + "</span></div>"; }
      var t = typeOf(n.type), ex = plain(n.text);
      out += '<button class="row" data-id="' + esc(n.id) + '" aria-current="' + (S.sel === n.id) + '"><span class="meta"><span>' + fmtD(n.date) + (n.time ? " · " + n.time : "") + '</span><span class="right">' + (n.hasAudio ? '<span title="Has a recording">♪</span>' : "") + (n.type !== "reflection" ? '<span title="' + t[1] + '">' + t[2] + "</span>" : "") + moodDot(n) + '</span></span><span class="t">' + esc(n.title || ex.slice(0, 60) || "Untitled") + "</span>" + (ex && n.title ? '<span class="x">' + esc(ex.slice(0, 180)) + "</span>" : "") + "</button>";
    });
    return '<div class="list" id="npList" role="list" aria-label="Notes">' + out + "</div>";
  }
  function reader(S, o) {
    var n = S.notes.filter(function (x) { return x.id === S.sel; })[0];
    if (!n) return '<article class="reader"><p class="none">Pick a note to read it here.</p></article>';
    var t = typeOf(n.type), v = N.valence(n), body = o.bodyHtml ? o.bodyHtml(n) : "<p>" + esc(n.text).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
    return '<article class="reader" aria-label="Note"><button class="btn back" data-act="back">← All notes</button><p class="meta"><span>' + fmtD(n.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) + (n.time ? " · " + n.time : "") + '</span><span class="pill">' + t[2] + " " + t[1].replace(/s$/, "") + "</span>" + (n.priority ? '<span class="pill">' + esc(n.priority) + "</span>" : "") + (n.source ? '<span class="pill">via ' + esc(n.source) + "</span>" : "") + "</p>" +
      "<h2>" + esc(n.title || "Untitled") + "</h2>" +
      ((n.areas || []).length || (n.links || []).length ? '<p class="meta">' + (n.areas || []).map(function (a) { return '<button class="pill" data-area="' + esc(a) + '">' + esc(a) + "</button>"; }).join("") + (n.links || []).map(function (l) { return '<button class="pill" data-link="' + esc(l.label) + '">' + (l.kind === "person" ? "@" : "#") + esc(l.label) + "</button>"; }).join("") + "</p>" : "") +
      ((n.sentiment || []).length ? '<p class="meta"><i class="mood" style="' + moodCss(v) + '"></i><span>Mood: ' + moodWord(v) + "</span>" + n.sentiment.map(function (s) { return '<span class="pill">' + esc(s) + "</span>"; }).join("") + "</p>" : "") +
      (n.hasAudio ? '<p><button class="btn" data-act="play">♪ Play the recording</button></p>' : "") +
      '<div class="body">' + (body || '<p class="sub">This note has no text.</p>') + '</div><div class="acts"><button class="btn pri" data-act="edit">Edit</button>' + (n.type === "reflection" ? '<button class="btn" data-act="sentiment">Read the mood</button>' : "") + '<button class="btn" data-act="autofill">Fill in title and links</button><button class="btn" data-act="archive">Archive</button></div></article>';
  }
  function capture(S) {
    var opt = function (a, cur) { return a.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (x[0] === cur ? " selected" : "") + ">" + esc(x[1]) + "</option>"; }).join(""); };
    return '<form class="cap' + (S.cap ? " open" : "") + '" id="npCap"><div class="cap-row"><textarea id="npText" rows="1" placeholder="Write a note…" title="@ tags people, # tags goals" aria-label="New note">' + esc(S.draft.text) + '</textarea><button type="button" class="btn icon" data-act="record" title="Record a voice note">● Record</button><button type="submit" class="btn pri">Add note</button></div>' +
      '<div class="cap-more"><input class="in title" id="npTitle" placeholder="Title (optional)" aria-label="Title" value="' + esc(S.draft.title) + '"><input class="in" id="npDate" type="date" aria-label="Date" value="' + esc(S.draft.date) + '"><input class="in" id="npTime" type="time" aria-label="Time" value="' + esc(S.draft.time) + '">' +
      '<select class="in" id="npType" aria-label="Kind of note">' + opt(TYPES.map(function (t) { return [t[0], t[2] + " " + t[1].replace(/s$/, "")]; }), S.draft.type) + '</select><select class="in" id="npArea" aria-label="Area">' + opt([["", "No area"]].concat(AREAS.map(function (a) { return [a, a]; })), S.draft.area) + '</select><select class="in" id="npPri" aria-label="Priority">' + opt([["", "No priority"], ["P0", "P0"], ["P1", "P1"], ["P2", "P2"], ["P3", "P3"]], S.draft.priority) + "</select></div></form>";
  }
  function moodMap(S, V) {
    var by = {}, un = 0; V.forEach(function (n) { var v = N.valence(n); if (v == null) { un++; return; } var k = iso(monday(day(n.date))); (by[k] = by[k] || []).push({ n: n, v: v }); });
    var keys = Object.keys(by).sort().reverse();
    return '<section class="panel"><div><p class="lab">Mood map</p><p class="sub">One dot per note that has mood tags, by week. Left is low, right is good. ' + (un ? un + " note" + (un > 1 ? "s have" : " has") + " no mood tags and " + (un > 1 ? "are" : "is") + " not placed." : "") + '</p></div><div class="axis"><span></span><div><span>low</span><span>even</span><span>good</span></div></div>' +
      (keys.length ? keys.map(function (k) { return '<div class="wk"><span>' + fmtD(k, { day: "numeric", month: "short" }) + '</span><div class="lane">' + by[k].map(function (p) { return '<button data-id="' + esc(p.n.id) + '" data-goto="1" style="left:' + (4 + p.v * 92).toFixed(1) + "%;" + moodCss(p.v) + '" aria-label="' + esc(p.n.title || "Untitled") + '"' + tip((p.n.title || "Untitled") + "\n" + fmtD(p.n.date) + " · mood " + moodWord(p.v)) + "></button>"; }).join("") + "</div></div>"; }).join("") : '<p class="none">No notes with mood tags match.</p>') + "</section>";
  }
  function recordings(S) {
    var r = S.recs.slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    return '<section class="panel"><p class="lab">Recordings · ' + r.length + "</p>" + (r.length ? r.map(function (x) { var d = new Date(x.createdAt); return '<div class="rec"><button class="btn" data-play="' + esc(x.id) + '">♪ Play</button><div><p>' + (isNaN(d) ? "" : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })) + ' <span class="sub">· ' + (x.noteTitle ? "attached to “" + esc(x.noteTitle) + "”" : "not attached to a note") + '</span></p><p class="sub">' + (x.transcript ? esc(x.transcript.slice(0, 260)) : "No transcript yet.") + '</p><p style="margin-top:6px"><button class="pill" data-transcribe="' + esc(x.id) + '">' + (x.transcript ? "Transcribe again" : "Transcribe") + "</button></p></div></div>"; }).join("") : '<p class="none">No recordings yet. Use the microphone above to record one.</p>') + "</section>";
  }

  N.mount = function (host, o) {
    o = o || {};
    var root = host.shadowRoot || host.attachShadow({ mode: "open" }), now = o.now || new Date();
    var sortN = function (a) { return a.slice().sort(function (x, y) { return x.date !== y.date ? y.date.localeCompare(x.date) : String(y.time || "").localeCompare(String(x.time || "")); }); };
    var S = { notes: sortN(o.notes || []), recs: o.recordings || [], now: now, q: "", type: "", area: "", link: "", day: "", week: "", sel: null, view: "list", cap: false, ov: o.overviewOpen !== false, sample: !!o.sample,
      draft: { text: "", title: "", date: iso(now), time: pad(now.getHours()) + ":" + pad(now.getMinutes()), type: "reflection", area: "", priority: "" } };
    var theme = o.theme === "dark" || o.theme === "light" ? o.theme : (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    var narrow = function () { return host.getBoundingClientRect().width < 700; };
    if (S.notes.length && !narrow()) S.sel = S.notes[0].id;
    if (narrow() && o.overviewOpen !== true) S.ov = false;
    root.innerHTML = '<link rel="stylesheet" href="' + (o.css || "notes/notes.css") + '"><div class="np"></div>';
    var np = root.querySelector(".np");
    function draw(keep) {
      var V = visible(S), act = root.activeElement, fid = keep && act && act.id, pos = fid && act.selectionStart, lst = root.querySelector("#npList"), st = lst ? lst.scrollTop : 0;
      if (S.sel && !V.some(function (n) { return n.id === S.sel; }) && S.view === "list") S.sel = V.length && !narrow() ? V[0].id : null;
      np.dataset.theme = theme; if (S.open) np.dataset.open = "1"; else delete np.dataset.open;
      var seg = [["list", "List"], ["map", "Mood map"], ["recordings", "Recordings"]].map(function (v) { return '<button data-view="' + v[0] + '" aria-pressed="' + (S.view === v[0]) + '">' + v[1] + "</button>"; }).join("");
      np.innerHTML = (S.sample ? '<div class="ribbon" role="note"><b>SAMPLE NOTES</b> · invented text to show the page · nothing below is yours</div>' : "") + '<div class="wrap"><header class="top"><div class="title"><p class="eyebrow">Notes</p><h1>' + S.notes.length + " note" + (S.notes.length === 1 ? "" : "s") + '</h1></div><div class="seg" role="group" aria-label="View">' + seg + "</div></header>" + capture(S) +
        (S.view === "recordings" ? recordings(S) : '<details class="ov"' + (S.ov ? " open" : "") + '><summary><span class="lab">Overview</span><span class="sub">Click a day, a week, an area or a name to filter the notes.</span></summary><div class="ov-grid">' + calendar(S) + moodChart(S) + mix(S) + linked(S) + "</div></details>" +
          (S.view === "map" ? activeFilters(S) + moodMap(S, V) : '<div class="work">' + rail(S) + '<div style="display:grid;gap:10px;align-content:start;min-width:0">' + activeFilters(S) + list(S, V) + "</div>" + reader(S, o) + "</div>")) + '</div><div class="tip" id="npTip" hidden></div>';
      if (fid) { var el = root.getElementById(fid); if (el) { el.focus(); if (pos != null && el.setSelectionRange) try { el.setSelectionRange(pos, pos); } catch (e) {} } }
      var l2 = root.querySelector("#npList"); if (l2) l2.scrollTop = st;
    }
    var call = function (name, a) { if (o[name]) return o[name](a); };
    var selNote = function () { return S.notes.filter(function (x) { return x.id === S.sel; })[0]; };
    np.addEventListener("click", function (e) {
      var t = e.target.closest("button,[data-day],[data-week]"); if (!t) return; var d = t.dataset;
      if (d.view) { S.view = d.view; S.open = false; }
      else if (d.id) { S.sel = d.id; if (d.goto) S.view = "list"; S.open = true; call("onOpen", selNote()); }
      else if (d.type != null) S.type = S.type === d.type ? "" : d.type;
      else if (d.area) S.area = S.area === d.area ? "" : d.area;
      else if (d.link) S.link = S.link === d.link ? "" : d.link;
      else if (d.day) { S.day = S.day === d.day ? "" : d.day; S.week = ""; }
      else if (d.week) { S.week = S.week === d.week ? "" : d.week; S.day = ""; }
      else if (d.clear) { if (d.clear === "all") S.type = S.area = S.link = S.day = S.week = ""; else S[d.clear] = ""; }
      else if (d.play) { call("onPlay", d.play); return; }
      else if (d.transcribe) { call("onTranscribe", d.transcribe); return; }
      else if (d.act === "back") S.open = false;
      else if (d.act === "record") { call("onRecord"); return; }
      else if (d.act) { var n = selNote(); if (n) call({ edit: "onEdit", sentiment: "onSentiment", autofill: "onAutoFill", archive: "onArchive", play: "onPlayNote" }[d.act], n); return; }
      else return;
      draw();
    });
    np.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("[data-day],[data-week]")) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.target.classList && e.target.classList.contains("row")) { e.preventDefault(); var r = [].slice.call(root.querySelectorAll(".row")), i = r.indexOf(e.target) + (e.key === "ArrowDown" ? 1 : -1); if (r[i]) { S.sel = r[i].dataset.id; draw(); var x = root.querySelector('.row[data-id="' + S.sel + '"]'); if (x) x.focus(); } }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.id === "npText") { e.preventDefault(); root.getElementById("npCap").requestSubmit(); }
    });
    np.addEventListener("input", function (e) {
      var id = e.target.id; if (id === "npQ") { S.q = e.target.value; draw(true); return; }
      var m = { npText: "text", npTitle: "title", npDate: "date", npTime: "time", npType: "type", npArea: "area", npPri: "priority" }[id]; if (m) S.draft[m] = e.target.value;
    });
    np.addEventListener("focusin", function (e) { if (e.target.id === "npText" && !S.cap) { S.cap = true; root.getElementById("npCap").classList.add("open"); } });
    np.addEventListener("submit", function (e) {
      e.preventDefault(); if (!S.draft.text.trim()) { root.getElementById("npText").focus(); return; }
      var p = JSON.parse(JSON.stringify(S.draft)); Promise.resolve(call("onSave", p)).then(function (ok) { if (ok === false) return; S.draft.text = ""; S.draft.title = ""; S.cap = false; draw(); });
    });
    np.addEventListener("toggle", function (e) { if (e.target.classList && e.target.classList.contains("ov")) { S.ov = e.target.open; call("onOverview", S.ov); } }, true);
    var tipEl = function () { return root.getElementById("npTip"); };
    np.addEventListener("pointermove", function (e) {
      var el = e.target.closest && e.target.closest("[data-tip]"), tp = tipEl(); if (!tp) return; if (!el) { tp.hidden = true; return; }
      tp.textContent = el.getAttribute("data-tip"); tp.hidden = false; var hr = np.getBoundingClientRect();
      tp.style.left = Math.max(8, Math.min(e.clientX - hr.left + 14, hr.width - tp.offsetWidth - 8)) + "px"; tp.style.top = Math.max(8, e.clientY - hr.top - tp.offsetHeight - 10) + "px";
    });
    np.addEventListener("pointerleave", function () { var tp = tipEl(); if (tp) tp.hidden = true; });
    draw();
    return {
      update: function (u) { if (u.notes) S.notes = sortN(u.notes); if (u.recordings) S.recs = u.recordings; if (u.theme) theme = u.theme; if (u.select) { S.sel = u.select; S.view = "list"; } draw(true); },
      state: function () { return { view: S.view, sel: S.sel }; }
    };
  };
})();
