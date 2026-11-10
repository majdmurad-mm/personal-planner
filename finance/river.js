/* Money river for the Finance page: a Sankey of one month (or an average), drawn by hand in SVG.
   Everything comes from the snapshot; no number lives here. Category names are matched by keyword
   only, so no personal names appear in this file. */
(function () {
  var R = window.PPFinanceRiver = {};
  var n = function (v) { return v == null || v === "" || isNaN(+v) ? null : +v; }, z = function (v) { return n(v) || 0; };
  var arr = function (a) { return Array.isArray(a) ? a : []; };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var eur = function (v, cur) { var d = Math.abs(v) >= 100 ? 0 : 2; return new Intl.NumberFormat("de-DE", { style: "currency", currency: cur || "EUR", minimumFractionDigits: d, maximumFractionDigits: d }).format(v); };
  var monY = function (s) { var d = new Date(s + "-01T12:00:00"); return isNaN(d) ? String(s) : d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }); };
  R.monY = monY;

  /* ---------- category → stream (first match wins; anything else is "other") ---------- */
  var OUT = [
    ["housing", "Housing", /\brent\b|miete|housing|mortgage|deposit/i],
    ["groceries", "Groceries", /grocer|supermarket|drugstore|lebensmittel/i],
    ["eating", "Eating out & delivery", /deliver|dining|restaurant|going out|eating|takeaway|caf[eé]/i],
    ["transport", "Transport", /transit|transport|\bcar\b|fuel|train|bahn|taxi|\bbike/i],
    ["travel", "Travel", /travel|flight|hotel|holiday|\btrip/i],
    ["bills", "Bills & subscriptions", /stream|\bsubs|subscription|electric|strom|internet|mobile|phone|insurance|\bfees?\b|interest|utilit|membership|wellhub|\bgym|\btools?\b|immoscout|software|cloud/i],
    ["shopping", "Shopping", /amazon|shopping|furniture|\bhome\b|gaming|steam|clothes|electronic|hobb|gift/i],
    ["loans", "Loans", /\bloans?\b|kredit/i]
  ];
  var INC = [
    ["drawn", "From savings", /\bsold\b|liquidat|from savings/i],
    ["salary", "Salary", /salary|gehalt|wage|payroll/i],
    ["sublet", "Sublet rent", /sublet|tenant|untermiet/i],
    ["shared", "Shared costs", /shared/i],
    ["refunds", "Refunds", /refund|landlord|erstattung/i],
    ["freelance", "Freelance & extra", /freelance|side work|consult|invoice|bonus/i]
  ];
  var ORDER_OUT = ["housing", "loans", "bills", "groceries", "eating", "transport", "shopping", "travel", "other", "rest", "savings", "buffer"];
  var ORDER_IN = ["inc", "salary", "income", "sublet", "shared", "freelance", "refunds", "otherin", "drawn", "gap"];
  var match = function (rules, name) { for (var i = 0; i < rules.length; i++) if (rules[i][2].test(name)) return rules[i]; return null; };
  R.streamOfCategory = function (name) { var m = match(OUT, String(name || "")); return m ? m[0] : "other"; };
  R.streamOfIncome = function (name) { var m = match(INC, String(name || "")); return m ? m[0] : "otherin"; };
  var NAMES = { other: "Other", otherin: "Other income", rest: "Everything else", savings: "Savings & investments", buffer: "Buffer (left over)", income: "Income (all sources)", gap: "Shortfall (from buffer or overdraft)", drawn: "From savings" };
  OUT.concat(INC).forEach(function (r) { NAMES[r[0]] = r[1]; });
  R.mapping = function (s) {
    var m = { categories: {}, income: {}, unmapped: [] };
    arr(s.categories).forEach(function (c) { var k = R.streamOfCategory(c.category); m.categories[c.category] = NAMES[k]; if (k === "other" && !/^other$/i.test(String(c.category).trim())) m.unmapped.push(c.category); });
    arr(s.income_sources).forEach(function (c) { m.income[c.source] = NAMES[R.streamOfIncome(c.source)]; });
    return m;
  };

  /* ---------- months ---------- */
  R.months = function (s) { return arr(s.monthly).map(function (m) { return m.month; }).filter(Boolean); };
  R.defaultMonth = function (s) { var ms = R.months(s), part = s.period && s.period.partial_month, full = ms.filter(function (m) { return m !== part; }); return full[full.length - 1] || ms[ms.length - 1] || null; };
  var periodMonths = function (s) {
    var p = s.period || {}, a = new Date(p.from), b = new Date(p.to);
    if (!isNaN(a) && !isNaN(b) && b > a) return Math.max(1, (b - a) / 864e5 / 30.4375);
    return Math.max(1, R.months(s).length);
  };

  /* ---------- the flows of one month ---------- */
  function finish(M, cur) {
    var by = function (order) { return function (a, b) { var x = order.indexOf(a.key.split(":")[0]), y = order.indexOf(b.key.split(":")[0]); return (x < 0 ? 99 : x) - (y < 0 ? 99 : y); }; };
    M.ins = M.ins.filter(function (x) { return x.v > 0.5; }); M.outs = M.outs.filter(function (x) { return x.v > 0.5; });
    M.income = M.ins.filter(function (x) { return x.key !== "drawn"; }).reduce(function (t, x) { return t + x.v; }, 0);
    M.drawn = M.ins.filter(function (x) { return x.key === "drawn"; }).reduce(function (t, x) { return t + x.v; }, 0);
    M.saved = M.outs.filter(function (x) { return x.key === "savings"; }).reduce(function (t, x) { return t + x.v; }, 0);
    M.spent = M.outs.reduce(function (t, x) { return t + x.v; }, 0) - M.saved;
    M.left = M.income + M.drawn - M.spent - M.saved;
    if (M.left > 0.5) M.outs.push({ key: "buffer", name: NAMES.buffer, v: M.left });
    else if (M.left < -0.5) M.ins.push({ key: "gap", name: NAMES.gap, v: -M.left });
    M.ins.sort(by(ORDER_IN)); M.outs.sort(by(ORDER_OUT));
    M.total = Math.max(M.ins.reduce(function (t, x) { return t + x.v; }, 0), M.outs.reduce(function (t, x) { return t + x.v; }, 0));
    M.cur = cur || "EUR"; M.empty = M.total < 1;
    return M;
  }
  var add = function (list, key, v, name) { if (!(v > 0)) return; var hit = list.filter(function (x) { return x.key === key; })[0]; if (hit) hit.v += v; else list.push({ key: key, name: name || NAMES[key] || key, v: v }); };
  function loansInto(outs, s, total) {
    var ls = arr(s.loans).filter(function (l) { return z(l.payment) > 0; }), sum = ls.reduce(function (t, l) { return t + z(l.payment); }, 0);
    if (!(total > 0)) return;
    if (!ls.length || !sum) { add(outs, "loans", total); return; }
    ls.forEach(function (l, i) { add(outs, "loans:" + i, total * z(l.payment) / sum, l.loan || "Loan " + (i + 1)); });
  }
  // One stream per income source. Money taken out of savings is kept apart (it is not income).
  var incKey = function (name) { return R.streamOfIncome(name) === "drawn" ? "drawn" : "inc:" + name; };
  R.incomeKey = incKey;
  function sourcesInto(M, list, nameKey, valKey, scale) {
    list.slice().sort(function (a, b) { return z(b[valKey]) - z(a[valKey]); }).forEach(function (c) { var k = incKey(c[nameKey]); add(M.ins, k, z(c[valKey]) * scale, k === "drawn" ? NAMES.drawn : String(c[nameKey])); });
  }
  R.month = function (s, month) {
    var row = arr(s.monthly).filter(function (m) { return m.month === month; })[0], M = { month: month, mode: "month", ins: [], outs: [], coarse: true, missing: [] };
    if (!row) { M.missing.push("no figures for this month"); return finish(M, s.currency); }
    M.partial = !!(s.period && s.period.partial_month === month);
    var cats = arr(s.monthly_categories).filter(function (c) { return c.month === month; }), incs = arr(s.monthly_income).filter(function (c) { return c.month === month; });
    // income
    if (incs.length) sourcesInto(M, incs, "source", "amount", 1);
    else {
      if (n(row.income) == null) M.missing.push("income");
      // No per-month income in the snapshot: split the month's income in the proportions of the whole period.
      var real = arr(s.income_sources).filter(function (c) { return incKey(c.source) !== "drawn" && z(c.total) > 0; }), tot = real.reduce(function (t, c) { return t + z(c.total); }, 0);
      if (real.length > 1 && tot > 0 && z(row.income) > 0) { sourcesInto(M, real, "source", "total", z(row.income) / tot); M.incomeEstimated = true; }
      else add(M.ins, "income", z(row.income));
      add(M.ins, "drawn", z(row.liquidated));
    }
    // spending
    var spend = n(row.spend);
    if (cats.length) {
      M.coarse = false;
      var seen = 0; cats.forEach(function (c) { var k = R.streamOfCategory(c.category); if (k === "loans") return; add(M.outs, k, z(c.amount)); seen += z(c.amount); });
      if (spend != null && spend - seen > 1) add(M.outs, "other", spend - seen);
    } else {
      if (spend == null) M.missing.push("spending");
      var rent = Object.keys(row).filter(function (k) { return /^rent/i.test(k); }).reduce(function (t, k) { return t + z(row[k]); }, 0), f = arr(s.food).filter(function (x) { return x.month === month; })[0] || {};
      var gro = z(f.groceries), eat = z(f.delivery) + z(f.dining);
      add(M.outs, "housing", rent); add(M.outs, "groceries", gro); add(M.outs, "eating", eat);
      add(M.outs, "rest", Math.max(0, z(spend) - rent - gro - eat));
    }
    loansInto(M.outs, s, z(row.loans)); add(M.outs, "savings", z(row.invest));
    return finish(M, s.currency);
  };
  // Average: the last three full months when they have per-month categories, otherwise the whole period.
  R.average = function (s, month) {
    var part = s.period && s.period.partial_month, ms = R.months(s).filter(function (m) { return m !== part && m <= month; }).slice(-3);
    var detailed = ms.length && ms.every(function (m) { return arr(s.monthly_categories).some(function (c) { return c.month === m; }); });
    var M = { month: month, mode: "average", ins: [], outs: [], coarse: false, missing: [] };
    if (detailed || !arr(s.categories).length) {
      var parts = ms.map(function (m) { return R.month(s, m); });
      parts.forEach(function (p) { p.ins.concat(p.outs).forEach(function (x) { if (x.key === "buffer" || x.key === "gap") return; add(p.ins.indexOf(x) >= 0 ? M.ins : M.outs, x.key, x.v / parts.length, x.name); }); });
      M.incomeEstimated = parts.some(function (p) { return p.incomeEstimated; });
      M.label = ms.length ? "Average of " + monY(ms[0]) + " to " + monY(ms[ms.length - 1]) : "No full months yet"; M.coarse = !detailed;
      return finish(M, s.currency);
    }
    var k = periodMonths(s), rows = arr(s.monthly);
    arr(s.categories).forEach(function (c) { var key = R.streamOfCategory(c.category); if (key !== "loans") add(M.outs, key, z(c.total) / k); });
    if (arr(s.income_sources).length) sourcesInto(M, arr(s.income_sources), "source", "total", 1 / k);
    else { add(M.ins, "income", rows.reduce(function (t, r) { return t + z(r.income); }, 0) / k); add(M.ins, "drawn", rows.reduce(function (t, r) { return t + z(r.liquidated); }, 0) / k); }
    loansInto(M.outs, s, rows.reduce(function (t, r) { return t + z(r.loans); }, 0) / k); add(M.outs, "savings", rows.reduce(function (t, r) { return t + z(r.invest); }, 0) / k);
    M.label = "Average per month over the whole snapshot period"; M.period = true;
    return finish(M, s.currency);
  };
  R.model = function (s, month, mode) { return mode === "average" ? R.average(s, month) : R.month(s, month); };
  R.prev = function (s, month) { var ms = R.months(s), i = ms.indexOf(month); return i > 0 ? R.month(s, ms[i - 1]) : null; };

  /* ---------- drawing ---------- */
  var tone = function (x, i, side) { var b = x.key.split(":")[0]; return b === "gap" || b === "drawn" ? "gap" : b === "savings" ? "save" : b === "buffer" ? "lake" : side === "in" ? "in" + (Math.min(i, 4) + 1) : "sp" + ((i % 4) + 1); };
  function info(M, x, side, prev) {
    var cur = M.cur, share = M.income > 0 ? Math.round(x.v / M.income * 100) + " % of income" : "", p = prev ? prev.ins.concat(prev.outs).filter(function (y) { return y.key === x.key; })[0] : null, d = prev ? x.v - (p ? p.v : 0) : null;
    return { tip: x.name + "\n" + eur(x.v, cur) + (side === "in" && M.incomeEstimated && x.key.indexOf("inc:") === 0 ? " (estimated share of the month’s income)" : "") + (share && side === "out" ? " · " + share : "") + (share && side === "in" && x.key.indexOf("inc:") === 0 ? " · " + share : "") + (d == null || M.mode !== "month" ? "" : "\n" + (Math.abs(d) < 0.5 ? "Same as the month before" : (d > 0 ? "+" : "−") + eur(Math.abs(d), cur) + " vs the month before")), share: share, delta: d };
  }
  var attrs = function (M, x, side, prev, sel) { var I = info(M, x, side, prev); return ' class="rs' + (sel === x.key ? " on" : "") + '" data-stream="' + esc(x.key) + '" tabindex="0" role="button" aria-pressed="' + (sel === x.key) + '" aria-label="' + esc(I.tip.replace(/\n/g, ", ")) + '" data-tip="' + esc(I.tip) + '"'; };
  var shim = function (d) { return '<path class="shim" d="' + d + '"/>'; };
  function wide(M, prev, sel) {
    var W = 1180, gap = 9, nIn = M.ins.length, nOut = M.outs.length, H = Math.max(360, Math.min(560, 150 + Math.max(nIn, nOut) * 34)), k = (H - 50 - gap * Math.max(nOut - 1, (nIn - 1) * 2)) / M.total;
    var xl = 330, xm = 620, mw = 60, xr = 940, nw = 10, sumIn = M.ins.reduce(function (t, x) { return t + x.v; }, 0), sumOut = M.outs.reduce(function (t, x) { return t + x.v; }, 0);
    var my = (H - M.total * k) / 2 + 8, ly = (H - (sumIn * k + gap * 2 * (nIn - 1))) / 2 + 8, ry = (H - (sumOut * k + gap * (nOut - 1))) / 2 + 8, a = my + (M.total - sumIn) * k / 2, b = my + (M.total - sumOut) * k / 2, svg = "";
    var rib = function (x0, y0, x1, y1, h, c, at) { var mx = (x0 + x1) / 2, hh = Math.max(1.2, h); return "<g" + at + '><path class="rib" fill="var(--r-' + c + ')" d="M' + x0 + "," + y0 + " C" + mx + "," + y0 + " " + mx + "," + y1 + " " + x1 + "," + y1 + " L" + x1 + "," + (y1 + hh) + " C" + mx + "," + (y1 + hh) + " " + mx + "," + (y0 + hh) + " " + x0 + "," + (y0 + hh) + ' Z"/>' + (h > 14 ? shim("M" + x0 + "," + (y0 + h / 2) + " C" + mx + "," + (y0 + h / 2) + " " + mx + "," + (y1 + h / 2) + " " + x1 + "," + (y1 + h / 2)) : "") + "</g>"; };
    M.ins.forEach(function (x, i) { var h = x.v * k, c = tone(x, i, "in"); svg += rib(xl + nw, ly, xm, a, h, c, attrs(M, x, "in", prev, sel)) + '<rect x="' + xl + '" y="' + ly + '" width="' + nw + '" height="' + Math.max(2, h) + '" rx="3" fill="var(--r-' + c + ')"/><text text-anchor="end" x="' + (xl - 10) + '" y="' + (ly + h / 2 + 4) + '"><tspan class="big">' + (c === "gap" ? "▲ " : "") + esc(x.name.length > 30 ? x.name.slice(0, 29) + "…" : x.name) + '</tspan><tspan class="amt" dx="8">' + eur(x.v, M.cur) + "</tspan></text>"; ly += h + gap * 2; a += h; });
    svg += '<rect x="' + xm + '" y="' + my + '" width="' + mw + '" height="' + M.total * k + '" rx="8" fill="var(--r-trunk)"/><text class="big" text-anchor="middle" x="' + (xm + mw / 2) + '" y="' + (my - 12) + '">' + (M.mode === "average" ? "An average month" : "This month’s money") + '</text><text class="amt" text-anchor="middle" x="' + (xm + mw / 2) + '" y="' + (my + M.total * k + 20) + '">' + eur(M.total, M.cur) + "</text>";
    M.outs.forEach(function (x, i) { var h = x.v * k, c = tone(x, i, "out"), lake = c === "lake"; svg += rib(xm + mw, b, xr, ry, h, c, attrs(M, x, "out", prev, sel)) + (lake ? '<ellipse cx="' + (xr + 26) + '" cy="' + (ry + h / 2) + '" rx="30" ry="' + Math.max(12, h / 2 + 4) + '" fill="var(--r-lake)" opacity=".85"/>' : '<rect x="' + xr + '" y="' + ry + '" width="' + nw + '" height="' + Math.max(2, h) + '" rx="3" fill="var(--r-' + c + ')"/>') + '<text x="' + (xr + (lake ? 66 : 20)) + '" y="' + (ry + h / 2 + 4) + '"><tspan class="big">' + esc(x.name) + '</tspan><tspan class="amt" dx="8">' + eur(x.v, M.cur) + (M.income > 0 ? " · " + Math.round(x.v / M.income * 100) + " %" : "") + "</tspan></text>"; ry += h + gap; b += h; });
    return '<svg viewBox="0 0 ' + W + " " + (H + 16) + '" role="group" aria-label="Money river: income on the left flows into spending, savings and the buffer on the right">' + svg + "</svg>";
  }
  function tall(M, prev, sel) {
    var W = 358, k = 92 / M.total, x0 = 14, xe = 148, r = 10, yy = 16, flow = 0, bound = null, parts = "";
    var trunkTo = function (y) { if (bound != null && flow > 0.01 && y > bound) parts += '<rect x="' + x0 + '" y="' + (bound - 0.5) + '" width="' + flow * k + '" height="' + (y - bound + 1) + '" fill="var(--r-trunk)"/>'; bound = y; };
    var label = function (x, y, c, txt) { var lx = xe + (c === "lake" ? 30 : 10); return (c === "lake" ? '<ellipse cx="' + (xe + 8) + '" cy="' + y + '" rx="15" ry="' + Math.max(10, x.v * k / 2 + 4) + '" fill="var(--r-lake)"/>' : "") + '<text x="' + lx + '" y="' + (y - 2) + '" class="big">' + (c === "gap" ? "▲ " : "") + esc(x.name) + '</text><text class="amt" x="' + lx + '" y="' + (y + 14) + '">' + txt + "</text>"; };
    M.ins.forEach(function (x, i) {
      var w = Math.max(2, x.v * k), y = yy + w / 2 + 8, xr = x0 + (flow + x.v) * k, yb = y + w / 2 + r, c = tone(x, i, "in");
      trunkTo(yb); flow += x.v;
      parts += "<g" + attrs(M, x, "in", prev, sel) + '><path class="rib" fill="var(--r-' + c + ')" d="M' + xe + "," + (y - w / 2) + " L" + (xr + r) + "," + (y - w / 2) + " Q" + (xr - w) + "," + (y - w / 2) + " " + (xr - w) + "," + yb + " L" + xr + "," + yb + " Q" + xr + "," + (y + w / 2) + " " + (xr + r) + "," + (y + w / 2) + " L" + xe + "," + (y + w / 2) + ' Z"/></g>' + label(x, y, c, eur(x.v, M.cur));
      yy = Math.max(yb, y + 24) + 8;
    });
    trunkTo(yy + 44);
    parts += '<text class="big" x="' + (x0 + flow * k + 12) + '" y="' + (yy + 18) + '">' + (M.mode === "average" ? "An average month" : "This month’s money") + '</text><text class="amt" x="' + (x0 + flow * k + 12) + '" y="' + (yy + 34) + '">' + eur(M.total, M.cur) + "</text>"; yy += 52;
    M.outs.forEach(function (x, i) {
      var w = Math.max(2, x.v * k), y = yy + w / 2 + r, xr = x0 + flow * k, yt = y - w / 2 - r, c = tone(x, i, "out");
      trunkTo(yt); flow -= x.v;
      parts += "<g" + attrs(M, x, "out", prev, sel) + '><path class="rib" fill="var(--r-' + c + ')" d="M' + xr + "," + yt + " Q" + xr + "," + (y - w / 2) + " " + (xr + r) + "," + (y - w / 2) + " L" + xe + "," + (y - w / 2) + " L" + xe + "," + (y + w / 2) + " L" + (xr + r) + "," + (y + w / 2) + " Q" + (xr - w) + "," + (y + w / 2) + " " + (xr - w) + "," + yt + ' Z"/></g>' + label(x, y, c, eur(x.v, M.cur) + (M.income > 0 ? " · " + Math.round(x.v / M.income * 100) + " %" : ""));
      yy = Math.max(y + w / 2, y + 22) + 10;
    });
    return '<svg viewBox="0 0 ' + W + " " + yy + '" role="group" aria-label="Money river, top to bottom: income joins, then spending, savings and the buffer branch off">' + parts + "</svg>";
  }
  R.svg = function (M, prev, o) { return M.empty ? "" : (o && o.narrow ? tall : wide)(M, prev, o && o.sel); };
  R.table = function (M, prev) {
    var row = function (x, side) { var I = info(M, x, side, prev); return "<tr><td>" + (side === "in" ? "In" : "Out") + "</td><td>" + esc(x.name) + '</td><td class="num">' + eur(x.v, M.cur) + '</td><td class="num">' + (side === "out" && M.income > 0 ? Math.round(x.v / M.income * 100) + " %" : "") + '</td><td class="num">' + (I.delta == null || M.mode !== "month" ? "" : (I.delta > 0.5 ? "+" : I.delta < -0.5 ? "−" : "±") + eur(Math.abs(I.delta), M.cur)) + "</td></tr>"; };
    return '<div class="rtable"><table><thead><tr><th>Direction</th><th>Stream</th><th class="num">Amount</th><th class="num">Share of income</th><th class="num">Change vs month before</th></tr></thead><tbody>' + M.ins.map(function (x) { return row(x, "in"); }).join("") + M.outs.map(function (x) { return row(x, "out"); }).join("") + "</tbody></table></div>";
  };
  // A blend of two models, for the short animation when the month changes.
  R.blend = function (A, B, t) {
    var mix = function (la, lb) { var keys = [], out = []; la.concat(lb).forEach(function (x) { if (keys.indexOf(x.key) < 0) keys.push(x.key); }); keys.forEach(function (k) { var a = la.filter(function (x) { return x.key === k; })[0], b = lb.filter(function (x) { return x.key === k; })[0], v = (a ? a.v : 0) * (1 - t) + (b ? b.v : 0) * t; if (v > 0.5) out.push({ key: k, name: (b || a).name, v: v }); }); return out; };
    var M = { month: B.month, mode: B.mode, cur: B.cur, ins: mix(A.ins, B.ins), outs: mix(A.outs, B.outs), income: A.income * (1 - t) + B.income * t };
    var order = function (list, ref) { return list.sort(function (x, y) { var i = ref.map(function (r) { return r.key; }); return (i.indexOf(x.key) < 0 ? 99 : i.indexOf(x.key)) - (i.indexOf(y.key) < 0 ? 99 : i.indexOf(y.key)); }); };
    order(M.ins, B.ins); order(M.outs, B.outs);
    M.total = Math.max(M.ins.reduce(function (s, x) { return s + x.v; }, 0), M.outs.reduce(function (s, x) { return s + x.v; }, 0)); M.empty = M.total < 1;
    return M;
  };
  R.eur = eur;
})();
