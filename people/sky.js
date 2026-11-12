/* People page, part 2 of 3: drawing. The constellation (an SVG string), its focus/filter paint pass,
   and the List view. Everything here returns markup or toggles classes; state lives in people.js. */
(function () {
  "use strict";
  var C = window.PPPeopleCore, RINGS = C.RINGS, QL = C.QL;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function glyph(q) { return '<svg viewBox="0 0 38 12" aria-hidden="true"><path class="ln show q-' + q + '" d="' + C.linePath(1, 6, 37, 6, q) + '"/></svg>'; }
  function av(p) { return '<span class="av"' + (p.color ? ' style="background:' + esc(p.color) + ';color:#0B1430"' : "") + ">" + esc(p.ini) + "</span>"; }

  /* does this person pass the search box and the filter chips? */
  function match(p, st) {
    if (st.q && p.name.toLowerCase().indexOf(st.q) < 0) return false;
    if (st.flt.thread && !p.threads.length) return false;
    if (st.flt.drift && !p.drift) return false;
    if (st.flt.tense && !p.tense) return false;
    if (st.group && p.group !== st.group) return false;
    if (st.ring && p.circle !== +st.ring) return false;
    if (st.quality && p.quality !== st.quality) return false;
    return true;
  }
  function filtering(st) { return !!(st.q || st.flt.thread || st.flt.drift || st.flt.tense || st.group || st.ring || st.quality); }

  function draw(svg, M, st) {
    var narrow = st.narrow, VB = narrow ? 600 : 540, box = svg.getBoundingClientRect(), side = Math.min(box.width || 2 * VB, box.height || box.width || 2 * VB) || 2 * VB;
    svg.setAttribute("viewBox", -VB + " " + -VB + " " + 2 * VB + " " + 2 * VB);
    var K = 2 * VB / side, secs = C.layout(M, K, narrow), h = "", fs = function (px) { return (px * K).toFixed(1); }, ME = narrow ? 12 * K : 21, c, i;
    h += "<defs>" + secs.map(function (s, i) { var mid = (s.a0 + s.a1) / 2, rev = mid > 0 && mid < 180, half = Math.min(50, (s.a1 - s.a0) / 2 + 8); return '<path id="sa' + i + '" d="' + C.arc(rev ? 508 + 11 * K : 505, mid - half, mid + half, rev) + '"/>'; }).join("") + "</defs>";
    var z = 4711; for (i = 0; i < 150; i++) { z = (z * 16807) % 2147483647; var bx = z % 1040 - 520; z = (z * 16807) % 2147483647; var by = z % 1040 - 520; h += '<circle class="bgs" cx="' + bx + '" cy="' + by + '" r="' + (.5 + (z % 10) / 9).toFixed(1) + '"/>'; }
    for (c = 1; c <= 5; c++) h += '<circle class="ringc" r="' + C.RLINE[c] + '"/>';
    secs.forEach(function (s, i) {
      if (secs.length > 1) { var a = (s.a0 - 1.6) * Math.PI / 180; h += '<line class="sec-div" x1="' + (Math.cos(a) * 50).toFixed(1) + '" y1="' + (Math.sin(a) * 50).toFixed(1) + '" x2="' + (Math.cos(a) * 496).toFixed(1) + '" y2="' + (Math.sin(a) * 496).toFixed(1) + '"/>'; }
      var gc = M.colors[s.g.id]; if (gc && secs.length > 1) h += '<path class="sec-c" style="stroke:' + esc(gc) + '" d="' + C.arc(497.5, s.a0 + .6, s.a1 - .6) + '"/>';
      var lab = s.g.label, room = (s.a1 - s.a0) * 8.6, per = (narrow ? 6 : 8.4) * K;
      if (lab.length * per > room) lab = lab.slice(0, Math.max(3, Math.floor(room / per) - 1)) + "…";
      h += '<text class="sec-t" style="font-size:' + fs(narrow ? 8.5 : 12) + "px" + (narrow ? ";letter-spacing:.08em" : "") + '"><textPath href="#sa' + i + '" startOffset="50%" text-anchor="middle">' + esc(lab) + "</textPath></text>";
    });
    for (c = 1; c <= 4; c++) h += '<text class="ringl" style="font-size:' + fs(9.5) + "px;stroke-width:" + fs(5) + 'px" x="0" y="' + (-C.RLINE[c]) + '" dy="' + fs(3) + '">' + RINGS[c] + "</text>";
    var vis = M.on.filter(function (p) { return p.x != null; });
    vis.forEach(function (p) {
      var L = Math.hypot(p.x, p.y), ux = p.x / L, uy = p.y / L, x1 = ux * (ME + 5), y1 = uy * (ME + 5), x2 = ux * (L - p.r - 2), y2 = uy * (L - p.r - 2), show = p.circle <= 2 || p.quality !== "ok";
      h += '<path class="ln q-' + p.quality + (show ? " show" : "") + (p.circle >= 3 ? " far" : "") + '" data-id="' + p.id + '" d="' + C.linePath(x1, y1, x2, y2, p.quality) + '"/>';
      if (p.energy !== "neutral") {
        var t = L * .56, cx = ux * t, cy = uy * t, dir = p.energy === "nourishing" ? -1 : 1, s = 6, nx = -uy, ny = ux;
        h += '<path class="chev' + (dir > 0 ? " drain" : "") + '" data-id="' + p.id + '" d="M' + (cx - ux * s * dir + nx * s).toFixed(1) + "," + (cy - uy * s * dir + ny * s).toFixed(1) + "L" + (cx + ux * s * dir * .4).toFixed(1) + "," + (cy + uy * s * dir * .4).toFixed(1) + "L" + (cx - ux * s * dir - nx * s).toFixed(1) + "," + (cy - uy * s * dir - ny * s).toFixed(1) + '"/>';
      }
    });
    h += '<g id="links"></g>';
    vis.forEach(function (p) {
      var r = p.r, lbl = p.circle <= (narrow ? 0 : 2), first = p.first, below = p.y > -20 || p.circle === 1;
      h += '<g class="nd c' + p.circle + (p.color ? ' gc" style="--gc:' + esc(p.color) : "") + '" data-id="' + p.id + '" tabindex="0" role="button" aria-label="' + esc(p.name + ", " + RINGS[p.circle] + " circle, " + QL[p.quality] + (p.threads.length ? ", open thread" : "") + (p.drift ? ", drifting" : "") + (p.bday != null && p.bday <= 14 ? ", birthday " + C.inDays(p.bday) : "")) + '" transform="translate(' + p.x.toFixed(1) + "," + p.y.toFixed(1) + ')">';
      if (p.fresh != null) h += '<circle class="halo" r="' + (r + 7 + 7 * p.fresh).toFixed(1) + '" opacity="' + (.08 + .5 * p.fresh).toFixed(2) + '"/>';
      h += '<circle class="star" r="' + (r * 1.55).toFixed(1) + '"/><circle r="' + Math.max(r + 6, 11 * K).toFixed(1) + '" fill="transparent"/><circle class="disc" r="' + r.toFixed(1) + '"/>';
      if (p.circle <= 2) h += '<text class="ini" style="font-size:' + (r * .82).toFixed(1) + 'px">' + esc(p.ini) + "</text>";
      if (p.threads.length) h += '<circle class="dot" cx="' + (r * .74).toFixed(1) + '" cy="' + (-r * .74).toFixed(1) + '" r="' + Math.max(3.2 * K, r * .3).toFixed(1) + '"/>';
      if (p.bday != null && p.bday <= 14) h += '<g transform="translate(' + (-r * .8).toFixed(1) + "," + (-r * .8).toFixed(1) + ')"><circle class="cake" r="' + (6.5 * K).toFixed(1) + '"/><text class="cake-t" style="font-size:' + fs(8) + 'px">🎂</text></g>';
      var lx = 0, ly = below ? r + 12.5 * K : -(r + 5 * K), anc = "middle";
      if (p.circle === 1 && lbl) { var ax = Math.cos(p.ang), ay = Math.sin(p.ang), md = Math.abs(ax) < .35; lx = ax * (r + 5 * K); ly = ay * (r + (md ? 10 : 5) * K) + 4 * K; anc = md ? "middle" : ax > 0 ? "start" : "end"; }
      h += '<text class="nm' + (lbl ? "" : " hov") + '" style="text-anchor:' + anc + ";font-size:calc(" + fs(lbl ? (p.circle === 1 ? 12 : 11) : 11) + "px*var(--iz,1));stroke-width:" + fs(4) + 'px" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '">' + esc(lbl ? first : p.name) + "</text></g>";
    });
    h += '<g class="me"><circle class="pulse" r="' + (ME + 8).toFixed(1) + '"/><circle class="disc" r="' + ME.toFixed(1) + '"/><text style="font-size:' + fs(11) + 'px">You</text></g>';
    svg.innerHTML = h; declutter(svg, K); paint(svg, M, st);
  }
  /* Label collision avoidance. Inner circles first. A label that overlaps another label or a dot tries a few
     spots around its dot (drawing a thin leader line when it moves away); if none is free it is shown only on
     hover or focus. Every dot also carries its full name as a tooltip. */
  function declutter(svg, K) {
    var nodes = [].slice.call(svg.querySelectorAll("g.nd")), placed = [], dots = [];
    var pos = function (g) { var m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute("transform") || ""); return m ? [+m[1], +m[2]] : [0, 0]; };
    nodes.forEach(function (g) { var d = g.querySelector(".disc"), p = pos(g), r = d ? +d.getAttribute("r") : 6; dots.push([p[0] - r, p[1] - r, p[0] + r, p[1] + r, g]);
      if (!g.querySelector("title")) { var t = document.createElementNS("http://www.w3.org/2000/svg", "title"), al = g.getAttribute("aria-label") || ""; t.textContent = al.split(",")[0]; g.insertBefore(t, g.firstChild); } });
    var hit = function (b, skip) { return placed.some(function (q) { return b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]; }) || dots.some(function (q) { return q[4] !== skip && b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]; }); };
    var labels = nodes.map(function (g) { return { g: g, t: g.querySelector("text.nm:not(.hov)"), c: +((/\bc(\d)\b/.exec(g.getAttribute("class")) || [])[1] || 9) }; }).filter(function (x) { return x.t; }).sort(function (a, b) { return a.c - b.c; });
    labels.forEach(function (L) {
      var bb; try { bb = L.t.getBBox(); } catch (e) { return; } if (!bb || !bb.width) return;
      var p = pos(L.g), x0 = +L.t.getAttribute("x") || 0, y0 = +L.t.getAttribute("y") || 0, d = L.g.querySelector(".disc"), r = d ? +d.getAttribute("r") : 6, pad = 2 * K;
      var at = function (dx, dy) { return [p[0] + bb.x + dx - pad, p[1] + bb.y + dy - pad, p[0] + bb.x + bb.width + dx + pad, p[1] + bb.y + bb.height + dy + pad]; };
      if (!hit(at(0, 0), L.g)) { placed.push(at(0, 0)); return; }
      var step = bb.height + 3 * K, tries = [[0, step], [0, -step - r], [bb.width / 2 + r, -bb.height / 3], [-bb.width / 2 - r, -bb.height / 3], [0, 2 * step], [0, -2 * step - r], [bb.width / 2 + r, step], [-bb.width / 2 - r, step]];
      for (var i = 0; i < tries.length; i++) {
        var b = at(tries[i][0], tries[i][1]);
        if (!hit(b, L.g)) {
          L.t.setAttribute("x", (x0 + tries[i][0]).toFixed(1)); L.t.setAttribute("y", (y0 + tries[i][1]).toFixed(1)); placed.push(b);
          var ln = document.createElementNS("http://www.w3.org/2000/svg", "line"), lx = x0 + tries[i][0], ly = y0 + tries[i][1] - bb.height / 3, len = Math.hypot(lx, ly) || 1;
          ln.setAttribute("class", "lead"); ln.setAttribute("x1", (lx / len * r).toFixed(1)); ln.setAttribute("y1", (ly / len * r).toFixed(1)); ln.setAttribute("x2", lx.toFixed(1)); ln.setAttribute("y2", (ly + (ly > 0 ? -bb.height / 2 : bb.height / 3)).toFixed(1));
          L.g.insertBefore(ln, L.t); return;
        }
      }
      L.t.classList.add("hid");
    });
  }

  /* focus, filters and the person-to-person lines: cheap, runs on every selection or keystroke */
  function paint(svg, M, st) {
    var kin = {}, sel = st.sel && M.byId[st.sel] && !M.byId[st.sel].off ? M.byId[st.sel] : null;
    if (sel) sel.links.forEach(function (l) { kin[l.id] = 1; });
    svg.classList.toggle("focus", !!sel); svg.classList.toggle("dimq", filtering(st));
    [].forEach.call(svg.querySelectorAll(".nd,.ln,.chev"), function (e) {
      var p = M.byId[e.getAttribute("data-id")]; if (!p) return;
      e.classList.toggle("on", !!sel && p.id === sel.id); e.classList.toggle("kin", !!kin[p.id]); e.classList.toggle("miss", !match(p, st));
    });
    var L = "", pairs = [], calm = !sel && !st.showConn, tree = !!svg._tree;
    if (sel) sel.links.forEach(function (l) { pairs.push([sel, M.byId[l.id]]); });
    else if (!tree || st.showConn) M.on.forEach(function (a) {
      a.links.forEach(function (l) {
        var b = M.byId[l.id]; if (!b || b.off || !(a.id < b.id)) return;
        if (st.showConn ? Math.min(a.circle, b.circle) <= 3 : (a.circle <= 3 && b.circle <= 3 && a.g === b.g)) pairs.push([a, b]);
      });
    });
    pairs.forEach(function (pr) {
      var a = pr[0], b = pr[1]; if (!a || !b || a.x == null || b.x == null) return;
      var kf = calm || tree ? 1 : .62, mx = (a.x + b.x) / 2 * kf, my = (a.y + b.y) / 2 * kf;
      L += '<path class="p2p" style="stroke-opacity:' + (sel ? .85 : calm ? .28 : .34) + ";stroke-width:" + (calm ? 1 : 1.4) + '" d="M' + a.x.toFixed(1) + "," + a.y.toFixed(1) + "Q" + mx.toFixed(1) + "," + my.toFixed(1) + " " + b.x.toFixed(1) + "," + b.y.toFixed(1) + '"/>';
    });
    var g = svg.querySelector("#links"); if (g) g.innerHTML = L;
  }

  /* the List view: everyone, grouped by circle; people who are off the map sit quietly at the end */
  function listHtml(M, st) {
    var h = "", row = function (p) {
      var s = p.sits[0], sub = [p.rel, p.group, p.loc].filter(Boolean).join(" · ");
      return '<button class="lrow' + (st.sel === p.id ? " on" : "") + '" data-id="' + p.id + '">' + av(p) + "<span><b>" + esc(p.name) + "</b><small>" + esc(sub) + '</small></span><span class="s">' + esc(s ? s.t : "") + '</span><span class="m">' +
        (p.threads.length ? '<i title="Open thread"></i>' : "") + (p.bday != null && p.bday <= 14 ? "<span>🎂 " + C.inDays(p.bday) + "</span>" : "") + (p.last != null ? "<span>" + C.ago(p.last) + "</span>" : "") + glyph(p.quality) + "</span></button>";
    }, sec = function (title, arr, note) {
      arr = arr.filter(function (p) { return match(p, st); }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
      if (arr.length) h += "<section><h2>" + title + " <small>" + arr.length + (note ? " · " + note : "") + "</small></h2>" + arr.map(row).join("") + "</section>";
    };
    if (st.flt.archived) sec("Archived", M.P.filter(function (p) { return p.archived; }), "hidden everywhere else");
    else {
      for (var c = 1; c <= 5; c++) sec(RINGS[c], M.on.filter(function (p) { return p.circle === c; }));
      sec("Cut off", M.P.filter(function (p) { return !p.archived && !p.inMemory && p.quality === "cut_off"; }), "not on the map");
      sec("In memory", M.P.filter(function (p) { return !p.archived && p.inMemory; }));
    }
    return h || '<p class="empty" style="padding:24px 4px">Nobody matches. Clear the search or the filters to see everyone.</p>';
  }

  window.PPPeopleSky = { esc: esc, glyph: glyph, av: av, match: match, filtering: filtering, draw: draw, paint: paint, listHtml: listHtml };
})();
