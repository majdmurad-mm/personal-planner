/* People page: the Tree view. A family tree around you (grandparents, parents, aunts and uncles,
   siblings, cousins under their parent when the two are linked, children), your partner to your
   right, former partners folded into one "Exes" point, relatives whose place is not known yet, and
   below that friends, colleagues and others as free-standing clusters (not part of the tree). Family roles come from each
   person's kinRole / kinSide, set in the person panel. Returns nothing; draws into the SVG and
   leaves the full box in svg._vb and the family part in svg._focus for the zoom code in people.js. */
(function () {
  "use strict";
  var C = window.PPPeopleCore, K = window.PPPeopleSky, esc = K.esc, KIN = C.KIN, SIDED = C.KIN_SIDED;
  var CW = 88, H = 138, R = 17, SR = 12, SUB = 96, BCW = 66, BCH = 70, PER = 5, BPER = 4;
  var PLURAL = { Friend: "Friends", Colleague: "Colleagues", Mentor: "Mentors", Other: "Others", Family: "Family", Partner: "Partners" };
  function byName(a, b) { return a.name < b.name ? -1 : 1; }
  function dispName(n) { return String(n || "").replace(/^\s*\[[^\]]*\]\s*/, "").replace(/\s*\([^)]*\)/g, "").trim() || String(n || ""); }

  function draw(svg, M, st) {
    var nodes = "", lines = "", texts = "", bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9, f = function (n) { return n.toFixed(1); };
    function grow(x, y, pad) { bx0 = Math.min(bx0, x - pad); bx1 = Math.max(bx1, x + pad); by0 = Math.min(by0, y - pad); by1 = Math.max(by1, y + pad + 16); }
    function line(d, cls) { lines += '<path class="tl' + (cls ? " " + cls : "") + '" d="' + d + '"/>'; }
    function text(x, y, t, cls, anchor) { texts += '<text class="' + cls + '" x="' + f(x) + '" y="' + f(y) + '"' + (anchor ? ' text-anchor="' + anchor + '"' : "") + ">" + esc(t) + "</text>"; grow(x, y, 30); }
    function put(p, x, y, r, cap) {
      p.x = x; p.y = y; p.r = r; grow(x, y, r + 34);
      var lab = p.first.length > 12 ? p.first.slice(0, 11) + "…" : p.first;
      var dn = dispName(p.name);
      nodes += '<g class="nd tr' + (p.color ? ' gc" style="--gc:' + esc(p.color) : "") + (p.off && !p.inMemory ? " quiet" : "") + (p.inMemory ? " mem" : "") + (st.q && dn.toLowerCase().indexOf(st.q) >= 0 ? " hit" : "") + '" data-id="' + p.id + '" tabindex="0" role="button" aria-label="' + esc(dn + (cap ? ", " + cap : "") + (p.inMemory ? ", in memory" : "") + (p.group ? ", " + p.group : "")) + '" transform="translate(' + f(x) + "," + f(y) + ')"><title>' + esc(dn + (p.inMemory ? " · in memory" : "")) + "</title>" + (p.inMemory ? '<circle class="memring" r="' + (r + 4) + '"/>' : "") +
        '<circle r="' + (r + 7) + '" fill="transparent"/><g class="rs" style="opacity:' + (p.rs && !p.inMemory ? p.rs.alpha : 1) + '"><circle class="disc" r="' + r + '"/><text class="ini" style="font-size:' + f(r * .8) + 'px">' + esc(p.ini) + "</text></g>" +
        (p.threads.length ? '<circle class="dot" cx="' + f(r * .74) + '" cy="' + f(-r * .74) + '" r="' + f(Math.max(3.2, r * .3)) + '"/>' : "") +
        '<text class="nm" style="font-size:calc(' + (r > 14 ? 12 : 10.5) + 'px*var(--iz,1)*var(--tz,1))" y="' + (r + 14) + '">' + esc(lab) + "</text>" + (cap ? '<text class="cap" y="' + (r + 27) + '">' + esc(cap) + "</text>" : "") + "</g>";
    }
    /* a bar above a row of siblings with a drop to each; xs are the node centres, y the row */
    function bar(xs, y, r) { if (!xs.length) return y; var yb = y - r - 20, a = Math.min.apply(0, xs), b = Math.max.apply(0, xs); if (b > a) line("M" + f(a) + "," + f(yb) + "H" + f(b)); xs.forEach(function (x) { line("M" + f(x) + "," + f(yb) + "V" + f(y - r - 3)); }); return yb; }

    var all = M.P.filter(function (p) { return !p.archived; });
    all.forEach(function (p) { p.x = null; });
    var isEx = function (p) { return p.kinRole === "ex" || p.rel === "Ex" || (p.rel === "Partner" && p.kinRole !== "partner"); };
    var role = function (p) { return isEx(p) ? "" : (p.kinRole || ""); };
    var exes = all.filter(isEx).sort(byName);
    var fam = all.filter(function (p) { return !isEx(p) && (role(p) || p.rel === "Family"); }), placed = {};
    var pick = function (roles, side) { return fam.filter(function (p) { return roles.indexOf(role(p)) >= 0 && (!side || p.kinSide === side); }).sort(byName); };
    var cap = function (p) { return KIN[role(p)] || ""; }, mark = function (arr) { arr.forEach(function (p) { placed[p.id] = 1; }); return arr; };
    var bottom = R + 40;

    /* ---- the family tree from typed links (parent_of, spouse, partner, sibling). Generations are rows,
       the father's side to the left, the mother's to the right, couples side by side with their children
       below. Only people reached from you through those links appear. Returns null without typed links. */
    function typedTree() {
      var byId = {}; all.forEach(function (p) { byId[p.id] = p; });
      var L = []; all.forEach(function (p) { p.links.forEach(function (l) { if (l.kind && byId[l.id] && p.id < l.id) L.push({ a: p.id, b: l.id, kind: l.kind, parent: l.parent }); }); });
      if (!L.some(function (l) { return l.kind === "parent_of" || l.kind === "spouse" || l.kind === "sibling"; })) return null;
      var other = function (l, id) { return l.a === id ? l.b : l.a; };
      var rel = function (id, ks) { return L.filter(function (l) { return (l.a === id || l.b === id) && ks.indexOf(l.kind) >= 0; }).map(function (l) { return other(l, id); }).filter(function (x) { return byId[x]; }); };
      var kidsOf = function (id) { return L.filter(function (l) { return l.kind === "parent_of" && l.parent === id; }).map(function (l) { return other(l, id); }).filter(function (x) { return byId[x]; }); };
      var parentsOf = function (id) { return L.filter(function (l) { return l.kind === "parent_of" && l.parent && l.parent !== id && (l.a === id || l.b === id); }).map(function (l) { return l.parent; }).filter(function (x) { return byId[x]; }); };
      var kindOf = function (a, b) { var l = L.filter(function (x) { return x.kind !== "parent_of" && ((x.a === a && x.b === b) || (x.a === b && x.b === a)); })[0]; return l ? l.kind : ""; };
      var used = {}, fold = st.fold || {}, exOpen = !!st.exOpen, side = st.narrow ? (st.side || "paternal") : (st.side || "both"), PG = 34;
      var roleOf = function (r) { return all.filter(function (p) { return p.kinRole === r; }).sort(byName); };
      var F = roleOf("father")[0], Mo = roleOf("mother")[0];
      if (F) used[F.id] = 1; if (Mo) used[Mo.id] = 1;
      function count(id, seen) { var n = 0; kidsOf(id).forEach(function (k) { if (!seen[k]) { seen[k] = 1; n += 1 + count(k, seen); } }); return n; }
      function unit(id, depth) {
        used[id] = 1;
        var ps = rel(id, ["spouse", "partner"]).filter(function (x) { return !used[x]; }); ps.forEach(function (x) { used[x] = 1; });
        var ex = exOpen ? rel(id, ["ex_partner"]).filter(function (x) { return !used[x]; }) : []; ex.forEach(function (x) { used[x] = 1; });
        var ch = []; [id].concat(ps).forEach(function (pid) { kidsOf(pid).forEach(function (k) { if (!used[k] && ch.indexOf(k) < 0) ch.push(k); }); });
        ch.sort(function (a, b) { return byName(byId[a], byId[b]); });
        var u = { id: id, p: byId[id], partners: ps.map(function (x) { return { p: byId[x], kind: kindOf(id, x) }; }), exes: ex.map(function (x) { return byId[x]; }), kids: [], hidden: 0, canFold: ch.length > 0 };
        if (fold[id] || depth > 6) { var seen = {}; ch.forEach(function (k) { seen[k] = 1; used[k] = 1; }); u.hidden = ch.length + ch.reduce(function (s, k) { return s + count(k, seen); }, 0); Object.keys(seen).forEach(function (k) { used[k] = 1; }); }
        else u.kids = ch.map(function (k) { return unit(k, depth + 1); });
        return u;
      }
      /* you, your siblings and your partner, as the centre family */
      var mine = roleOf("partner").filter(function (p) { return !used[p.id]; }); mine.forEach(function (p) { used[p.id] = 1; });
      var myEx = exOpen ? all.filter(function (p) { return !used[p.id] && (p.kinRole === "ex" || (p.rel === "Partner" && p.kinRole !== "partner")); }) : [];
      myEx.forEach(function (p) { used[p.id] = 1; });
      var sibIds = []; roleOf("brother").concat(roleOf("sister")).forEach(function (p) { if (sibIds.indexOf(p.id) < 0) sibIds.push(p.id); });
      [F, Mo].forEach(function (pa) { if (pa) kidsOf(pa.id).forEach(function (k) { if (sibIds.indexOf(k) < 0) sibIds.push(k); }); });
      sibIds = sibIds.filter(function (k) { return !used[k]; }); sibIds.forEach(function (k) { used[k] = 1; });
      var ME = { me: true, partners: mine.map(function (p) { return { p: p, kind: "partner" }; }), exes: myEx, kids: [], hidden: 0 };
      var myKids = roleOf("son").concat(roleOf("daughter")).filter(function (p) { return !used[p.id]; }); myKids.forEach(function (p) { used[p.id] = 1; });
      var sibUnits = sibIds.sort(function (a, b) { return byName(byId[a], byId[b]); }).map(function (k) { used[k] = 0; return unit(k, 1); });
      ME.kids = myKids.map(function (p) { return { id: p.id, p: p, partners: [], exes: [], kids: [], hidden: 0 }; });
      var half = Math.ceil(sibUnits.length / 2), centreKids = sibUnits.slice(0, half).concat([ME]).concat(sibUnits.slice(half));
      var centre = { id: "centre", couple: [F, Mo].filter(Boolean), kids: centreKids };
      var grand = { paternal: F ? parentsOf(F.id).map(function (x) { used[x] = 1; return byId[x]; }) : [], maternal: Mo ? parentsOf(Mo.id).map(function (x) { used[x] = 1; return byId[x]; }) : [] };
      /* both sides are built (so a hidden side's people are not mistaken for unlinked relatives); only the chosen side is drawn */
      var sideUnits = function (pa) { return pa ? rel(pa.id, ["sibling"]).filter(function (x) { return !used[x]; }).sort(function (a, b) { return byName(byId[a], byId[b]); }).map(function (x) { return unit(x, 0); }) : []; };
      var paternal = sideUnits(F), maternal = sideUnits(Mo);
      if (side === "maternal") paternal = []; if (side === "paternal") maternal = [];
      /* widths, bottom up */
      function width(u) { var n = u.couple ? u.couple.length : 1 + u.partners.length + u.exes.length; u.cw = Math.max(1, n) * CW; var kw = 0; u.kids.forEach(function (k) { kw += width(k); }); u.w = Math.max(u.cw, kw) + (u.couple ? 0 : 6); return u.w; }
      var maxGen = 0;
      function place(u, x0, gen) {
        var y = gen * H, kw = u.kids.reduce(function (s, k) { return s + k.w; }, 0), kx = x0 + (u.w - kw) / 2, xs = [];
        maxGen = Math.max(maxGen, gen);
        u.kids.forEach(function (k) { place(k, kx, gen + 1); xs.push(k.dropX); kx += k.w; });
        var cx = x0 + u.w / 2, people = u.couple ? u.couple.map(function (p) { return { p: p, kind: "spouse" }; }) : [{ p: u.p, me: u.me }].concat(u.partners).concat(u.exes.map(function (p) { return { p: p, kind: "ex_partner" }; }));
        var start = cx - (people.length - 1) * CW / 2;
        people.forEach(function (o, i) {
          var x = start + i * CW;
          if (o.me) { nodes += '<g class="me" transform="translate(' + f(x) + "," + f(y) + ')"><circle class="pulse" r="29"/><circle class="disc" r="21"/><text style="font-size:11px">You</text></g>'; grow(x, y, 50); meX = x; }
          else put(o.p, x, y, R, u.couple ? cap(o.p) : "");
          if (i) line("M" + f(start + (i - 1) * CW + (i === 1 && people[0].me ? 23 : R + 2)) + "," + f(y) + "H" + f(x - R - 2), o.kind === "ex_partner" ? "dash" : o.kind === "partner" ? "pair lite" : "pair");
        });
        var main = people.filter(function (o) { return o.kind !== "ex_partner"; }), dx = main.length > 1 ? start + CW / 2 : start;
        u.dropX = start; u.topX = start; u.dropFrom = dx;
        if (u.kids.length) { var yb = bar(xs, (gen + 1) * H, R); line("M" + f(dx) + "," + f(y + (main.length > 1 ? 0 : R + 3)) + "V" + f(yb)); }
        if (u.canFold || u.hidden) {
          var fx = dx, fy = y + R + 30;
          nodes += '<g class="fold" data-fold="' + esc(u.id) + '" tabindex="0" role="button" aria-expanded="' + !u.hidden + '" aria-label="' + esc((u.hidden ? "Show " : "Fold ") + dispName(u.p.name) + "’s family" + (u.hidden ? ", " + u.hidden + (u.hidden === 1 ? " person" : " people") : "")) + '" transform="translate(' + f(fx) + "," + f(fy) + ')"><circle r="7"/><text>' + (u.hidden ? "+" + u.hidden : "−") + "</text></g>";
        }
      }
      var meX = 0;
      width(centre); paternal.forEach(width); maternal.forEach(width);
      var cx0 = -centre.w / 2; place(centre, cx0, -1);
      var fx0 = F ? cx0 + centre.w / 2 - (centre.couple.length - 1) * CW / 2 : 0, mx0 = Mo ? fx0 + (centre.couple.length - 1) * CW : 0;
      if (centre.couple.length > 1) { /* place() drew the parents left to right: father, then mother */ }
      var xl = cx0 - PG, xr = cx0 + centre.w + PG, pxs = F ? [fx0] : [], mxs = Mo ? [mx0] : [];
      paternal.forEach(function (u) { xl -= u.w; place(u, xl, -1); pxs.push(u.topX); });
      maternal.forEach(function (u) { place(u, xr, -1); mxs.push(u.topX); xr += u.w; });
      /* sibling bars between each parent and their brothers and sisters, grandparents above */
      var surname = function (p) { var w = dispName(p.name).split(/\s+/); return w.length > 1 ? w[w.length - 1] : ""; };
      [[pxs, grand.paternal, F, "paternal", paternal.length], [mxs, grand.maternal, Mo, "maternal", maternal.length]].forEach(function (S2) {
        var xs = S2[0], gp = S2[1], pa = S2[2]; if (!pa || (S2[3] === "paternal" ? side === "maternal" : side === "paternal")) return;
        var yb = xs.length > 1 ? bar(xs.map(function (x) { return x; }), -H, R) : -H - R - 20, mid = (Math.min.apply(0, xs) + Math.max.apply(0, xs)) / 2;
        if (xs.length > 1) { /* bar() also dropped a line to the parent; nothing else to join */ }
        gp.slice(0, 2).forEach(function (p, i) { put(p, gp.length > 1 ? mid + (i ? 1 : -1) * CW * .56 : mid, -2 * H, R, cap(p) || (p.kinRole ? "" : "Grandparent")); });
        if (gp.length > 1) line("M" + f(mid - CW * .56 + R + 2) + "," + -2 * H + "H" + f(mid + CW * .56 - R - 2), "pair");
        if (gp.length) line("M" + f(mid) + "," + f(gp.length > 1 ? -2 * H : -2 * H + R + 31) + "V" + f(yb));
        var sn = surname(pa), lab = C.SIDE[S2[3]] + (sn ? " · " + sn : "");
        if (S2[4] || gp.length) text(mid, (gp.length ? -2 * H : -H) - R - 40, lab, "tsec", "middle");
      });
      /* phone: one side at a time */
      if (st.narrow && F && Mo) {
        var sx = meX, sy = -H - R - (grand.paternal.length || grand.maternal.length ? H + 74 : 74);
        [["paternal", "Father’s side"], ["maternal", "Mother’s side"], ["both", "Both"]].forEach(function (b, i) {
          var x = sx + (i - 1) * 108;
          nodes += '<g class="sidebtn' + (side === b[0] ? " on" : "") + '" data-side="' + b[0] + '" tabindex="0" role="button" aria-pressed="' + (side === b[0]) + '" transform="translate(' + f(x) + "," + f(sy) + ')"><rect x="-50" y="-14" width="100" height="28" rx="14"/><text>' + b[1] + "</text></g>"; grow(x, sy, 60);
        });
      }
      /* exes: one quiet switch beside you */
      var exCount = all.filter(function (p) { return p.kinRole === "ex" || (p.rel === "Partner" && p.kinRole !== "partner"); }).length + L.filter(function (l) { return l.kind === "ex_partner"; }).length;
      if (exCount) { var ex0 = meX, ey = R + 58; nodes += '<g class="exn' + (exOpen ? " open" : "") + '" data-exes="1" tabindex="0" role="button" aria-expanded="' + exOpen + '" aria-label="Former partners, ' + (exOpen ? "shown dashed" : "hidden") + '" transform="translate(' + f(ex0) + "," + ey + ')"><circle r="' + (R + 7) + '" fill="transparent"/><circle class="disc" r="' + (R - 4) + '"/><text class="ini" style="font-size:10px">' + exCount + '</text><text class="cap" y="' + (R + 6) + '">' + (exOpen ? "hide exes" : "show exes") + "</text></g>"; grow(ex0, ey, 40); }
      bottom = (maxGen) * H + R + 48;
      /* relatives not reached from you yet */
      var rest = all.filter(function (p) { return !used[p.id] && (p.rel === "Family" || (p.kinRole && p.kinRole !== "ex")) && !(p.kinRole === "ex" || (p.rel === "Partner" && p.kinRole !== "partner")); }).sort(byName);
      if (rest.length) {
        var per = Math.min(rest.length, 9), my = bottom + 74;
        text(meX, my - R - 40, "More family", "tsec", "middle");
        text(meX, my - R - 24, (rest.length === 1 ? "One relative is" : rest.length + " relatives are") + " not linked to the tree yet. Open someone and link them to a parent, partner or sibling.", "thint", "middle");
        rest.forEach(function (p, i) { var rowN = Math.min(per, rest.length - Math.floor(i / per) * per); put(p, meX + ((i % per) - (rowN - 1) / 2) * CW, my + Math.floor(i / per) * SUB, R, cap(p)); });
        bottom = my + (Math.ceil(rest.length / per) - 1) * SUB + R + 40;
      }
      return { used: used };
    }

    var TY = typedTree();
    if (!TY) {
    /* ---- you, siblings, partner ---- */
    var sib = mark(pick(["brother", "sister"])), partners = mark(pick(["partner"])), m = sib.length + 1, xAt = function (i) { return (i - (m - 1) / 2) * CW; }, meX = xAt(sib.length);
    sib.forEach(function (p, i) { put(p, xAt(i), 0, R, cap(p)); });
    partners.forEach(function (p, i) { put(p, meX + (i + 1) * CW, 0, R, cap(p)); line("M" + f(meX + (i ? i * CW + R : 23)) + ",0H" + f(meX + (i + 1) * CW - R - 2), "pair"); });
    grow(meX, 0, 50);
    var coreL = xAt(0), coreR = meX + partners.length * CW, exBottom = 0;
    /* ---- exes: one quiet point beyond the partner; it opens into its people only when asked ---- */
    if (exes.length) {
      var exX = coreR + CW, open = !!st.exOpen;
      coreR = exX;
      line("M" + f(exX - CW + (partners.length ? R + 2 : 23)) + ",0H" + f(exX - R - 2), "dash");
      nodes += '<g class="exn' + (open ? " open" : "") + '" data-exes="1" tabindex="0" role="button" aria-expanded="' + open + '" aria-label="Exes, ' + exes.length + (exes.length === 1 ? " person" : " people") + (open ? ", shown" : ", hidden") + '" transform="translate(' + f(exX) + ',0)"><circle r="' + (R + 7) + '" fill="transparent"/><circle class="disc" r="' + R + '"/><text class="ini" style="font-size:' + f(R * .8) + 'px">' + exes.length + '</text><text class="nm" style="font-size:calc(12px*var(--iz,1)*var(--tz,1))" y="' + (R + 14) + '">Exes</text><text class="cap" y="' + (R + 27) + '">' + (open ? "tap to fold" : "tap to open") + "</text></g>";
      grow(exX, 0, R + 34);
      if (open) {
        exes.forEach(function (p, i) { put(p, exX + ((i % 3) - 1) * BCW, 74 + Math.floor(i / 3) * BCH, SR, ""); });
        line("M" + f(exX) + "," + (R + 32) + "V" + (74 - SR - 6), "dash");
        exBottom = 74 + (Math.ceil(exes.length / 3) - 1) * BCH + SR + 40;
      }
    }
    /* ---- parents ---- */
    var fa = mark(pick(["father"])), mo = mark(pick(["mother"])), both = fa.length && mo.length, par = fa.concat(mo);
    var faX = both ? -CW * .56 : 0, moX = both ? CW * .56 : 0, sibXs = sib.map(function (p) { return p.x; }).concat([meX]);
    fa.slice(0, 1).forEach(function (p) { put(p, faX, -H, R, cap(p)); }); mo.slice(0, 1).forEach(function (p) { put(p, moX, -H, R, cap(p)); });
    par.forEach(function (p) { if (p.x == null) placed[p.id] = 0; });               // a second "father" falls through to More family
    if (par.length) {
      var yb = bar(sibXs, 0, R + (0)), top = both ? -H : -H + R + 31;
      if (both) line("M" + f(faX + R + 2) + "," + -H + "H" + f(moX - R - 2), "pair");
      line("M0," + f(top) + "V" + f(yb)); if (sibXs.length === 1 && Math.abs(meX) > .5) line("M0," + f(yb) + "H" + f(meX));
    } else if (sib.length) bar(sibXs, 0, R);
    /* ---- each side: grandparents, aunts and uncles, cousins ---- */
    bottom = Math.max(R + 40, exBottom);
    [["paternal", -1, fa[0] && fa[0].x != null ? faX : null], ["maternal", 1, mo[0] && mo[0].x != null ? moX : null]].forEach(function (S) {
      var side = S[0], dir = S[1], px = S[2], au = mark(pick(["uncle", "aunt"], side)), gp = mark(pick(["grandfather", "grandmother"], side)).slice(0, 2), co = mark(pick(["cousin"], side));
      if (!au.length && !gp.length && !co.length) return;
      var x0 = (dir < 0 ? Math.min(coreL, faX) : Math.max(coreR, moX)) + dir * CW * 1.45;
      au.forEach(function (p, i) { put(p, x0 + dir * i * CW, -H, R, cap(p)); });
      var gen = (px != null ? [px] : []).concat(au.map(function (p) { return p.x; })), mid = gen.length ? (Math.min.apply(0, gen) + Math.max.apply(0, gen)) / 2 : x0;
      if (au.length) { var ybp = bar(gen, -H, R); if (gp.length) line("M" + f(mid) + "," + f(gp.length > 1 ? -2 * H : -2 * H + R + 31) + "V" + f(ybp)); }
      else if (gp.length && px != null) line("M" + f(mid) + "," + f(gp.length > 1 ? -2 * H : -2 * H + R + 31) + "V" + f(-H - R - 3));
      gp.forEach(function (p, i) { put(p, gp.length > 1 ? mid + (i ? 1 : -1) * CW * .56 : mid, -2 * H, R, cap(p)); });
      if (gp.length > 1) line("M" + f(mid - CW * .56 + R + 2) + "," + -2 * H + "H" + f(mid + CW * .56 - R - 2), "pair");
      mark(gp); pick(["grandfather", "grandmother"], side).forEach(function (p) { if (p.x == null) placed[p.id] = 0; });
      if (co.length) {
        var parentOf = {}, loose = [];
        co.forEach(function (c) { var par = au.filter(function (a) { return (c.links || []).some(function (l) { return l.id === a.id; }); })[0]; if (par) (parentOf[par.id] = parentOf[par.id] || []).push(c); else loose.push(c); });
        var slot = 0, row0 = [];
        au.forEach(function (a) {
          var kids = parentOf[a.id]; if (!kids) return;
          var xs = kids.map(function (c) { var cx = x0 + dir * slot * CW; put(c, cx, 0, R, cap(c)); slot++; row0.push(cx); return cx; });
          var ybk = bar(xs, 0, R), mid2 = (Math.min.apply(0, xs) + Math.max.apply(0, xs)) / 2;
          line("M" + f(a.x) + "," + f(-H + R + 31) + "V" + f((-H + R + 31 + ybk) / 2) + "H" + f(mid2) + "V" + f(ybk));
          slot += 0.4;
        });
        if (loose.length) {
          var start = Math.ceil(slot);
          loose.forEach(function (p, i) { put(p, x0 + dir * (start + (i % PER)) * CW, Math.floor(i / PER) * SUB, R, cap(p)); });
          var ybc = bar(loose.slice(0, PER).map(function (p) { return p.x; }), 0, R), lx = x0 + dir * start * CW;
          if (au.length && !row0.length) line("M" + f(lx) + "," + f(-H + R + 31) + "V" + f(ybc));
          else if (!au.length && px != null) line("M" + f(lx) + "," + f(ybc) + "V" + f(-H) + "H" + f(px + dir * (R + 2)), "dash");
          bottom = Math.max(bottom, (Math.ceil(loose.length / PER) - 1) * SUB + R + 40);
        }
      }
      text(x0 + dir * (Math.max(au.length, Math.min(co.length, PER), 1) - 1) * CW / 2, -H * (gp.length ? 2 : au.length ? 1 : 0) - R - 34 - (!gp.length && !au.length ? 6 : 0), C.SIDE[side], "tsec", "middle");
    });
    /* ---- children, nephews and nieces ---- */
    var kids = mark(pick(["son", "daughter"])), nn = mark(pick(["nephew", "niece"]));
    if (kids.length || nn.length) {
      var ky = Math.max(H, bottom + 62), kx0 = meX - (kids.length - 1) * CW / 2;
      kids.forEach(function (p, i) { put(p, kx0 + i * CW, ky, R, cap(p)); });
      if (kids.length) { var ybk = bar(kids.map(function (p) { return p.x; }), ky, R); line("M" + f(meX) + "," + (R + 8) + "V" + f(ybk)); }
      nn.forEach(function (p, i) { put(p, (kids.length ? kx0 : meX + CW * .5) - (i + 1) * CW - (kids.length ? CW * .4 : 0), ky, R, cap(p)); });
      bottom = ky + R + 40;
    }
    nodes += '<g class="me" transform="translate(' + f(meX) + ',0)"><circle class="pulse" r="29"/><circle class="disc" r="21"/><text style="font-size:11px">You</text></g>';
    /* ---- relatives without a place yet ---- */
    var rest = fam.filter(function (p) { return !placed[p.id]; }).sort(function (a, b) { return cap(a) === cap(b) ? byName(a, b) : (cap(a) || "~") < (cap(b) || "~") ? -1 : 1; });
    if (rest.length) {
      var per = Math.min(rest.length, 9), my = bottom + 74, unset = rest.filter(function (p) { return !role(p) || (SIDED[role(p)] && !p.kinSide); }).length;
      text(0, my - R - 40, "More family", "tsec", "middle");
      if (unset) text(0, my - R - 24, unset === 1 ? "One relative has no place in the tree yet. Open them and choose how you are related." : unset + " relatives have no place in the tree yet. Open someone and choose how you are related.", "thint", "middle");
      rest.forEach(function (p, i) { var rowN = Math.min(per, rest.length - Math.floor(i / per) * per); put(p, ((i % per) - (rowN - 1) / 2) * CW, my + Math.floor(i / per) * SUB, R, cap(p) + (SIDED[role(p)] && !p.kinSide ? " · side?" : "")); });
      bottom = my + (Math.ceil(rest.length / per) - 1) * SUB + R + 40;
    }
    } /* end of the role-based layout */
    var focus = [bx0 - 20, by0 - 10, bx1 - bx0 + 40, by1 - by0 + 30];
    /* ---- everyone else: one branch per kind of relationship, split by group ---- */
    var inTree = function (p) { return TY ? (TY.used[p.id] || p.rel === "Family" || (p.kinRole && p.kinRole !== "ex")) : fam.indexOf(p) >= 0; };
    var others = all.filter(function (p) { return !inTree(p) && !isEx(p); }), kinds = {}, order = ["Friend", "Colleague", "Mentor", "Other"];
    others.forEach(function (p) { var k = p.rel || "Other"; (kinds[k] = kinds[k] || []).push(p); });
    Object.keys(kinds).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    order = order.filter(function (k) { return kinds[k]; });
    if (order.length) {
      var BW = BPER * BCW, GAP = 64, tot = order.length * BW + (order.length - 1) * GAP, ty = bottom + (fam.length ? 70 : 60), xs = order.map(function (k, i) { return -tot / 2 + i * (BW + GAP) + BW / 2; });
      text(0, ty - 8, "Around you: not family, so not part of the tree", "thint", "middle");
      order.forEach(function (k, i) {
        var cx = xs[i], left = cx - BW / 2, y = ty + 44, groups = {}, spine = left - 14;
        text(cx, ty + 38, (PLURAL[k] || k) + " · " + kinds[k].length, "tbr", "middle");
        kinds[k].forEach(function (p) { (groups[p.group || ""] = groups[p.group || ""] || []).push(p); });
        var names = Object.keys(groups).sort(function (a, b) { return !a ? 1 : !b ? -1 : groups[b].length - groups[a].length || (a < b ? -1 : 1); }), lastY = y;
        names.forEach(function (g) {
          y += 30; lastY = y - 4;
          line("M" + f(spine) + "," + f(lastY) + "H" + f(left - 3));
          if (g && M.colors[g]) texts += '<circle class="tsw" cx="' + f(left + 5) + '" cy="' + f(y - 4) + '" r="4.5" style="fill:' + esc(M.colors[g]) + '"/>';
          text(left + (g && M.colors[g] ? 16 : 0), y, (g || "No group") + " · " + groups[g].length, "tgrp");
          groups[g].sort(function (a, b) { return a.circle - b.circle || byName(a, b); }).forEach(function (p, j) { put(p, left + BCW / 2 + (j % BPER) * BCW, y + 30 + Math.floor(j / BPER) * BCH, SR, ""); });
          y += 30 + Math.ceil(groups[g].length / BPER) * BCH - 22;
        });
        line("M" + f(spine) + "," + f(ty + 52) + "V" + f(lastY), "dash");
      });
    }
    if (!fam.length) focus = null;
    svg._vb = [bx0 - 30, by0 - 20, bx1 - bx0 + 60, by1 - by0 + 50]; svg._focus = focus;
    svg.innerHTML = '<g class="tlines">' + lines + '</g><g id="links"></g>' + texts + nodes;
    K.paint(svg, M, st);
  }
  window.PPPeopleTree = { draw: draw };
})();
