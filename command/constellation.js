/* Command Center → Big picture → the constellation. The whole life structure as connected dots, drawn in the
   People constellation's language (night sky, dotted rings, glowing discs, stroked labels):
   areas sit in fixed sectors around you; goals inside their area (size = priority, ring = score); projects orbit
   their goal with a progress arc; tasks are small dots around their project or goal. Tasks and projects with no
   parent float loose in their area with a dashed outline; tasks with no area sit in the grey "No area" sector.
   The layout is a seeded force pass inside fixed sectors, so it is the same on every visit for the same data.
   Hover highlights a branch; click opens the item; drag a task onto a project or goal to move it there, or onto
   empty space in an area to leave it loose there. Area labels zoom into their cluster; Fit and Esc zoom out. */
(function () {
  var V = window.PPCommandView, C = window.PPCommandCore;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var KEYS = ["work", "task", "health", "growth", "people", "sol", "none"];     // fixed sectors, clockwise from the top
  var AREA_DEFAULT = { work: "Career", task: "Maintenance", health: "Health", growth: "Growth", people: "Relationships", sol: "Sol", none: "" };
  var R = 520, R0 = 92, SEC = 360 / KEYS.length;
  var PRI_R = { P0: 21, P1: 17, P2: 14, P3: 12 };
  var col = function (k) { return k === "sol" ? "var(--cn-sol)" : "var(--area-" + k + ")"; };
  var rad = function (deg) { return (deg - 90) * Math.PI / 180; };
  var polar = function (r, deg) { return [Math.cos(rad(deg)) * r, Math.sin(rad(deg)) * r]; };
  var fmtD = function (d) { return d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""; };
  var hashN = function (s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };

  /* ---------- model: who hangs under whom ---------- */
  V.cnModel = function (S) {
    var all = (S.allItems || S.items || []).filter(function (i) { return !i.archived && i.kind !== "event"; });
    var showDone = !!S.cnDone, t = S.today;
    var isDone = function (i) { return !i.recurrence && !!i.done; };
    var items = all.filter(function (i) { return showDone || !isDone(i); });
    var goals = (S.goals || []).slice(), projects = (S.projects || []).slice();
    var N = {}, nodes = [], links = [];
    var add = function (n) { N[n.id] = n; nodes.push(n); return n; };
    goals.forEach(function (g) { add({ id: "g:" + g.id, ref: g.id, type: "goal", key: C.areaKey(g.area), key2: g.area2 ? C.areaKey(g.area2) : null, title: g.title, g: g, r: PRI_R[g.priority] || PRI_R.P2, kids: [] }); });
    // a project's area is its goal's; a project without a goal takes the area most of its tasks share
    projects.forEach(function (p) {
      var gn = p.goalId && N["g:" + p.goalId], key = gn ? gn.key : null;
      if (!key) { var cnt = {}; all.forEach(function (i) { if (i.projectId === p.id) { var k = C.areaKey(i.area); cnt[k] = (cnt[k] || 0) + 1; } }); key = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; })[0] || "none"; }
      var n = add({ id: "p:" + p.id, ref: p.id, type: "project", key: key, title: p.title, p: p, r: 7.5, parent: gn ? gn.id : null, orphan: !gn, kids: [] });
      if (gn) { gn.kids.push(n.id); links.push({ a: gn.id, b: n.id, kind: "gp" }); }
    });
    items.forEach(function (i) {
      var pn = i.projectId && N["p:" + i.projectId], gn = !pn && i.goalId && N["g:" + i.goalId], par = pn || gn || null;
      var key = par ? par.key : C.areaKey(i.area);
      var late = !isDone(i) && !i.someday && i.date && i.date < t && C.hasDone(i), today = !isDone(i) && i.date === t;
      var n = add({ id: "t:" + i.id, ref: i.id, type: "task", key: key, title: i.title, i: i, r: 3.4, parent: par ? par.id : null, orphan: !par, done: isDone(i), someday: !!i.someday, late: late, today: today, main: S.mainId === i.id, kids: [] });
      if (par) { par.kids.push(n.id); links.push({ a: par.id, b: n.id, kind: pn ? "pt" : "gt" }); }
    });
    // goal states: open work under it, empty, no next step
    nodes.forEach(function (n) {
      if (n.type !== "goal") return;
      var openN = 0, any = 0;
      var walk = function (id) { var x = N[id]; x.kids.forEach(function (k) { var y = N[k]; any++; if (y.type === "task" && !y.done) openN++; walk(k); }); };
      walk(n.id);
      var allUnder = all.filter(function (i) { return i.goalId === n.ref; }), openAll = allUnder.filter(function (i) { return !isDone(i); }).length;
      n.empty = !allUnder.length && !n.kids.some(function (k) { return N[k].type === "project"; });
      n.noNext = !n.empty && !openAll;
      n.score = n.empty ? null : (n.g.score == null ? null : Math.max(0, Math.min(100, +n.g.score)));
      n.openN = openAll;
    });
    nodes.forEach(function (n) {
      if (n.type !== "project") return;
      var p = n.p; n.prog = p.total ? (p.doneCount || 0) / p.total : null; n.openN = all.filter(function (i) { return i.projectId === p.id && !isDone(i); }).length;
    });
    return { N: N, nodes: nodes, links: links, hiddenDone: all.filter(isDone).length };
  };

  /* ---------- layout: fixed sectors, a seeded force pass inside each ---------- */
  V.cnLayout = function (M) {
    var bySec = {}; KEYS.forEach(function (k) { bySec[k] = []; }); M.nodes.forEach(function (n) { (bySec[n.key] || bySec.none).push(n); });
    KEYS.forEach(function (k, si) {
      var a0 = si * SEC, a1 = a0 + SEC, mid = a0 + SEC / 2, list = bySec[k];
      var goals = list.filter(function (n) { return n.type === "goal"; }).sort(function (a, b) { return (a.g.priority || "P9") < (b.g.priority || "P9") ? -1 : (a.g.priority || "P9") > (b.g.priority || "P9") ? 1 : a.ref < b.ref ? -1 : 1; });
      // goals: one arc for up to three, two staggered arcs beyond
      goals.forEach(function (g, i) {
        var two = goals.length > 3, row = two ? i % 2 : 0, perRow = two ? Math.ceil(goals.length / 2) : goals.length, j = two ? Math.floor(i / 2) : i;
        var span = SEC - 14, deg = perRow === 1 ? mid : a0 + 7 + span * (j + 0.5) / perRow, r = two ? (row ? 400 : 255) : 315;
        var p = polar(r, deg); g.x = g.hx = p[0]; g.y = g.hy = p[1];
      });
      // children around their parent, deterministic order
      var place = function (par, kids, dist, step) {
        var out = Math.atan2(par.y, par.x);
        kids.forEach(function (c, i) { var a = out + (i * 2.39996) + (c.type === "project" ? 0 : 0.6), d = dist + step * Math.sqrt(i); c.x = c.hx = par.x + Math.cos(a) * d; c.y = c.hy = par.y + Math.sin(a) * d; });
      };
      goals.forEach(function (g) {
        var ps = g.kids.map(function (id) { return M.N[id]; }).filter(function (x) { return x.type === "project"; }), ts = g.kids.map(function (id) { return M.N[id]; }).filter(function (x) { return x.type === "task"; });
        place(g, ps, g.r + 46, 9); place(g, ts, g.r + 20, 7);
        ps.forEach(function (p) { place(p, p.kids.map(function (id) { return M.N[id]; }), 17, 5); });
      });
      // loose things: a pocket near the inner edge of the sector
      var loose = list.filter(function (n) { return n.orphan; }), pocket = polar(R0 + 70, mid);
      loose.forEach(function (n, i) { var a = i * 2.39996, d = 10 + 9 * Math.sqrt(i); n.x = n.hx = pocket[0] + Math.cos(a) * d; n.y = n.hy = pocket[1] + Math.sin(a) * d; });
      loose.filter(function (n) { return n.type === "project"; }).forEach(function (p) { place(p, p.kids.map(function (id) { return M.N[id]; }), 15, 5); });
      // relax: push overlapping nodes apart, pull each back towards its home, keep it inside its sector
      var pad = 3;
      for (var it = 0; it < 70; it++) {
        for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) {
          var A = list[i], B = list[j], dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01, need = A.r + B.r + pad + (A.type === "goal" || B.type === "goal" ? 6 : 0);
          if (d < need) { var push = (need - d) / 2, ux = dx / d, uy = dy / d, wa = A.type === "goal" ? 0.25 : 1, wb = B.type === "goal" ? 0.25 : 1; A.x -= ux * push * wa; A.y -= uy * push * wa; B.x += ux * push * wb; B.y += uy * push * wb; }
        }
        list.forEach(function (n) {
          var k = n.type === "goal" ? 0.08 : 0.04; n.x += (n.hx - n.x) * k; n.y += (n.hy - n.y) * k;
          var r = Math.sqrt(n.x * n.x + n.y * n.y), deg = (Math.atan2(n.y, n.x) * 180 / Math.PI + 90 + 360) % 360, lo = a0 + 1.5, hi = a1 - 1.5;
          if (deg < lo || deg > hi) { deg = Math.abs(deg - lo) < Math.abs(deg - hi) || (deg > a1 && deg - a1 > 180) ? lo : hi; var p = polar(r, deg); n.x = p[0]; n.y = p[1]; }
          if (r < R0 + 10 || r > R - 26) { var rr = Math.max(R0 + 10, Math.min(R - 26, r)), d2 = (Math.atan2(n.y, n.x) * 180 / Math.PI + 90 + 360) % 360, p2 = polar(rr, d2); n.x = p2[0]; n.y = p2[1]; }
        });
      }
    });
    return M;
  };

  /* ---------- drawing ---------- */
  function ring(cx, cy, r, frac, cls, k) {
    if (frac == null) return "";
    var c = 2 * Math.PI * r; return '<circle class="' + cls + '" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r.toFixed(1) + '" style="stroke:' + col(k) + ";stroke-dasharray:" + (c * frac).toFixed(1) + " " + c.toFixed(1) + '" transform="rotate(-90 ' + cx.toFixed(1) + " " + cy.toFixed(1) + ')"/>';
  }
  var star = function (x, y, s) { var p = []; for (var i = 0; i < 10; i++) { var a = Math.PI / 5 * i - Math.PI / 2, r = i % 2 ? s * 0.45 : s; p.push((x + Math.cos(a) * r).toFixed(1) + "," + (y + Math.sin(a) * r).toFixed(1)); } return '<polygon class="cn-star" points="' + p.join(" ") + '"/>'; };
  V.cnSvg = function (S, M, narrow) {
    var h = "", zk = S.cnCam ? (2 * R + 128) / S.cnCam[2] : 1, showTasks = !narrow || zk >= 1.8;
    // sky: faint stars, dotted rings, sector spokes and area labels on the rim
    var z = 7211; for (var i = 0; i < 170; i++) { z = (z * 16807) % 2147483647; var bx = z % 1160 - 580; z = (z * 16807) % 2147483647; var by = z % 1160 - 580; h += '<circle class="cn-bg" cx="' + bx + '" cy="' + by + '" r="' + (0.5 + (z % 10) / 10).toFixed(2) + '"/>'; }
    [R0, 220, 360, R - 10].forEach(function (r) { h += '<circle class="cn-ringc" r="' + r + '"/>'; });
    var used = {}; M.nodes.forEach(function (n) { used[n.key] = (used[n.key] || 0) + 1; });
    h += "<defs>";
    KEYS.forEach(function (k, si) { var a0 = si * SEC, mid = a0 + SEC / 2, rev = mid > 90 && mid < 270, half = SEC / 2 - 4, lr = rev ? R + 42 : R + 16, p0 = polar(lr, rev ? mid + half : mid - half), p1 = polar(lr, rev ? mid - half : mid + half); h += '<path id="cnA' + si + '" d="M' + p0[0].toFixed(1) + " " + p0[1].toFixed(1) + " A" + lr + " " + lr + " 0 0 " + (rev ? 0 : 1) + " " + p1[0].toFixed(1) + " " + p1[1].toFixed(1) + '"/>'; });
    h += "</defs>";
    KEYS.forEach(function (k, si) {
      var a0 = si * SEC, s0 = polar(R0, a0), s1 = polar(R - 4, a0), fade = S.areaFilter && S.areaFilter !== k ? " fade" : "";
      h += '<line class="cn-spoke" x1="' + s0[0].toFixed(1) + '" y1="' + s0[1].toFixed(1) + '" x2="' + s1[0].toFixed(1) + '" y2="' + s1[1].toFixed(1) + '"/>';
      h += '<path class="cn-arc' + fade + '" style="stroke:' + col(k) + '" d="M' + polar(R, a0 + 2).map(function (v) { return v.toFixed(1); }).join(" ") + " A" + R + " " + R + " 0 0 1 " + polar(R, a0 + SEC - 2).map(function (v) { return v.toFixed(1); }).join(" ") + '"/>';
      h += '<text class="cn-alab' + fade + (used[k] ? "" : " none") + '" data-cnarea="' + k + '" tabindex="0" role="button" aria-label="Zoom into ' + esc(C.AREA_NAME[k]) + '" style="fill:' + col(k) + '"><textPath href="#cnA' + si + '" startOffset="50%" text-anchor="middle">' + esc(C.AREA_NAME[k].toUpperCase()) + (used[k] ? "" : " · empty") + "</textPath></text>";
    });
    // links
    M.links.forEach(function (l) {
      var a = M.N[l.a], b = M.N[l.b]; if (b.type === "task" && !showTasks) return;
      h += '<line class="cn-ln ' + l.kind + (S.areaFilter && S.areaFilter !== a.key ? " fade" : "") + '" data-a="' + esc(a.id) + '" data-b="' + esc(b.id) + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '" style="stroke:' + col(a.key) + '"/>';
    });
    // a goal's second area: a faint dashed line towards that area's cluster
    M.nodes.forEach(function (n) {
      if (n.type !== "goal" || !n.key2 || n.key2 === n.key) return; var si = KEYS.indexOf(n.key2), p = polar(300, si * SEC + SEC / 2);
      h += '<line class="cn-ln sec' + (S.areaFilter && S.areaFilter !== n.key && S.areaFilter !== n.key2 ? " fade" : "") + '" data-a="' + esc(n.id) + '" x1="' + n.x.toFixed(1) + '" y1="' + n.y.toFixed(1) + '" x2="' + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '" style="stroke:' + col(n.key2) + '"/>';
    });
    // you, in the middle
    h += '<g class="cn-me"><circle class="cn-pulse" r="34"/><circle class="cn-medisc" r="24"/><text dy=".35em">You</text></g>';
    // nodes: tasks first, then projects, then goals on top
    var order = { task: 0, project: 1, goal: 2 };
    M.nodes.slice().sort(function (a, b) { return order[a.type] - order[b.type]; }).forEach(function (n) {
      if (n.type === "task" && !showTasks) return;
      var x = n.x.toFixed(1), y = n.y.toFixed(1), c = col(n.key), fade = S.areaFilter && S.areaFilter !== n.key && S.areaFilter !== n.key2 ? " fade" : "";
      var cls = "cn-n " + n.type + fade + (n.orphan ? " orphan" : "") + (n.done ? " done" : "") + (n.someday ? " someday" : "") + (n.late ? " late" : "") + (n.today ? " today" : "") + (n.empty ? " empty" : "") + (n.noNext ? " nonext" : "");
      var label = n.type === "goal" ? "Goal" : n.type === "project" ? "Project" : n.i.kind === "deadline" ? "Deadline" : n.i.kind === "block" ? "Time block" : "Task";
      h += '<g class="' + cls + '" data-cn="' + esc(n.id) + '" tabindex="0" role="button" aria-label="' + esc(label + ": " + n.title) + '" style="--c:' + c + '" transform="translate(' + x + "," + y + ')">';
      if (n.type === "goal") {
        h += '<circle class="cn-halo" r="' + (n.r + 16) + '"/><circle class="cn-hit" r="' + (n.r + 8) + '"/>';
        h += '<circle class="cn-track" r="' + (n.r + 5) + '"/>' + ring(0, 0, n.r + 5, n.score == null ? null : n.score / 100, "cn-score", n.key);
        h += '<circle class="cn-disc" r="' + n.r + '"/>';
        if (n.noNext) h += '<g class="cn-flag" transform="translate(' + (n.r * 0.8).toFixed(1) + "," + (-n.r * 0.8).toFixed(1) + ')"><circle r="6"/><text dy=".35em">!</text></g>';
        if (narrow && !showTasks && n.openN) h += '<g class="cn-count" transform="translate(' + (-n.r * 0.85).toFixed(1) + "," + (n.r * 0.85).toFixed(1) + ')"><rect x="-9" y="-7" width="18" height="14" rx="7"/><text dy=".35em">' + n.openN + "</text></g>";
        h += '<text class="cn-nm g" y="' + (n.r + 19) + '">' + esc(n.title.length > 28 ? n.title.slice(0, 27) + "…" : n.title) + "</text>";
      } else if (n.type === "project") {
        h += '<circle class="cn-hit" r="' + (n.r + 7) + '"/><circle class="cn-track" r="' + (n.r + 3) + '"/>' + ring(0, 0, n.r + 3, n.prog, "cn-prog", n.key) + '<circle class="cn-disc" r="' + n.r + '"/>';
        if (narrow && !showTasks && n.openN) h += '<g class="cn-count" transform="translate(' + (n.r + 6) + "," + (-n.r - 2) + ')"><rect x="-8" y="-6.5" width="16" height="13" rx="6.5"/><text dy=".35em">' + n.openN + "</text></g>";
        if (!narrow || zk >= 1.4) h += '<text class="cn-nm p" y="' + (n.r + 14) + '">' + esc(n.title.length > 24 ? n.title.slice(0, 23) + "…" : n.title) + "</text>";
      } else {
        h += '<circle class="cn-hit" r="8"/>' + (n.i.kind === "deadline" ? '<rect class="cn-disc" x="-3.4" y="-3.4" width="6.8" height="6.8" transform="rotate(45)"/>' : '<circle class="cn-disc" r="' + n.r + '"/>');
        if (n.late || n.today) h += '<circle class="cn-st" r="' + (n.r + 2.6) + '"/>';
        if (n.main) h += star(0, -9, 4.2);
      }
      h += "</g>";
    });
    return h;
  };

  /* the section: toolbar, the sky, the legend, a tooltip */
  V.cnHtml = function (S) {
    var M = V.cnLayout(V.cnModel(S)); S.cnM = M;
    var narrow = !!S.cnNarrow, vb = S.cnCam || [-R - 64, -R - 64, 2 * R + 128, 2 * R + 128];
    var g = M.nodes.filter(function (n) { return n.type === "goal"; }).length, p = M.nodes.filter(function (n) { return n.type === "project"; }).length, t = M.nodes.filter(function (n) { return n.type === "task"; }).length, loose = M.nodes.filter(function (n) { return n.orphan; }).length;
    return '<section class="cn" id="cnSec" aria-label="Your life as a constellation"><div class="cn-bar"><div><p class="cn-k">The constellation</p><p class="cn-sum">' + g + (g === 1 ? " goal" : " goals") + " · " + p + (p === 1 ? " project" : " projects") + " · " + t + (t === 1 ? " task" : " tasks") + (loose ? " · " + loose + " loose" : "") + '</p></div><div class="cn-tools"><input class="cn-find" id="cnFind" type="search" placeholder="Find in the map" aria-label="Find in the map" value="' + esc(S.cnQ || "") + '"><button class="cn-b" data-cnact="done" aria-pressed="' + !!S.cnDone + '">' + (S.cnDone ? "Hide done" : "Show done" + (M.hiddenDone ? " (" + M.hiddenDone + ")" : "")) + '</button><span class="cn-zoom" role="group" aria-label="Zoom"><button class="cn-b" data-cnact="out" aria-label="Zoom out">−</button><button class="cn-b" data-cnact="in" aria-label="Zoom in">+</button><button class="cn-b" data-cnact="fit">Fit</button></span></div></div>' +
      '<div class="cn-wrap" id="cnWrap"><svg id="cnSvg" tabindex="0" viewBox="' + vb.map(function (v) { return v.toFixed(1); }).join(" ") + '" role="group" aria-label="Areas, goals, projects and tasks. Click an area name to zoom in; Esc zooms out.">' + V.cnSvg(S, M, narrow) + "</svg>" +
      '<div class="cn-tip" id="cnTip" role="status" hidden></div>' +
      '<details class="cn-leg"' + (S.cnLegOpen ? " open" : "") + '><summary>Legend</summary><ul>' +
      '<li><svg viewBox="-12 -12 24 24"><circle class="lg-score" r="9"/><circle class="lg-disc" r="6"/></svg>Goal: size = priority, ring = score</li>' +
      '<li><svg viewBox="-12 -12 24 24"><circle class="lg-score" r="7"/><circle class="lg-disc" r="4.5"/></svg>Project: ring = tasks done</li>' +
      '<li><svg viewBox="-12 -12 24 24"><circle class="lg-disc" r="3.4"/></svg>Task · <svg viewBox="-12 -12 24 24"><circle class="lg-hollow" r="3.4"/></svg>someday</li>' +
      '<li><svg viewBox="-12 -12 24 24"><circle class="lg-disc" r="3.4"/><circle class="lg-late" r="6"/></svg>Overdue · <svg viewBox="-12 -12 24 24"><circle class="lg-disc" r="3.4"/><circle class="lg-today" r="6"/></svg>due today</li>' +
      '<li><svg viewBox="-12 -12 24 24"><polygon class="cn-star" points="0,-6 1.4,-1.9 5.7,-1.9 2.3,0.7 3.5,4.9 0,2.4 -3.5,4.9 -2.3,0.7 -5.7,-1.9 -1.4,-1.9"/></svg>Today’s main thing</li>' +
      '<li><svg viewBox="-12 -12 24 24"><circle class="lg-flag" r="6"/><text dy=".35em" class="lg-flagt">!</text></svg>Goal with no next step</li>' +
      '<li><svg viewBox="-12 -12 24 24"><circle class="lg-empty" r="7"/></svg>Empty goal (nothing under it, no score)</li>' +
      '<li><svg viewBox="-12 -12 24 24"><circle class="lg-orphan" r="6"/><circle class="lg-disc" r="3.4"/></svg>Loose: no goal or project</li>' +
      '<li><svg viewBox="0 0 24 12"><line class="lg-ln" x1="1" y1="6" x2="23" y2="6"/></svg>Belongs to · <svg viewBox="0 0 24 12"><line class="lg-ln2" x1="1" y1="6" x2="23" y2="6"/></svg>second area</li>' +
      '<li class="tip">Drag a task onto a project or goal to move it there, or onto empty space in an area to leave it loose.</li></ul></details></div></section>';
  };

  /* ---------- behaviour: hover, click, drag to move, zoom and pan ---------- */
  V.cnMount = function (root, S, api) {
    var wrap = root.getElementById("cnWrap"), svg = root.getElementById("cnSvg"), tip = root.getElementById("cnTip"); if (!wrap || !svg) return;
    var M = S.cnM, FULL = [-R - 64, -R - 64, 2 * R + 128, 2 * R + 128];
    var narrowNow = wrap.getBoundingClientRect().width < 1000;
    if (narrowNow !== !!S.cnNarrow) { S.cnNarrow = narrowNow; api.redraw(); return; }
    var cam = function () { return S.cnCam || FULL.slice(); };
    var setCam = function (v, animate) {
      var lim = function (x) { var w = Math.max(FULL[2] / 6, Math.min(FULL[2], x[2])), h = w, cx = Math.max(FULL[0] + w / 2, Math.min(FULL[0] + FULL[2] - w / 2, x[0] + x[2] / 2)), cy = Math.max(FULL[1] + h / 2, Math.min(FULL[1] + FULL[3] - h / 2, x[1] + x[3] / 2)); return [cx - w / 2, cy - h / 2, w, h]; };
      var to = lim(v), from = cam(), was = (2 * R + 128) / from[2], k1 = (2 * R + 128) / to[2], step = function (f) { var c = from.map(function (a, i) { return a + (to[i] - a) * f; }); svg.setAttribute("viewBox", c.map(function (x) { return x.toFixed(1); }).join(" ")); };
      S.cnCam = Math.abs(to[2] - FULL[2]) < 1 && Math.abs(to[0] - FULL[0]) < 1 ? null : to;
      var crossing = S.cnNarrow && ((was >= 1.8) !== (k1 >= 1.8) || (was >= 1.4) !== (k1 >= 1.4));
      var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!animate || reduce) { step(1); if (crossing) api.redraw(); else declutter(); return; }
      var t0 = performance.now(); (function fr(now) { var f = Math.min(1, (now - t0) / 320), e = 1 - Math.pow(1 - f, 3); step(e); if (f < 1) requestAnimationFrame(fr); else if (crossing) api.redraw(); else declutter(); })(t0);
    };
    var toWorld = function (cx, cy) { var r = svg.getBoundingClientRect(), v = cam(), s = Math.min(r.width / v[2], r.height / v[3]), ox = r.left + (r.width - v[2] * s) / 2, oy = r.top + (r.height - v[3] * s) / 2; return [v[0] + (cx - ox) / s, v[1] + (cy - oy) / s, s]; };
    var zoomAt = function (f, cx, cy, animate) { var v = cam(), p = cx == null ? [v[0] + v[2] / 2, v[1] + v[3] / 2] : toWorld(cx, cy), w = v[2] / f, fx = (p[0] - v[0]) / v[2], fy = (p[1] - v[1]) / v[3]; setCam([p[0] - fx * w, p[1] - fy * w, w, w], animate); };
    // labels: never on top of each other (goals keep their place first)
    function declutter() {
      var vr = svg.getBoundingClientRect(), vv = cam(), u = Math.max(vv[2] / (vr.width || 1), vv[3] / (vr.height || 1)); svg.style.setProperty("--u", u.toFixed(3));
      var placed = [], labs = [].slice.call(svg.querySelectorAll(".cn-nm.g, .cn-nm.p"));
      var obst = []; [].forEach.call(svg.querySelectorAll(".cn-n.goal .cn-disc, .cn-n.project .cn-disc, .cn-medisc"), function (c) { var q = c.getBoundingClientRect(); if (q.width) obst.push({ b: q, g: c.closest("[data-cn]") }); });
      labs.forEach(function (t) { t.classList.remove("hid"); });
      var over = function (b, q) { return b.left < q.right - 1 && b.right > q.left + 1 && b.top < q.bottom - 1 && b.bottom > q.top + 1; };
      labs.forEach(function (t) { var b = t.getBoundingClientRect(); if (!b.width) return; var own = t.closest("[data-cn]"); var hit = placed.some(function (q) { return over(b, q); }) || obst.some(function (o) { return o.g !== own && (!t.classList.contains("g") || !o.g || o.g.classList.contains("goal")) && over(b, o.b); }); if (hit) t.classList.add("hid"); else placed.push(b); });
    }
    // branch highlight
    var chain = function (id) { var out = [], n = M.N[id]; while (n) { out.unshift(n); n = n.parent ? M.N[n.parent] : null; } return out; };
    var branchIds = function (id) { var set = {}; chain(id).forEach(function (n) { set[n.id] = 1; }); var down = function (x) { M.N[x].kids.forEach(function (k) { set[k] = 1; down(k); }); }; down(id); return set; };
    function highlight(id) {
      [].forEach.call(svg.querySelectorAll(".on"), function (e) { e.classList.remove("on"); });
      svg.classList.toggle("hl", !!id); if (!id) return;
      var set = branchIds(id);
      [].forEach.call(svg.querySelectorAll("[data-cn]"), function (e) { if (set[e.getAttribute("data-cn")]) e.classList.add("on"); });
      [].forEach.call(svg.querySelectorAll(".cn-ln"), function (e) { if (set[e.getAttribute("data-a")] && (set[e.getAttribute("data-b")] || !e.getAttribute("data-b"))) e.classList.add("on"); });
    }
    function showTip(id, ev) {
      var n = M.N[id]; if (!n) { tip.hidden = true; return; }
      var ch = chain(id).slice(0, -1).map(function (x) { return x.title; }), area = C.AREA_NAME[n.key];
      var what = n.type === "goal" ? (n.empty ? "Empty goal: nothing under it yet" : "Score " + (n.score == null ? "not set" : n.g.scoreMode === "manual" ? (n.score / 10) + "/10" : Math.round(n.score) + "%") + " · " + n.openN + " open" + (n.noNext ? " · no next step" : "")) + (n.g.due ? " · due " + fmtD(n.g.due) : n.g.ongoing ? " · ongoing" : "")
        : n.type === "project" ? (n.p.doneCount || 0) + " of " + (n.p.total || 0) + " tasks done" + (n.p.due ? " · due " + fmtD(n.p.due) : "")
        : (n.done ? "Done" : n.someday ? "Someday" : n.i.date ? (n.late ? "Overdue · " : n.today ? "Due today · " : "") + fmtD(n.i.date) + (n.i.time ? " " + n.i.time : "") : "No date") + (n.main ? " · today’s main thing" : "");
      var type = n.type === "goal" ? "Goal" : n.type === "project" ? "Project" : n.i.kind === "deadline" ? "Deadline" : n.i.kind === "block" ? "Time block" : "Task";
      tip.innerHTML = '<b>' + esc(n.title) + '</b><span class="cn-tt">' + esc(type + " · " + area + (n.orphan ? " · loose" : "")) + "</span><span>" + esc(what) + "</span>" + '<span class="cn-ch">' + esc([area].concat(ch).join(" › ")) + "</span>";
      tip.hidden = false;
      var wr = wrap.getBoundingClientRect(), x = ev.clientX - wr.left + 14, y = ev.clientY - wr.top + 14;
      var tw = tip.offsetWidth, th = tip.offsetHeight; if (x + tw > wr.width - 8) x = Math.max(8, ev.clientX - wr.left - tw - 14); if (y + th > wr.height - 8) y = Math.max(8, ev.clientY - wr.top - th - 14);
      tip.style.left = x + "px"; tip.style.top = y + "px";
    }
    // search highlight
    function find(q) {
      S.cnQ = q; q = String(q || "").trim().toLowerCase(); svg.classList.toggle("finding", !!q);
      [].forEach.call(svg.querySelectorAll("[data-cn]"), function (e) { var n = M.N[e.getAttribute("data-cn")]; e.classList.toggle("hit", !!q && !!n && n.title.toLowerCase().indexOf(q) >= 0); });
    }
    var fi = root.getElementById("cnFind"); if (fi) { fi.addEventListener("input", function () { find(fi.value); }); if (S.cnQ) find(S.cnQ); }
    // pointer: pan the sky, drag a task, hover, click
    var pd = null, over = null;
    wrap.addEventListener("pointermove", function (e) {
      if (pd) return;
      var g = e.target.closest && e.target.closest("[data-cn]"), id = g ? g.getAttribute("data-cn") : null;
      if (id !== over) { over = id; highlight(id); }
      if (id) showTip(id, e); else tip.hidden = true;
    });
    wrap.addEventListener("pointerleave", function () { if (pd) return; over = null; highlight(null); tip.hidden = true; });
    svg.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      var g = e.target.closest && e.target.closest("[data-cn]"), id = g ? g.getAttribute("data-cn") : null, n = id ? M.N[id] : null;
      pd = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, node: n && n.type === "task" ? n : null, el: g, v0: cam(), click: id };
    });
    svg.addEventListener("pointermove", function (e) {
      if (!pd || e.pointerId !== pd.id) return;
      var dx = e.clientX - pd.x, dy = e.clientY - pd.y;
      if (!pd.moved) { if (Math.abs(dx) + Math.abs(dy) < 5) return; pd.moved = true; try { svg.setPointerCapture(e.pointerId); } catch (x) {} tip.hidden = true; if (pd.node) { pd.el.classList.add("drag"); svg.classList.add("dragging"); highlight(null); } else svg.classList.add("panning"); }
      var w = toWorld(e.clientX, e.clientY);
      if (pd.node) {
        pd.el.setAttribute("transform", "translate(" + w[0].toFixed(1) + "," + w[1].toFixed(1) + ")");
        var tg = target(w[0], w[1], pd.node); [].forEach.call(svg.querySelectorAll(".drop"), function (x) { x.classList.remove("drop"); });
        if (tg.node) { var el = svg.querySelector('[data-cn="' + tg.node.id + '"]'); if (el) el.classList.add("drop"); }
        else if (tg.key) { var al = svg.querySelector('[data-cnarea="' + tg.key + '"]'); if (al) al.classList.add("drop"); }
      } else {
        var s = w[2], v = pd.v0; setCam([v[0] - dx / s, v[1] - dy / s, v[2], v[3]]);
      }
    });
    function target(x, y, task) {
      var best = null, bd = 1e9;
      M.nodes.forEach(function (n) { if (n.type === "task" || n.id === task.parent) return; var d = Math.hypot(n.x - x, n.y - y); if (d < n.r + 16 && d < bd) { bd = d; best = n; } });
      if (best) return { node: best };
      var r = Math.hypot(x, y); if (r < R0 || r > R) return {};
      var deg = (Math.atan2(y, x) * 180 / Math.PI + 90 + 360) % 360; return { key: KEYS[Math.min(KEYS.length - 1, Math.floor(deg / SEC))] };
    }
    var end = function (e) {
      if (!pd || e.pointerId !== pd.id) return; var m = pd; pd = null; svg.classList.remove("panning"); svg.classList.remove("dragging");
      [].forEach.call(svg.querySelectorAll(".drop"), function (x) { x.classList.remove("drop"); });
      if (!m.moved) {
        var n = m.click ? M.N[m.click] : null;
        if (n) { if (n.type === "task") api.open({ type: "item", id: n.ref, date: n.i.date || null }); else if (n.type === "goal") api.call("onOpenGoal", n.ref); else api.call("onOpenProject", n.ref); }
        return;
      }
      if (!m.node || e.type === "pointercancel") { if (m.node) api.redraw(); return; }
      var w = toWorld(e.clientX, e.clientY), tg = target(w[0], w[1], m.node), it = m.node.i, patch = null, label = "move";
      if (tg.node && tg.node.type === "project" && it.projectId !== tg.node.ref) patch = { parentType: "project", parentId: tg.node.ref };
      else if (tg.node && tg.node.type === "goal" && (it.goalId !== tg.node.ref || it.projectId)) patch = { parentType: "goal", parentId: tg.node.ref };
      else if (!tg.node && tg.key && (it.goalId || it.projectId || C.areaKey(it.area) !== tg.key)) { patch = { parentType: "none", parentId: null }; if (C.areaKey(it.area) !== tg.key) patch.area = AREA_DEFAULT[tg.key] || null; }
      if (!patch) { api.redraw(); return; }
      // shows at once; the host saves, offers Undo, and the change log records it
      if (patch.parentType === "project") { var pp = M.N["p:" + patch.parentId]; it.projectId = patch.parentId; it.goalId = pp && pp.p.goalId || null; }
      else if (patch.parentType === "goal") { it.projectId = null; it.goalId = patch.parentId; }
      else { it.projectId = null; it.goalId = null; if (patch.area !== undefined) it.area = patch.area; }
      api.redraw(); api.patch(it.id, patch, label);
    };
    svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
    svg.addEventListener("wheel", function (e) { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022)), e.clientX, e.clientY); }, { passive: false });
    svg.addEventListener("dblclick", function (e) { if (e.target.closest && e.target.closest("[data-cn],[data-cnarea]")) return; zoomAt(e.shiftKey ? 0.5 : 2, e.clientX, e.clientY, true); });
    // area labels zoom into their cluster
    function zoomArea(k) { var si = KEYS.indexOf(k), pts = [[0, 0]]; for (var a = si * SEC; a <= (si + 1) * SEC; a += SEC / 6) { pts.push(polar(R + 30, a)); pts.push(polar(R0, a)); } var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; }), x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys), s = Math.max(x1 - x0, y1 - y0) + 40; setCam([(x0 + x1) / 2 - s / 2, (y0 + y1) / 2 - s / 2, s, s], true); svg.focus({ preventScroll: true }); }
    svg.addEventListener("click", function (e) { var a = e.target.closest && e.target.closest("[data-cnarea]"); if (a) zoomArea(a.getAttribute("data-cnarea")); });
    svg.addEventListener("keydown", function (e) {
      var a = e.target.closest && e.target.closest("[data-cnarea]"), g = e.target.closest && e.target.closest("[data-cn]");
      if ((e.key === "Enter" || e.key === " ") && a) { e.preventDefault(); zoomArea(a.getAttribute("data-cnarea")); return; }
      if ((e.key === "Enter" || e.key === " ") && g) { e.preventDefault(); var n = M.N[g.getAttribute("data-cn")]; if (n.type === "task") api.open({ type: "item", id: n.ref, date: n.i.date || null }); else if (n.type === "goal") api.call("onOpenGoal", n.ref); else api.call("onOpenProject", n.ref); return; }
      if (e.key === "Escape" && S.cnCam) { e.preventDefault(); e.stopPropagation(); setCam(FULL.slice(), true); }
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomAt(1.4, null, null, true); } else if (e.key === "-") { e.preventDefault(); zoomAt(1 / 1.4, null, null, true); } else if (e.key === "0") { e.preventDefault(); setCam(FULL.slice(), true); }
    });
    svg.addEventListener("focusin", function (e) { var g = e.target.closest && e.target.closest("[data-cn]"); if (g) { highlight(g.getAttribute("data-cn")); var b = g.getBoundingClientRect(); showTip(g.getAttribute("data-cn"), { clientX: b.right, clientY: b.bottom }); } });
    svg.addEventListener("focusout", function () { highlight(null); tip.hidden = true; });
    root.getElementById("cnSec").addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-cnact]"); if (!b) return; var a = b.getAttribute("data-cnact");
      if (a === "done") { S.cnDone = !S.cnDone; api.redraw(); } else if (a === "fit") setCam(FULL.slice(), true); else zoomAt(a === "in" ? 1.5 : 1 / 1.5, null, null, true);
    });
    var leg = wrap.querySelector(".cn-leg"); if (leg) leg.addEventListener("toggle", function () { S.cnLegOpen = leg.open; });
    // Esc zooms out even when focus is elsewhere on the page (but never closes something else first)
    if (!S.cnEscBound) { S.cnEscBound = true; document.addEventListener("keydown", function (e) { if (e.key !== "Escape" || !S.cnCam || S.over || S.view !== "areas") return; var s = root.getElementById("cnSvg"); if (!s || !s.isConnected) return; var el = e.composedPath ? e.composedPath()[0] : e.target; if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return; S.cnCam = null; api.redraw(); }); }
    V.cnFocus = function (goalId) { var n = M.N["g:" + goalId]; if (!n) return; var s = 300; setCam([n.x - s / 2, n.y - s / 2, s, s], true); highlight(n.id); var sec = root.getElementById("cnSec"); if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: "start", behavior: "smooth" }); };
    requestAnimationFrame(declutter);
  };
})();
