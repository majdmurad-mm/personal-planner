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
// Serves every file under this folder as-is, plus one special endpoint:
//   GET /__memory_projects_list — lists the local project folders under _Memory/_projects/ (used by
//   the Integrations page and each linked goal/project's "html integrations" panel). See
//   _Memory/_projects/README.md.

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

function listMemoryProjects(){
  const base = path.join(process.cwd(), "_Memory", "_projects");
  const out = {};
  try{
    fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(d => {
      const slugPath = path.join(base, d.name);
      const types = {};
      try{
        fs.readdirSync(slugPath, { withFileTypes: true }).filter(t => t.isDirectory()).forEach(t => {
          const typePath = path.join(slugPath, t.name);
          try{ types[t.name] = fs.readdirSync(typePath).filter(f => f.indexOf(".") !== 0); }
          catch(e){ types[t.name] = []; }
        });
      }catch(e){}
      out[d.name] = types;
    });
  }catch(e){}
  return out;
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);

  if(p === "/__memory_projects_list"){
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listMemoryProjects()));
    return;
  }

  if(p === "/") p = "/index.html";
  const full = path.join(process.cwd(), p);
  fs.readFile(full, (err, data) => {
    if(err){ res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(full);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log("listening on " + PORT));
