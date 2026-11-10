/* Finance page: renders one snapshot (see finance/sample.js for the shape). No number lives in this file;
   everything comes from the snapshot. A null renders as "not provided yet", never as 0. */
(function () {
  var F = window.PPFinance = window.PPFinance || {}, R = window.PPFinanceRiver;
  var SUPPORTED = ["1", "1.0"], NP = "not provided yet", CUR = "EUR", STALE_DAYS = 35;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var n = function (v) { return v == null || v === "" || isNaN(+v) ? null : +v; };
  var arr = function (a) { return Array.isArray(a) ? a : []; };
  var eur = function (v) { v = n(v); if (v == null) return NP; var d = Math.abs(v) >= 100 ? 0 : 2; return new Intl.NumberFormat("de-DE", { style: "currency", currency: CUR, minimumFractionDigits: d, maximumFractionDigits: d }).format(v); };
  var money = function (v) { return n(v) == null ? '<span class="np">' + NP + "</span>" : eur(v); };
  var pct = function (v, d) { return n(v) == null ? NP : new Intl.NumberFormat("de-DE", { maximumFractionDigits: d == null ? 1 : d, minimumFractionDigits: 0 }).format(v) + " %"; };
  var signed = function (v) { return (v > 0 ? "+" : v < 0 ? "−" : "±") + eur(Math.abs(v)); };
  var dmy = function (s) { if (!s) return NP; var d = new Date(String(s).length === 7 ? s + "-01" : s); return isNaN(d) ? esc(s) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };
  var mon = function (s) { var d = new Date(s + "-01"); return isNaN(d) ? String(s) : d.toLocaleDateString("en-GB", { month: "short" }); };
  var monY = function (s) { var d = new Date(s + "-01"); return isNaN(d) ? String(s) : d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }); };
  /* null-aware sum: null when nothing is known; miss counts the unknown rows */
  var sum = function (list, key) { var t = 0, have = 0, miss = 0; arr(list).forEach(function (x) { var v = n(typeof key === "function" ? key(x) : x[key]); if (v == null) miss++; else { t += v; have++; } }); return { v: have ? t : null, miss: miss }; };
  var missNote = function (m, what) { return m ? " · " + m + " " + what + (m > 1 ? "s " : " ") + NP : ""; };
  var label = function (k) { return String(k).replace(/_/g, " ").replace(/^./, function (c) { return c.toUpperCase(); }); };
  var tip = function (t) { return ' data-tip="' + esc(t) + '" tabindex="0"'; };

  /* ---------- validation (the same rules the import tool applies) ---------- */
  F.validate = function (s) {
    var e = [], lists = ["accounts", "monthly", "balances_eom", "categories", "food", "subscriptions", "loans", "investments", "property", "income_sources", "actions", "monthly_categories", "monthly_income"];
    if (!s || typeof s !== "object" || Array.isArray(s)) return ["The file is not a snapshot object."];
    if (SUPPORTED.indexOf(String(s.schema_version)) < 0) e.push("Unknown schema_version " + JSON.stringify(s.schema_version) + ". This page reads version " + SUPPORTED[0] + ".");
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(s.as_of || ""))) e.push("as_of must be a date like 2026-11-10.");
    lists.forEach(function (k) { if (s[k] != null && !Array.isArray(s[k])) e.push(k + " must be a list."); });
    if (s.kpis != null && typeof s.kpis !== "object") e.push("kpis must be an object.");
    arr(s.accounts).forEach(function (a, i) { if (["checking", "savings", "credit_card", "investment", "loan", "equity_share"].indexOf(a.type) < 0) e.push("accounts[" + i + "].type is not a known account type."); });
    arr(s.actions).forEach(function (a, i) { if (["open", "waiting", "done"].indexOf(a.status) < 0) e.push("actions[" + i + "].status must be open, waiting or done."); });
    return e;
  };

  /* ---------- the four headline figures, computed the same way for any snapshot ---------- */
  F.headline = function (s) {
    var k = s.kpis || {}, part = s.period && s.period.partial_month;
    var cash = arr(s.balances_eom).map(function (b) { var g = n(b.giro), t = n(b.tagesgeld); return { month: b.month, giro: g, tg: t, total: g == null || t == null ? null : g + t }; });
    var known = cash.filter(function (c) { return c.total != null; }), first = known[0], last = known[known.length - 1];
    var prop = sum(s.property, "monthly"), lp = sum(s.loans, "payment"), subs = sum(s.subscriptions, "monthly"), sal = n(k.avg_net_salary);
    var parts = [prop.v, lp.v, subs.v], anyC = parts.some(function (x) { return x != null; }), committed = anyC ? parts.reduce(function (a, x) { return a + (x || 0); }, 0) : null;
    var full = arr(s.monthly).filter(function (m) { return m.month !== part; }), sp = sum(full, "spend"), nsp = full.length - sp.miss;
    var debt = sum(s.loans, "balance"), top = arr(s.loans).filter(function (l) { return n(l.rate_pct) != null; }).sort(function (a, b) { return b.rate_pct - a.rate_pct; })[0];
    return { cash: cash, first: first, last: last, liquid: last ? last.total : null, prop: prop, loanPay: lp, subs: subs, salary: sal, committed: committed, share: committed != null && sal ? committed / sal * 100 : null,
      full: full, avgSpend: nsp ? sp.v / nsp : null, spendMonths: nsp, debt: debt, topRate: top, floor: n(k.cash_floor_target), part: part };
  };

  /* ---------- small builders ---------- */
  function card(cls, title, sub, inner, right) { return '<section class="card ' + cls + '"><header><div><h2>' + title + "</h2>" + (sub ? '<p class="sub">' + sub + "</p>" : "") + "</div>" + (right || "") + "</header>" + inner + "</section>"; }
  function none(what) { return '<p class="np">' + esc(what) + " " + NP + ".</p>"; }
  function legend(items) { return '<div class="legend">' + items.map(function (x) { return "<span><i class=\"" + x[0] + '"></i>' + x[1] + "</span>"; }).join("") + "</div>"; }
  function nice(mx) { if (!(mx > 0)) return 1; var p = Math.pow(10, Math.floor(Math.log10(mx))), f = mx / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
  function short(v) { return Math.abs(v) >= 1000 ? new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(v / 1000) + "k" : String(Math.round(v)); }
  function axisY(top, x0, x1, y, lo) { var out = "", st = top / 4; for (var g = lo || 0; g <= top + 1e-9; g += st) out += '<line class="' + (g === 0 ? "base" : "gl") + '" x1="' + x0 + '" x2="' + x1 + '" y1="' + y(g).toFixed(1) + '" y2="' + y(g).toFixed(1) + '"/><text class="ax" x="' + (x0 - 8) + '" y="' + (y(g) + 4).toFixed(1) + '" text-anchor="end">' + short(g) + "</text>"; return out; }
  function ranked(rows, o) {
    /* rows: [{name, v, meta, tip}] ; bars share one scale */
    var known = rows.filter(function (r) { return r.v != null; }), mx = Math.max.apply(0, known.map(function (r) { return Math.abs(r.v); }).concat([0])) || 1;
    return '<div class="bars">' + rows.map(function (r) { return '<div class="bar"' + (r.stream ? ' data-stream="' + esc(r.stream) + '"' : "") + tip(r.tip || r.name + "\n" + eur(r.v)) + '><span class="n">' + esc(r.name) + '</span><span class="tr">' + (r.v == null ? "" : '<i style="width:' + (Math.abs(r.v) / mx * 100).toFixed(1) + '%"></i>') + '</span><span class="val">' + money(r.v) + (o && o.unit ? '<span class="sub"> ' + o.unit + "</span>" : "") + "</span>" + (r.meta ? '<span class="meta">' + r.meta + "</span>" : "") + "</div>"; }).join("") + "</div>";
  }

  /* ---------- sections ---------- */
  function header(S, s, idx) {
    var age = Math.floor((S.now - new Date(s.as_of)) / 864e5), src = arr(s.sources).map(function (x) { return typeof x === "string" ? x : x.name || x.source || ""; }).filter(Boolean);
    var opts = S.list.map(function (x, i) { return '<option value="' + i + '"' + (i === idx ? " selected" : "") + ">" + dmy(x.as_of) + (i === 0 ? " (latest)" : "") + "</option>"; }).join("");
    var per = s.period ? (s.period.from ? dmy(s.period.from) + " – " + dmy(s.period.to) : "") + (s.period.partial_month ? " · " + monY(s.period.partial_month) + " is a partial month" : "") : "";
    return '<header class="top"><div class="title"><p class="eyebrow">Finance</p><h1>Where you stand</h1><p class="asof">As of <b>' + dmy(s.as_of) + "</b>" + (idx > 0 ? ' · <span class="chip wait">◷ older snapshot</span>' : "") + '</p><p class="sub">' + (per ? "Period " + per + ". " : "") + (src.length ? "Sources: " + esc(src.join(", ")) + "." : "Sources " + NP + ".") + "</p></div>" +
      '<div class="tools">' + (S.list.length ? '<label class="sub" for="fpHist">Snapshot</label><select id="fpHist" class="sel">' + opts + "</select>" : "") + '<button class="btn" id="fpImport">Import a snapshot</button><input type="file" id="fpFile" accept="application/json,.json" hidden></div></header>' +
      (age > STALE_DAYS ? '<div class="warn" role="alert"><b>▲ Out of date</b><span>This snapshot is ' + age + " days old. Ask Claude for a fresh one, or import a newer file.</span></div>" : "");
  }
  function kpis(s, H, P) {
    var d = function (cur, prev, unit, goodUp) { if (!P || cur == null || prev == null) return ""; var x = cur - prev; if (Math.abs(x) < 0.05) return '<p class="h">No change since the previous snapshot</p>'; var g = (x > 0) === goodUp; return '<p class="h"><span class="' + (g ? "good" : "bad") + '">' + (x > 0 ? "▲" : "▼") + " " + (unit === "pp" ? new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(Math.abs(x)) + " points" : eur(Math.abs(x))) + "</span> " + (x > 0 ? "higher" : "lower") + " than the previous snapshot (" + (g ? "better" : "worse") + ")</p>"; };
    var v = function (x, f) { return x == null ? '<p class="v np">' + NP + "</p>" : '<p class="v num">' + f(x) + "</p>"; };
    var ch = H.first && H.last && H.first !== H.last ? H.last.total - H.first.total : null;
    var k1 = '<div class="kpi"><p class="lab">Liquid cash</p>' + v(H.liquid, eur) + '<p class="d">' + (ch == null ? "Giro plus Tagesgeld" : '<span class="' + (ch >= 0 ? "good" : "bad") + '">' + (ch >= 0 ? "▲ " : "▼ ") + signed(ch) + "</span> since " + monY(H.first.month)) + "</p>" + d(H.liquid, P && P.liquid, "", true) + "</div>";
    var over = H.share != null && H.share > 100;
    var k2 = '<div class="kpi"><p class="lab">Committed share of salary</p>' + v(H.share, function (x) { return pct(x, 0); }) + '<p class="d">' + (H.committed == null ? "Commitments " + NP : eur(H.committed) + " of " + (H.salary == null ? "a salary that is " + NP : eur(H.salary)) + " a month") + (over ? ' · <span class="bad">▲ more than the salary</span>' : "") + "</p>" + d(H.share, P && P.share, "pp", false) + "</div>";
    var k3 = '<div class="kpi"><p class="lab">Average monthly spending</p>' + v(H.avgSpend, eur) + '<p class="d">Over ' + H.spendMonths + " full month" + (H.spendMonths === 1 ? "" : "s") + (H.part ? ", " + mon(H.part) + " left out as partial" : "") + "</p>" + d(H.avgSpend, P && P.avgSpend, "", false) + "</div>";
    var k4 = '<div class="kpi"><p class="lab">Total debt</p>' + v(H.debt.v, eur) + '<p class="d">' + (H.topRate ? "Highest rate: " + esc(H.topRate.loan) + " at " + pct(H.topRate.rate_pct, 2) : "Loan rates " + NP) + missNote(H.debt.miss, "balance") + "</p>" + d(H.debt.v, P && P.debt.v, "", false) + "</div>";
    return '<div class="kpis">' + k1 + k2 + k3 + k4 + "</div>";
  }
  function actions(s) {
    var a = arr(s.actions).slice().sort(function (x, y) { return (n(x.rank) || 99) - (n(y.rank) || 99); }), chip = { open: '<span class="chip">○ Open</span>', waiting: '<span class="chip wait">◐ Waiting</span>', done: '<span class="chip good">✓ Done</span>' };
    var li = function (x) { return '<li><span class="rk num">' + (n(x.rank) == null ? "·" : x.rank) + '</span><span class="t">' + esc(x.title) + "</span>" + (chip[x.status] || "") + "</li>"; };
    var live = a.filter(function (x) { return x.status !== "done"; }), done = a.filter(function (x) { return x.status === "done"; });
    return card("s5", "Next actions", live.length + " to do" + (done.length ? ", " + done.length + " done" : ""), !a.length ? none("Actions") : (live.length ? '<ol class="acts">' + live.map(li).join("") + "</ol>" : '<p class="sub">Nothing open. Everything on the list is done.</p>') + (done.length ? '<details class="done"><summary>' + done.length + ' done</summary><ol class="acts">' + done.map(li).join("") + "</ol></details>" : ""));
  }
  function inOut(s, H) {
    var M = arr(s.monthly); if (!M.length) return card("s7", "Money in, money out", "", none("Monthly figures"));
    var W = 680, Hh = 280, L = 44, R = 8, T = 12, B = 44, mx = nice(Math.max.apply(0, M.map(function (m) { return Math.max((n(m.income) || 0) + (n(m.liquidated) || 0), n(m.spend) || 0); }))), gw = (W - L - R) / M.length, bw = Math.min(26, (gw - 12) / 2);
    var y = function (v) { return T + (1 - v / mx) * (Hh - T - B); }, y0 = y(0), bar = function (x, v, top, cls, p) { var yt = y(top), h = Math.max(0, y(top - v) - yt - (top > v ? 2 : 0)); return h <= 0 ? "" : '<rect class="' + cls + (p ? " part" : "") + '" x="' + x.toFixed(1) + '" y="' + yt.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3"/>'; };
    var extra = function (m) { return Object.keys(m).filter(function (k) { return /^rent_/.test(k); }).map(function (k) { return "\n" + label(k) + ": " + eur(m[k]); }).join(""); };
    var g = M.map(function (m, i) {
      var p = m.month === H.part, cx = L + i * gw + gw / 2, inc = n(m.income), liq = n(m.liquidated), sp = n(m.spend), x1 = cx - bw - 1, x2 = cx + 1;
      var t = monY(m.month) + (p ? " (partial month)" : "") + "\nIncome: " + eur(inc) + "\nLiquidated: " + eur(liq) + "\nSpending: " + eur(sp) + "\nInvested: " + eur(m.invest) + "\nLoans: " + eur(m.loans) + "\nNet: " + eur(m.net) + extra(m);
      return "<g>" + (inc ? bar(x1, inc, inc, "f1", p) : "") + (liq ? bar(x1, liq, (inc || 0) + liq, "f3", p) : "") + (sp ? bar(x2, sp, sp, "fg", p) : "") +
        (p ? '<rect class="partbox" x="' + (cx - gw / 2 + 3).toFixed(1) + '" y="' + T + '" width="' + (gw - 6).toFixed(1) + '" height="' + (y0 - T) + '" rx="4"/>' : "") +
        '<text class="ax' + (p ? " strong" : "") + '" x="' + cx.toFixed(1) + '" y="' + (y0 + 16) + '" text-anchor="middle">' + mon(m.month) + "</text>" + (p ? '<text class="ax strong" x="' + cx.toFixed(1) + '" y="' + (y0 + 30) + '" text-anchor="middle">partial</text>' : "") +
        '<rect class="hit" x="' + (cx - gw / 2).toFixed(1) + '" y="' + T + '" width="' + gw.toFixed(1) + '" height="' + (y0 - T) + '"' + tip(t) + "/></g>";
    }).join("");
    return card("s7", "Money in, money out", "Per month, in " + CUR, legend([["f1 b1", "Income"], ["f3 b3", "Liquidated (stacked on income)"], ["fg bg", "Spending"]]) + '<svg class="ch" viewBox="0 0 ' + W + " " + Hh + '" role="img" aria-label="Income plus liquidated against spending, per month">' + axisY(mx, L, W - R, y) + g + "</svg>");
  }
  function cash(s, H) {
    var C = H.cash; if (C.filter(function (c) { return c.total != null; }).length < 2) return card("st-buffer st-gap s7", "Cash on hand", "", none("Month-end balances"));
    var W = 680, Hh = 280, L = 44, R = 14, T = 16, B = 30, vals = C.map(function (c) { return c.total; }).filter(function (v) { return v != null; }), mx = nice(Math.max.apply(0, vals.concat([H.floor || 0])) * 1.05), y = function (v) { return T + (1 - v / mx) * (Hh - T - B); }, x = function (i) { return L + 10 + i * (W - L - R - 20) / (C.length - 1); };
    var d = "", pen = false, pts = "", hits = "", sw = (W - L - R - 20) / (C.length - 1);
    C.forEach(function (c, i) {
      if (c.total == null) { pen = false; } else { d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(c.total).toFixed(1); pen = true; var low = H.floor != null && c.total < H.floor; pts += '<circle class="pt' + (low ? " low" : "") + '" cx="' + x(i).toFixed(1) + '" cy="' + y(c.total).toFixed(1) + '" r="4.5"/>'; }
      hits += '<text class="ax" x="' + x(i).toFixed(1) + '" y="' + (Hh - 10) + '" text-anchor="middle">' + mon(c.month) + '</text><rect class="hit" x="' + (x(i) - sw / 2).toFixed(1) + '" y="' + T + '" width="' + sw.toFixed(1) + '" height="' + (Hh - T - B) + '"' + tip("End of " + monY(c.month) + "\nTotal: " + eur(c.total) + "\nGiro: " + eur(c.giro) + "\nTagesgeld: " + eur(c.tg) + (H.floor != null && c.total != null ? "\n" + (c.total >= H.floor ? "Above" : "Below") + " the floor by " + eur(Math.abs(c.total - H.floor)) : "")) + "/>";
    });
    var iF = C.findIndex(function (c) { return c.total != null; }), iL = C.length - 1; while (C[iL].total == null) iL--;
    var area = '<path class="ar" d="' + d + "L" + x(iL).toFixed(1) + " " + y(0) + "L" + x(iF).toFixed(1) + " " + y(0) + 'Z"/>';
    var ref = H.floor == null ? "" : '<line class="ref" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(H.floor).toFixed(1) + '" y2="' + y(H.floor).toFixed(1) + '"/><text class="ax strong" x="' + (L + 6) + '" y="' + (y(H.floor) - 6).toFixed(1) + '">Cash floor ' + eur(H.floor) + "</text>";
    var st = H.floor == null || H.liquid == null ? "" : H.liquid >= H.floor ? '<span class="chip good">✓ ' + eur(H.liquid - H.floor) + " above the floor</span>" : '<span class="chip bad">▼ ' + eur(H.floor - H.liquid) + " below the floor</span>";
    return card("st-buffer st-gap s7", "Cash on hand", "Giro plus Tagesgeld at each month end" + (H.floor == null ? " · cash floor " + NP : ""), '<svg class="ch" viewBox="0 0 ' + W + " " + Hh + '" role="img" aria-label="Cash on hand at each month end, with the cash floor as a reference line">' + axisY(mx, L, W - R, y) + area + ref + '<path class="ln" d="' + d + '"/>' + pts + hits + "</svg>", st);
  }
  function committed(s, H) {
    if (H.committed == null) return card("s5", "Committed money", "", none("Commitments"));
    var parts = [["Property", H.prop.v, "b1"], ["Loan payments", H.loanPay.v, "b2"], ["Subscriptions", H.subs.v, "b3"]], sal = H.salary, free = sal == null ? null : sal - H.committed, scale = Math.max(H.committed, sal || 0) || 1;
    var seg = parts.map(function (p) { return p[1] ? '<i class="' + p[2] + '" style="width:' + (p[1] / scale * 100).toFixed(2) + '%"' + tip(p[0] + "\n" + eur(p[1]) + " a month" + (sal ? "\n" + pct(p[1] / sal * 100, 0) + " of salary" : "")) + "></i>" : ""; }).join("") + (free > 0 ? '<i class="bfree" style="flex:1"' + tip("Free after commitments\n" + eur(free) + " a month") + "></i>" : "");
    var kv = '<dl class="kv">' + parts.map(function (p) { return '<div><dt><i class="' + p[2] + '" style="display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px"></i>' + p[0] + '</dt><dd class="num">' + money(p[1]) + "</dd></div>"; }).join("") + '<div><dt>Free remainder</dt><dd class="num' + (free != null && free < 0 ? " bad" : "") + '">' + (free == null ? '<span class="np">' + NP + "</span>" : (free < 0 ? "▼ " : "") + eur(free)) + "</dd></div></dl>";
    var ax = sal == null ? '<p class="np">Average net salary ' + NP + ", so the bar has no salary line.</p>" : '<div class="meter-ax"><span style="left:' + (sal / scale * 100).toFixed(2) + '%">Salary ' + eur(sal) + "</span></div>";
    return card("s5", "Committed money", "Fixed monthly commitments against the average net salary", '<div><div class="meter" role="img" aria-label="Committed ' + eur(H.committed) + (sal ? " of " + eur(sal) + " salary" : "") + '">' + seg + "</div>" + ax + "</div>" + kv + (free != null && free < 0 ? '<p class="msg"><b class="bad">▲ Over the salary.</b> Commitments are ' + eur(-free) + " more than the average net salary.</p>" : "") +
      '<p class="fine">' + pct(H.share, 0) + " of salary is committed before any other spending" + missNote(H.prop.miss + H.loanPay.miss + H.subs.miss, "amount") + ".</p>");
  }
  function categories(s, H) {
    var c = arr(s.categories).slice().sort(function (a, b) { return (n(b.total) || 0) - (n(a.total) || 0); }), top = c.slice(0, 12), rest = c.length - top.length;
    return card("st-any s6 tall", "Where it went", "Top " + top.length + " categories by total", !c.length ? none("Categories") : ranked(top.map(function (x) { return { name: x.category, stream: R.streamOfCategory(x.category), v: n(x.total), tip: x.category + "\nTotal: " + eur(x.total) + "\nPer month: " + eur(x.per_month), meta: "" }; })) + (rest > 0 ? '<p class="fine">' + rest + " smaller categor" + (rest === 1 ? "y is" : "ies are") + " not shown.</p>" : ""));
  }
  function food(s, H) {
    var Fd = arr(s.food); if (!Fd.length) return card("st-groceries st-eating s6", "Food", "", none("Food spending"));
    var keys = [["groceries", "Groceries", "f1 b1"], ["dining", "Dining out", "f2 b2"], ["delivery", "Delivery", "f3 b3"]], W = 680, Hh = 230, L = 44, R = 8, T = 10, B = 30;
    var tot = function (m) { return keys.reduce(function (a, k) { return a + (n(m[k[0]]) || 0); }, 0); }, mx = nice(Math.max.apply(0, Fd.map(tot))), gw = (W - L - R) / Fd.length, bw = Math.min(34, gw - 14), y = function (v) { return T + (1 - v / mx) * (Hh - T - B); };
    var g = Fd.map(function (m, i) {
      var cx = L + i * gw + gw / 2, at = 0, p = m.month === H.part, out = keys.map(function (k) { var v = n(m[k[0]]); if (!v) return ""; var y1 = y(at + v), h = Math.max(0, y(at) - y1 - 2); at += v; return '<rect class="' + k[2].split(" ")[0] + (p ? " part" : "") + '" x="' + (cx - bw / 2).toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3"/>'; }).join("");
      return "<g>" + out + '<text class="ax' + (p ? " strong" : "") + '" x="' + cx.toFixed(1) + '" y="' + (Hh - 10) + '" text-anchor="middle">' + mon(m.month) + (p ? "*" : "") + '</text><rect class="hit" x="' + (cx - gw / 2).toFixed(1) + '" y="' + T + '" width="' + gw.toFixed(1) + '" height="' + (Hh - T - B) + '"' + tip(monY(m.month) + (p ? " (partial month)" : "") + keys.map(function (k) { return "\n" + k[1] + ": " + eur(m[k[0]]); }).join("") + "\nTotal: " + eur(tot(m))) + "/></g>";
    }).join("");
    return card("st-groceries st-eating s6", "Food", "Per month" + (H.part ? " · * partial month" : ""), legend(keys.map(function (k) { return [k[2], k[1]]; })) + '<svg class="ch" viewBox="0 0 ' + W + " " + Hh + '" role="img" aria-label="Food spending per month, split into groceries, dining out and delivery">' + axisY(mx, L, W - R, y) + g + "</svg>");
  }
  function incomeSrc(s) {
    var a = arr(s.income_sources).slice().sort(function (x, y) { return (n(y.total) || 0) - (n(x.total) || 0); }), t = sum(a, "total");
    return card("s6 st-salary st-sublet st-shared st-refunds st-freelance st-otherin st-drawn st-income", "Income sources", t.v == null ? "" : eur(t.v) + " in total", !a.length ? none("Income sources") : ranked(a.map(function (x) { return { name: x.source, stream: R.streamOfIncome(x.source), v: n(x.total), tip: x.source + "\n" + eur(x.total) + (t.v && n(x.total) != null ? "\n" + pct(x.total / t.v * 100, 0) + " of income" : "") }; })));
  }
  function subscriptions(s, H) {
    var a = arr(s.subscriptions).slice().sort(function (x, y) { return (n(y.monthly) || 0) - (n(x.monthly) || 0); }), m = H.subs;
    return card("st-bills s7", "Contracts and subscriptions", m.v == null ? "" : eur(m.v) + " a month · " + eur(m.v * 12) + " a year" + missNote(m.miss, "amount"), !a.length ? none("Subscriptions") : ranked(a.map(function (x) {
      var yr = n(x.monthly) == null ? null : x.monthly * 12;
      return { name: x.name, v: n(x.monthly), tip: x.name + "\nMonthly: " + eur(x.monthly) + "\nYearly: " + eur(yr) + "\nLast charge: " + (x.last_charge ? dmy(x.last_charge) : NP) + (n(x.charges_2026) != null ? "\nCharges this year: " + x.charges_2026 : "") + (x.note ? "\nNote: " + x.note : ""),
        meta: eur(yr) + " a year · last charge " + (x.last_charge ? dmy(x.last_charge) : NP) + (x.note ? ' · <span class="flag"><b>⚑</b>' + esc(x.note) + "</span>" : "") };
    }), { unit: "/ mo" }));
  }
  function loans(s) {
    var a = arr(s.loans); if (!a.length) return card("st-loans s5", "Loans", "", none("Loans"));
    var mx = Math.max.apply(0, a.map(function (l) { return (n(l.balance) || 0) + (n(l.future_interest) || 0); })) || 1;
    return card("st-loans s5", "Loans", "What is left to repay, with the interest still to come", legend([["b2", "Remaining balance"], ["hatch", "Future interest"]]) + '<div class="rows">' + a.map(function (l) {
      var b = n(l.balance), fi = n(l.future_interest);
      return '<article class="rowc"><header><h3>' + esc(l.loan) + "</h3>" + (l.verdict ? '<span class="chip">' + esc(l.verdict) + "</span>" : "") + '</header><div class="stack"' + tip(l.loan + "\nBalance: " + eur(b) + "\nFuture interest: " + eur(fi) + (b != null && fi != null ? "\nStill to pay in total: " + eur(b + fi) : "")) + ">" + (b ? '<i class="b2" style="width:' + (b / mx * 100).toFixed(2) + '%"></i>' : "") + (fi ? '<i class="hatch" style="width:' + (fi / mx * 100).toFixed(2) + '%"></i>' : "") + "</div>" +
        '<dl class="kv"><div><dt>Balance</dt><dd>' + money(b) + "</dd></div><div><dt>Future interest</dt><dd>" + money(fi) + "</dd></div><div><dt>Rate</dt><dd>" + (n(l.rate_pct) == null ? '<span class="np">' + NP + "</span>" : pct(l.rate_pct, 2)) + "</dd></div><div><dt>Payment</dt><dd>" + money(l.payment) + "</dd></div><div><dt>Months left</dt><dd>" + (n(l.months_left) == null ? '<span class="np">' + NP + "</span>" : l.months_left) + "</dd></div></dl></article>";
    }).join("") + "</div>");
  }
  function investments(s) {
    var a = arr(s.investments), t = sum(a, "value"), sp = n((s.kpis || {}).union_sparplan_monthly);
    var gain = function (v, p) { v = n(v); if (v == null) return '<span class="np">' + NP + "</span>"; return '<span class="' + (v >= 0 ? "good" : "bad") + '">' + (v >= 0 ? "▲ " : "▼ ") + signed(v) + "</span>" + (n(p) == null ? "" : '<span class="sub">' + (p > 0 ? "+" : "") + pct(p, 1) + "</span>"); };
    return card("st-savings s6", "Investments", (t.v == null ? "" : eur(t.v) + " in total" + missNote(t.miss, "value")) + (sp == null ? "" : (t.v == null ? "" : " · ") + "savings plan " + eur(sp) + " a month"), !a.length ? none("Investments") : '<div class="scroll"><table><thead><tr><th>Item</th><th class="r">Value</th><th class="r">Lifetime gain</th></tr></thead><tbody>' + a.map(function (x) {
      return "<tr" + tip(x.item + "\nValue: " + eur(x.value) + "\nLifetime gain: " + eur(x.gain_total) + "\nCurrent gain: " + eur(x.gain_current) + (x.note ? "\n" + x.note : "")) + "><td>" + esc(x.item) + (x.note ? '<span class="sub">' + esc(x.note) + "</span>" : "") + '</td><td class="r num">' + money(x.value) + '</td><td class="r">' + gain(x.gain_total, x.gain_pct) + "</td></tr>";
    }).join("") + "</tbody></table></div>");
  }
  function property(s) {
    var p = arr(s.property), ctx = arr(s.accounts).filter(function (a) { return a.tracked === false; }), t = sum(p, "monthly");
    var tiles = p.map(function (x) { return '<div class="tile"><p class="lab">' + esc(x.item) + '</p><p class="v num">' + money(x.monthly) + (n(x.monthly) == null ? "" : '<span class="sub"> / month</span>') + "</p>" + (x.note ? '<p class="sub">' + esc(x.note) + "</p>" : "") + "</div>"; }).join("");
    var c = ctx.map(function (a) { return '<div class="tile ctx"><p class="lab">' + esc(a.name) + " · " + esc(label(a.type)) + '</p><p class="v num">' + money(a.balance) + '</p><p class="sub">' + (a.note ? esc(a.note) + " · " : "") + "Not tracked: shown for context, left out of every total.</p></div>"; }).join("");
    return card("st-housing s6", "Property", t.v == null ? "" : eur(t.v) + " a month" + missNote(t.miss, "amount"), (p.length ? '<div class="tiles">' + tiles + "</div>" : none("Property items")) + (ctx.length ? '<p class="lab">For context only</p><div class="tiles">' + c + "</div>" : ""));
  }
  function accounts(s) {
    var a = arr(s.accounts).filter(function (x) { return x.tracked !== false; }); if (!a.length) return "";
    return card("s12", "Accounts in this snapshot", a.length + " tracked", '<div class="tiles">' + a.map(function (x) { return '<div class="tile"><p class="lab">' + esc(x.name) + " · " + esc(label(x.type)) + '</p><p class="v num">' + money(x.balance) + "</p>" + (x.note ? '<p class="sub">' + esc(x.note) + "</p>" : "") + "</div>"; }).join("") + "</div>");
  }

  /* ---------- page ---------- */
  function page(S) {
    var s = S.list[S.idx], prev = S.list[S.idx + 1]; CUR = s.currency || "EUR";
    var H = F.headline(s), P = prev ? F.headline(prev) : null;
    return (S.sample ? '<div class="ribbon" role="note"><b>SAMPLE DATA</b> · invented numbers to show the page · nothing below is yours</div>' : "") + '<div class="wrap">' + header(S, s, S.idx) + (S.msg || "") + '<section class="river" id="fpRiver" aria-label="Money river"></section>' + kpis(s, H, P) +
      (P ? '<p class="fine" style="margin-top:8px">Changes on the four figures compare this snapshot with the one from ' + dmy(prev.as_of) + ".</p>" : "") +
      '<div class="grid">' + actions(s) + inOut(s, H) + cash(s, H) + committed(s, H) + categories(s, H) + food(s, H) + incomeSrc(s) + subscriptions(s, H) + loans(s) + investments(s) + property(s) + accounts(s) + "</div>" +
      '<footer class="foot"><p>' + S.list.length + " snapshot" + (S.list.length === 1 ? "" : "s") + " stored. Older ones are kept as history and never deleted. Figures are a summary for your own planning, not financial advice.</p></footer></div>" + '<div class="tip" id="fpTip" hidden></div>';
  }
  function emptyPage(S) {
    return '<div class="wrap"><div class="empty"><p class="eyebrow">Finance</p><h1>No snapshot yet</h1><p>Ask Claude to push a finance snapshot from a chat, or drop a snapshot file here. Nothing is typed in by hand.</p>' + (S.msg || "") +
      '<div class="drop" id="fpDrop"><p><b>Drop a snapshot .json file here</b></p><button class="btn" id="fpImport">Choose a file</button><input type="file" id="fpFile" accept="application/json,.json" hidden></div>' + (S.onSample ? '<button class="btn" id="fpSample">Show the page with sample data</button>' : "") + "</div></div>";
  }

  F.mount = function (host, o) {
    o = o || {};
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    var S = { list: arr(o.snapshots).slice().sort(function (a, b) { return String(b.as_of).localeCompare(String(a.as_of)); }), idx: 0, sample: !!o.sample, now: o.now || new Date(), msg: "", onSample: o.onSample };
    var theme = o.theme === "dark" || o.theme === "light" ? o.theme : (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    var RV = { month: null, mode: "month", table: false, sel: null, last: null, raf: 0, narrow: false };
    var still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    function riverHtml(s, M, prev) {
      var ms = R.months(s), i = ms.indexOf(RV.month), cur = M.cur, part = s.period && s.period.partial_month === RV.month, sel = RV.sel && M.ins.concat(M.outs).filter(function (x) { return x.key === RV.sel; })[0];
      var seg = function (id, cur2, opts) { return '<div class="seg" role="group">' + opts.map(function (x) { return '<button data-rv="' + id + '" data-val="' + x[0] + '" aria-pressed="' + (cur2 === x[0]) + '">' + x[1] + "</button>"; }).join("") + "</div>"; };
      var notes = [];
      if (M.mode === "average") notes.push(esc(M.label) + ".");
      if (part && M.mode === "month") notes.push("This month is not finished yet, so the figures are only so far.");
      if (M.coarse && !M.empty) notes.push("Only housing, loans, food and savings are known month by month. Everything else is one stream until the snapshot carries per-month categories. Switch to the average to see every stream.");
      if (M.missing && M.missing.length) notes.push("Not provided yet: " + esc(M.missing.join(", ")) + ".");
      return '<div class="rtop"><div class="mon"><button class="rbtn" data-rv="step" data-val="-1" aria-label="Previous month"' + (i <= 0 ? " disabled" : "") + '>‹</button><span aria-live="polite">' + esc(R.monY(RV.month)) + '</span><button class="rbtn" data-rv="step" data-val="1" aria-label="Next month"' + (i >= ms.length - 1 ? " disabled" : "") + ">›</button></div>" +
        seg("mode", RV.mode, [["month", "This month"], ["average", "Average"]]) + seg("table", RV.table ? "1" : "", [["", "River"], ["1", "View as table"]]) + "</div>" +
        '<div class="rsum"><span>Income<b>' + R.eur(M.income, cur) + "</b></span><span>Spent<b>" + R.eur(M.spent, cur) + '</b></span><span class="g">Saved<b>' + R.eur(M.saved, cur) + "</b></span>" + (M.drawn > 0.5 ? '<span class="w">▲ From savings<b>' + R.eur(M.drawn, cur) + "</b></span>" : "") + (M.left >= -0.5 ? '<span class="g">Left<b>' + R.eur(Math.max(0, M.left), cur) + "</b></span>" : '<span class="w">▲ Gap<b>' + R.eur(-M.left, cur) + "</b></span>") + "</div>" +
        (sel ? '<p class="rsel">Showing <b>' + esc(sel.name) + '</b> in the charts below <button class="btn" data-rv="clear">Show everything</button></p>' : "") +
        '<div id="fpRiverBody">' + (M.empty ? '<p class="np" style="padding:24px 0">No figures for this month.</p>' : RV.table ? R.table(M, prev) : R.svg(M, prev, { narrow: RV.narrow, sel: RV.sel })) + "</div>" +
        (notes.length ? '<p class="fine">' + notes.join(" ") + "</p>" : "") + (M.empty || RV.table ? "" : '<p class="fine">Stream width is the amount. Point at or tap a stream for the amount, its share of income and the change from the month before; click it to pick it out in the charts below.</p>');
    }
    function riverSel() {
      var fp = root.querySelector(".fp"), base = RV.sel ? RV.sel.split(":")[0] : "";
      if (!fp) return;
      if (base) fp.dataset.sel = base; else delete fp.dataset.sel;
      [].forEach.call(fp.querySelectorAll(".bar[data-stream]"), function (b) { b.classList.toggle("hit", !!base && b.getAttribute("data-stream") === base); });
      [].forEach.call(fp.querySelectorAll(".card"), function (c) { c.classList.toggle("hit", !!base && c.classList.contains("st-" + base)); });
    }
    function riverDraw(animate) {
      var box = root.querySelector("#fpRiver"), s = S.list[S.idx]; if (!box || !s) return;
      var ms = R.months(s); if (!ms.length) { box.innerHTML = '<p class="np">Monthly figures ' + NP + ", so the river cannot be drawn.</p>"; return; }
      if (!RV.month || ms.indexOf(RV.month) < 0) RV.month = R.defaultMonth(s);
      RV.narrow = box.getBoundingClientRect().width < 700;
      var M = R.model(s, RV.month, RV.mode), prev = RV.mode === "month" ? R.prev(s, RV.month) : null, from = RV.last;
      if (RV.sel && !M.ins.concat(M.outs).some(function (x) { return x.key === RV.sel; })) RV.sel = null;
      cancelAnimationFrame(RV.raf);
      box.innerHTML = riverHtml(s, M, prev); riverSel(); RV.last = M;
      if (!animate || still || RV.table || !from || from.empty || M.empty) return;
      var body = root.querySelector("#fpRiverBody"), t0 = null, final = body.innerHTML;
      var step = function (ts) {
        if (t0 == null) t0 = ts; var t = Math.min(1, (ts - t0) / 420), e = 1 - Math.pow(1 - t, 3);
        body.innerHTML = t < 1 ? R.svg(R.blend(from, M, e), null, { narrow: RV.narrow, sel: RV.sel }) : final;
        if (t < 1) RV.raf = requestAnimationFrame(step);
      };
      RV.raf = requestAnimationFrame(step);
    }
    function draw() {
      root.innerHTML = '<link rel="stylesheet" href="' + (o.css || "finance/finance.css") + '"><div class="fp" data-theme="' + theme + '">' + (S.list.length ? page(S) : emptyPage(S)) + "</div>";
      wire(); RV.last = null; riverDraw(false);
    }
    function read(file) {
      var r = new FileReader();
      r.onload = function () {
        var snap, errs; try { snap = JSON.parse(r.result); errs = F.validate(snap); } catch (e) { errs = ["The file is not valid JSON."]; }
        if (errs.length) { S.msg = '<p class="msg bad warn" role="alert"><b>▲ Not imported</b><span>' + esc(errs.slice(0, 6).join("\n")) + "</span></p>"; draw(); return; }
        Promise.resolve(o.onImport ? o.onImport(snap) : null).then(function () {
          S.list = S.list.filter(function (x) { return x.as_of !== snap.as_of; }).concat([snap]).sort(function (a, b) { return String(b.as_of).localeCompare(String(a.as_of)); });
          if (S.sample) { S.list = [snap]; S.sample = false; }
          S.idx = S.list.indexOf(snap); S.msg = '<p class="msg" role="status"><span class="chip good">✓ Imported</span> Snapshot of ' + dmy(snap.as_of) + " is saved.</p>"; draw();
        }, function (err) { S.msg = '<p class="msg bad warn" role="alert"><b>▲ Not saved</b><span>' + esc((err && err.message) || "The snapshot could not be saved. Try again.") + "</span></p>"; draw(); });
      };
      r.readAsText(file);
    }
    function wire() {
      var $ = function (q) { return root.querySelector(q); }, fp = $(".fp"), tipEl = $("#fpTip"), file = $("#fpFile"), hist = $("#fpHist"), drop = $("#fpDrop") || fp;
      if ($("#fpImport")) $("#fpImport").onclick = function () { file.click(); };
      if (file) file.onchange = function () { if (file.files[0]) read(file.files[0]); };
      if (hist) hist.onchange = function () { S.idx = +hist.value; S.msg = ""; RV.month = null; RV.sel = null; draw(); };
      var rv = $("#fpRiver");
      if (rv) {
        rv.addEventListener("click", function (e) {
          var b = e.target.closest("[data-rv]"), st = e.target.closest(".rs"), s = S.list[S.idx], ms = R.months(s);
          if (b && !b.disabled) {
            var k = b.getAttribute("data-rv"), v = b.getAttribute("data-val");
            if (k === "step") { var i = ms.indexOf(RV.month) + +v; if (i < 0 || i >= ms.length) return; RV.month = ms[i]; riverDraw(true); var nb = rv.querySelector('[data-rv="step"][data-val="' + v + '"]'); if (nb && !nb.disabled) nb.focus(); }
            else if (k === "mode") { RV.mode = v; riverDraw(true); }
            else if (k === "table") { RV.table = !!v; riverDraw(false); }
            else if (k === "clear") { RV.sel = null; riverDraw(false); }
          } else if (st) { var key = st.getAttribute("data-stream"); RV.sel = RV.sel === key ? null : key; riverDraw(false); }
        });
        rv.addEventListener("keydown", function (e) { var st = e.target.closest && e.target.closest(".rs"); if (st && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); var key = st.getAttribute("data-stream"); RV.sel = RV.sel === key ? null : key; riverDraw(false); var again = rv.querySelector('.rs[data-stream="' + key + '"]'); if (again) again.focus(); } });
        if (window.ResizeObserver && !RV.ro) { RV.ro = new ResizeObserver(function () { var box = root.querySelector("#fpRiver"); if (box && (box.getBoundingClientRect().width < 700) !== RV.narrow) riverDraw(false); }); RV.ro.observe(host); }
      }
      if ($("#fpSample")) $("#fpSample").onclick = function () { S.onSample(); };
      fp.ondragover = function (e) { e.preventDefault(); drop.classList.add("over"); };
      fp.ondragleave = function () { drop.classList.remove("over"); };
      fp.ondrop = function (e) { e.preventDefault(); drop.classList.remove("over"); var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) read(f); };
      if (!tipEl) return;
      var show = function (el, cx, cy) {
        tipEl.textContent = el.getAttribute("data-tip"); tipEl.hidden = false;
        var hr = fp.getBoundingClientRect(), r = el.getBoundingClientRect(), x = (cx == null ? r.left + r.width / 2 : cx) - hr.left + 14, y = (cy == null ? r.top : cy) - hr.top - tipEl.offsetHeight - 10;
        tipEl.style.left = Math.max(8, Math.min(x, hr.width - tipEl.offsetWidth - 8)) + "px"; tipEl.style.top = Math.max(8, y) + "px";
      };
      fp.addEventListener("pointermove", function (e) { var el = e.target.closest && e.target.closest("[data-tip]"); if (el) show(el, e.clientX, e.clientY); else tipEl.hidden = true; });
      fp.addEventListener("pointerleave", function () { tipEl.hidden = true; });
      fp.addEventListener("focusin", function (e) { var el = e.target.closest && e.target.closest("[data-tip]"); if (el) show(el); });
      fp.addEventListener("focusout", function () { tipEl.hidden = true; });
    }
    draw();
    return { setTheme: function (t) { theme = t; draw(); } };
  };
})();
