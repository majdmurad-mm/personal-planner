/* Knowledge page logic with no DOM: zones and types, sorting a new file by rules, topics, links
   between items, the graph layout and a local search. Runs in the page (window.PPKnowledgeCore)
   and in node for tests. Nothing here talks to a server or an AI service. */
(function (root) {
  var K = {};
  K.ZONES = [["documents", "Personal documents"], ["library", "Library"], ["web", "Web & media"], ["ideas", "Ideas"], ["thinkers", "People of thought"], ["mine", "My constellation"]];
  K.TYPES = {
    documents: [["id", "ID or residence paper"], ["contract", "Contract"], ["letter", "Letter from an authority"], ["insurance", "Insurance"], ["certificate", "Certificate or diploma"], ["payslip", "Payslip"], ["tax", "Tax paper"], ["invoice", "Invoice"], ["document", "Other document"]],
    library: [["book", "Book"], ["paper", "Paper"], ["report", "Report"], ["manual", "Manual"]],
    web: [["link", "Link"], ["article", "Article"], ["website", "Website"], ["video", "Video"], ["tool", "Tool"]],
    ideas: [["idea", "Idea"], ["concept", "Product concept"], ["question", "Question"], ["quote", "Quote"]],
    thinkers: [["author", "Author or creator"]],
    mine: [["note", "My note"], ["reference", "Reference note"], ["decision", "Decision note"]]
  };
  // The owner's own zones (for OneDrive sources such as "Work"): listed after the built-in ones, one generic type.
  K.CUSTOM_COLORS = [["#4E6A3C", "#A9C98F"], ["#8A3B53", "#E39AB1"], ["#2F6B6B", "#86CACA"], ["#6B5A2F", "#D9C48A"], ["#4A4F86", "#A7ACE8"]];
  K.addZone = function (id, label) {
    if (!id || K.ZONES.some(function (z) { return z[0] === id; })) return;
    K.ZONES.push([id, label || id]); K.TYPES[id] = [["file", "File"], ["document", "Document"]];
  };
  K.isCustomZone = function (z) { return ["documents", "library", "web", "ideas", "thinkers", "mine"].indexOf(z) < 0; };
  K.zoneName = function (z) { var h = K.ZONES.filter(function (x) { return x[0] === z; })[0]; return h ? h[1] : z; };
  K.typeName = function (z, t) { var h = (K.TYPES[z] || []).filter(function (x) { return x[0] === t; })[0]; return h ? h[1] : t; };
  K.zoneOfType = function (t) { for (var z in K.TYPES) if (K.TYPES[z].some(function (x) { return x[0] === t; })) return z; return "documents"; };
  // the drawn shape of a node; type is also always written out as text
  K.shapeOf = function (zone) { return { documents: "doc", library: "book", web: "link", ideas: "idea", thinkers: "person", mine: "note" }[zone] || "doc"; };

  /* ---------- sorting a new file (rules only, German and English) ---------- */
  var RULES = [
    ["contract", /mietvertrag|untermietvertrag|arbeitsvertrag|vertrag zwischen|rental (contract|agreement)|tenancy agreement|sublet|sublease|lease agreement|employment contract|hereinafter|vertragspartei|vermieter|mieter\b/gi, 3],
    ["payslip", /gehaltsabrechnung|entgeltabrechnung|lohnabrechnung|verdienstabrechnung|payslip|pay slip|brutto.{0,40}netto|gross pay|net pay/gi, 4],
    ["tax", /steuerbescheid|einkommensteuer|finanzamt|steuer-?id|lohnsteuerbescheinigung|tax (assessment|return|office)|steuererkl[aä]rung/gi, 3],
    ["insurance", /versicherung(sschein|snummer|snehmer)?|haftpflicht|police\b|insurance (policy|certificate)|insured person|krankenkasse/gi, 3],
    ["id", /aufenthaltstitel|aufenthaltserlaubnis|reisepass|personalausweis|residence permit|passport|meldebescheinigung|anmeldung|identity card/gi, 4],
    ["certificate", /zeugnis|urkunde|diplom\b|bescheinigung|certificate|diploma|transcript of records|hereby certif/gi, 2],
    ["invoice", /rechnung(snummer)?|invoice( number| no)?|zahlungsziel|umsatzsteuer|\bvat\b|total due|betrag f[aä]llig/gi, 3],
    ["letter", /sehr geehrte|bescheid\b|aktenzeichen|ihr zeichen|amt f[uü]r|b[uü]rgeramt|jobcenter|ausl[aä]nderbeh[oö]rde|dear (sir|madam|mr|ms)|reference number|within the period/gi, 2],
    ["paper", /\babstract\b|keywords:|doi:|et al\.|references\n|introduction\n|zusammenfassung\n/gi, 3],
    ["manual", /user (guide|manual)|handbuch|bedienungsanleitung|installation|troubleshooting|getting started/gi, 2],
    ["report", /annual report|jahresbericht|executive summary|\breport\b|bericht\b|findings/gi, 1],
    ["book", /\bisbn\b|chapter \d|kapitel \d|table of contents|inhaltsverzeichnis|all rights reserved|copyright ©|verlag\b/gi, 2]
  ];
  var count = function (re, s) { re.lastIndex = 0; var m = s.match(re); return m ? m.length : 0; };
  K.language = function (text) {
    var s = " " + String(text || "").toLowerCase().slice(0, 6000) + " ", de = count(/ (der|die|das|und|ist|nicht|mit|f[uü]r|wird|oder|eine[rn]?|den|dem|sich|auch|zum|zur)(?= )/g, s), en = count(/ (the|and|is|of|to|with|for|that|this|are|was|not|from|by|or)(?= )/g, s);
    return de + en < 4 ? "" : de > en ? "de" : "en";
  };
  K.sentences = function (text, n) {
    var s = String(text || "").replace(/\s+/g, " ").trim(), out = [], re = /[^.!?]{25,400}?[.!?](?=\s|$)/g, m;
    while ((m = re.exec(s)) && out.length < (n || 3)) { var t = m[0].trim(); if (!/^\d|seite \d|page \d/i.test(t)) out.push(t); }
    return out.join(" ") || s.slice(0, 280);
  };
  K.meta = function (text) {
    var s = String(text || ""), m = {}, d, x;
    var dates = []; var re = /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/g;
    while ((d = re.exec(s)) && dates.length < 8) { var iso = d[4] ? d[4] + "-" + d[5] + "-" + d[6] : d[3] + "-" + ("0" + d[2]).slice(-2) + "-" + ("0" + d[1]).slice(-2); if (+iso.slice(5, 7) <= 12 && +iso.slice(8) <= 31 && dates.indexOf(iso) < 0) dates.push(iso); }
    if (dates.length) m.dates = dates;
    if ((x = /k[uü]ndigungsfrist[^.\n]{0,80}?(\d+|ein|eine|zwei|drei|vier|sechs)\s*(monat|woche|tag)[a-z]*/i.exec(s))) m.notice = x[1] + " " + x[2].toLowerCase() + (x[2].length ? "" : "");
    else if ((x = /notice period[^.\n]{0,60}?(\d+|one|two|three|four|six)\s*(month|week|day)s?/i.exec(s))) m.notice = x[1] + " " + x[2].toLowerCase() + "s";
    if ((x = /(?:mietbeginn|beginnt am|beginn des mietverh[aä]ltnisses|commenc\w+ on|starts on|start date)[^\d\n]{0,30}(\d{1,2}\.\s?\d{1,2}\.\s?\d{4}|\d{4}-\d{2}-\d{2})/i.exec(s))) m.starts = x[1];
    if ((x = /(?:befristet bis|g[uü]ltig bis|valid until|expires? on|ablaufdatum)[^\d\n]{0,30}(\d{1,2}\.\s?\d{1,2}\.\s?\d{4}|\d{4}-\d{2}-\d{2})/i.exec(s))) m.expires = x[1];
    if ((x = /isbn(?:-1[03])?:?\s*([\d][\d\- ]{8,16}[\dxX])/i.exec(s))) m.isbn = x[1].replace(/[\s]/g, "");
    var org = [], ro = /\b([A-ZÄÖÜ][\wÄÖÜäöüß&.\- ]{2,40}?\s(?:GmbH|AG|KG|e\.V\.|Ltd|Inc|LLC|UG))\b/g;
    while ((d = ro.exec(s)) && org.length < 4) { var o = d[1].trim().replace(/^((vermieter|mieter|firma|der|die|das|zwischen|und|von|landlord|tenant|the|between|and|company)\s+)+/i, ""); if (o && org.indexOf(o) < 0) org.push(o); }
    if (org.length) m.named = org;
    return m;
  };
  K.titleFrom = function (name, text) {
    var base = String(name || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
    var first = String(text || "").split(/\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 5 && l.length < 90 && /[A-Za-zÄÖÜäöü]{3}/.test(l); })[0];
    if (base && !/^(scan|img|image|doc|document|dokument|file|untitled|\d+)[ \d]*$/i.test(base)) return base.charAt(0).toUpperCase() + base.slice(1);
    return first || base || "Untitled";
  };
  // -> { zone, type, confidence 0..1, needsSort, lang, meta, title, summary }
  K.classify = function (f) {
    var text = String(f.text || ""), name = String(f.name || ""), hay = name.replace(/[_\-.]/g, " ") + "\n" + text.slice(0, 20000), scores = [], ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    RULES.forEach(function (r) { var c = count(r[1], hay); if (c) scores.push([r[0], Math.min(c, 6) * r[2]]); });
    if (/^epub$/i.test(ext)) scores.push(["book", 9]);
    scores.sort(function (a, b) { return b[1] - a[1]; });
    var top = scores[0], second = scores[1], type = top ? top[0] : (text.length > 60000 ? "book" : "document"), conf = !top ? 0.2 : Math.min(0.97, 0.45 + top[1] / 24 + (second ? (top[1] - second[1]) / 30 : 0.15));
    if (text.replace(/\s/g, "").length < 40) conf = Math.min(conf, 0.25);
    var meta = K.meta(text), lang = K.language(text); if (lang) meta.language = lang;
    return { zone: K.zoneOfType(type), type: type, confidence: +conf.toFixed(2), needsSort: conf < 0.55, lang: lang, meta: meta, title: K.titleFrom(name, text), summary: K.sentences(text, 3) };
  };

  /* ---------- life areas (the planner's colour code): from the owner's choice, else the name and the folders ---------- */
  K.AREAS = [["task", "Tasks & money"], ["work", "Work"], ["health", "Health"], ["growth", "Growth & knowledge"], ["people", "People"], ["sol", "Sol"], ["none", "No area"]];
  K.areaName = function (a) { var h = K.AREAS.filter(function (x) { return x[0] === a; })[0]; return h ? h[1] : "No area"; };
  var AREA_RULES = [
    ["health", /health|gesund|[aä]rzt|aerzt|klinik|krankenhaus|praxis|befund|impf|vaccin|rezept|therap|medical|medizin|diagnos|sleep|nutrition|fitness|workout/i],
    ["work", /arbeitsvertrag|arbeitszeugnis|arbeitgeber|employer|employment|onboarding|lebenslauf|\bcv\b|resume|job.?offer|offer.?letter|minijob|career|karriere|payslip|gehalt|lohnabrechnung|entgeltabrechnung|verdienst|arbeitsagentur|jobcenter|\bjob\b/i],
    ["task", /miet|wohnung|vermiet|nebenkosten|betriebskosten|umzug|selbstauskunft|schufa|k[uü]ndigung|rechnung|invoice|quittung|receipt|steuer|finanzamt|\btax\b|konto|ums[aä]tze|transactions|statement|\bbank|paypal|kredit|darlehen|bauspar|versicherung|insurance|krankenkasse|rundfunk|vertrag|contract|financ|finanz|depot|broker|wertpapier|aufenthalt|ausweis|passport|reisepass|anmeldung|meldebescheinigung|b[uü]rgeramt|ausl[aä]nderbeh/i],
    ["growth", /certificat|zertifikat|zeugnis|diplom|degree|kurs\b|course|sprachkurs|universit|studium|transcript/i],
    ["people", /\bmama\b|\bpapa\b|mutter|vater|familie|family|geburtstag|birthday|hochzeit|wedding/i]
  ];
  var TYPE_AREA = { payslip: "work", certificate: "growth", contract: "task", tax: "task", insurance: "task", invoice: "task", id: "task", letter: "task" };
  var TOPIC_AREA = { "Health": "health", "Tax & pay": "task", "Finance": "task", "Insurance": "task", "Housing & tenancy": "task", "Identity & residence": "task", "Education & certificates": "growth", "GIS & remote sensing": "growth", "Urban planning": "growth", "AI": "growth", "Software & tools": "growth" };
  var areaIn = function (s) { s = String(s || ""); for (var k = 0; k < AREA_RULES.length; k++) if (AREA_RULES[k][1].test(s)) return AREA_RULES[k][0]; return null; };
  // folders of an item, deepest first (the closest folder says the most)
  K.folders = function (it) {
    var p = it.onedrive && it.onedrive.path ? String(it.onedrive.path).split("/").slice(0, -1) : String((it.meta && it.meta.folder) || "").split(" / ");
    return p.map(function (x) { return x.trim(); }).filter(Boolean).reverse();
  };
  K.areaOf = function (it) {
    var own = it.meta && it.meta.area; if (own && K.AREAS.some(function (x) { return x[0] === own; })) return own;
    var a = areaIn(it.title); if (a) return a;
    var f = K.folders(it); for (var k = 0; k < f.length; k++) { a = areaIn(f[k]); if (a) return a; }
    if (TYPE_AREA[it.type]) return TYPE_AREA[it.type];
    if (TOPIC_AREA[it.topic]) return TOPIC_AREA[it.topic];
    return it.zone === "documents" || K.isCustomZone(it.zone) ? "none" : "growth";
  };
  // OneDrive: the first folder below the mapped folder is a cluster, the next one its sub-cluster
  K.folderLevels = function (it, sources) {
    if (!it.onedrive) { var mf = (it.meta && it.meta.folder) || "No folder"; return [mf, it.topic || "General"]; }
    var dirs = String(it.onedrive.path || "").split("/").filter(Boolean).slice(0, -1), src = (sources || []).filter(function (s) { return s.id === it.onedrive.sourceId; })[0];
    var base = src && src.path ? String(src.path).split("/").filter(Boolean) : [], n = 0;
    while (n < base.length && n < dirs.length && dirs[n].toLowerCase() === base[n].toLowerCase()) n++;
    if (!n && dirs.length > 1) n = 1;
    var root = (base[base.length - 1] || dirs[n - 1] || "OneDrive"), rest = dirs.slice(n);
    return [rest.length ? rest[0] : root + " (top level)", rest.length > 1 ? rest[1] : "in this folder"];
  };

  /* ---------- topics ---------- */
  var TOPICS = [
    ["Housing & tenancy", /miet|wohnung|vermieter|tenan|rent\b|rental|landlord|housing|flat\b|apartment|sublet|k[uü]ndigungsfrist|notice period/i],
    ["Tax & pay", /steuer|gehalt|lohn|payslip|salary|tax\b|income|finanzamt/i],
    ["Insurance", /versicherung|insurance|haftpflicht|krankenkasse/i],
    ["Identity & residence", /aufenthalt|passport|reisepass|ausweis|residence|visa|anmeldung|citizenship/i],
    ["Education & certificates", /zeugnis|diplom|certificate|degree|universit|transcript/i],
    ["GIS & remote sensing", /\bgis\b|remote sensing|satellit|fernerkundung|geodat|qgis|raster|vector tiles?|cartograph|kartograf|lidar|map(s|ping)?\b/i],
    ["Urban planning", /urban|stadtplanung|city|cities|st[aä]dte|mobility|public space|neighbou?rhood|street/i],
    ["AI", /\bai\b|\bki\b|machine learning|language model|neural|llm|embedding|retrieval/i],
    ["Finance", /finan|invest|budget|bank|loan|kredit|pension|rente\b/i],
    ["Health", /health|gesund|medical|arzt|training|sleep|nutrition/i],
    ["Software & tools", /software|code|program|developer|api\b|toolkit|open source|framework/i]
  ];
  K.topicOf = function (it) {
    if (it.zone === "thinkers") return "Authors"; if (it.zone === "mine") return "Notes to keep";
    var hay = [it.title, (it.tags || []).join(" "), it.summary, it.why].join(" \n ");
    for (var i = 0; i < TOPICS.length; i++) if (TOPICS[i][1].test(hay)) return TOPICS[i][0];
    return it.zone === "thinkers" ? "Authors" : it.zone === "mine" ? "Notes to keep" : "General";
  };
  K.tagsOf = function (it) { var out = []; TOPICS.forEach(function (t) { if (t[1].test([it.title, it.summary].join(" "))) out.push(t[0].toLowerCase().split(" & ")[0]); }); return out.slice(0, 3); };

  /* ---------- duplicates ---------- */
  K.normUrl = function (u) {
    var s = String(u || "").trim(); if (!s) return "";
    if (!/^[a-z]+:\/\//i.test(s)) s = "https://" + s;
    try { var x = new URL(s); x.hash = ""; ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach(function (p) { x.searchParams.delete(p); }); var out = x.protocol + "//" + x.hostname.replace(/^www\./, "").toLowerCase() + x.pathname.replace(/\/+$/, "") + (x.search || ""); return out; } catch (e) { return s; }
  };
  K.urlKey = function (u) { return K.normUrl(u).replace(/^[a-z]+:\/\//i, ""); };
  K.duplicateOf = function (items, cand) {
    var u = cand.url ? K.urlKey(cand.url) : "", t = String(cand.title || "").toLowerCase().trim();
    return items.filter(function (i) { return !i.archived && i.id !== cand.id && ((cand.fileHash && i.fileHash === cand.fileHash) || (u && K.urlKey(i.url) === u) || (!u && !cand.fileHash && t && i.zone === cand.zone && String(i.title).toLowerCase().trim() === t)); })[0] || null;
  };

  /* ---------- text into passages (kept with their page) ---------- */
  K.chunks = function (pages, size) {
    var out = []; size = size || 900;
    (pages || []).forEach(function (p) {
      var s = String(p.text || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(); if (!s) return;
      while (s.length) { var cut = s.length <= size ? s.length : Math.max(s.lastIndexOf(". ", size) + 1, s.lastIndexOf("\n", size), s.lastIndexOf(" ", size)); if (cut < size * 0.5) cut = Math.min(size, s.length); out.push({ page: p.page || null, content: s.slice(0, cut).trim() }); s = s.slice(cut).trim(); }
    });
    return out;
  };

  /* ---------- links between items ---------- */
  // explicit: [{from,to,kind}] stored links. Derived: same author, same named thing, a link that an item mentions.
  K.edges = function (items, explicit) {
    var out = [], seen = {}, live = items.filter(function (i) { return !i.archived; }), byId = {};
    live.forEach(function (i) { byId[i.id] = i; });
    var push = function (a, b, kind) { if (a === b || !byId[a] || !byId[b]) return; var k = [a, b].sort().join("|"); if (seen[k]) return; seen[k] = 1; out.push({ from: a, to: b, kind: kind }); };
    (explicit || []).forEach(function (e) { push(e.from, e.to, e.kind); });
    var authors = live.filter(function (i) { return i.zone === "thinkers"; });
    live.forEach(function (i) {
      var a = String((i.meta && i.meta.author) || "").toLowerCase();
      authors.forEach(function (p) { var n = String(p.title).toLowerCase(); if (i.id !== p.id && n.length > 3 && (a === n || (a && a.indexOf(n) >= 0) || ((p.meta && p.meta.works) || []).some(function (w) { return String(w).toLowerCase() === String(i.title).toLowerCase(); }))) push(i.id, p.id, "author"); });
    });
    for (var x = 0; x < live.length; x++) for (var y = x + 1; y < live.length; y++) {
      var A = live[x], B = live[y], na = (A.meta && A.meta.named) || [], nb = (B.meta && B.meta.named) || [];
      if (na.some(function (n) { return nb.indexOf(n) >= 0; })) push(A.id, B.id, "same name");
      var ea = (A.tags || []).filter(function (t) { return /^(flat|wohnung|project|case)\b/i.test(t); });
      if (ea.some(function (t) { return (B.tags || []).indexOf(t) >= 0; })) push(A.id, B.id, "same subject");
    }
    // a tag only a few items share links them; a tag on many items would just be noise
    var tagUse = {}; live.forEach(function (i) { (i.tags || []).forEach(function (t) { var k = String(t).toLowerCase(); (tagUse[k] = tagUse[k] || []).push(i.id); }); });
    Object.keys(tagUse).forEach(function (k) { var ids = tagUse[k]; if (ids.length < 2 || ids.length > 5) return; for (var a = 0; a < ids.length; a++) for (var b = a + 1; b < ids.length; b++) push(ids[a], ids[b], "same tag"); });
    return out;
  };
  K.EDGE_LABEL = { author: "author", cites: "cites", derived: "inspired by", "same name": "same name", "same subject": "same subject", same_entity: "same subject", "same tag": "same tag", related: "linked by you" };

  /* ---------- graph layout: fixed zone regions, topics on a ring, items around their topic ---------- */
  var hash = function (s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
  K.REGION = { documents: [0.19, 0.3, 0.17, 0.25], library: [0.53, 0.28, 0.17, 0.23], web: [0.85, 0.33, 0.13, 0.24], ideas: [0.45, 0.76, 0.15, 0.18], thinkers: [0.74, 0.76, 0.13, 0.17], mine: [0.17, 0.77, 0.11, 0.15] };
  K.REGION_TALL = { documents: [0.27, 0.17, 0.23, 0.14], library: [0.74, 0.19, 0.22, 0.15], web: [0.73, 0.5, 0.23, 0.14], ideas: [0.27, 0.48, 0.23, 0.13], thinkers: [0.72, 0.81, 0.23, 0.13], mine: [0.26, 0.8, 0.2, 0.12] };
  K.layout = function (items, W, H, regions) {
    var live = items.filter(function (i) { return !i.archived; }), pos = {}, topics = [], zones = [];
    K.ZONES.forEach(function (z) {
      var r = (regions || K.REGION)[z[0]], cx = r[0] * W, cy = r[1] * H, rx = r[2] * W, ry = r[3] * H, mine = live.filter(function (i) { return i.zone === z[0]; }), names = [];
      mine.forEach(function (i) { var t = i.topic || "General"; if (names.indexOf(t) < 0) names.push(t); });
      names.sort();
      zones.push({ id: z[0], name: z[1], cx: cx, cy: cy, rx: rx, ry: ry, count: mine.length, topics: names });
      names.forEach(function (t, k) {
        var a = names.length === 1 ? 0 : (k / names.length) * Math.PI * 2 - Math.PI / 2 + hash(z[0]) * 1.5, d = names.length === 1 ? 0 : 0.5, tx = cx + Math.cos(a) * rx * d, ty = cy + Math.sin(a) * ry * d, list = mine.filter(function (i) { return (i.topic || "General") === t; });
        var tid = "topic:" + z[0] + ":" + t; topics.push({ id: tid, zone: z[0], name: t, x: tx, y: ty, n: list.length }); pos[tid] = [tx, ty];
        list.forEach(function (i, j) {
          var ring = Math.floor(j / 7), inRing = Math.min(7, list.length - ring * 7), ang = (j % 7) / inRing * Math.PI * 2 + hash(i.id) * 0.9 + k, rad = Math.min(rx, ry) * (names.length === 1 ? 0.42 : 0.3) * (1 + ring * 0.62);
          pos[i.id] = [tx + Math.cos(ang) * rad, ty + Math.sin(ang) * rad * 0.9];
        });
      });
    });
    // a few rounds of pushing apart, kept inside the zone
    var ids = live.map(function (i) { return i.id; }), zoneOf = {}; live.forEach(function (i) { zoneOf[i.id] = i.zone; });
    for (var it = 0; it < 40; it++) for (var a = 0; a < ids.length; a++) for (var b = a + 1; b < ids.length; b++) {
      var p = pos[ids[a]], q = pos[ids[b]], dx = q[0] - p[0], dy = q[1] - p[1], dist = Math.sqrt(dx * dx + dy * dy) || 0.01, min = 30;
      if (dist < min) { var push = (min - dist) / 2, ux = dx / dist, uy = dy / dist; p[0] -= ux * push; p[1] -= uy * push; q[0] += ux * push; q[1] += uy * push; }
    }
    ids.forEach(function (id) { var z = zones.filter(function (x) { return x.id === zoneOf[id]; })[0], p = pos[id], nx = (p[0] - z.cx) / (z.rx * 0.86), ny = (p[1] - z.cy) / (z.ry * 0.86), d = Math.sqrt(nx * nx + ny * ny); if (d > 1) { p[0] = z.cx + (p[0] - z.cx) / d; p[1] = z.cy + (p[1] - z.cy) / d; } });
    return { pos: pos, topics: topics, zones: zones };
  };

  /* ---------- search over what is already loaded (titles, tags, summaries, notes) ---------- */
  K.search = function (items, q) {
    var words = String(q || "").toLowerCase().split(/\s+/).filter(function (w) { return w.length > 1; }); if (!words.length) return [];
    var out = [];
    items.forEach(function (i) {
      if (i.archived) return;
      var title = String(i.title || "").toLowerCase(), rest = [(i.tags || []).join(" "), i.summary, i.why, i.topic, JSON.stringify(i.meta || {}), i.url].join(" ").toLowerCase(), score = 0;
      words.forEach(function (w) { if (title.indexOf(w) >= 0) score += 3; else if (rest.indexOf(w) >= 0) score += 1; });
      if (score >= words.length) out.push({ id: i.id, score: score, snippet: i.summary || i.why || "", page: null, how: "title or tags" });
    });
    return out.sort(function (a, b) { return b.score - a.score; });
  };
  K.filter = function (items, f) {
    return items.filter(function (i) {
      if (i.archived) return false;
      if (f.zone && i.zone !== f.zone) return false; if (f.area && K.areaOf(i) !== f.area) return false; if (f.type && i.type !== f.type) return false; if (f.topic && i.topic !== f.topic) return false; if (f.source && i.source !== f.source) return false;
      if (f.from && String(i.createdAt || "").slice(0, 10) < f.from) return false; if (f.to && String(i.createdAt || "").slice(0, 10) > f.to) return false;
      return true;
    });
  };
  if (typeof module !== "undefined" && module.exports) module.exports = K; else root.PPKnowledgeCore = K;
})(typeof window !== "undefined" ? window : this);
