// Local dev server for the planner. Run it yourself with:
//
//   node dev-server.js
//
// ...from this folder, then open http://localhost:8977 in your own browser. Leave the terminal
// window open while you use the app — closing it (or Ctrl+C) stops the server. This is the same
// server Claude Code's own preview tool runs via .claude/launch.json, but that copy runs inside
// Claude Code's own sandboxed environment — it is NOT reachable from your actual desktop browser.
// To use the app in your real browser, this script needs to be running on your real machine.
//
// Serves every file under this folder as-is.

const http = require("http");
const fs = require("fs");
const path = require("path");
const PORT = 8977;

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/manifest+json",
  ".png": "image/png"
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if(p === "/") p = "/index.html";
  const full = path.join(process.cwd(), p);
  fs.readFile(full, (err, data) => {
    if(err){ res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(full);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log("listening on " + PORT));
