/* SAMPLE snapshot for the Finance page. Every name and number here is invented. It only exists so the
   page can be shown before a real snapshot is imported, and it is never written to the database. */
(function () {
  var months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];
  var income = [4150, 4150, 4150, 4320, 4320, 5900, 4320, 4320, 4320, 4320, 1400], liq = [0, 0, 1500, 0, 0, 0, 2500, 0, 0, 1000, 0];
  var spend = [3620, 3410, 4480, 3350, 3720, 4100, 5230, 3540, 3390, 3980, 1120], giro = [3200, 3650, 2900, 3500, 3800, 5200, 3100, 3400, 3900, 3300, 3550], tg = [9500, 9500, 8000, 8200, 8600, 9400, 7000, 7300, 7900, 7100, 7100];
  var latest = {
    schema_version: "1", as_of: "2026-11-08", currency: "EUR",
    period: { from: "2026-01-01", to: "2026-11-08", partial_month: "2026-11" },
    sources: ["Sample bank export", "Sample broker statement"],
    accounts: [
      { id: "giro", name: "Everyday account", type: "checking", balance: 3550, tracked: true, note: "" },
      { id: "tg", name: "Savings pot", type: "savings", balance: 7100, tracked: true, note: "Cash floor lives here" },
      { id: "cc", name: "Credit card", type: "credit_card", balance: null, tracked: true, note: "Statement not in yet" },
      { id: "depot", name: "Broker account", type: "investment", balance: 18240, tracked: true, note: "" },
      { id: "share", name: "Family flat share", type: "equity_share", balance: 40000, tracked: false, note: "Rough estimate, not for sale" }
    ],
    monthly: months.map(function (m, i) { return { month: m, income: income[i], liquidated: liq[i], spend: spend[i], invest: i === 10 ? 0 : 250, loans: i === 10 ? 0 : 610, net: income[i] + liq[i] - spend[i], rent_flat_a: i === 10 ? null : 780, rent_flat_b: i === 10 ? null : 0 }; }),
    balances_eom: months.map(function (m, i) { return { month: m, giro: giro[i], tagesgeld: tg[i] }; }),
    categories: [["Housing", 8580], ["Groceries", 4310], ["Loan payments", 6100], ["Travel", 3920], ["Dining out", 2240], ["Car and transport", 2010], ["Insurance", 1760], ["Shopping", 1690], ["Health", 1180], ["Subscriptions", 1040], ["Delivery", 980], ["Gifts", 760], ["Hobbies", 540], ["Fees", 210]].map(function (c) { return { category: c[0], total: c[1], per_month: Math.round(c[1] / 10) }; }),
    food: months.map(function (m, i) { return { month: m, delivery: [120, 90, 140, 70, 95, 110, 130, 85, 60, 80, 35][i], dining: [210, 180, 320, 190, 230, 260, 340, 170, 150, 190, 70][i], groceries: [430, 410, 445, 420, 450, 440, 400, 435, 425, 455, 160][i] }; }),
    subscriptions: [
      { name: "Gym membership", monthly: 49, last_charge: "2026-11-01", charges_2026: 11, note: "" },
      { name: "Mobile plan", monthly: 29.99, last_charge: "2026-10-28", charges_2026: 10, note: "" },
      { name: "Streaming bundle", monthly: 17.99, last_charge: "2026-11-03", charges_2026: 11, note: "Price went up in July" },
      { name: "Cloud storage", monthly: 9.99, last_charge: "2026-10-15", charges_2026: 10, note: "" },
      { name: "Language app", monthly: 12.5, last_charge: "2026-06-12", charges_2026: 6, note: "No charge since June, check if cancelled" },
      { name: "News site", monthly: null, last_charge: null, charges_2026: null, note: "Amount unknown" }
    ],
    loans: [
      { loan: "Car loan", balance: 9400, rate_pct: 5.9, payment: 310, months_left: 33, future_interest: 830, verdict: "Pay off early" },
      { loan: "Study loan", balance: 14200, rate_pct: 1.8, payment: 300, months_left: 50, future_interest: null, verdict: "Keep as is" }
    ],
    investments: [
      { item: "World index fund", value: 12900, gain_total: 2140, gain_pct: 19.9, gain_current: 2140, note: "Savings plan" },
      { item: "Bond fund", value: 3800, gain_total: -120, gain_pct: -3.1, gain_current: -120, note: "" },
      { item: "Company shares", value: 1540, gain_total: null, gain_pct: null, gain_current: null, note: "Cost basis unknown" }
    ],
    property: [
      { item: "Flat A, rent", monthly: 780, note: "Includes heating" },
      { item: "Flat A, utilities", monthly: 95, note: "" },
      { item: "Flat B, upkeep share", monthly: null, note: "Waiting for the yearly statement" }
    ],
    income_sources: [{ source: "Salary", total: 42350 }, { source: "Bonus", total: 1580 }, { source: "Side work", total: 1400 }, { source: "Tax refund", total: 340 }],
    kpis: { avg_net_salary: 4270, cash_floor_target: 10000, union_sparplan_monthly: 250 },
    actions: [
      { rank: 1, title: "Top the savings pot back up to the cash floor", status: "open" },
      { rank: 2, title: "Pay the car loan down with the next bonus", status: "open" },
      { rank: 3, title: "Check whether the language app is cancelled", status: "waiting" },
      { rank: 4, title: "Move the mobile plan to the cheaper tariff", status: "done" }
    ]
  };
  /* an older sample snapshot, so History and the "since the previous snapshot" lines have something to show */
  var older = JSON.parse(JSON.stringify(latest));
  older.as_of = "2026-10-05"; older.period = { from: "2026-01-01", to: "2026-10-05", partial_month: "2026-10" };
  ["monthly", "balances_eom", "food"].forEach(function (k) { older[k] = older[k].slice(0, 10); });
  older.balances_eom[9] = { month: "2026-10", giro: 3700, tagesgeld: 7900 };
  older.loans[0].balance = 9700; older.loans[1].balance = 14500; older.subscriptions[1].monthly = 39.99; older.actions[3].status = "open";
  window.PPFinanceSample = [latest, older];
})();
