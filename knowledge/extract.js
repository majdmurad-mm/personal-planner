/* Knowledge page: reads the text out of a file inside the browser, so nothing has to be sent
   anywhere to be understood. PDF (text layer, or OCR for scans), images (OCR), EPUB, DOCX, TXT/MD.
   The helper libraries are loaded from a CDN only when a file of that kind is first added. */
(function () {
  var X = window.PPKnowledgeExtract = {};
  var LIBS = {
    pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
    zip: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
    ocr: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"
  };
  var loading = {};
  function script(url) {
    if (!loading[url]) loading[url] = new Promise(function (ok, bad) { var el = document.createElement("script"); el.src = url; el.crossOrigin = "anonymous"; el.onload = ok; el.onerror = function () { delete loading[url]; bad(new Error("Could not load a helper needed to read this file. Check the connection and try again.")); }; document.head.appendChild(el); });
    return loading[url];
  }
  X.MAX_OCR_PAGES = 30;
  X.kind = function (file) {
    var n = String(file.name || "").toLowerCase(), t = String(file.type || "");
    if (/\.pdf$/.test(n) || t === "application/pdf") return "pdf";
    if (/\.(png|jpe?g|webp|bmp|gif)$/.test(n) || /^image\//.test(t)) return "image";
    if (/\.epub$/.test(n)) return "epub";
    if (/\.docx$/.test(n)) return "docx";
    if (/\.(txt|md|markdown|csv)$/.test(n) || /^text\//.test(t)) return "text";
    return "";
  };
  X.hash = async function (file) {
    var buf = await file.arrayBuffer(), d = await crypto.subtle.digest("SHA-256", buf);
    return Array.prototype.map.call(new Uint8Array(d), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  };
  async function ocr(image, progress) {
    await script(LIBS.ocr);
    var r = await window.Tesseract.recognize(image, "deu+eng", { logger: function (m) { if (progress && m && m.status === "recognizing text") progress("Reading the scan", m.progress); } });
    return (r && r.data && r.data.text) || "";
  }
  var strip = function (html) { var d = new DOMParser().parseFromString(html, "text/html"); [].forEach.call(d.querySelectorAll("script,style,nav"), function (e) { e.remove(); }); return (d.body ? d.body.textContent : "").replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim(); };
  async function pdf(file, progress) {
    await script(LIBS.pdf);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    var doc = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise, pages = [], scanned = 0, usedOcr = false, skipped = 0;
    for (var p = 1; p <= doc.numPages; p++) {
      var page = await doc.getPage(p), tc = await page.getTextContent(), last = null, text = "";
      tc.items.forEach(function (it) { if (last != null && Math.abs(it.transform[5] - last) > 2) text += "\n"; else if (text && !/\s$/.test(text)) text += " "; text += it.str; last = it.transform[5]; });
      text = text.trim();
      if (text.replace(/\s/g, "").length < 20) {
        if (scanned < X.MAX_OCR_PAGES) {
          scanned++; usedOcr = true;
          var vp = page.getViewport({ scale: 2 }), cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height;
          await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
          text = (await ocr(cv, function (l, f) { if (progress) progress("Reading scanned page " + p + " of " + doc.numPages, f); })).trim();
        } else skipped++;
      }
      pages.push({ page: p, text: text });
      if (progress) progress("Reading page " + p + " of " + doc.numPages, p / doc.numPages);
    }
    return { pages: pages, pageCount: doc.numPages, ocr: usedOcr, note: skipped ? skipped + " scanned pages were not read (only the first " + X.MAX_OCR_PAGES + " scanned pages are)." : "" };
  }
  async function epub(file) {
    await script(LIBS.zip);
    var zip = await window.JSZip.loadAsync(await file.arrayBuffer()), cont = zip.file("META-INF/container.xml"), meta = {}, order = [];
    if (cont) {
      var opfPath = (/full-path="([^"]+)"/.exec(await cont.async("string")) || [])[1], opf = opfPath && zip.file(opfPath);
      if (opf) {
        var x = new DOMParser().parseFromString(await opf.async("string"), "application/xml"), base = opfPath.replace(/[^/]*$/, ""), man = {};
        var pick = function (tag) { var e = x.getElementsByTagName(tag)[0] || x.getElementsByTagNameNS("*", tag.replace(/^dc:/, ""))[0]; return e ? e.textContent.trim() : ""; };
        meta.title = pick("dc:title"); meta.author = pick("dc:creator"); meta.language = pick("dc:language").slice(0, 2);
        [].forEach.call(x.getElementsByTagName("item"), function (i) { man[i.getAttribute("id")] = i.getAttribute("href"); });
        [].forEach.call(x.getElementsByTagName("itemref"), function (i) { var h = man[i.getAttribute("idref")]; if (h) order.push(base + decodeURIComponent(h)); });
      }
    }
    if (!order.length) order = Object.keys(zip.files).filter(function (n) { return /\.x?html?$/i.test(n); }).sort();
    var pages = [];
    for (var i = 0; i < order.length; i++) { var f = zip.file(order[i]); if (!f) continue; var t = strip(await f.async("string")); if (t) pages.push({ page: pages.length + 1, text: t }); }
    return { pages: pages, pageCount: pages.length, meta: meta, pageWord: "section" };
  }
  async function docx(file) {
    await script(LIBS.zip);
    var zip = await window.JSZip.loadAsync(await file.arrayBuffer()), f = zip.file("word/document.xml");
    if (!f) throw new Error("This Word file has no readable text.");
    var x = new DOMParser().parseFromString(await f.async("string"), "application/xml"), paras = [];
    [].forEach.call(x.getElementsByTagNameNS("*", "p"), function (p) { var t = ""; [].forEach.call(p.getElementsByTagNameNS("*", "t"), function (n) { t += n.textContent; }); if (t.trim()) paras.push(t.trim()); });
    return { pages: [{ page: 1, text: paras.join("\n") }], pageCount: 1 };
  }
  // -> { kind, pages:[{page,text}], pageCount, ocr, note, meta }
  X.read = async function (file, progress) {
    var kind = X.kind(file), out;
    if (!kind) throw new Error("This kind of file is not supported yet. Use PDF, an image, EPUB, DOCX, TXT or MD.");
    if (kind === "pdf") out = await pdf(file, progress);
    else if (kind === "image") out = { pages: [{ page: 1, text: (await ocr(file, progress)).trim() }], pageCount: 1, ocr: true };
    else if (kind === "epub") out = await epub(file);
    else if (kind === "docx") out = await docx(file);
    else out = { pages: [{ page: 1, text: await file.text() }], pageCount: 1 };
    out.kind = kind; out.text = out.pages.map(function (p) { return p.text; }).join("\n\n"); out.meta = out.meta || {};
    return out;
  };
})();
