/* Finance by bank and account. Shared by the Finance page (browser) and the connector, so both always agree.
   Pure functions: rows in, a model out. Balances are readings (one per account per date) kept forever, so
   "over time" and month-end figures come from real readings. Loans, credit cards and a building-savings
   contract in its loan phase are debts: their balance is what is owed, stored as a positive number.
   A shared account counts with "my share" (0–1) in net worth. Nothing here knows a full IBAN. */
(function (g) {
  var F = {};
  F.BANKS = { volksbank: "Berliner Volksbank", scalable: "Scalable Capital", dkb: "DKB", other: "Other" };
  F.BANK_ORDER = ["volksbank", "scalable", "dkb", "other"];
  F.TYPES = { checking: "Checking", savings: "Savings", credit_card: "Credit card", investment: "Investment", building_savings: "Building savings", loan: "Loan", share: "Membership share", shared: "Shared account" };
  F.STALE_DAYS = 14;
  var num = function (v) { return v == null || v === "" || isNaN(+v) ? null : +v; };
  var day = function (d) { return String(d || "").slice(0, 10); };
  var diff = function (a, b) { return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5); };
  var r2 = function (v) { return Math.round(v * 100) / 100; };
  F.bankName = function (id) { return F.BANKS[id] || String(id || "Other").replace(/^./, function (c) { return c.toUpperCase(); }); };
  F.slug = function (s) { return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "account"; };
  /* never keep a full IBAN or card number: anything that looks like one is cut to its last 4 characters */
  F.scrub = function (s) {
    return String(s == null ? "" : s).replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, function (m) { var c = m.replace(/\s/g, ""); return "…" + c.slice(-4); })
      .replace(/\b(?:\d[ -]?){13,19}\b/g, function (m) { var c = m.replace(/\D/g, ""); return "…" + c.slice(-4); }).replace(/\s+/g, " ").trim();
  };
  F.last4 = function (s) { var c = String(s == null ? "" : s).replace(/\s/g, "").toUpperCase(); return /^[0-9A-Z]{4,}$/.test(c) ? c.slice(-4) : null; };
  F.isDebt = function (a, det) { return a.type === "loan" || a.type === "credit_card" || (a.type === "building_savings" && String((det && det.phase) || (a.details && a.details.phase) || "") === "loan"); };

  /* months left and the interest still to pay, from balance, yearly rate (%) and monthly payment */
  F.payoff = function (balance, ratePct, payment) {
    var B = num(balance), P = num(payment), r = num(ratePct); if (B == null || !P || B <= 0) return { months: B === 0 ? 0 : null, interest: B === 0 ? 0 : null };
    if (!r) return { months: Math.ceil(B / P), interest: 0 };
    var i = r / 100 / 12; if (P <= B * i) return { months: null, interest: null };   // the payment does not cover the interest
    var n = -Math.log(1 - i * B / P) / Math.log(1 + i); return { months: Math.ceil(n), interest: r2(Math.max(0, n * P - B)) };
  };

  /* everything the page and get_finance show: accounts with their latest reading, banks, net worth, cash, loans */
  F.model = function (raw, today) {
    raw = raw || {}; today = day(today);
    var prevEnd = (function () { var d = new Date(today.slice(0, 7) + "-01T12:00:00Z"); d.setUTCDate(0); return d.toISOString().slice(0, 10); })();
    var byAcc = {}; (raw.balances || []).forEach(function (b) { (byAcc[b.account_id] = byAcc[b.account_id] || []).push(b); });
    var accounts = (raw.accounts || []).filter(function (a) { return !a.archived_at; }).map(function (a) {
      var hist = (byAcc[a.id] || []).slice().sort(function (x, y) { return day(x.as_of) < day(y.as_of) ? -1 : 1; });
      var last = hist[hist.length - 1] || null, prev = null; hist.forEach(function (h) { if (day(h.as_of) <= prevEnd) prev = h; });
      var det = Object.assign({}, a.details || {}, (last && last.details) || {}), debt = F.isDebt(a, det), share = num(a.my_share) == null ? 1 : +a.my_share;
      var bal = last ? num(last.balance) : null, sign = debt ? -1 : 1, age = last ? diff(day(last.as_of), today) : null;
      var o = { id: a.id, bank: a.bank || "other", key: a.key, name: a.name, type: a.type, typeName: F.TYPES[a.type] || a.type, last4: a.iban_last4 || null, currency: a.currency || "EUR", share: share, shared: share < 1 || a.type === "shared",
        debt: debt, balance: bal, asOf: last ? day(last.as_of) : null, ageDays: age, stale: age == null || age > F.STALE_DAYS, never: !last, details: det,
        mine: bal == null ? null : r2(sign * bal * share), prevMine: prev && num(prev.balance) != null ? r2(sign * +prev.balance * share) : null, prevAsOf: prev ? day(prev.as_of) : null,
        history: hist.map(function (h) { return { d: day(h.as_of), v: num(h.balance) }; }).filter(function (h) { return h.v != null; }) };
      if (debt && a.type !== "credit_card") {
        var p = F.payoff(bal, det.rate, det.monthlyPayment), orig = num(det.original) != null ? +det.original : (o.history.length ? Math.max.apply(null, o.history.map(function (h) { return h.v; })) : null);
        o.loan = { rate: num(det.rate), payment: num(det.monthlyPayment), monthsLeft: num(det.monthsLeft) != null ? +det.monthsLeft : p.months, futureInterest: num(det.futureInterest) != null ? +det.futureInterest : p.interest, original: orig, progress: orig && bal != null ? Math.max(0, Math.min(1, 1 - bal / orig)) : null };
      }
      return o;
    });
    var order = function (b) { var i = F.BANK_ORDER.indexOf(b); return i < 0 ? 98 : i; };
    var bankIds = accounts.map(function (a) { return a.bank; }).filter(function (b, i, l) { return l.indexOf(b) === i; }).sort(function (a, b) { return order(a) - order(b); });
    var sumMine = function (list) { var have = list.filter(function (a) { return a.mine != null; }); return have.length ? r2(have.reduce(function (s, a) { return s + a.mine; }, 0)) : null; };
    var banks = bankIds.map(function (b) { var list = accounts.filter(function (a) { return a.bank === b; }).sort(function (x, y) { return (num(x.position) || 0) - (num(y.position) || 0); }); return { id: b, name: F.bankName(b), accounts: list, total: sumMine(list), shared: list.length > 0 && list.every(function (a) { return a.shared; }) }; });
    var comparable = accounts.filter(function (a) { return a.mine != null && a.prevMine != null; });
    var own = accounts.filter(function (a) { return !a.shared && (a.type === "checking" || a.type === "savings") && a.balance != null; });
    var loans = accounts.filter(function (a) { return a.loan; }).sort(function (x, y) { return (y.loan.rate == null ? -1 : y.loan.rate) - (x.loan.rate == null ? -1 : x.loan.rate); });
    var debtHave = loans.filter(function (a) { return a.balance != null; });
    var floor = num(raw.settings && raw.settings.cash_floor); if (floor == null) floor = 3000;
    var assets = accounts.filter(function (a) { return !a.debt && a.mine != null; }), debts = accounts.filter(function (a) { return a.debt && a.mine != null; });
    return {
      today: today, accounts: accounts, banks: banks,
      netWorth: sumMine(accounts), assets: assets.length ? r2(assets.reduce(function (s, a) { return s + a.mine; }, 0)) : null, debts: debts.length ? r2(-debts.reduce(function (s, a) { return s + a.mine; }, 0)) : null,
      change: comparable.length ? r2(comparable.reduce(function (s, a) { return s + a.mine - a.prevMine; }, 0)) : null, changeSince: comparable.length ? prevEnd : null,
      cash: own.length ? r2(own.reduce(function (s, a) { return s + a.balance; }, 0)) : null, cashFloor: floor,
      loans: loans, loanDebt: debtHave.length ? r2(debtHave.reduce(function (s, a) { return s + a.balance * a.share; }, 0)) : null,
      needsRefresh: accounts.filter(function (a) { return a.stale; }).sort(function (x, y) { return (y.ageDays == null ? 1e9 : y.ageDays) - (x.ageDays == null ? 1e9 : x.ageDays); })
    };
  };

  /* ---------- transactions ---------- */
  var norm = function (s) { return String(s == null ? "" : s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); };
  F.norm = norm;
  /* the same transaction pushed twice gets the same fingerprint; two truly identical ones on one day are numbered */
  F.fingerprints = function (list) {
    var seen = {};
    return (list || []).map(function (t) { var base = day(t.date) + "|" + (num(t.amount) == null ? "" : (+t.amount).toFixed(2)) + "|" + norm(t.counterparty) + "|" + norm(t.purpose); seen[base] = (seen[base] || 0) + 1; return base + "|" + seen[base]; });
  };
  /* categories by rules on counterparty and purpose. The owner's rules come first, then these general ones. */
  F.DEFAULT_RULES = [
    ["lieferando|wolt|uber eats|delivery hero|flink|gorillas", "Food delivery"], ["rewe|edeka|lidl|aldi|penny|netto|kaufland|dm drogerie|rossmann|denns|bio company", "Groceries & drugstore"],
    ["netflix|spotify|disney|apple com bill|youtube premium|prime video|audible", "Streaming & subs"], ["amazon|amzn", "Amazon"], ["paypal", "PayPal (various)"],
    ["bvg|deutsche bahn|db vertrieb|deutschlandticket", "Transit pass"], ["vattenfall|stromio|e on|eprimo|strom", "Electricity"], ["telekom|vodafone|o2|1und1|1 1|congstar", "Mobile"],
    ["miete|rent", "Rent"], ["steam", "Gaming (Steam)"], ["wellhub|urban sports|fitness", "Wellhub"], ["geldautomat|bargeld|cash withdrawal|atm", "Cash withdrawals"],
    ["entgelt|kontofuhrung|zinsen|sollzins", "Bank fees & interest"], ["gehalt|lohn|salary", "Salary"], ["restaurant|cafe|bar |bistro|imbiss", "Dining & going out"], ["sparplan|depot|wertpapier", "Investing"]
  ];
  F.categorize = function (t, rules) {
    var hay = " " + norm(t.counterparty) + " " + norm(t.purpose) + " ";
    for (var i = 0; i < (rules || []).length; i++) { var r = rules[i]; if (!r || r.archived_at || !r.match) continue; if (hay.indexOf(norm(r.match)) >= 0) return r.category; }
    for (var j = 0; j < F.DEFAULT_RULES.length; j++) { if (new RegExp("(^| )(" + F.DEFAULT_RULES[j][0] + ")").test(hay)) return F.DEFAULT_RULES[j][1]; }
    return null;
  };
  /* transfers between my own accounts (the shared one included): the same amount leaving one and arriving in another within 3 days */
  F.internalIds = function (txs) {
    var out = {}, used = {}, list = (txs || []).filter(function (t) { return !t.archived_at && num(t.amount) != null; });
    list.forEach(function (t) { if (t.internal) out[t.id] = 1; });
    var ins = list.filter(function (t) { return +t.amount > 0; });
    list.filter(function (t) { return +t.amount < 0; }).forEach(function (o) {
      for (var i = 0; i < ins.length; i++) { var n = ins[i]; if (used[n.id] || n.account_id === o.account_id) continue; if (Math.abs(+n.amount + +o.amount) < 0.005 && Math.abs(diff(day(o.date), day(n.date))) <= 3) { used[n.id] = 1; out[o.id] = 1; out[n.id] = 1; break; } }
    });
    return out;
  };
  /* income and spending per month with categories; the shared account's flows are kept apart so nothing counts twice */
  F.cashflow = function (txs, accounts, rules) {
    var acc = {}; (accounts || []).forEach(function (a) { acc[a.id] = a; });
    var internal = F.internalIds(txs), months = {}, toCheck = [];
    (txs || []).forEach(function (t) {
      if (t.archived_at || num(t.amount) == null) return;
      var a = acc[t.account_id] || {}, shared = a.type === "shared" || (num(a.my_share) != null && +a.my_share < 1), m = day(t.date).slice(0, 7);
      var M = months[m] = months[m] || { month: m, income: 0, spend: 0, categories: {}, shared: { in: 0, out: 0 }, internal: 0 };
      if (internal[t.id]) { M.internal = r2(M.internal + Math.abs(+t.amount) / 2); return; }
      if (shared) { if (+t.amount > 0) M.shared.in = r2(M.shared.in + +t.amount); else M.shared.out = r2(M.shared.out - +t.amount); return; }
      var cat = t.category || F.categorize(t, rules);
      if (+t.amount > 0) M.income = r2(M.income + +t.amount); else { M.spend = r2(M.spend - +t.amount); var k = cat || "To check"; M.categories[k] = r2((M.categories[k] || 0) - +t.amount); }
      if (!cat) toCheck.push(t);
    });
    return { months: Object.keys(months).sort().map(function (k) { return months[k]; }), toCheck: toCheck, internal: internal };
  };
  F.similar = function (t, txs) { var c = norm(t.counterparty); return c ? (txs || []).filter(function (x) { return x.id !== t.id && !x.archived_at && norm(x.counterparty) === c; }) : []; };
  /* a short form for Claude: names and amounts, no ids, no account numbers */
  F.brief = function (M) {
    return { netWorth: M.netWorth, changeSinceLastMonth: M.change, cash: M.cash, cashFloor: M.cashFloor, loanDebt: M.loanDebt,
      banks: M.banks.map(function (b) { return { bank: b.name, total: b.total, accounts: b.accounts.map(function (a) { var o = { name: a.name, type: a.typeName, balance: a.balance, asOf: a.asOf, daysOld: a.ageDays }; if (a.shared) { o.myShare = a.share; o.mine = a.mine; } if (a.debt) o.debt = true; if (a.type === "investment") { o.gainEur = num(a.details.gainEur); o.gainPct = num(a.details.gainPct); o.sparplan = num(a.details.sparplan); } if (a.stale) o.needsRefresh = true; return o; }) }; }),
      loans: M.loans.map(function (a) { return { name: a.name, balance: a.balance, ratePct: a.loan.rate, monthlyPayment: a.loan.payment, monthsLeft: a.loan.monthsLeft, futureInterest: a.loan.futureInterest, paidOffPct: a.loan.progress == null ? null : Math.round(a.loan.progress * 100) }; }),
      needsRefresh: M.needsRefresh.map(function (a) { return F.bankName(a.bank) + ": " + a.name + (a.never ? " (never read)" : " (" + a.ageDays + " days old)"); }) };
  };
  g.PPFin = F;
})(typeof globalThis !== "undefined" ? globalThis : this);
