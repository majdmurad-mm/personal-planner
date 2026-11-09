/* Health page, part 2 of 3: charts and the body figure, as SVG strings.
   Body region paths: body-muscles 1.0.0 by Ivan Vulović, Apache-2.0 (https://github.com/vulovix/body-muscles).
   The paths are unmodified and only restyled. The organ shapes are original. */
(function () {
  var H = window.PPH = window.PPH || {};
  var fmt = H.fmt, dstr = H.dstr, wday = H.wday, esc = H.esc, pad2 = H.pad2;
  var ok = function (a) { return a.filter(function (x) { return x != null; }); };
  var note = function (t) { return '<p class="empty">' + t + "</p>"; };
  H.charts = []; var cid = 0;
  function linePath(pts) { var d = "", pen = false; pts.forEach(function (p) { if (p[1] == null) { pen = false; return; } d += (pen ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); pen = true; }); return d; }
  function lastIdx(v) { var i = v.length - 1; while (i >= 0 && v[i] == null) i--; return i; }

  H.spark = function (v, o) {
    o = o || {}; var have = ok(v); if (have.length < 2) return note(o.empty || "Not enough readings yet");
    var w = o.w || 132, h = o.h || 40, a = have.concat(o.band || []), mn = Math.min.apply(0, a), mx = Math.max.apply(0, a), r = (mx - mn) || 1, p = 5;
    var y = function (x) { return h - p - (x - mn) / r * (h - 2 * p); }, pts = v.map(function (x, i) { return [p + i * (w - 2 * p) / (v.length - 1), x == null ? null : y(x)]; });
    var li = lastIdx(v), first = pts.filter(function (q) { return q[1] != null; })[0];
    var band = o.band ? '<rect x="0" y="' + y(o.band[1]).toFixed(1) + '" width="' + w + '" height="' + Math.max(2, y(o.band[0]) - y(o.band[1])).toFixed(1) + '" rx="3" class="c-band"/>' : "";
    var area = o.band || have.length !== v.length ? "" : '<path class="c-area" d="M' + first[0].toFixed(1) + " " + h + linePath(pts).replace(/M/g, "L") + "L" + pts[li][0].toFixed(1) + " " + h + 'Z"/>';
    return '<svg class="spark' + (o.wide ? " wide" : "") + '" viewBox="0 0 ' + w + " " + h + '"' + (o.label ? ' role="img" aria-label="' + esc(o.label) + '"' : ' aria-hidden="true"') + ">" + band + area + '<path class="c-line" d="' + linePath(pts) + '"/><circle class="c-end" cx="' + pts[li][0].toFixed(1) + '" cy="' + pts[li][1].toFixed(1) + '" r="3.2"/></svg>';
  };

  /* o.periods: [{from,to,status}] drawn as shaded bands, so a sick week reads as a pause, not a slump. */
  H.trend = function (vals, dates, o) {
    o = o || {}; var have = ok(vals); if (have.length < 2) return note(o.empty || "Not enough readings yet to draw a trend.");
    var w = o.w || 640, h = o.h || 190, L = 38, R = 10, Tp = 12, Bt = 22, id = "hc" + (++cid);
    var extra = o.band || [], mn = Math.min.apply(0, have.concat(extra)), mx = Math.max.apply(0, have.concat(extra)), pad = (mx - mn) * 0.12 || 1; mn -= pad; mx += pad;
    var x = function (i) { return L + i * (w - L - R) / (vals.length - 1); }, y = function (v) { return Tp + (mx - v) / (mx - mn) * (h - Tp - Bt); };
    var f = function (v) { return o.dec ? v.toFixed(o.dec) : fmt(v); };
    var grid = [mn + (mx - mn) * 0.15, (mn + mx) / 2, mx - (mx - mn) * 0.15].map(function (g) { return '<line class="c-grid" x1="' + L + '" x2="' + (w - R) + '" y1="' + y(g).toFixed(1) + '" y2="' + y(g).toFixed(1) + '"/><text class="c-ax" x="' + (L - 6) + '" y="' + (y(g) + 3.5).toFixed(1) + '" text-anchor="end">' + f(g) + "</text>"; }).join("");
    var ticks = [0, Math.floor(vals.length / 2), vals.length - 1].map(function (i, n) { return '<text class="c-ax" x="' + x(i).toFixed(1) + '" y="' + (h - 5) + '" text-anchor="' + ["start", "middle", "end"][n] + '">' + dstr(dates[i]) + "</text>"; }).join("");
    var band = o.band ? '<rect class="c-band" x="' + L + '" width="' + (w - L - R) + '" y="' + y(o.band[1]).toFixed(1) + '" height="' + Math.max(2, y(o.band[0]) - y(o.band[1])).toFixed(1) + '" rx="3"/><text class="c-ax" x="' + (w - R - 4) + '" y="' + (y(o.band[1]) + 12).toFixed(1) + '" text-anchor="end">your usual range</text>' : "";
    var per = (o.periods || []).map(function (p) {
      var a = -1, b = -1; dates.forEach(function (d, i) { if (d >= p.from && (!p.to || d <= p.to)) { if (a < 0) a = i; b = i; } }); if (a < 0) return "";
      var x0 = Math.max(L, x(a) - 3), x1 = Math.min(w - R, x(b) + 3);
      return '<rect class="c-sick" x="' + x0.toFixed(1) + '" y="' + Tp + '" width="' + (x1 - x0).toFixed(1) + '" height="' + (h - Tp - Bt) + '" rx="3"/><text class="c-ax" x="' + ((x0 + x1) / 2).toFixed(1) + '" y="' + (h - Bt - 5) + '" text-anchor="middle">' + esc(p.status) + "</text>";
    }).join("");
    var dots = o.dots ? vals.map(function (v, i) { return v == null ? "" : '<circle class="c-faint" cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.4"/>'; }).join("") : "";
    var main = o.smooth && ok(o.smooth).length >= 2 ? o.smooth : vals, pts = main.map(function (v, i) { return [x(i), v == null ? null : y(v)]; }), li = lastIdx(main);
    H.charts.push({ id: id, x: vals.map(function (_, i) { return x(i); }), w: w, labels: vals.map(function (v, i) { return dstr(dates[i]) + " · " + (v == null ? "no data" : f(v) + (o.unit ? " " + o.unit : "")) + (o.smooth && o.smooth[i] != null ? " · 7-day " + o.smooth[i].toFixed(1) : ""); }) });
    return '<svg class="trend" id="' + id + '" viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="' + esc(o.label || "Trend") + '">' + grid + band + per + ticks + dots + '<path class="c-line' + (main !== vals ? " strong" : "") + '" d="' + linePath(pts) + '"/><circle class="c-end" cx="' + x(li).toFixed(1) + '" cy="' + y(main[li]).toFixed(1) + '" r="3.6"/><line class="c-cross" y1="' + Tp + '" y2="' + (h - Bt) + '" style="display:none"/></svg>';
  };

  H.volumeBars = function (V) {
    if (!V.some(function (v) { return v.vol > 0; })) return note("No sessions logged in the last 8 weeks.");
    var w = 420, h = 130, mx = Math.max.apply(0, V.map(function (v) { return v.vol; })), bw = (w - 16) / V.length, id = "hc" + (++cid), Hh = h - 24;
    var b = V.map(function (v, i) { var bh = Math.max(8, v.vol / mx * (Hh - 12)), x = 8 + i * bw + 7, cw = bw - 14; return (v.vol ? '<path class="c-bar' + (v.current ? " on" : "") + '" d="M' + x + " " + Hh + "V" + (Hh - bh + 4).toFixed(1) + "q0 -4 4 -4h" + (cw - 8) + "q4 0 4 4V" + Hh + 'Z"/>' : '<rect class="c-rest" x="' + x + '" y="' + (Hh - 3) + '" width="' + cw + '" height="3" rx="1.5"/>') + (i % 2 === 1 ? '<text class="c-ax" x="' + (x + cw / 2) + '" y="' + (h - 6) + '" text-anchor="middle">' + dstr(v.from) + "</text>" : ""); }).join("");
    H.charts.push({ id: id, x: V.map(function (_, i) { return 8 + i * bw + bw / 2; }), w: w, labels: V.map(function (v) { return "Week of " + dstr(v.from) + " · " + (v.vol ? fmt(v.vol) + " kg in " + v.n + " session" + (v.n > 1 ? "s" : "") : v.paused ? v.paused + ", paused" : v.current ? "no session yet" : "no sessions") + (v.vol && v.paused ? " · " + v.paused + " part of the week" : ""); }) });
    return '<svg class="trend" id="' + id + '" viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="Training volume per week, last 8 weeks"><line class="c-grid" x1="8" x2="' + (w - 8) + '" y1="' + Hh + '" y2="' + Hh + '"/>' + b + "</svg>";
  };

  H.stages = function (r) {
    var s = [["Deep", r.deep_minutes, "deep"], ["Light", r.light_minutes, "light"], ["REM", r.rem_minutes, "rem"], ["Awake", r.awake_minutes, "awake"]].filter(function (x) { return x[1] != null; });
    if (!s.length) return ""; var t = s.reduce(function (a, x) { return a + +x[1]; }, 0) || 1;
    return '<div class="stages" role="img" aria-label="Sleep stages: ' + s.map(function (x) { return x[0] + " " + x[1] + " minutes"; }).join(", ") + '">' + s.map(function (x) { return '<i class="st-' + x[2] + '" style="flex:' + (x[1] / t).toFixed(3) + '"></i>'; }).join("") + '</div><div class="stage-key">' + s.map(function (x) { return '<span><b class="st-' + x[2] + '"></b>' + x[0] + " " + Math.floor(x[1] / 60) + "h" + pad2(x[1] % 60) + "</span>"; }).join("") + "</div>";
  };
  H.nights = function (days) {
    return '<div class="nights">' + days.map(function (x) { var v = x.r && x.r.sleep_score != null ? +x.r.sleep_score : null, s = H.st(v), t = wday(x.d) + (v == null ? ": no sleep data" : ": score " + v + (x.r.bed_time ? ", asleep " + H.clock(x.r.bed_time) : ""));
      return '<div class="night ' + s + '" title="' + t + '" aria-label="' + t + '"><i style="height:' + (v == null ? 14 : Math.max(10, v * 0.72)) + '%"></i><span>' + wday(x.d)[0] + "</span></div>"; }).join("") + "</div>";
  };
  H.bbCurve = function (curve) {
    if (!curve || curve.length < 2) return note("No Body Battery curve for today yet.");
    var w = 240, h = 58, v = curve.map(function (p) { return +p[1]; }), n = v.length, pts = v.map(function (x, i) { return [4 + i * (w - 8) / (n - 1), h - 5 - x / 100 * (h - 10)]; });
    return '<svg class="spark wide" viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="Body Battery since midnight: low ' + Math.min.apply(0, v) + ", high " + Math.max.apply(0, v) + ", latest " + v[n - 1] + '"><path class="c-area" d="M4 ' + h + linePath(pts).replace(/M/g, "L") + "L" + (w - 4) + " " + h + 'Z"/><path class="c-line" d="' + linePath(pts) + '"/><circle class="c-end" cx="' + pts[n - 1][0].toFixed(1) + '" cy="' + pts[n - 1][1].toFixed(1) + '" r="3.2"/></svg>';
  };

  /* blocks: [{from, to (hours 0–24), cls, label}], curve: [[hour, value]], nowH: hour of day */
  H.timeline = function (blocks, curve, nowH, aria) {
    var w = 760, h = 132, X = function (t) { return 8 + Math.max(0, Math.min(24, t)) / 24 * (w - 16); };
    var hrs = [0, 6, 12, 18, 24].map(function (t) { return '<line class="c-grid" x1="' + X(t) + '" x2="' + X(t) + '" y1="8" y2="' + (h - 22) + '"/><text class="c-ax" x="' + X(t) + '" y="' + (h - 6) + '" text-anchor="' + (t === 0 ? "start" : t === 24 ? "end" : "middle") + '">' + pad2(t) + ":00</text>"; }).join("");
    var bl = curve && curve.length > 1 ? '<path class="c-line" d="' + curve.map(function (p, i) { return (i ? "L" : "M") + X(+p[0]).toFixed(1) + " " + (64 - p[1] / 100 * 50).toFixed(1); }).join("") + '"/><text class="c-ax" x="' + Math.max(96, X(+curve[curve.length - 1][0]) - 8).toFixed(1) + '" text-anchor="end" y="' + Math.max(18, 64 - curve[curve.length - 1][1] / 100 * 50 - 9).toFixed(1) + '">Body Battery ' + curve[curve.length - 1][1] + "</text>" : "";
    var free = [0, 0], bk = blocks.map(function (b) {
      var x0 = X(b.from), bwid = Math.max(5, X(b.to) - x0), inside = bwid > b.label.length * 6.2 + 12, out = "";
      if (!inside && b.label) { var row = x0 > free[0] ? 0 : x0 > free[1] ? 1 : -1; if (row >= 0) { var tx = Math.min(x0, w - 8 - b.label.length * 5.6); free[row] = tx + b.label.length * 5.8 + 8; out = '<text class="c-ax" x="' + tx.toFixed(1) + '" y="' + (row ? 70 : 106) + '">' + esc(b.label) + "</text>"; } }
      return '<g><title>' + esc(b.title || b.label) + '</title><rect class="tl ' + b.cls + '" x="' + x0.toFixed(1) + '" y="74" width="' + bwid.toFixed(1) + '" height="18" rx="5"/>' + (inside ? '<text class="tl-t' + (b.cls === "sleep" ? "" : " inv") + '" x="' + (x0 + 7).toFixed(1) + '" y="87">' + esc(b.label) + "</text>" : out) + "</g>";
    }).join("");
    var now = nowH == null ? "" : '<line class="c-now" x1="' + X(nowH).toFixed(1) + '" x2="' + X(nowH).toFixed(1) + '" y1="8" y2="' + (h - 22) + '"/><text class="c-ax now" x="' + (nowH > 21.5 ? X(nowH) - 5 : X(nowH) + 5).toFixed(1) + '" y="16"' + (nowH > 21.5 ? ' text-anchor="end"' : "") + ">now</text>";
    return '<div class="scroll-x"><svg class="timeline" viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="' + esc(aria) + '">' + hrs + bl + bk + now + "</svg></div>";
  };

  /* ---------- body figure ---------- */
  var classify = function (id) { var r = [[/^chest/, "chest"], [/^shoulder-/, "shoulders"], [/^deltoid-rear/, "rear"], [/^traps/, "traps"], [/^lats/, "lats"], [/^lower-back/, "lower_back"], [/^biceps/, "biceps"], [/^triceps/, "triceps"], [/^forearm/, "forearms"], [/^abs/, "abs"], [/^(obliques|serratus)/, "obliques"], [/^quads/, "quads"], [/^hamstrings/, "hamstrings"], [/^gluteus/, "glutes"], [/^adductors/, "adductors"], [/^(calves|tibialis)/, "calves"]]; for (var i = 0; i < r.length; i++) if (r[i][0].test(id)) return r[i][1]; return null; };
  H.ORGANS = {
    brain: { label: "Brain", paths: ["M15.85 2.5C13 2.5 11.7 4.1 11.8 5.9c.1 1.6 1.3 2.6 2.4 2.8.7.8 2.5.8 3.3 0 1.1-.2 2.3-1.2 2.4-2.8.1-1.8-1.2-3.4-4.05-3.4Z"], lines: ["M15.85 2.8v5.6M13 4.3c.8.3 1.3.9 1.4 1.7M18.7 4.3c-.8.3-1.3.9-1.4 1.7M12.9 6.9c.6-.3 1.2-.3 1.8.1M18.8 6.9c-.6-.3-1.2-.3-1.8.1"] },
    lungs: { label: "Lungs", paths: ["M14.9 17.9c-2.6.4-4.5 4-4.7 9.3-.1 1.5 1.3 1.9 2.8 1.2 1.1-.5 2-1 2.1-2.2Z", "M16.8 17.9c2.6.4 4.5 4 4.7 9.3.1 1.5-1.3 1.9-2.8 1.2-1.1-.5-2-1-2.1-2.2Z"], lines: [] },
    heart: { label: "Heart", paths: ["M17 20.7c.5-1.2 2.7-1.3 3.1.4.4 1.9-1.7 3.8-3.5 5-1.5-1.1-3.1-2.8-2.7-4.4.3-1.4 2.5-1.4 3.1-1Z"], lines: [] }
  };
  H.bodySVG = function (view, flags) {
    var list = window.PPHealthBody[view], vb = view === "front" ? "0 0 35 93" : "37 0 35 93", S = "_" + view, by = {}, off = view === "back" ? 37 : 0;
    list.forEach(function (m) { var g = classify(m.id); if (g) (by[g] = by[g] || []).push(m); });
    var sil = list.map(function (m) { return '<path d="' + m.d + '"/>'; }).join("");
    var grp = function (a11y) { return Object.keys(by).map(function (g) { return '<g class="mg" data-m="' + g + '"' + (a11y ? ' tabindex="-1" role="button" aria-label="' + H.MUSCLES[g] + '"' : ' aria-hidden="true"') + ">" + by[g].map(function (m) { return '<path d="' + m.d + '"/>'; }).join("") + "</g>"; }).join(""); };
    var organs = view === "front" ? '<g class="organs">' + Object.keys(H.ORGANS).map(function (k) { var o = H.ORGANS[k]; return '<g class="organ" data-o="' + k + '" tabindex="-1" role="button" aria-label="' + o.label + '">' + o.paths.map(function (p) { return '<path d="' + p + '"/>'; }).join("") + o.lines.map(function (p) { return '<path class="sulci" d="' + p + '"/>'; }).join("") + "</g>"; }).join("") + "</g>" : "";
    var marks = flags.map(function (f, i) { if (f.view !== view) return ""; var cx = (view === "back" && f.cx < 37 ? f.cx + off : f.cx); return '<g class="flagmark" data-f="' + i + '" data-s="' + f.s + '" tabindex="-1" role="button" aria-label="' + esc(f.label) + ' flag"><circle class="pulse" cx="' + cx + '" cy="' + f.cy + '" r="3.4"/><circle cx="' + cx + '" cy="' + f.cy + '" r="1.25"/></g>'; }).join("");
    return '<svg viewBox="' + vb + '" class="bodysvg" role="group" aria-label="Body, ' + view + ' view">' +
      '<defs><filter id="goo' + S + '" x="-5%" y="-3%" width="110%" height="106%"><feGaussianBlur stdDeviation=".2"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 14 -6"/></filter>' +
      '<filter id="fuse' + S + '" x="-8%" y="-4%" width="116%" height="108%"><feGaussianBlur stdDeviation=".55"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 9 -4"/></filter>' +
      '<filter id="soft' + S + '" x="-30%" y="-15%" width="160%" height="130%"><feGaussianBlur stdDeviation="1.5"/></filter>' +
      '<linearGradient id="bg' + S + '" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--body-a)"/><stop offset="1" stop-color="var(--body-b)"/></linearGradient></defs>' +
      '<g class="silwrap"><g class="sil" filter="url(#fuse' + S + ')" fill="url(#bg' + S + ')" stroke="url(#bg' + S + ')" stroke-width=".85" stroke-linejoin="round">' + sil + "</g></g>" +
      '<g class="glow" filter="url(#soft' + S + ')">' + grp(false) + "</g>" +
      '<g class="muscles" filter="url(#goo' + S + ')">' + grp(true) + "</g>" + organs + marks + "</svg>";
  };
})();
