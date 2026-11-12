/* Command Center → Strategy, as trees. One section per area (its colour as the header and accent); inside it
   every goal is a tree that runs top to bottom: the goal (title, score ring, 4-week sparkline, due date),
   its projects (done/total), the tasks under each project; tasks filed straight under the goal hang from it,
   and tasks with no goal or project sit in "Unassigned" at the end of their area.
   Done tasks are dimmed, overdue ones get a red edge. Branches fold, any node opens, a task can be dragged
   onto another project or goal (or onto Unassigned) to move it there. Areas stack on narrow screens. */
(function () {
  var V = window.PPCommandView, C = window.PPCommandCore;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var ORDER = ["task", "work", "health", "growth", "people", "sol", "none"];
  var AREA_OF_KEY = { task: ["Finance", "Maintenance"], work: ["Career"], health: ["Health"], growth: ["Growth"], people: ["Relationships"], sol: ["Sol"], none: [""] };
  var fmtD = function (d) { return d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""; };
  /* the score ring: manual reads "8.5/10", the rest as a percentage */
  function ring(g) {
    var v = g.score == null ? null : Math.max(0, Math.min(100, +g.score)), r = 15, c = 2 * Math.PI * r, k = C.areaKey(g.area);
    var label = v == null ? "–" : g.scoreMode === "manual" ? (v / 10).toFixed(v % 10 ? 1 : 0) + "<tspan class=\"o\">/10</tspan>" : Math.round(v) + "<tspan class=\"o\">%</tspan>";
    var what = { manual: "your rating", sleep: "7-day sleep score", workout: "workouts done of planned, 28 days", net_zero: "debt cleared", tasks: "tasks done" }[g.scoreMode || "tasks"];
    return '<svg class="tt-ring" viewBox="0 0 40 40" role="img" aria-label="' + esc("Score " + (v == null ? "not set" : g.scoreMode === "manual" ? (v / 10) + " of 10" : Math.round(v) + " percent") + ", " + what) + '"><title>' + esc(what) + '</title><circle class="rt" cx="20" cy="20" r="' + r + '"/><circle class="rv" cx="20" cy="20" r="' + r + '" style="stroke:var(--area-' + (k === "sol" ? "sol-line" : k) + ');stroke-dasharray:' + (v == null ? 0 : c * v / 100).toFixed(1) + " " + c.toFixed(1) + '" transform="rotate(-90 20 20)"/><text x="20" y="23.5">' + label + "</text></svg>";
  }
  function spark(g) {
    var h = (g.scoreHistory || []).filter(function (x) { return typeof x.s === "number"; }); if (h.length < 2) return "";
    var w = 64, ht = 18, xs = h.map(function (_, i) { return (i / (h.length - 1)) * w; }), ys = h.map(function (x) { return ht - 2 - (x.s / 100) * (ht - 4); });
    return '<svg class="tt-spk" viewBox="0 0 ' + w + " " + ht + '" aria-hidden="true"><polyline points="' + xs.map(function (x, i) { return x.toFixed(1) + "," + ys[i].toFixed(1); }).join(" ") + '"/><circle cx="' + xs[xs.length - 1].toFixed(1) + '" cy="' + ys[ys.length - 1].toFixed(1) + '" r="1.8"/></svg>';
  }
  function taskNode(S, i) {
    var t = S.today, done = i.recurrence ? false : !!i.done, late = !done && i.date && i.date < t && C.hasDone(i);
    return '<li class="tt-t' + (done ? " dn" : "") + (late ? " late" : "") + '" draggable="true" data-tdrag="' + esc(i.id) + '"><button class="tt-n" data-open="' + esc(i.id) + '" data-date="' + esc(i.date || t) + '" title="' + esc(i.title + (late ? " · overdue" : "") + (done ? " · done" : "")) + '"><span class="ck" aria-hidden="true">' + (done ? "✓" : i.kind === "deadline" ? "◆" : "") + "</span><span class=\"tl\">" + esc(i.title) + "</span>" + (i.date ? '<small>' + (late ? "overdue · " : "") + esc(fmtD(i.date)) + "</small>" : i.someday ? "<small>someday</small>" : "") + "</button></li>";
  }
  function taskList(S, list, more) {
    var open = list.filter(function (i) { return i.recurrence || !i.done; }).sort(function (a, b) { return String(a.date || "9999").localeCompare(String(b.date || "9999")); });
    var done = list.filter(function (i) { return !i.recurrence && i.done; });
    var shown = open.concat(S.treeShowDone ? done : []);
    return '<ul class="tt-ts">' + shown.map(function (i) { return taskNode(S, i); }).join("") + (!S.treeShowDone && done.length ? '<li class="tt-more">' + done.length + (done.length === 1 ? " done task" : " done tasks") + " hidden</li>" : "") + (!list.length ? '<li class="tt-more">' + (more || "No tasks yet") + "</li>" : "") + "</ul>";
  }
  var fold = function (S, id) { return !!(S.treeFold && S.treeFold[id]); };
  var tog = function (S, id, label) { var f = fold(S, id); return '<button class="tt-tog" data-tfold="' + esc(id) + '" aria-expanded="' + !f + '" aria-label="' + esc((f ? "Show " : "Fold ") + label) + '">' + (f ? "▸" : "▾") + "</button>"; };
  function projectNode(S, p, items) {
    var mine = items.filter(function (i) { return i.projectId === p.id; }), doneN = mine.filter(function (i) { return !i.recurrence && i.done; }).length, f = fold(S, "p" + p.id);
    return '<li class="tt-p" data-tdrop="project:' + esc(p.id) + '"><div class="tt-pn">' + tog(S, "p" + p.id, p.title) + '<button class="tt-n" data-project="' + esc(p.id) + '"><span class="kind">Project</span><span class="tl">' + esc(p.title) + "</span></button>" +
      '<span class="pg" role="img" aria-label="' + doneN + " of " + mine.length + ' tasks done"><i style="width:' + (mine.length ? Math.round(doneN / mine.length * 100) : 0) + '%"></i></span><small class="pc">' + doneN + "/" + mine.length + (p.due ? " · " + esc(fmtD(p.due)) : "") + "</small></div>" + (f ? "" : taskList(S, mine)) + "</li>";
  }
  function goalTree(S, g, items, projects) {
    var ps = projects.filter(function (p) { return p.goalId === g.id; }), direct = items.filter(function (i) { return i.goalId === g.id && !i.projectId; }), f = fold(S, "g" + g.id), k2 = g.area2 ? C.areaKey(g.area2) : null;
    var sub = g.scoreMode === "net_zero" && g.netZero && g.netZero.of ? new Intl.NumberFormat("en-GB", { style: "currency", currency: g.netZero.currency || "EUR", maximumFractionDigits: 0 }).format(g.netZero.cleared || 0) + " of " + new Intl.NumberFormat("en-GB", { style: "currency", currency: g.netZero.currency || "EUR", maximumFractionDigits: 0 }).format(g.netZero.of) + " cleared" : "";
    return '<div class="tt-g" data-tdrop="goal:' + esc(g.id) + '"><div class="tt-gn">' + tog(S, "g" + g.id, g.title) + ring(g) + '<button class="tt-n" data-goal="' + esc(g.id) + '"><span class="tl">' + esc(g.title) + (k2 && k2 !== C.areaKey(g.area) ? '<i class="a2" style="--c2:var(--area-' + (k2 === "sol" ? "sol-line" : k2) + ')" title="Also ' + esc(g.area2) + '"></i>' : "") + "</span><small>" + (g.ongoing ? "ongoing" : g.due ? "due " + esc(fmtD(g.due)) : "no due date") + (sub ? " · " + esc(sub) : "") + "</small></button>" + spark(g) + "</div>" +
      (f ? "" : '<ul class="tt-ch">' + ps.map(function (p) { return projectNode(S, p, items); }).join("") + (direct.length ? '<li class="tt-p direct"><div class="tt-pn"><span class="kind">Straight under the goal</span></div>' + taskList(S, direct) + "</li>" : "") + (!ps.length && !direct.length ? '<li class="tt-more">Nothing under this goal yet</li>' : "") + "</ul>") + "</div>";
  }
  V.strategyTrees = function (S) {
    var items = S.items.filter(function (i) { return !i.archived && i.kind !== "event"; }), goals = S.goals || [], projects = S.projects || [];
    var keyOfGoal = {}; goals.forEach(function (g) { keyOfGoal[g.id] = C.areaKey(g.area); });
    var projGoal = {}; projects.forEach(function (p) { projGoal[p.id] = p.goalId; });
    var keys = ORDER.filter(function (k) { return !S.areaFilter || S.areaFilter === k; });
    var html = '<div class="head"><div><p class="eyebrow">Strategy</p><h1>Every goal as a tree</h1><p class="sub" style="margin-top:6px">Area, goal, project, task. Drag a task onto another project or goal to move it there.</p></div><div class="nav"><span class="seg sm" role="group" aria-label="Strategy view"><button data-smode="trees" aria-pressed="true">Trees</button><button data-smode="board" aria-pressed="false">Board</button><button data-smode="outline" aria-pressed="false">Outline</button></span><button class="btn sm" data-act="tdone" aria-pressed="' + !!S.treeShowDone + '">' + (S.treeShowDone ? "Hide done" : "Show done") + '</button><span class="zoom" role="group" aria-label="Zoom"><button class="btn sm" data-tzoom="-1" aria-label="Zoom out">−</button><button class="btn sm" data-tzoom="1" aria-label="Zoom in">+</button><button class="btn sm" data-tzoom="0">Fit</button></span></div></div>';
    html += '<div class="tt-wrap" id="ttWrap"><div class="tt-canvas" id="ttCanvas" style="transform:scale(' + (S.treeZoom || 1) + ')">';
    keys.forEach(function (k) {
      var gs = goals.filter(function (g) { return keyOfGoal[g.id] === k; });
      var loose = items.filter(function (i) { if (i.goalId || i.projectId) return false; var ik = C.areaKey(i.area); return ik === k && (i.recurrence || !i.done || S.treeShowDone); });
      var orphanP = k === "none" ? projects.filter(function (p) { return !p.goalId || !keyOfGoal[p.goalId]; }) : [];
      if (!gs.length && !loose.length && !orphanP.length) return;
      html += '<section class="tt-a" style="--c:var(--area-' + (k === "sol" ? "sol-line" : k) + ");--cs:var(--area-" + k + '-soft)" aria-label="' + esc(C.AREA_NAME[k]) + '"><header><i></i><h2>' + esc(C.AREA_NAME[k]) + "</h2><small>" + gs.length + (gs.length === 1 ? " goal" : " goals") + "</small></header>" +
        gs.map(function (g) { return goalTree(S, g, items, projects); }).join("") +
        (orphanP.length ? '<div class="tt-g"><div class="tt-gn"><span class="tl"><b>Projects without a goal</b></span></div><ul class="tt-ch">' + orphanP.map(function (p) { return projectNode(S, p, items); }).join("") + "</ul></div>" : "") +
        (loose.length ? '<div class="tt-g un" data-tdrop="none:' + k + '"><div class="tt-gn">' + tog(S, "u" + k, "Unassigned") + '<span class="tl"><b>Unassigned</b><small>' + loose.length + " loose " + (loose.length === 1 ? "task" : "tasks") + " · no goal or project</small></span></div>" + (fold(S, "u" + k) ? "" : taskList(S, loose)) + "</div>" : "") + "</section>";
    });
    return html + "</div></div>";
  };
  /* fit: the trees at a scale that fills the width (never larger than 1) */
  V.treesFit = function (root, S) {
    var w = root.getElementById ? root.getElementById("ttWrap") : null, c = root.getElementById ? root.getElementById("ttCanvas") : null; if (!w || !c) return;
    c.style.transform = "scale(1)"; var need = c.scrollWidth, have = w.clientWidth; S.treeZoom = need > have ? Math.max(0.55, have / need) : 1; c.style.transform = "scale(" + S.treeZoom + ")";
  };
})();
