/* People page: the Tree view. A family tree around you (grandparents, parents, aunts and uncles,
   siblings, cousins, children), relatives whose place is not known yet, and below that one branch
   per kind of relationship (friends, colleagues, ...) split by group. Family roles come from each
   person's kinRole / kinSide, set in the person panel. Returns nothing; draws into the SVG and
   leaves the full box in svg._vb and the family part in svg._focus for the zoom code in people.js. */
(function () {
  "use strict";
  var C = window.PPPeopleCore, K = window.PPPeopleSky, esc = K.esc, KIN = C.KIN, SIDED = C.KIN_SIDED;
  var CW = 88, H = 138, R = 17, SR = 12, SUB = 96, BCW = 66, BCH = 70, PER = 5, BPER = 4;
  var PLURAL = { Friend: "Friends", Colleague: "Colleagues", Mentor: "Mentors", Other: "Others", Family: "Family", Partner: "Partners" };
  function byName(a, b) { return a.name < b.name ? -1 : 1; }

  function draw(svg, M, st) {
    var nodes = "", lines = "", texts = "", bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9, f = function (n) { return n.toFixed(1); };
    function grow(x, y, pad) { bx0 = Math.min(bx0, x - pad); bx1 = Math.max(bx1, x + pad); by0 = Math.min(by0, y - pad); by1 = Math.max(by1, y + pad + 16); }
    function line(d, cls) { lines += '<path class="tl' + (cls ? " " + cls : "") + '" d="' + d + '"/>'; }
    function text(x, y, t, cls, anchor) { texts += '<text class="' + cls + '" x="' + f(x) + '" y="' + f(y) + '"' + (anchor ? ' text-anchor="' + anchor + '"' : "") + ">" + esc(t) + "</text>"; grow(x, y, 30); }
    function put(p, x, y, r, cap) {
      p.x = x; p.y = y; p.r = r; grow(x, y, r + 34);
      var lab = p.first.length > 12 ? p.first.slice(0, 11) + "…" : p.first;
      nodes += '<g class="nd tr' + (p.color ? ' gc" style="--gc:' + esc(p.color) : "") + (p.off ? " quiet" : "") + '" data-id="' + p.id + '" tabindex="0" role="button" aria-label="' + esc(p.name + (cap ? ", " + cap : "") + (p.group ? ", " + p.group : "")) + '" transform="translate(' + f(x) + "," + f(y) + ')"><title>' + esc(p.name) + "</title>" +
        '<circle r="' + (r + 7) + '" fill="transparent"/><circle class="disc" r="' + r + '"/><text class="ini" style="font-size:' + f(r * .8) + 'px">' + esc(p.ini) + "</text>" +
        (p.threads.length ? '<circle class="dot" cx="' + f(r * .74) + '" cy="' + f(-r * .74) + '" r="' + f(Math.max(3.2, r * .3)) + '"/>' : "") +
        '<text class="nm" style="font-size:calc(' + (r > 14 ? 12 : 10.5) + 'px*var(--iz,1))" y="' + (r + 14) + '">' + esc(lab) + "</text>" + (cap ? '<text class="cap" y="' + (r + 27) + '">' + esc(cap) + "</text>" : "") + "</g>";
    }
    /* a bar above a row of siblings with a drop to each; xs are the node centres, y the row */
    function bar(xs, y, r) { if (!xs.length) return y; var yb = y - r - 20, a = Math.min.apply(0, xs), b = Math.max.apply(0, xs); if (b > a) line("M" + f(a) + "," + f(yb) + "H" + f(b)); xs.forEach(function (x) { line("M" + f(x) + "," + f(yb) + "V" + f(y - r - 3)); }); return yb; }

    var all = M.P.filter(function (p) { return !p.archived; });
    all.forEach(function (p) { p.x = null; });
    var role = function (p) { return p.kinRole || (p.rel === "Partner" ? "partner" : ""); };
    var fam = all.filter(function (p) { return role(p) || p.rel === "Family"; }), placed = {};
    var pick = function (roles, side) { return fam.filter(function (p) { return roles.indexOf(role(p)) >= 0 && (!side || p.kinSide === side); }).sort(byName); };
    var cap = function (p) { return KIN[role(p)] || ""; }, mark = function (arr) { arr.forEach(function (p) { placed[p.id] = 1; }); return arr; };

    /* ---- you, siblings, partner ---- */
    var sib = mark(pick(["brother", "sister"])), partners = mark(pick(["partner"])), m = sib.length + 1, xAt = function (i) { return (i - (m - 1) / 2) * CW; }, meX = xAt(sib.length);
    sib.forEach(function (p, i) { put(p, xAt(i), 0, R, cap(p)); });
    partners.forEach(function (p, i) { put(p, meX + (i + 1) * CW, 0, R, cap(p)); line("M" + f(meX + (i ? i * CW + R : 23)) + ",0H" + f(meX + (i + 1) * CW - R - 2), "pair"); });
    grow(meX, 0, 50);
    var coreL = xAt(0), coreR = meX + partners.length * CW;
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
    var bottom = R + 40;
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
        co.forEach(function (p, i) { put(p, x0 + dir * (i % PER) * CW, Math.floor(i / PER) * SUB, R, cap(p)); });
        var ybc = bar(co.slice(0, PER).map(function (p) { return p.x; }), 0, R);
        if (au.length) line("M" + f(x0) + "," + f(-H + R + 31) + "V" + f(ybc));
        else if (px != null) line("M" + f(x0) + "," + f(ybc) + "V" + f(-H) + "H" + f(px + dir * (R + 2)), "dash");
        bottom = Math.max(bottom, (Math.ceil(co.length / PER) - 1) * SUB + R + 40);
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
    var focus = [bx0 - 20, by0 - 10, bx1 - bx0 + 40, by1 - by0 + 30];
    /* ---- everyone else: one branch per kind of relationship, split by group ---- */
    var others = all.filter(function (p) { return fam.indexOf(p) < 0; }), kinds = {}, order = ["Friend", "Colleague", "Mentor", "Other"];
    others.forEach(function (p) { var k = p.rel || "Other"; (kinds[k] = kinds[k] || []).push(p); });
    Object.keys(kinds).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    order = order.filter(function (k) { return kinds[k]; });
    if (order.length) {
      var BW = BPER * BCW, GAP = 64, tot = order.length * BW + (order.length - 1) * GAP, ty = bottom + (fam.length ? 70 : 60), xs = order.map(function (k, i) { return -tot / 2 + i * (BW + GAP) + BW / 2; });
      line("M0," + f(fam.length ? ty - 34 : R + 10) + "V" + f(ty)); if (xs.length > 1) line("M" + f(xs[0]) + "," + f(ty) + "H" + f(xs[xs.length - 1]));
      order.forEach(function (k, i) {
        var cx = xs[i], left = cx - BW / 2, y = ty + 44, groups = {}, spine = left - 14;
        line("M" + f(cx) + "," + f(ty) + "V" + f(ty + 20));
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
        line("M" + f(spine) + "," + f(ty + 46) + "V" + f(lastY)); line("M" + f(spine) + "," + f(ty + 46) + "H" + f(cx - 4) + "V" + f(ty + 44), "");
      });
    }
    if (!fam.length) focus = null;
    svg._vb = [bx0 - 30, by0 - 20, bx1 - bx0 + 60, by1 - by0 + 50]; svg._focus = focus;
    svg.innerHTML = '<g class="tlines">' + lines + '</g><g id="links"></g>' + texts + nodes;
    K.paint(svg, M, st);
  }
  window.PPPeopleTree = { draw: draw };
})();
