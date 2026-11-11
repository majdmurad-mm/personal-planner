/* Command Center, Horizon as "the Terrain": the coming months as a landscape of load. One lane per area
   colour, height = booked hours that week, a grey ridge at the back for the total with the sustainable-week
   ceiling over it, pins for deadlines, ribbons for goals, a glass plane for today. three.js is loaded only
   when this view opens; rendering happens on demand. The 2D roadmap stays the accessible fallback. */
(function () {
  var T = window.PPTerrain = {}, THREE = null, loading = null;
  T.load = function () { if (!loading) { loading = import("https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js").then(function (m) { THREE = m; return m; }); loading.catch(function () { loading = null; }); } return loading; };
  var HS = 0.085, LW = 1.15, LG = 1.55, SUB = 6;

  /* data: { weeks:[iso monday], today:index, lanes:[{key,name,hours:[]}], total:[], ceiling, deadlines:[{lane,week,title,date}], goals:[{lane,from,to,title,progress}] } */
  T.mount = function (el, data, opts) {
    opts = opts || {};
    var css = getComputedStyle(opts.themeEl || el), col = function (n, d) { var v = css.getPropertyValue(n).trim(); return v || d; };
    var BG = col("--bg", "#1A1816"), TXT = col("--text", "#EEE7DB"), LINE = col("--line", "#37322D"), MUTED = col("--muted", "#A69D8F"), CARD = col("--card", "#23201D");
    var lanesD = data.lanes.concat([{ key: "total", name: "All areas", hours: data.total, color: MUTED }]), NL = lanesD.length, WEEKS = data.weeks.length, TODAY = data.today;
    lanesD.forEach(function (l) { if (!l.color) l.color = col("--area-" + l.key, "#888"); });
    var laneZ = function (i) { return (i - (NL - 1) / 2) * -LG; };       // work in front, total at the back
    var hAt = function (li, x) { var H = lanesD[li].hours, a = Math.max(0, Math.min(WEEKS - 1, Math.floor(x))), b = Math.min(WEEKS - 1, a + 1), t = (1 - Math.cos(Math.max(0, Math.min(1, x - a)) * Math.PI)) / 2; return H[a] * (1 - t) + H[b] * t; };
    var wdate = function (w) { return new Date(data.weeks[w] + "T12:00:00"); }, wlabel = function (w) { return "week of " + wdate(w).toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
    el.innerHTML = '<div class="tr-tip" hidden></div><div class="tr-labels"></div><p class="tr-fps mono"></p>'; el.classList.add("tr-on");
    var W = function () { return el.clientWidth || 800; }, Hh = function () { return el.clientHeight || 500; }, small = W() < 700;
    var renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2)); renderer.setSize(W(), Hh()); renderer.setClearColor(new THREE.Color(BG)); el.insertBefore(renderer.domElement, el.firstChild);
    var scene = new THREE.Scene(); scene.fog = new THREE.Fog(new THREE.Color(BG), 32, 78);
    var cam = new THREE.PerspectiveCamera(38, W() / Hh(), 0.1, 200);
    scene.add(new THREE.AmbientLight(0xffffff, 0.8)); var sun = new THREE.DirectionalLight(0xfff2dd, 1.5); sun.position.set(-8, 14, 10); scene.add(sun);
    var labelBox = el.querySelector(".tr-labels"), labels = [];
    var label = function (text, cls, color, x, y, z) { var d = document.createElement("div"); d.className = "tr-lb " + cls; d.textContent = text; if (color) d.style.setProperty("--c", color); labelBox.appendChild(d); var o = { el: d, p: new THREE.Vector3(x, y, z), on: true }; labels.push(o); return o; };
    var basic = function (c, o) { return new THREE.MeshBasicMaterial(Object.assign({ color: new THREE.Color(c) }, o || {})); };
    /* ground, week lines, month names */
    var depth = LG * NL + 2.4, ground = new THREE.Mesh(new THREE.PlaneGeometry(WEEKS + 6, depth + 1.6), basic(CARD)); ground.rotation.x = -Math.PI / 2; ground.position.set(WEEKS / 2 - 0.5, -0.01, 0); scene.add(ground);
    var gl = []; for (var w = 0; w <= WEEKS; w++) gl.push(w - 0.5, 0, -depth / 2, w - 0.5, 0, depth / 2);
    scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(gl, 3)), new THREE.LineBasicMaterial({ color: new THREE.Color(LINE) })));
    var lastM = -1; for (w = 0; w < WEEKS; w++) { var dm = wdate(w); if (dm.getMonth() !== lastM) { lastM = dm.getMonth(); label(dm.toLocaleDateString("en-GB", { month: "short" }).toUpperCase(), "mono", null, w, 0, depth / 2 + 0.5); } }
    /* one ridge per lane; past weeks desaturated */
    var grey = new THREE.Color(MUTED), only = opts.only || null;
    var meshes = lanesD.map(function (l, li) {
      var n = WEEKS * SUB - SUB + 1, pos = [], colr = [], idx = [], c = new THREE.Color(l.color), z0 = laneZ(li) - LW / 2, z1 = laneZ(li) + LW / 2, hs = [], ref = l.key === "total" ? 60 : 40;
      for (var i = 0; i < n; i++) {
        var x = i / SUB, h = hAt(li, x) * HS * (l.key === "total" ? 0.8 : 1); hs.push(h);
        var k = c.clone().lerp(grey, x < TODAY ? 0.6 : 0), top = k.clone().multiplyScalar(0.5 + Math.min(1, h / (ref * HS)) * 0.65), wall = k.clone().multiplyScalar(0.34);
        pos.push(x, h, z0, x, h, z1, x, 0, z1, x, 0, z0); [top, top, wall, wall].forEach(function (q) { colr.push(q.r, q.g, q.b); });
        if (i) { var a = (i - 1) * 4, b = i * 4; idx.push(a, a + 1, b + 1, a, b + 1, b, a + 1, a + 2, b + 2, a + 1, b + 2, b + 1, a + 3, a, b, a + 3, b, b + 3); }
      }
      var g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(colr, 3)); g.setIndex(idx); g.computeVertexNormals();
      var m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0, side: THREE.DoubleSide })); m.userData = { li: li, hs: hs }; m.visible = !only || l.key === only || l.key === "total"; scene.add(m);
      var lb = label(l.name, "lane", l.color, -1.7, 0.1, laneZ(li)); lb.lane = li; return m;
    });
    var TL = NL - 1, ceilY = data.ceiling * HS * 0.8;
    var ceil = new THREE.Mesh(new THREE.PlaneGeometry(WEEKS, LW + 0.5), basic(TXT, { transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false })); ceil.rotation.x = -Math.PI / 2; ceil.position.set(WEEKS / 2 - 0.5, ceilY, laneZ(TL)); scene.add(ceil);
    var ceilL = label("sustainable week · " + data.ceiling + " h", "mono", null, WEEKS - 2, ceilY + 0.2, laneZ(TL));
    var glass = new THREE.Mesh(new THREE.PlaneGeometry(depth, 5.6), basic(TXT, { transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false })); glass.rotation.y = Math.PI / 2; glass.position.set(TODAY, 2.8, 0); scene.add(glass);
    var todayL = label("TODAY", "mono today", null, TODAY, 5.9, 0);
    var laneIdx = function (key) { for (var i = 0; i < lanesD.length; i++) if (lanesD[i].key === key) return i; return -1; };
    var pins = data.deadlines.map(function (d) { var li = laneIdx(d.lane); if (li < 0) return null; var c = lanesD[li].color, g = new THREE.Group(), top = hAt(li, d.week) * HS + 1.4;
      var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1, 6), basic(c)), head = new THREE.Mesh(new THREE.OctahedronGeometry(0.14), basic(c)); g.add(stem, head); g.position.set(d.week, 0, laneZ(li)); g.visible = meshes[li].visible; scene.add(g);
      return { g: g, li: li, top: top, stem: stem, head: head, lb: label("◆ " + d.title + " · " + new Date(d.date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }), "pin", c, d.week, top + 0.3, laneZ(li)) }; }).filter(Boolean);
    var goals = data.goals.map(function (g) { var li = laneIdx(g.lane); if (li < 0 || g.to <= g.from) return null; var c = new THREE.Color(lanesD[li].color), m = new THREE.Mesh(new THREE.BoxGeometry(g.to - g.from, 0.05, 0.16), new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(0.35 + g.progress * 0.75) })); m.position.set((g.from + g.to) / 2, 0.04, laneZ(li) + LW / 2 + 0.16); m.visible = meshes[li].visible; scene.add(m);
      return { m: m, li: li, lb: label(g.title + " · " + Math.round(g.progress * 100) + "%", "goal", lanesD[li].color, g.from + 1.4, 0.3, laneZ(li) + LW / 2 + 0.3) }; }).filter(Boolean);
    var slab = new THREE.Mesh(new THREE.BoxGeometry(1, 1, LW + 0.06), basic("#ffffff", { transparent: true, opacity: 0.18, depthWrite: false })); slab.visible = false; scene.add(slab);

    var S = { az: -0.42, pol: 1.02, dist: small ? 30 : 23, tx: Math.min(WEEKS - 6, TODAY + 8), flat: 0, flatT: 0 }, dirty = true, dead = false, v3 = new THREE.Vector3();
    function place() { var pol = S.pol * (1 - S.flat) + 0.02 * S.flat, az = S.az * (1 - S.flat), dist = S.dist + S.flat * 10, tx = S.tx * (1 - S.flat) + (WEEKS / 2 - 0.5) * S.flat; cam.position.set(tx + dist * Math.sin(pol) * Math.sin(az), dist * Math.cos(pol), dist * Math.sin(pol) * Math.cos(az)); cam.up.set(0, S.flat > 0.98 ? 0 : 1, S.flat > 0.98 ? -1 : 0); cam.lookAt(tx, 1.2 * (1 - S.flat), 0); }
    function shape() { var k = 1 - S.flat * 0.985;
      meshes.forEach(function (m) { var p = m.geometry.attributes.position, hs = m.userData.hs; for (var i = 0; i < hs.length; i++) { p.setY(i * 4, hs[i] * k); p.setY(i * 4 + 1, hs[i] * k); } p.needsUpdate = true; m.geometry.computeVertexNormals(); });
      pins.forEach(function (u) { var t = Math.max(0.5, u.top * k); u.stem.scale.y = t; u.stem.position.y = t / 2; u.head.position.y = t; u.lb.p.y = t + 0.3; u.lb.on = u.g.visible; });
      goals.forEach(function (g) { g.lb.on = g.m.visible; }); labels.forEach(function (l) { if (l.lane != null) l.on = meshes[l.lane].visible; });
      ceil.visible = S.flat < 0.5; ceilL.on = ceil.visible; glass.scale.y = Math.max(0.05, k); glass.position.y = 2.8 * Math.max(0.05, k); todayL.p.y = 5.9 * k + 0.2; }
    function drawLabels() { var w = W(), h = Hh(); labels.forEach(function (l) { v3.copy(l.p).project(cam); var vis = l.on && v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1; l.el.style.display = vis ? "" : "none"; if (vis) l.el.style.transform = "translate(-50%,-50%) translate(" + ((v3.x + 1) / 2 * w).toFixed(1) + "px," + ((1 - v3.y) / 2 * h).toFixed(1) + "px)"; }); }
    var frames = 0, t0 = performance.now(), fps = 0, guard = opts.noGuard ? null : { n: 0, t: 0, last: 0 }, intro = 1;
    function loop(t) {
      if (dead) return; requestAnimationFrame(loop); if (document.hidden || !el.isConnected) return;
      if (intro > 0) { intro = Math.max(0, intro - 0.016); S.az = -0.42 - intro * 0.35; S.pol = 1.02 - intro * 0.25; dirty = true; if (guard) { if (guard.last) { guard.t += t - guard.last; guard.n++; } guard.last = t; if (intro === 0 && guard.n > 20) { var f = 1000 / (guard.t / guard.n); if (f < 22 && opts.onSlow) { opts.onSlow(Math.round(f)); return; } guard = null; } } }
      if (S.flat !== S.flatT) { S.flat += Math.sign(S.flatT - S.flat) * Math.min(0.04, Math.abs(S.flatT - S.flat)); shape(); dirty = true; if (S.flat === 1 && opts.onFlat) { opts.onFlat(); return; } }
      if (!dirty) return; dirty = false; place(); renderer.render(scene, cam); drawLabels();
      frames++; if (t - t0 > 600) { fps = Math.round(frames * 1000 / (t - t0)); frames = 0; t0 = t; }
    }
    shape(); requestAnimationFrame(loop);
    var cv = renderer.domElement, ray = new THREE.Raycaster(), tip = el.querySelector(".tr-tip"), drag = null, moved = false, hover = null, need = function () { dirty = true; };
    var pick = function (e) { var r = cv.getBoundingClientRect(); ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cam); return ray.intersectObjects(meshes.filter(function (m) { return m.visible; }))[0]; };
    cv.addEventListener("pointerdown", function (e) { drag = { x: e.clientX, y: e.clientY, az: S.az, pol: S.pol, tx: S.tx }; moved = false; intro = 0; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener("pointermove", function (e) {
      if (drag) { var dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) moved = true; if (e.shiftKey || e.pointerType === "touch" && Math.abs(dx) > Math.abs(dy) * 2) S.tx = Math.max(4, Math.min(WEEKS - 4, drag.tx - dx * 0.03)); else { S.az = Math.max(-0.95, Math.min(0.95, drag.az - dx * 0.005)); S.pol = Math.max(0.45, Math.min(1.3, drag.pol - dy * 0.004)); } tip.hidden = true; need(); return; }
      var hit = pick(e); if (!hit) { hover = null; slab.visible = false; tip.hidden = true; need(); return; }
      var li = hit.object.userData.li, wk = Math.max(0, Math.min(WEEKS - 1, Math.round(hit.point.x))), l = lanesD[li], h = l.hours[wk]; hover = { li: li, w: wk };
      slab.visible = true; slab.scale.y = Math.max(0.08, h * HS * (l.key === "total" ? 0.8 : 1) + 0.06); slab.position.set(wk, slab.scale.y / 2, laneZ(li));
      var dl = data.deadlines.filter(function (x) { return Math.round(x.week) === wk && (l.key === "total" || x.lane === l.key); }).map(function (x) { return "◆ " + x.title; }).join(", "), tot = data.total[wk], r = el.getBoundingClientRect();
      tip.innerHTML = ""; var b = document.createElement("b"); b.style.color = l.color; b.textContent = l.name + " · " + wlabel(wk); tip.appendChild(b);
      tip.appendChild(document.createTextNode((Math.round(h * 10) / 10) + " h " + (wk < TODAY ? "done or booked" : "booked"))); var sm = document.createElement("small"); sm.textContent = "all areas " + Math.round(tot) + " h" + (tot > data.ceiling ? " · above your sustainable week" : "") + (dl ? " · " + dl : ""); tip.appendChild(sm);
      tip.hidden = false; tip.style.left = Math.min(r.width - 250, e.clientX - r.left + 14) + "px"; tip.style.top = Math.min(r.height - 90, e.clientY - r.top + 14) + "px"; need();
    });
    cv.addEventListener("pointerup", function () { if (!moved && hover && opts.onWeek) opts.onWeek(data.weeks[hover.w], lanesD[hover.li].key); drag = null; });
    cv.addEventListener("pointerleave", function () { tip.hidden = true; slab.visible = false; need(); });
    cv.addEventListener("wheel", function (e) { e.preventDefault(); intro = 0; S.tx = Math.max(4, Math.min(WEEKS - 4, S.tx + (e.deltaY + e.deltaX) * 0.008)); need(); }, { passive: false });
    var ro = window.ResizeObserver ? new ResizeObserver(function () { if (dead) return; cam.aspect = W() / Hh(); cam.updateProjectionMatrix(); renderer.setSize(W(), Hh()); need(); }) : null; if (ro) ro.observe(el);
    return {
      flatten: function () { S.flatT = 1; intro = 0; tip.hidden = true; slab.visible = false; }, fps: function () { return fps; }, state: S, need: need,
      destroy: function () { dead = true; if (ro) ro.disconnect(); renderer.dispose(); scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); el.classList.remove("tr-on"); el.innerHTML = ""; }
    };
  };
})();
