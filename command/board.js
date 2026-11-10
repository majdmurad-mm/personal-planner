/* Command Center > Strategy board. Goals, projects and tasks as cards on a board you can pan and zoom.
   Each goal is a tree (goal → projects → tasks). Cards can be dragged (a branch moves together),
   branches can be folded, and any two cards can be connected by hand. This file builds the model,
   lays it out and returns HTML; command.js handles the pointer and saves the layout. */
(function () {
  var B = window.PPCommandBoard = {}, V = window.PPCommandView, esc = V.esc;
  var AREAS = ["Health", "Finance", "Career", "Maintenance", "Growth", "Relationships", "Sol"];
  var SIZE = { goal: [250, 88], project: [216, 84], task: [208, 52], group: [216, 60] }, GAPX = 54, GAPY = 10, TREEGAP = 34;
  var open = function (i) { return i.recurrence || !i.done; };
  B.SIZE = SIZE;
  // -> { nodes: {id: node}, roots: [id] }   node: { id, kind, title, area, meta, progress, children[], parent, ref }
  B.model = function (S) {
    var items = S.items.filter(function (i) { return !i.archived && i.kind !== "event" && open(i); }), goals = S.goals || [], projects = S.projects || [], nodes = {}, roots = [];
    var add = function (n) { n.children = []; nodes[n.id] = n; if (n.parent && nodes[n.parent]) nodes[n.parent].children.push(n.id); else roots.push(n.id); return n; };
    var when = function (i) { return i.someday ? "someday" : i.date ? V.fmt(i.date, { day: "numeric", month: "short" }) : "no date"; };
    var task = function (i, parent) { add({ id: "t:" + i.id, kind: "task", title: i.title, area: i.area, meta: when(i) + (i.kind === "deadline" ? " · deadline" : i.recurrence ? " · repeats" : ""), parent: parent, ref: i.id }); };
    var byDate = function (a, b) { return String(a.date || "9999").localeCompare(String(b.date || "9999")); };
    goals.forEach(function (g) {
      var ps = projects.filter(function (p) { return p.goalId === g.id && !p.done; }), direct = items.filter(function (i) { return i.goalId === g.id && !i.projectId; }).sort(byDate);
      add({ id: "g:" + g.id, kind: "goal", title: g.title, area: g.area, progress: g.progress, meta: ps.length + (ps.length === 1 ? " project" : " projects") + " · " + items.filter(function (i) { return i.goalId === g.id; }).length + " open", ref: g.id });
      ps.forEach(function (p) {
        var mine = items.filter(function (i) { return i.projectId === p.id; }).sort(byDate);
        add({ id: "p:" + p.id, kind: "project", title: p.title, area: g.area, progress: p.progress, meta: mine.length + " open" + (p.due ? " · due " + V.fmt(p.due, { day: "numeric", month: "short" }) : ""), parent: "g:" + g.id, ref: p.id });
        mine.forEach(function (i) { task(i, "p:" + p.id); });
      });
      direct.forEach(function (i) { task(i, "g:" + g.id); });
    });
    var looseP = projects.filter(function (p) { return !p.done && !goals.some(function (g) { return g.id === p.goalId; }); });
    if (looseP.length) {
      add({ id: "nogoal", kind: "group", title: "Projects without a goal", area: "", meta: looseP.length + (looseP.length === 1 ? " project" : " projects") });
      looseP.forEach(function (p) { var mine = items.filter(function (i) { return i.projectId === p.id; }).sort(byDate); add({ id: "p:" + p.id, kind: "project", title: p.title, area: "", progress: p.progress, meta: mine.length + " open", parent: "nogoal", ref: p.id }); mine.forEach(function (i) { task(i, "p:" + p.id); }); });
    }
    var orphans = items.filter(function (i) { return !i.goalId && !i.projectId; }).sort(byDate);
    if (orphans.length) { add({ id: "loose", kind: "group", title: "Loose tasks", area: "", meta: orphans.length + " that belong to no goal or project" }); orphans.forEach(function (i) { task(i, "loose"); }); }
    return { nodes: nodes, roots: roots };
  };
  // Folded by default: the loose-tasks group, and any branch with many tasks, so the board opens calm.
  B.isFolded = function (n, L) { var c = (L.collapsed || {})[n.id]; if (c != null) return !!c; return n.id === "loose" || (n.kind === "project" && n.children.length > 6); };
  // Positions: a card that was moved keeps its place; everything else is laid out as a tidy tree
  // hanging off wherever its parent actually is. Returns the bounds.
  B.layout = function (M, L) {
    var pos = L.pos || {}, N = M.nodes, sizeOf = function (n) { return SIZE[n.kind]; };
    var kids = function (n) { return B.isFolded(n, L) ? [] : n.children.map(function (id) { return N[id]; }); };
    var height = function (n) { var k = kids(n), sum = 0; k.forEach(function (c, i) { sum += height(c) + (i ? GAPY : 0); }); return Math.max(sizeOf(n)[1], sum); };
    var place = function (n, x, y) {
      var h = height(n), sz = sizeOf(n), p = pos[n.id];
      n.w = sz[0]; n.h = sz[1]; n.x = p ? p[0] : x; n.y = p ? p[1] : y + (h - sz[1]) / 2; n.pinned = !!p; n.vis = true;
      var k = kids(n), total = 0; k.forEach(function (c, i) { total += height(c) + (i ? GAPY : 0); });
      var cy = n.y + sz[1] / 2 - total / 2, cx = n.x + sz[0] + GAPX;
      k.forEach(function (c) { place(c, cx, cy); cy += height(c) + GAPY; });
      n.folded = B.isFolded(n, L) && n.children.length > 0;
      return h;
    };
    Object.keys(N).forEach(function (id) { N[id].vis = false; });
    // roots flow into columns so the board is roughly as wide as it is tall
    var trees = M.roots.map(function (id) { return { n: N[id], h: height(N[id]) }; }), totalH = trees.reduce(function (t, x) { return t + x.h + TREEGAP; }, 0), colW = SIZE.goal[0] + SIZE.project[0] + SIZE.task[0] + GAPX * 2 + 70;
    var cols = Math.max(1, Math.min(4, Math.round(Math.sqrt(totalH / colW / 0.62)))), target = totalH / cols, col = 0, y = 0;
    trees.forEach(function (t) { if (y > 0 && y + t.h / 2 > target && col < cols - 1) { col++; y = 0; } place(t.n, col * colW, y); y += t.h + TREEGAP; });
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    Object.keys(N).forEach(function (id) { var n = N[id]; if (!n.vis) return; x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); });
    if (x0 > x1) { x0 = y0 = 0; x1 = 600; y1 = 300; }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  B.curve = function (a, b) { var x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2; return "M" + x1.toFixed(1) + "," + y1.toFixed(1) + " C" + mx.toFixed(1) + "," + y1.toFixed(1) + " " + mx.toFixed(1) + "," + y2.toFixed(1) + " " + x2.toFixed(1) + "," + y2.toFixed(1); };
  B.link = function (a, b) { var x1 = a.x + a.w / 2, y1 = a.y + a.h / 2, x2 = b.x + b.w / 2, y2 = b.y + b.h / 2, dx = x2 - x1, dy = y2 - y1, mx = (x1 + x2) / 2 - dy * 0.12, my = (y1 + y2) / 2 + dx * 0.12; return "M" + x1.toFixed(1) + "," + y1.toFixed(1) + " Q" + mx.toFixed(1) + "," + my.toFixed(1) + " " + x2.toFixed(1) + "," + y2.toFixed(1); };
  B.lines = function (M, L) {
    var N = M.nodes, s = "";
    Object.keys(N).forEach(function (id) { var n = N[id]; if (!n.vis || n.folded) return; n.children.forEach(function (c) { if (N[c].vis) s += '<path class="bl-t" d="' + B.curve(n, N[c]) + '"/>'; }); });
    (L.links || []).forEach(function (l, i) { var a = N[l[0]], b = N[l[1]]; if (!a || !b || !a.vis || !b.vis) return; var d = B.link(a, b); s += '<path class="bl-c" d="' + d + '"/><path class="bl-hit" data-blink="' + i + '" d="' + d + '"><title>Connection drawn by you. Click to remove it.</title></path>'; });
    return s;
  };
  B.card = function (n, linkFrom) {
    var color = AREAS.indexOf(n.area) >= 0 ? "var(--" + n.area + ")" : "var(--muted)", kind = { goal: "Goal", project: "Project", task: "Task", group: "" }[n.kind], hasKids = n.children.length > 0;
    return '<div class="bn ' + n.kind + (n.pinned ? " pinned" : "") + (linkFrom === n.id ? " linking" : "") + '" data-n="' + esc(n.id) + '" style="left:' + n.x.toFixed(1) + "px;top:" + n.y.toFixed(1) + "px;width:" + n.w + "px;height:" + n.h + "px;--c:" + color + '" tabindex="0" role="button" aria-label="' + esc((kind ? kind + ": " : "") + n.title + (n.progress != null ? ", " + n.progress + " percent done" : "") + (n.meta ? ", " + n.meta : "") + (n.folded ? ", folded" : "")) + '">' +
      (hasKids ? '<button class="bt" data-btoggle="' + esc(n.id) + '" aria-expanded="' + !n.folded + '" aria-label="' + (n.folded ? "Unfold" : "Fold") + " " + esc(n.title) + '" title="' + (n.folded ? "Unfold" : "Fold") + '">' + (n.folded ? "▸" : "▾") + "</button>" : "") +
      '<span class="bb">' + (kind && n.kind !== "task" ? '<span class="bk">' + kind + "</span>" : "") + '<b class="btt" title="' + esc(n.title) + '">' + esc(n.title) + "</b>" +
      (n.progress != null ? '<span class="bp"><span class="tbar"><i style="width:' + n.progress + "%;background:" + color + '"></i></span><small>' + n.progress + " %</small></span>" : "") +
      (n.meta ? "<small>" + esc(n.meta) + (n.folded ? " · " + n.children.length + " folded" : "") + "</small>" : "") + "</span>" +
      '<span class="bh" data-bhandle="' + esc(n.id) + '" title="Drag from here to another card to connect them" aria-hidden="true"></span></div>';
  };
  B.html = function (S) {
    var L = S.board, M = B.model(S), box = B.layout(M, L), N = M.nodes, cards = "";
    S.boardM = M; S.boardBox = box;
    Object.keys(N).forEach(function (id) { if (N[id].vis) cards += B.card(N[id], L.linkFrom); });
    var cam = L.cam, pinned = Object.keys(L.pos || {}).length, nl = (L.links || []).length;
    return '<div class="board" id="ccBoard" tabindex="0" aria-label="Strategy board. Each goal is a tree of its projects and tasks. Drag a card to move its branch, drag the small circle on a card onto another card to connect them, or focus a card and press L, then focus another and press L again.">' +
      '<div class="bw" id="ccBW" style="transform:translate(' + cam.x.toFixed(1) + "px," + cam.y.toFixed(1) + "px) scale(" + cam.k.toFixed(3) + ')"><svg class="bl" id="ccBL" width="10" height="10" aria-hidden="true">' + B.lines(M, L) + '<path class="bl-new" id="ccBNew" d=""/></svg>' + cards + "</div>" +
      '<div class="bzoom"><button data-bzoom="-1" aria-label="Zoom out">−</button><button data-bzoom="0" aria-label="Show everything">⤢</button><button data-bzoom="1" aria-label="Zoom in">+</button></div>' +
      '<p class="bhint">' + (L.linkFrom ? "Now choose the card to connect to (press L on it, or Esc to cancel)." : "Drag a card to move its branch · drag the small circle to connect two cards · click a dashed line to remove it" + (pinned || nl ? " · " + pinned + " moved, " + nl + (nl === 1 ? " connection" : " connections") : "")) + "</p></div>";
  };
})();
