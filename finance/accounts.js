/* Finance by bank and account. Net worth on top, one card per bank with its accounts as rows, then loans, cash
   flow, what needs checking and property. The numbers come from PPFin (supabase/functions/_shared/fin.js), the
   same code the connector uses, so the page and Claude always agree. Data arrives when Claude reads the banks in
   the browser and pushes it; this page shows it, lets the owner file uncategorised transactions, and holds two
   settings (cash floor, my share of a shared account). Missing values show "—", never 0. */
(function () {
  var F = window.PPFin, P = window.PPFinAccounts = {};
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var num = function (v) { return v == null || v === "" || isNaN(+v) ? null : +v; };
  var eur = function (v, cur) { return num(v) == null ? "—" : new Intl.NumberFormat("de-DE", { style: "currency", currency: cur || "EUR", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v); };
  var signed = function (v) { return num(v) == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "±") + eur(Math.abs(v)); };
  var dmy = function (d) { return d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"; };
  var dm = function (d) { return d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"; };
  var monY = function (m) { return new Date(m + "-01T12:00:00").toLocaleDateString("en-GB", { month: "short", year: "2-digit" }); };
  var ago = function (n) { return n == null ? "never read" : n === 0 ? "read today" : n === 1 ? "read yesterday" : "read " + n + " days ago"; };
  var I = function (d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>"; };
  var ICON = {
    checking: I('<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M3 10h18M7 14.5h3"/>'), savings: I('<path d="M5 11a6.5 5.5 0 0 1 13-1l2 1v3l-2 .8a6 6 0 0 1-2 2.2V19h-2.5v-1.2h-3V19H8v-2a6 5 0 0 1-3-6z"/><circle cx="14.5" cy="10.5" r=".6" fill="currentColor"/>'),
    credit_card: I('<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 9.5h18M6.5 14.5h4"/>'), investment: I('<path d="M4 19h16M6 15l4-4 3 3 5-6"/><path d="M15 8h3v3"/>'),
    building_savings: I('<path d="M4 11.5 12 5l8 6.5V19H4z"/><path d="M10 19v-5h4v5"/>'), loan: I('<circle cx="12" cy="12" r="8"/><path d="M9 15l6-6M9.5 9.5h.01M14.5 14.5h.01"/>'),
    share: I('<path d="M12 4l2.3 4.8 5.2.7-3.8 3.6.9 5.2L12 15.8 7.4 18.3l.9-5.2-3.8-3.6 5.2-.7z"/>'), shared: I('<circle cx="9" cy="9" r="3"/><circle cx="16.5" cy="10" r="2.3"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.800 5.5 4.8M15.5 14.5c2.300.1 4.200 1.700 4.800 4"/>')
  };
  P.mount = function (host, o) {
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    var S = { raw: o.data || {}, snap: o.snapshot || null, today: o.today, theme: o.theme || "light", open: null, month: null, busy: false, msg: "" };
    root.innerHTML = '<link rel="stylesheet" href="' + (o.css || "finance/accounts.css") + '"><div class="fa"></div>';
    var fa = root.querySelector(".fa");
    function cats() {
      var set = {}; F.DEFAULT_RULES.forEach(function (r) { set[r[1]] = 1; });
      ((S.snap && S.snap.categories) || []).forEach(function (c) { if (c.category) set[c.category] = 1; });
      (S.raw.transactions || []).forEach(function (t) { if (t.category) set[t.category] = 1; }); (S.raw.rules || []).forEach(function (r) { set[r.category] = 1; });
      ["Internal transfer", "Income (other)", "Other"].forEach(function (c) { set[c] = 1; });
      return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
    }
    function line(hist, debt) {
      if (hist.length < 2) return '<p class="none">One reading so far. The line appears with the second read.</p>';
      var W = 520, H = 120, L = 6, T = 10, B = 18, vs = hist.map(function (h) { return h.v; }), lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs), pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1; lo -= pad; hi += pad;
      var t0 = Date.parse(hist[0].d), t1 = Date.parse(hist[hist.length - 1].d) || t0 + 1, x = function (d) { return L + (W - 2 * L) * (Date.parse(d) - t0) / ((t1 - t0) || 1); }, y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); };
      var pts = hist.map(function (h) { return x(h.d).toFixed(1) + "," + y(h.v).toFixed(1); }).join(" ");
      return '<svg class="line" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc((debt ? "Owed" : "Balance") + " from " + dmy(hist[0].d) + " to " + dmy(hist[hist.length - 1].d)) + '"><line class="base" x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - L) + '" y2="' + (H - B) + '"/><polyline points="' + pts + '"/>' +
        hist.map(function (h) { return '<circle cx="' + x(h.d).toFixed(1) + '" cy="' + y(h.v).toFixed(1) + '" r="3"><title>' + esc(dmy(h.d) + ": " + eur(h.v)) + "</title></circle>"; }).join("") +
        '<text class="ax" x="' + L + '" y="' + (H - 4) + '">' + esc(dm(hist[0].d)) + '</text><text class="ax" x="' + (W - L) + '" y="' + (H - 4) + '" text-anchor="end">' + esc(dm(hist[hist.length - 1].d)) + "</text></svg>";
    }
    function catPick(t, list) {
      return '<span class="pick"><select data-cat="' + esc(t.id) + '" aria-label="Category for ' + esc(t.counterparty || "this transaction") + '"><option value="">Choose a category…</option>' + list.map(function (c) { return "<option>" + esc(c) + "</option>"; }).join("") + '</select><label class="sim"><input type="checkbox" data-sim="' + esc(t.id) + '" checked> and others from ' + esc(t.counterparty || "the same place") + "</label></span>";
    }
    function txRow(t, C, list) {
      var internal = !!C.internal[t.id], cat = t.category || F.categorize(t, S.raw.rules);
      return '<li><span class="d">' + esc(dm(t.date)) + '</span><span class="w"><b>' + esc(t.counterparty || "—") + "</b>" + (t.purpose ? "<small>" + esc(t.purpose) + "</small>" : "") + '</span><span class="c">' + (internal ? '<i class="chip int">Internal transfer</i>' : cat ? '<i class="chip">' + esc(cat) + "</i>" : catPick(t, list)) + '</span><span class="a ' + (t.amount < 0 ? "out" : "in") + '">' + signed(+t.amount) + "</span></li>";
    }
    function detail(a, C, list) {
      var d = a.details || {}, rows = [];
      if (a.type === "investment") rows.push(["Value", eur(num(d.value) != null ? d.value : a.balance)], ["Gain", num(d.gainEur) == null ? "—" : signed(d.gainEur) + (num(d.gainPct) != null ? " · " + (d.gainPct > 0 ? "+" : "") + d.gainPct + " %" : "")], ["Sparplan", num(d.sparplan) == null ? "—" : eur(d.sparplan) + " a month"]);
      if (a.type === "building_savings") rows.push(["Phase", d.phase === "loan" ? "Loan phase" : d.phase === "saving" ? "Saving phase" : "—"], ["Rate", num(d.rate) == null ? "—" : d.rate + " %"], [a.debt ? "Owed" : "Saved", eur(a.balance)]);
      if (a.loan) rows.push(["Owed", eur(a.balance)], ["Rate", a.loan.rate == null ? "—" : a.loan.rate + " %"], ["Monthly payment", eur(a.loan.payment)], ["Months left", a.loan.monthsLeft == null ? "—" : String(a.loan.monthsLeft)], ["Interest still to pay", eur(a.loan.futureInterest)]);
      if (a.shared) rows.push(["Total", eur(a.balance)], ["My share", Math.round(a.share * 100) + " % · " + eur(a.mine)]);
      if (a.last4) rows.push(["Account", "…" + esc(a.last4)]);
      var tx = (S.raw.transactions || []).filter(function (t) { return t.account_id === a.id && !t.archived_at; }).sort(function (x, y) { return x.date < y.date ? 1 : -1; });
      return '<div class="det" id="det-' + esc(a.id) + '">' + (rows.length ? '<dl class="kv">' + rows.map(function (r) { return "<div><dt>" + r[0] + "</dt><dd>" + r[1] + "</dd></div>"; }).join("") + "</dl>" : "") +
        (Array.isArray(d.holdings) && d.holdings.length ? '<p class="lab">Holdings</p><ul class="hold">' + d.holdings.map(function (h) { return "<li><span>" + esc(h.name) + (h.isin ? "<small>" + esc(h.isin) + "</small>" : "") + "</span><span>" + (num(h.quantity) != null ? esc(h.quantity) + " × · " : "") + eur(h.value) + "</span></li>"; }).join("") + "</ul>" : "") +
        '<p class="lab">' + (a.debt ? "Owed over time" : "Balance over time") + "</p>" + (a.history.length ? line(a.history, a.debt) : '<p class="none">No reading yet.</p>') +
        '<p class="lab">Transactions' + (tx.length ? " · " + tx.length : "") + "</p>" + (tx.length ? '<ul class="tx">' + tx.slice(0, 60).map(function (t) { return txRow(t, C, list); }).join("") + "</ul>" + (tx.length > 60 ? '<p class="none">Showing the latest 60 of ' + tx.length + ".</p>" : "") : '<p class="none">No transactions read for this account yet.</p>') + "</div>";
    }
    function draw() {
      fa.dataset.theme = S.theme;
      var M = F.model(S.raw, S.today), C = F.cashflow(S.raw.transactions, S.raw.accounts, S.raw.rules), list = cats(), h = "";
      h += '<div class="wrap"><header class="top"><div><p class="eyebrow">Finance</p><h1>' + (M.accounts.length ? eur(M.netWorth) : "Your banks and accounts") + "</h1>" + (M.accounts.length ? '<p class="sub">Net worth: ' + eur(M.assets) + " in assets, " + eur(M.debts) + " owed" + (M.change != null ? ' · <b class="' + (M.change >= 0 ? "up" : "dn") + '">' + signed(M.change) + "</b> since " + esc(dm(M.changeSince)) : " · no earlier reading to compare with yet") + "</p>" : "") + '</div><div class="tools"><button class="btn" data-act="history">Monthly history</button></div></header>';
      if (S.msg) h += '<p class="msg" role="status">' + esc(S.msg) + "</p>";
      if (!M.accounts.length) { fa.innerHTML = h + '<section class="card empty"><h2>No accounts yet</h2><p>Sign in to a bank in Chrome, then ask Claude to read it: “read my Volksbank accounts and update Finance”. Balances and transactions appear here. The monthly history from the earlier snapshot is still available above.</p></section></div>'; return; }
      // cash against the floor
      var pc = M.cash == null ? 0 : Math.max(0, Math.min(100, M.cash / Math.max(M.cashFloor * 2, M.cash, 1) * 100)), pf = Math.min(100, M.cashFloor / Math.max(M.cashFloor * 2, M.cash || 0, 1) * 100);
      h += '<section class="card cash" aria-label="Cash on hand"><div class="ch"><div><p class="lab">Cash on hand</p><p class="big">' + eur(M.cash) + '</p></div><p class="note">' + (M.cash == null ? "No checking or savings balance read yet." : M.cash >= M.cashFloor ? eur(M.cash - M.cashFloor) + " above your floor of " + eur(M.cashFloor) : '<b class="dn">' + eur(M.cashFloor - M.cash) + " below</b> your floor of " + eur(M.cashFloor)) + ' <span class="quiet">Own checking and savings; the shared account is not counted.</span></p></div><div class="meter" role="img" aria-label="' + esc("Cash " + eur(M.cash) + " against a floor of " + eur(M.cashFloor)) + '"><i class="' + (M.cash != null && M.cash < M.cashFloor ? "low" : "") + '" style="width:' + pc.toFixed(1) + '%"></i><b style="left:' + pf.toFixed(1) + '%"><span>floor</span></b></div></section>';
      if (M.needsRefresh.length) h += '<section class="card warn" aria-label="Needs refresh"><h2>Needs a fresh read</h2><p class="sub">Older than ' + F.STALE_DAYS + " days or never read. Sign in to the bank, then ask Claude to read it.</p><ul>" + M.banks.filter(function (b) { return b.accounts.some(function (a) { return a.stale; }); }).map(function (b) { return "<li><b>" + esc(b.name) + "</b> " + b.accounts.filter(function (a) { return a.stale; }).map(function (a) { return esc(a.name) + " (" + (a.never ? "never read" : a.ageDays + " days") + ")"; }).join(", ") + "</li>"; }).join("") + "</ul></section>";
      // banks
      h += '<div class="banks">' + M.banks.map(function (b) {
        return '<section class="card bank" aria-label="' + esc(b.name) + '"><header><h2>' + esc(b.name) + (b.shared ? '<small class="tag">shared</small>' : "") + '</h2><p class="tot">' + (b.total == null ? "—" : eur(b.total)) + "<small>" + (b.shared ? "my share" : "total") + '</small></p></header><ul class="accs">' + b.accounts.map(function (a) {
          var open = S.open === a.id;
          return '<li class="acc' + (open ? " open" : "") + '"><button class="row" data-acc="' + esc(a.id) + '" aria-expanded="' + open + '" aria-controls="det-' + esc(a.id) + '"><span class="ic">' + (ICON[a.type] || ICON.checking) + '</span><span class="nm"><b>' + esc(a.name) + "</b><small>" + esc(a.typeName) + (a.shared ? " · " + Math.round(a.share * 100) + " % mine" : "") + (a.type === "investment" && num(a.details.gainPct) != null ? " · " + (a.details.gainPct > 0 ? "+" : "") + a.details.gainPct + " %" : "") + (a.loan && a.loan.rate != null ? " · " + a.loan.rate + " %" : "") + '</small></span><span class="bal' + (a.debt ? " debt" : "") + '"><b>' + (a.balance == null ? "—" : (a.debt ? "−" : "") + eur(a.balance)) + '</b><small class="' + (a.stale ? "stale" : "") + '">' + (a.stale && !a.never ? "⚠ " : "") + esc(ago(a.ageDays)) + "</small></span></button>" + (open ? detail(a, C, list) : "") + "</li>";
        }).join("") + "</ul></section>";
      }).join("") + "</div>";
      // loans
      if (M.loans.length) h += '<section class="card" aria-label="Loans"><header class="sh"><h2>Loans</h2><p class="tot">' + eur(M.loanDebt) + '<small>owed · this is what “Reach Net 0” counts</small></p></header><ul class="loans">' + M.loans.map(function (a) {
        var l = a.loan, pr = l.progress == null ? null : Math.round(l.progress * 100);
        return '<li><div class="lh"><b>' + esc(a.name) + "</b><span>" + (l.rate == null ? "rate —" : l.rate + " %") + '</span><span class="amt">' + eur(a.balance) + '</span></div><div class="prog" role="img" aria-label="' + esc(pr == null ? "Payoff progress unknown" : pr + " percent paid off") + '"><i style="width:' + (pr || 0) + '%"></i></div><p class="lm">' + (pr == null ? "Progress shows once an original amount or an earlier reading exists" : pr + " % paid off") + " · " + (l.payment == null ? "payment —" : eur(l.payment) + " a month") + " · " + (l.monthsLeft == null ? "months left —" : l.monthsLeft + " months left") + " · " + (l.futureInterest == null ? "interest —" : eur(l.futureInterest) + " interest still to pay") + "</p></li>";
      }).join("") + "</ul><p class=\"quiet\">Sorted by interest rate: the top one costs the most, so it is the one to clear first. The credit card counts in net worth but is not a loan here.</p></section>";
      // cash flow
      var months = C.months.slice(-12), fromSnap = !months.length && S.snap && (S.snap.monthly || []).length;
      if (fromSnap) months = S.snap.monthly.map(function (m) { return { month: m.month, income: num(m.income) || 0, spend: num(m.spend) || 0, categories: {}, shared: { in: 0, out: 0 }, internal: 0 }; });
      if (months.length) {
        var cur = months.filter(function (m) { return m.month === S.month; })[0] || months[months.length - 1], mx = Math.max.apply(null, months.map(function (m) { return Math.max(m.income, m.spend); }).concat([1]));
        var catRows = Object.keys(cur.categories).map(function (k) { return [k, cur.categories[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
        if (fromSnap && S.snap.monthly_categories) catRows = S.snap.monthly_categories.filter(function (c) { return c.month === cur.month && num(c.amount); }).map(function (c) { return [c.category, Math.abs(c.amount)]; }).sort(function (a, b) { return b[1] - a[1]; });
        var cm = Math.max.apply(null, catRows.map(function (r) { return r[1]; }).concat([1]));
        h += '<section class="card" aria-label="Cash flow"><header class="sh"><h2>Cash flow</h2><p class="quiet">' + (fromSnap ? "From the earlier monthly snapshot, until transactions are read from the banks." : "From the transactions read so far. Transfers between your own accounts are left out.") + '</p></header><div class="cf" role="group" aria-label="Income and spending by month">' + months.map(function (m) {
          return '<button class="mo' + (m.month === cur.month ? " on" : "") + '" data-month="' + m.month + '" aria-pressed="' + (m.month === cur.month) + '" title="' + esc(monY(m.month) + ": in " + eur(m.income) + ", out " + eur(m.spend)) + '"><span class="bars"><i class="in" style="height:' + (m.income / mx * 100).toFixed(1) + '%"></i><i class="out" style="height:' + (m.spend / mx * 100).toFixed(1) + '%"></i></span><small>' + esc(monY(m.month)) + "</small></button>";
        }).join("") + '</div><p class="leg"><span><i class="in"></i>Income</span><span><i class="out"></i>Spending</span></p><div class="cfd"><p class="lab">' + esc(new Date(cur.month + "-01T12:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" })) + '</p><dl class="kv"><div><dt>Income</dt><dd>' + eur(cur.income) + "</dd></div><div><dt>Spending</dt><dd>" + eur(cur.spend) + "</dd></div><div><dt>Left over</dt><dd>" + signed(cur.income - cur.spend) + "</dd></div>" + (cur.internal ? "<div><dt>Own transfers (not counted)</dt><dd>" + eur(cur.internal) + "</dd></div>" : "") + "</dl>" +
          (cur.shared.in || cur.shared.out ? '<p class="shr"><b>Shared account</b> in ' + eur(cur.shared.in) + " · out " + eur(cur.shared.out) + ' <span class="quiet">shown apart so it does not count twice</span></p>' : "") +
          (catRows.length ? '<ul class="cats">' + catRows.slice(0, 14).map(function (r) { return "<li><span>" + esc(r[0]) + '</span><span class="cb"><i style="width:' + (r[1] / cm * 100).toFixed(1) + '%"></i></span><span class="cv">' + eur(r[1]) + "</span></li>"; }).join("") + "</ul>" : "") + "</div></section>";
      }
      // to check
      if (C.toCheck.length) h += '<section class="card" aria-label="To check"><header class="sh"><h2>To check</h2><p class="quiet">' + C.toCheck.length + (C.toCheck.length === 1 ? " transaction has" : " transactions have") + ' no category yet. Pick one; the same rule can apply to the others from that place.</p></header><ul class="tx">' + C.toCheck.slice().sort(function (x, y) { return x.date < y.date ? 1 : -1; }).slice(0, 20).map(function (t) { return txRow(t, C, list); }).join("") + "</ul>" + (C.toCheck.length > 20 ? '<p class="none">Showing 20 of ' + C.toCheck.length + ".</p>" : "") + "</section>";
      // property (from the snapshot) and settings
      var prop = (S.snap && S.snap.property) || [];
      if (prop.length) h += '<section class="card" aria-label="Property"><header class="sh"><h2>Property</h2></header><ul class="prop">' + prop.map(function (p) { return "<li><b>" + esc(p.item) + "</b><span>" + esc(p.note || "") + '</span><span class="amt">' + (num(p.monthly) == null ? "—" : eur(p.monthly) + " a month") + "</span></li>"; }).join("") + "</ul></section>";
      var shared = M.accounts.filter(function (a) { return a.type === "shared" || a.share < 1; });
      h += '<details class="card set"><summary>Settings</summary><div class="sg"><label>Cash floor (€)<input type="number" min="0" step="100" id="faFloor" value="' + esc(M.cashFloor) + '"></label>' + shared.map(function (a) { return "<label>My share of " + esc(a.name) + ' (%)<input type="number" min="0" max="100" step="5" data-share="' + esc(a.id) + '" value="' + Math.round(a.share * 100) + '"></label>'; }).join("") + '<button class="btn" data-act="saveset"' + (S.busy ? " disabled" : "") + ">Save</button></div></details>";
      fa.innerHTML = h + "</div>";
    }
    function run(p, msg) { S.busy = true; return Promise.resolve(p).then(function (d) { if (d) S.raw = d; S.msg = msg || ""; }, function (e) { S.msg = "That could not be saved. Check your connection and try again."; if (window.console) console.warn(e); }).then(function () { S.busy = false; draw(); }); }
    fa.addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest("[data-acc],[data-act],[data-month]"); if (!t || t.disabled) return; var d = t.dataset;
      if (d.acc) { S.open = S.open === d.acc ? null : d.acc; draw(); var b = root.querySelector('[data-acc="' + d.acc + '"]'); if (b) b.focus(); }
      else if (d.month) { S.month = d.month; draw(); var mb = root.querySelector('[data-month="' + d.month + '"]'); if (mb) mb.focus(); }
      else if (d.act === "history") { if (o.onHistory) o.onHistory(); }
      else if (d.act === "saveset") {
        var fl = num(root.getElementById("faFloor").value), shares = [].map.call(root.querySelectorAll("[data-share]"), function (i) { return { id: i.dataset.share, share: Math.max(0, Math.min(100, num(i.value) == null ? 50 : +i.value)) / 100 }; });
        if (fl == null || fl < 0) { S.msg = "The cash floor needs to be a number of 0 or more."; draw(); return; }
        run(o.onSettings ? o.onSettings({ cashFloor: fl, shares: shares }) : null, "Settings saved.");
      }
    });
    fa.addEventListener("change", function (e) {
      var id = e.target.dataset && e.target.dataset.cat; if (!id || !e.target.value) return;
      var t = (S.raw.transactions || []).filter(function (x) { return String(x.id) === id; })[0]; if (!t) return;
      var box = root.querySelector('[data-sim="' + id + '"]'), sim = box && box.checked ? F.similar(t, S.raw.transactions).filter(function (x) { return !x.category; }) : [];
      run(o.onCategory ? o.onCategory({ id: t.id, category: e.target.value, similarIds: sim.map(function (x) { return x.id; }), rule: box && box.checked && t.counterparty ? t.counterparty : null }) : null, "Filed under " + e.target.value + (sim.length ? ", with " + sim.length + " more from " + t.counterparty : "") + ".");
    });
    draw();
    return { update: function (u) { if (u.data) S.raw = u.data; if (u.snapshot !== undefined) S.snap = u.snapshot; if (u.theme) S.theme = u.theme; if (u.today) S.today = u.today; draw(); }, state: function () { return { open: S.open, month: S.month }; } };
  };
})();
