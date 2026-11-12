/* Communication page: iCloud Mail and WhatsApp in one place.
   Mounted by index.html into #commSection (shadow root). The host passes accounts and messages and
   handles every network call (onConnect, onSync, onDisconnect, onAccess, onBody); this file only draws.
   Mail bodies are never stored: onBody fetches one from iCloud when an email is opened. */
(function () {
  var P = window.PPComm = {};
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var ENV = '<svg class="g" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="2"/><path d="M2 4.2l6 4.6 6-4.6"/></svg>';
  var BUB = '<svg class="g" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 11.5H7l-3.2 2.4v-2.4H3A1.5 1.5 0 0 1 1.5 10V5A1.5 1.5 0 0 1 3 3.5z"/></svg>';
  var CLIP = '<svg class="g s" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5l-5 5a1.4 1.4 0 0 0 2 2l5.5-5.5a2.6 2.6 0 0 0-3.7-3.7L3.8 7.8a3.8 3.8 0 0 0 5.4 5.4l4.3-4.3"/></svg>';
  var glyph = function (p) { return p === "whatsapp" ? BUB : ENV; };
  var dayKey = function (iso) { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" }); };
  var when = function (iso) {
    var d = new Date(iso), now = new Date(), k = dayKey(iso);
    if (k === dayKey(now.toISOString())) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
    if (now - d < 6 * 864e5) return d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "Europe/Berlin" });
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric", timeZone: "Europe/Berlin" });
  };
  var full = function (iso) { return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }); };
  var ago = function (iso) { if (!iso) return "never"; var m = (Date.now() - new Date(iso).getTime()) / 60000; return m < 1 ? "just now" : m < 60 ? Math.round(m) + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : when(iso); };
  var size = function (n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; };
  // remote pictures are dropped before showing an email (senders use them to see when it was opened); the frame CSP blocks anything left
  var noRemote = function (h) { return String(h || "").replace(/(<img\b[^>]*?)\s(src|srcset)\s*=\s*(["'])(?:https?:)?\/\/[^"']*\3/gi, "$1").replace(/url\(\s*(["']?)(?:https?:)?\/\/[^)]*\)/gi, "none"); };
  var linkify = function (t) { return esc(t).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + "</a>"; }); };

  P.mount = function (host, o) {
    o = o || {};
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    root.innerHTML = '<link rel="stylesheet" href="' + (o.css || "communication/comm.css") + '"><div class="cm"></div>';
    var cm = root.querySelector(".cm"), $ = function (q) { return root.querySelector(q); };
    var S = { accounts: [], messages: [], ready: true, theme: o.theme || "light", filter: "all", unread: false, q: "", sel: null, sheet: null, bodies: {}, open: {}, html: {}, busy: {}, err: "", confirm: null, waPrompt: "", sample: !!o.sample, narrow: false };
    var call = function (name) { var a = [].slice.call(arguments, 1); return Promise.resolve(o[name] ? o[name].apply(null, a) : null); };

    function setData(d) { ["accounts", "messages", "ready", "theme", "waPrompt"].forEach(function (k) { if (d[k] !== undefined) S[k] = d[k]; }); }
    var acc = function (p) { return S.accounts.filter(function (a) { return a.provider === p; })[0] || null; };
    function threads() {
      var by = {}, out = [];
      S.messages.forEach(function (m) {
        var k = m.provider + "|" + m.threadKey, t = by[k];
        if (!t) { t = by[k] = { key: k, provider: m.provider, title: m.threadTitle || m.subject || "(no subject)", msgs: [], unread: 0, people: {} }; out.push(t); }
        t.msgs.push(m); if (m.unread) t.unread++;
        if (m.direction === "in" && m.fromName) t.people[m.fromName] = 1;
        if (m.direction === "in" && !m.fromName && m.fromAddr) t.people[m.fromAddr] = 1;
      });
      out.forEach(function (t) { t.msgs.sort(function (a, b) { return a.sentAt < b.sentAt ? -1 : 1; }); t.last = t.msgs[t.msgs.length - 1]; t.who = Object.keys(t.people); });
      out.sort(function (a, b) { return a.last.sentAt < b.last.sentAt ? 1 : -1; });
      return out;
    }
    function visible(all) {
      var q = S.q.trim().toLowerCase();
      return all.filter(function (t) {
        if (S.filter === "mail" && t.provider !== "icloud") return false;
        if (S.filter === "wa" && t.provider !== "whatsapp") return false;
        if (S.unread && !t.unread) return false;
        if (!q) return true;
        return t.title.toLowerCase().indexOf(q) >= 0 || t.msgs.some(function (m) { return [m.subject, m.preview, m.fromName, m.fromAddr, m.body].join(" ").toLowerCase().indexOf(q) >= 0; });
      });
    }

    /* ---------- sources ---------- */
    function pill(a) {
      if (!a) return "";
      var st = a.status, cls = st === "reconnect" || st === "error" ? "bad" : st === "syncing" || S.busy["sync:" + a.id] ? "run" : "ok";
      var txt = st === "reconnect" ? "Needs connecting again" : st === "error" ? "Last sync failed" : cls === "run" ? "Syncing…" : (a.provider === "whatsapp" ? "Saved " : "Synced ") + ago(a.lastSyncAt);
      return '<span class="pill ' + cls + '"><i></i>' + esc(txt) + "</span>";
    }
    function accessChip(a) { return '<button class="chip" data-access="' + esc(a.id) + '" aria-pressed="' + !!a.claudeAccess + '" title="Whether Claude may read these messages through the planner connector">' + (a.claudeAccess ? "Claude may read" : "Kept from Claude") + "</button>"; }
    function sources() {
      var m = acc("icloud"), w = acc("whatsapp"), cnt = function (p) { return S.messages.filter(function (x) { return x.provider === p; }).length; };
      var mail = '<section class="src" aria-label="iCloud Mail"><div class="sh">' + ENV + "<div><h2>iCloud Mail</h2>" + (m ? '<p class="sub">' + esc(m.address) + "</p>" : '<p class="sub">Not connected</p>') + "</div>" + pill(m) + "</div>" +
        (m ? (m.lastError && m.status !== "ok" ? '<p class="warn">' + esc(m.lastError) + "</p>" : "") + '<p class="sub">Claude can search your mail, open an email and read its attachments when you ask, in a chat or with the planner connector. Read-only: nothing in iCloud is marked read, moved, deleted or sent.</p>' +
          (S.confirm === m.id ? '<div class="acts"><span class="sub">Disconnect? The password is removed from the planner; the emails stay here, archived.</span><button class="btn sm" data-disc-ok="' + esc(m.id) + '">Disconnect</button><button class="btn sm ghost" data-disc-no="1">Keep</button></div>'
            : '<div class="acts">' + (m.status === "reconnect" ? '<button class="btn sm pri" data-act="connect">Connect again</button>' : '<button class="btn sm" data-sync="' + esc(m.id) + '"' + (S.busy["sync:" + m.id] ? " disabled" : "") + ">" + (S.busy["sync:" + m.id] ? "Syncing…" : "Sync now") + "</button>") + accessChip(m) + '<button class="btn sm ghost" data-disc="' + esc(m.id) + '">Disconnect</button></div>')
          : '<p class="sub">Reads your Inbox and Sent with an app-specific password from Apple. Nothing is changed, moved or sent in iCloud.</p><div class="acts"><button class="btn pri" data-act="connect">Connect iCloud Mail</button></div>') + "</section>";
      var wa = '<section class="src" aria-label="WhatsApp"><div class="sh">' + BUB + "<div><h2>WhatsApp</h2><p class=\"sub\">Saved by Claude on your desktop</p></div>" + pill(w) + "</div>" +
        '<p class="sub">' + (w ? cnt("whatsapp") + " messages saved. " : "") + "WhatsApp has no way in for apps, so Claude in the desktop app reads your WhatsApp app and saves the chats here. Nothing is sent or deleted.</p>" +
        '<div class="acts"><button class="btn' + (w ? " sm" : " pri") + '" data-act="wa">' + (w ? "Save new chats" : "Set up with Claude") + "</button>" + (w ? accessChip(w) : "") + "</div></section>";
      return '<div class="srcs">' + mail + wa + "</div>";
    }

    /* ---------- conversation list ---------- */
    function listHtml(ts) {
      if (!S.messages.length) return '<div class="empty"><p class="t">No messages yet</p><p class="sub">Connect iCloud Mail or save your WhatsApp chats with Claude, and conversations appear here, newest first.</p></div>';
      if (!ts.length) return '<div class="empty"><p class="sub">Nothing matches.</p></div>';
      return '<ul class="list" role="listbox" aria-label="Conversations">' + ts.slice(0, 400).map(function (t) {
        var l = t.last, who = t.provider === "whatsapp" ? (l.direction === "out" ? "You" : l.fromName) : (t.who.length ? t.who.slice(0, 3).join(", ") + (t.who.length > 3 ? " +" + (t.who.length - 3) : "") : "You");
        return '<li><button class="row' + (t.unread ? " un" : "") + (S.sel === t.key ? " on" : "") + '" data-thread="' + esc(t.key) + '" role="option" aria-selected="' + (S.sel === t.key) + '">' + glyph(t.provider) +
          '<span class="rt"><span class="r1"><b>' + esc(t.provider === "whatsapp" ? t.title : who) + "</b><time>" + esc(when(l.sentAt)) + "</time></span>" +
          (t.provider === "icloud" ? '<span class="r2">' + esc(t.title) + (t.msgs.length > 1 ? ' <small>' + t.msgs.length + "</small>" : "") + "</span>" : "") +
          '<span class="r3">' + (t.provider === "whatsapp" && l.direction === "out" ? "You: " : "") + esc(l.preview || (l.hasAttachments ? "Attachment" : "")) + "</span></span>" +
          (t.unread ? '<span class="dot" aria-label="' + t.unread + ' unread"></span>' : t.msgs.some(function (m) { return m.hasAttachments; }) ? CLIP : "") + "</button></li>";
      }).join("") + "</ul>" + (ts.length > 400 ? '<p class="sub more">Showing the newest 400. Search to find older ones.</p>' : "");
    }

    /* ---------- reading pane ---------- */
    function mailBody(m) {
      var b = S.bodies[m.id];
      if (!b || b.loading) return '<p class="sub load">Opening from iCloud…</p>';
      if (b.error) return '<p class="warn">' + esc(b.error) + '</p><button class="btn sm" data-retry="' + esc(m.id) + '">Try again</button>';
      var html = S.html[m.id] && b.html;
      var out = html ? '<iframe class="mframe" sandbox="allow-popups allow-popups-to-escape-sandbox" title="' + esc("Email: " + (m.subject || "")) + '" srcdoc="' + esc('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: cid:; style-src \'unsafe-inline\'; font-src data:"><base target="_blank"><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:4px;color:#1e2530;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}</style>' + noRemote(b.html)) + '"></iframe>'
        : '<div class="mtext">' + linkify(b.text || "(This email has no plain text. Use the formatted view.)") + "</div>";
      return (b.html ? '<div class="acts mt"><button class="chip" data-html="' + esc(m.id) + '" aria-pressed="' + !!S.html[m.id] + '">' + (S.html[m.id] ? "Formatted · images blocked" : "Plain text") + '</button><span class="sub">' + (S.html[m.id] ? "Pictures from the internet are not loaded, so senders cannot see that you opened it." : "") + "</span></div>" : "") + out +
        (b.attachments && b.attachments.length ? '<div class="att"><p class="lab">Attachments</p>' + b.attachments.map(function (a) { return "<span>" + CLIP + esc(a.name) + " <small>" + size(a.size || 0) + "</small></span>"; }).join("") + '<p class="sub">Open attachments in iCloud Mail.</p></div>' : "");
    }
    function reader(t) {
      if (!t) return '<div class="rd none"><p class="sub">Choose a conversation.</p></div>';
      var back = S.narrow ? '<button class="btn sm ghost" data-back="1">← Back</button>' : "";
      if (t.provider === "whatsapp") {
        var group = t.msgs.some(function (m) { return m.folder === "group"; }), lastDay = "";
        return '<div class="rd wa">' + back + '<header class="rh">' + BUB + "<div><h2>" + esc(t.title) + '</h2><p class="sub">WhatsApp · ' + t.msgs.length + " saved messages</p></div></header><div class=\"bubs\">" + t.msgs.map(function (m) {
          var dk = dayKey(m.sentAt), sep = dk !== lastDay ? '<p class="day">' + esc(new Date(m.sentAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" })) + "</p>" : ""; lastDay = dk;
          return sep + '<div class="bub ' + m.direction + '">' + (group && m.direction === "in" ? "<b>" + esc(m.fromName) + "</b>" : "") + '<span class="tx">' + linkify(m.body || m.preview) + "</span><time>" + esc(new Date(m.sentAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })) + "</time></div>";
        }).join("") + "</div></div>";
      }
      return '<div class="rd mail">' + back + '<header class="rh">' + ENV + "<div><h2>" + esc(t.title) + '</h2><p class="sub">' + t.msgs.length + (t.msgs.length === 1 ? " email" : " emails") + (t.who.length ? " · " + esc(t.who.join(", ")) : "") + '</p></div><a class="btn sm ghost" href="https://www.icloud.com/mail" target="_blank" rel="noopener noreferrer">Open iCloud Mail</a></header>' +
        t.msgs.map(function (m) {
          var on = !!S.open[m.id];
          return '<article class="em' + (on ? " on" : "") + (m.unread ? " un" : "") + '"><button class="eh" data-msg="' + esc(m.id) + '" aria-expanded="' + on + '"><span class="ef"><b>' + esc(m.direction === "out" ? "You" : (m.fromName || m.fromAddr)) + "</b>" + (m.direction === "in" && m.fromName && m.fromAddr ? " <small>" + esc(m.fromAddr) + "</small>" : "") + "</span><time>" + esc(full(m.sentAt)) + "</time>" +
            (on ? '<span class="eto">to ' + esc((m.to || []).map(function (x) { return x.name || x.address; }).join(", ") || "—") + "</span>" : '<span class="ep">' + esc(m.preview) + "</span>") + "</button>" + (on ? '<div class="eb">' + mailBody(m) + "</div>" : "") + "</article>";
        }).join("") + "</div>";
    }

    /* ---------- sheets ---------- */
    function sheet() {
      if (S.sheet === "connect") return '<button class="btn sm ghost x" data-act="close" aria-label="Close">✕</button><p class="lab">iCloud Mail</p><h2 class="st">Connect with an app-specific password</h2>' +
        '<ol class="steps"><li>Open <a href="https://account.apple.com/account/manage" target="_blank" rel="noopener noreferrer">account.apple.com</a> and sign in.</li><li>Go to <b>Sign-In and Security → App-Specific Passwords</b> and create one called “Planner”.</li><li>Paste it below. It looks like <code>abcd-efgh-ijkl-mnop</code>.</li></ol>' +
        '<div class="f"><label for="cmA">iCloud email address</label><input class="in" id="cmA" type="email" autocomplete="email" placeholder="name@icloud.com"></div>' +
        '<div class="f"><label for="cmP">App-specific password</label><input class="in" id="cmP" type="password" autocomplete="new-password" spellcheck="false"></div>' +
        (S.err ? '<p class="warn" role="alert">' + esc(S.err) + "</p>" : "") +
        '<div class="acts"><button class="btn pri" data-act="doconnect"' + (S.busy.connect ? " disabled" : "") + ">" + (S.busy.connect ? "Checking with iCloud…" : "Connect") + '</button><button class="btn ghost" data-act="close">Cancel</button></div>' +
        '<p class="sub fine">The password is checked with iCloud, then stored encrypted on the planner’s server. It is never shown again and is only used to read mail. You can withdraw it any time at account.apple.com.</p>';
      if (S.sheet === "wa") return '<button class="btn sm ghost x" data-act="close" aria-label="Close">✕</button><p class="lab">WhatsApp</p><h2 class="st">Save your chats with Claude</h2>' +
        '<ol class="steps"><li>Open the <b>WhatsApp app</b> on this computer and keep it signed in.</li><li>Open the <b>Claude desktop app</b>, start a chat with the planner connector on, and allow computer use when Claude asks.</li><li>Paste this and send it. Claude reads the chats and saves them here; run it again whenever you want new messages.</li></ol>' +
        '<div class="f"><label for="cmW">Prompt for Claude</label><textarea class="in" id="cmW" rows="8" readonly>' + esc(S.waPrompt) + '</textarea></div><div class="acts"><button class="btn pri" data-act="wacopy">Copy</button><span class="sub" id="cmWc" role="status"></span></div>' +
        '<p class="sub fine">Claude only reads. It does not send, reply, delete or open media. Messages are stored in your planner database behind your login.</p>';
      return "";
    }

    function render() {
      S.narrow = host.getBoundingClientRect().width < 860;
      cm.dataset.theme = S.theme;
      if (!S.ready) { cm.innerHTML = '<div class="wrap"><header class="top"><div><p class="eyebrow">Communication</p><h1>Mail and WhatsApp</h1></div></header><div class="empty"><p class="t">One setup step first</p><p class="sub">The Communication page needs its database tables. Once they are in, connect iCloud Mail and WhatsApp here.</p></div></div>'; return; }
      var all = threads(), ts = visible(all), sel = S.sel && all.filter(function (t) { return t.key === S.sel; })[0], unread = all.reduce(function (s, t) { return s + t.unread; }, 0);
      var keep = root.activeElement && root.activeElement.id === "cmQ", pos = keep ? root.activeElement.selectionStart : 0, typed = {}, fid = root.activeElement && root.activeElement.id;
      ["cmA", "cmP"].forEach(function (k) { var el = $("#" + k); if (el) typed[k] = el.value; });
      void listHtml; void reader; void sel; void ts; void unread;
      var listCol = '<div class="lc"><div class="tools"><input class="q" id="cmQ" type="search" placeholder="Search messages" aria-label="Search messages" value="' + esc(S.q) + '"><div class="seg" role="group" aria-label="Show">' +
        [["all", "All"], ["mail", "Mail"], ["wa", "WhatsApp"]].map(function (f) { return '<button data-filter="' + f[0] + '" aria-pressed="' + (S.filter === f[0]) + '">' + f[1] + "</button>"; }).join("") + '</div><button class="chip" data-act="unread" aria-pressed="' + S.unread + '">Unread</button></div>' + listHtml(ts) + "</div>";
      cm.innerHTML = (S.sample ? '<div class="ribbon" role="note"><b>SAMPLE DATA</b> · invented messages and names · nothing below is yours</div>' : "") +
        '<div class="wrap"><header class="top"><div><p class="eyebrow">Communication</p><h1>Mail and WhatsApp</h1><p class="sub">The connections Claude uses. Ask Claude to search your mail, for example “find the CBRE offer and read the PDF”.</p></div></header>' + sources() + "</div>" +
        (S.sheet ? '<div class="shade" data-shade="1"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + (S.sheet === "connect" ? "Connect iCloud Mail" : "Save WhatsApp chats") + '">' + sheet() + "</div></div>" : "");
      if (keep) { var q = $("#cmQ"); q.focus(); try { q.setSelectionRange(pos, pos); } catch (e) {} }
      Object.keys(typed).forEach(function (k) { var el = $("#" + k); if (el) { el.value = typed[k]; if (fid === k) el.focus(); } });
    }
    function body(id, force) {
      if (S.bodies[id] && !S.bodies[id].error && !force) return;
      S.bodies[id] = { loading: true }; render();
      call("onBody", id).then(function (b) { S.bodies[id] = b && !b.error ? b : { error: (b && b.error) || "Could not open this email." }; if (b && !b.error && !b.text && b.html) S.html[id] = true; render(); }, function (e) { S.bodies[id] = { error: e && e.message ? e.message : "Could not open this email." }; render(); });
    }
    function openThread(key) {
      S.sel = key; var t = threads().filter(function (x) { return x.key === key; })[0];
      if (t && t.provider === "icloud") { var last = t.last; S.open[last.id] = true; render(); body(last.id); var rd = $(".rd"); if (rd) rd.scrollTop = 0; }
      else { render(); var bb = $(".bubs"); if (bb) bb.scrollTop = bb.scrollHeight; }
    }

    cm.addEventListener("click", function (e) {
      if (e.target.dataset && e.target.dataset.shade) { S.sheet = null; S.err = ""; render(); return; }
      var t = e.target.closest("button,a"); if (!t || t.disabled || t.tagName === "A") return; var d = t.dataset;
      if (d.thread) openThread(d.thread);
      else if (d.back) { S.sel = null; render(); }
      else if (d.filter) { S.filter = d.filter; render(); }
      else if (d.msg) { S.open[d.msg] = !S.open[d.msg]; render(); if (S.open[d.msg]) body(d.msg); }
      else if (d.retry) body(d.retry, true);
      else if (d.html) { S.html[d.html] = !S.html[d.html]; render(); }
      else if (d.sync) { S.busy["sync:" + d.sync] = true; render(); call("onSync", d.sync).then(function () { S.busy["sync:" + d.sync] = false; render(); }, function () { S.busy["sync:" + d.sync] = false; render(); }); }
      else if (d.access) { var a = S.accounts.filter(function (x) { return x.id === d.access; })[0]; if (a) { a.claudeAccess = !a.claudeAccess; render(); call("onAccess", a.id, a.claudeAccess); } }
      else if (d.disc) { S.confirm = d.disc; render(); }
      else if (d.discNo) { S.confirm = null; render(); }
      else if (d.discOk) { var id = d.discOk; S.confirm = null; call("onDisconnect", id); }
      else if (d.act === "unread") { S.unread = !S.unread; render(); }
      else if (d.act === "connect") { S.sheet = "connect"; S.err = ""; render(); var f = $("#cmA"); if (f) { var m = acc("icloud"); if (m) f.value = m.address; f.focus(); } }
      else if (d.act === "wa") { S.sheet = "wa"; render(); var c = $(".sheet [data-act=wacopy]"); if (c) c.focus(); }
      else if (d.act === "close") { S.sheet = null; S.err = ""; render(); }
      else if (d.act === "wacopy") { var ta = $("#cmW"), done = function () { var n = $("#cmWc"); if (n) n.textContent = "Copied. Paste it into a Claude chat in the desktop app."; }; if (navigator.clipboard) navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); }); else { ta.select(); } }
      else if (d.act === "doconnect") {
        var addr = ($("#cmA") || {}).value || "", pass = ($("#cmP") || {}).value || "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.trim())) { S.err = "Enter your iCloud email address."; render(); $("#cmA").value = addr; $("#cmA").focus(); return; }
        if (pass.replace(/\s+/g, "").length < 12) { S.err = "Paste the app-specific password from account.apple.com."; render(); $("#cmA").value = addr; $("#cmP").focus(); return; }
        S.busy.connect = true; S.err = ""; render(); $("#cmA").value = addr;
        call("onConnect", addr.trim(), pass).then(function (r) { S.busy.connect = false; if (r && r.ok) { S.sheet = null; render(); } else { S.err = (r && r.error) || "That did not work."; render(); var a2 = $("#cmA"); if (a2) a2.value = addr; } }, function (er) { S.busy.connect = false; S.err = er && er.message ? er.message : "That did not work."; render(); });
      }
    });
    var qT = 0;
    cm.addEventListener("input", function (e) { if (e.target.id === "cmQ") { S.q = e.target.value; clearTimeout(qT); qT = setTimeout(render, 120); } });
    cm.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { if (S.sheet) { S.sheet = null; S.err = ""; render(); } else if (S.sel) { S.sel = null; render(); } }
      if (e.key === "Enter" && (e.target.id === "cmP" || e.target.id === "cmA")) { e.preventDefault(); var b = $(".sheet [data-act=doconnect]"); if (b) b.click(); }
    });
    var ro = window.ResizeObserver ? new ResizeObserver(function () { var n = host.getBoundingClientRect().width < 860; if (n !== S.narrow) render(); }) : null; if (ro) ro.observe(host);

    setData(o); render();
    return {
      update: function (d) { setData(d || {}); if (S.sel && !threads().some(function (t) { return t.key === S.sel; })) S.sel = null; render(); },
      open: openThread,
      state: function () { return { sel: S.sel, sheet: S.sheet, filter: S.filter, threads: threads().length, narrow: S.narrow }; }
    };
  };
})();
