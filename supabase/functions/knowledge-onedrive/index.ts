// ============================================================================
// knowledge-onedrive: read-only bridge between the owner's personal OneDrive and the Knowledge page.
//
// - Sign-in: authorization code flow with PKCE + state against the "consumers" authority. The code is
//   exchanged here; the refresh token is stored encrypted in Supabase Vault (public.onedrive_token_*),
//   never sent to the browser. Scopes: Files.Read offline_access. Nothing is ever written to OneDrive.
// - Sources: one row per folder the owner picked (public.knowledge_sources). Sync uses Graph delta per
//   source, in resumable chunks (public.knowledge_jobs) started by pg_cron or "Sync now".
// - Files are never stored here. For Index sources the browser asks /fetch for one file at a time,
//   reads the text itself and saves chunks; /fetch streams the bytes and keeps nothing.
//
// Callers: the Knowledge page (Supabase user JWT), the planner-mcp connector (x-internal-key = service
// role key, acting for OWNER_USER_ID), and the two cron schedules (x-cron-key from knowledge_cron_key).
// Secrets (Supabase function secrets): MS_CLIENT_ID, MS_CLIENT_SECRET. Optional: ONEDRIVE_RETURN_ORIGINS.
// ============================================================================
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OWNER = Deno.env.get("OWNER_USER_ID") ?? "";
const CLIENT_ID = Deno.env.get("MS_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET") ?? "";
const RETURN_ORIGINS = (Deno.env.get("ONEDRIVE_RETURN_ORIGINS") ?? "https://majdmurad-mm.github.io,http://localhost:8977,http://127.0.0.1:8977").split(",").map((s) => s.trim()).filter(Boolean);
const BUILD_COMMIT = "__BUILD_COMMIT__";
const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "Files.Read offline_access";
const CALLBACK = SUPABASE_URL + "/functions/v1/knowledge-onedrive/callback";
const CHUNK_MS = 20000;            // one worker run stops after this and saves its place

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------- what is never synced
export const ALWAYS_EXCLUDED_DIRS = [".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".astro", ".cache"];
export const CODE_EXT = ["js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "pyc", "exe", "dll", "zip", "so", "dylib", "bin", "class", "jar", "o", "obj", "lock", "map", "wasm"];
export const SUPPORTED = { pdf: "pdf", docx: "word", doc: "word", pptx: "slides", ppt: "slides", txt: "text", md: "text", markdown: "text", csv: "text", epub: "epub", xlsx: "sheet", xls: "sheet", png: "image", jpg: "image", jpeg: "image", tif: "image", tiff: "image" } as Record<string, string>;
const ext = (name: string) => (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || "").toLowerCase();
const globRe = (p: string) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");

// Decide what happens to one file. Pure, so it can be tested without Graph.
// deno-lint-ignore no-explicit-any
export function classify(src: any, relPath: string, name: string, size: number): { keep: boolean; reason?: string; privacy?: string; status?: string; kind?: string } {
  const parts = relPath ? relPath.split("/") : [];
  if (parts.some((p) => ALWAYS_EXCLUDED_DIRS.includes(p.toLowerCase()) || p.startsWith("."))) return { keep: false, reason: "excluded folder" };
  if (!src.include_subfolders && parts.length) return { keep: false, reason: "subfolder" };
  if (name.startsWith(".") || name.startsWith("~$") || /^(thumbs\.db|desktop\.ini)$/i.test(name)) return { keep: false, reason: "hidden or system" };
  const e = ext(name), wanted = (src.file_types || []).map((x: string) => x.toLowerCase().replace(/^\./, ""));
  if (CODE_EXT.includes(e) && !wanted.includes(e)) return { keep: false, reason: "code or binary" };
  if (wanted.length && !wanted.includes(e)) return { keep: false, reason: "file type filter" };
  const full = (relPath ? relPath + "/" : "") + name;
  if ((src.excludes || []).some((p: string) => globRe(p).test(name) || globRe(p).test(full))) return { keep: false, reason: "exclude pattern" };
  // privacy: the longest matching subfolder override wins, else the source's level
  let privacy = src.privacy, best = -1;
  for (const [k, v] of Object.entries(src.privacy_overrides || {})) { const kk = String(k).replace(/^\/+|\/+$/g, ""); if ((relPath === kk || relPath.startsWith(kk + "/")) && kk.length > best) { best = kk.length; privacy = v as string; } }
  const kind = SUPPORTED[e] || "other";
  let status: string;
  if (privacy === "private") status = src.index_privately && kind !== "other" && (kind !== "image" || src.ocr) && size <= src.max_index_mb * 1048576 ? "pending" : "private";
  else if (privacy === "links") status = "links_only";
  else if (kind === "other" || (kind === "image" && !src.ocr)) status = "links_only";
  else if (size > src.max_index_mb * 1048576) status = "links_only";
  else status = "pending";
  return { keep: true, privacy, status, kind };
}
// a type the Knowledge page knows for the zone the source lives in
const typeFor = (zone: string, kind: string) => ({ documents: "document", library: kind === "epub" ? "book" : "report", web: "link", ideas: "idea", thinkers: "author", mine: "reference" } as Record<string, string>)[zone] || "file";

// ---------------------------------------------------------------- http helpers
function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": RETURN_ORIGINS.includes(o) ? o : RETURN_ORIGINS[0], "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(req) } });
const b64url = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
function safeEqual(a: string, b: string) { if (!a || !b || a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }

// Who is calling: the page (user JWT), the connector (service key + OWNER) or nobody.
async function caller(req: Request): Promise<{ uid: string; via: "page" | "connector" } | null> {
  const internal = req.headers.get("x-internal-key") || "";
  if (internal && safeEqual(internal, SERVICE_KEY) && OWNER) return { uid: OWNER, via: "connector" };
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const r = await db.auth.getUser(jwt);
  return r.data?.user ? { uid: r.data.user.id, via: "page" } : null;
}
async function cronOk(req: Request) {
  const k = req.headers.get("x-cron-key") || "";
  const r = await db.from("knowledge_cron_key").select("key").eq("id", 1).maybeSingle();
  return !!r.data && safeEqual(k, r.data.key);
}

// ---------------------------------------------------------------- tokens and Graph
class Reconnect extends Error {}
class Throttled extends Error { constructor(public seconds: number) { super("throttled"); } }
const tokenCache = new Map<string, { token: string; until: number }>();

async function accessToken(uid: string): Promise<string> {
  const hit = tokenCache.get(uid); if (hit && hit.until > Date.now() + 60000) return hit.token;
  const rt = await db.rpc("onedrive_token_get", { p_user: uid });
  if (rt.error) throw new Error(rt.error.message);
  if (!rt.data) throw new Reconnect("not connected");
  const r = await fetch(AUTHORITY + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token", refresh_token: rt.data, scope: SCOPES }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "invalid_grant" || j.error === "interaction_required") { await markReconnect(uid, j.error_description ? String(j.error_description).split("\r\n")[0].slice(0, 160) : j.error); throw new Reconnect(j.error); }
    throw new Error("token refresh failed: " + (j.error || r.status));
  }
  // Microsoft hands out a new refresh token on every use; keep the newest.
  if (j.refresh_token) await db.rpc("onedrive_token_set", { p_user: uid, p_token: j.refresh_token, p_label: "" });
  tokenCache.set(uid, { token: j.access_token, until: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}
async function markReconnect(uid: string, why: string) {
  tokenCache.delete(uid);
  await db.from("onedrive_connection").update({ status: "reconnect", last_error: why }).eq("user_id", uid);
  await db.from("knowledge_sources").update({ status: "reconnect", last_error: "OneDrive needs to be reconnected" }).eq("user_id", uid).is("archived_at", null);
}
// deno-lint-ignore no-explicit-any
async function graph(uid: string, pathOrUrl: string, init: RequestInit = {}): Promise<any> {
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : GRAPH + pathOrUrl;
  if (!url.startsWith(GRAPH + "/")) throw new Error("refusing a non-Graph URL");
  if (init.method && init.method !== "GET") throw new Error("read-only: only GET is allowed");
  const r = await fetch(url, { ...init, method: "GET", headers: { ...(init.headers || {}), Authorization: "Bearer " + await accessToken(uid) } });
  if (r.status === 429 || r.status === 503) throw new Throttled(+(r.headers.get("retry-after") || 30));
  if (r.status === 401) { tokenCache.delete(uid); throw new Error("Graph said 401"); }
  if (!r.ok) { const t = await r.text(); throw new Error("Graph " + r.status + ": " + t.slice(0, 200)); }
  return r.json();
}

// ---------------------------------------------------------------- sign-in
async function start(req: Request, uid: string) {
  if (!CLIENT_ID || !CLIENT_SECRET) return json(req, { error: "OneDrive is not set up yet: add MS_CLIENT_ID and MS_CLIENT_SECRET as function secrets" }, 400);
  const body = await req.json().catch(() => ({}));
  const returnTo = String(body.returnTo || "");
  if (!RETURN_ORIGINS.some((o) => returnTo === o || returnTo.startsWith(o + "/"))) return json(req, { error: "returnTo is not an allowed address" }, 400);
  const state = randomToken(24), verifier = randomToken(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  await db.from("onedrive_oauth_states").delete().lt("expires_at", new Date().toISOString());
  const ins = await db.from("onedrive_oauth_states").insert({ state, user_id: uid, verifier, return_to: returnTo, expires_at: new Date(Date.now() + 10 * 60000).toISOString() });
  if (ins.error) return json(req, { error: ins.error.message }, 500);
  const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: "code", redirect_uri: CALLBACK, response_mode: "query", scope: SCOPES, state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" });
  return json(req, { url: AUTHORITY + "/authorize?" + q.toString() });
}
function back(returnTo: string, result: string, reason?: string) {
  const u = new URL(returnTo); u.searchParams.set("onedrive", result); if (reason) u.searchParams.set("onedrive_reason", reason.slice(0, 120)); u.hash = "knowledge";
  return new Response(null, { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store" } });
}
async function callback(req: Request) {
  const u = new URL(req.url), state = u.searchParams.get("state") || "", code = u.searchParams.get("code") || "";
  const row = state ? await db.from("onedrive_oauth_states").select("*").eq("state", state).maybeSingle() : { data: null };
  if (!row.data) return new Response("This sign-in link has expired. Go back to the planner and press Connect OneDrive again.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  await db.from("onedrive_oauth_states").delete().eq("state", state);           // single use
  const st = row.data;
  if (new Date(st.expires_at).getTime() < Date.now()) return back(st.return_to, "expired");
  if (u.searchParams.get("error") || !code) return back(st.return_to, "cancelled");
  const r = await fetch(AUTHORITY + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: st.verifier, scope: SCOPES }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) {
    const code = (j.error || (r.ok ? "no_refresh_token" : "http_" + r.status)) + ((j.error_codes || []).length ? " " + j.error_codes.join(",") : "");
    console.error("onedrive token exchange failed:", code, String(j.error_description || "").split(String.fromCharCode(10))[0].trim().slice(0, 200));
    return back(st.return_to, "failed", code);
  }
  let label = "";
  try { const d = await fetch(GRAPH + "/me/drive?$select=id,owner", { headers: { Authorization: "Bearer " + j.access_token } }).then((x) => x.json()); label = d?.owner?.user?.displayName || ""; } catch { /* label is optional */ }
  const set = await db.rpc("onedrive_token_set", { p_user: st.user_id, p_token: j.refresh_token, p_label: label });
  if (set.error) { console.error("onedrive token store failed:", set.error.message); return back(st.return_to, "failed", "store: " + set.error.message); }
  tokenCache.set(st.user_id, { token: j.access_token, until: Date.now() + (j.expires_in || 3600) * 1000 });
  await db.from("knowledge_sources").update({ status: "ok", last_error: null }).eq("user_id", st.user_id).eq("status", "reconnect");
  return back(st.return_to, "connected");
}
async function disconnect(req: Request, uid: string) {
  await db.rpc("onedrive_token_delete", { p_user: uid });
  tokenCache.delete(uid);
  await db.from("knowledge_jobs").update({ status: "failed", error: "disconnected", finished_at: new Date().toISOString() }).eq("user_id", uid).in("status", ["queued", "running"]);
  await db.from("knowledge_sources").update({ status: "reconnect", last_error: "OneDrive is disconnected" }).eq("user_id", uid).is("archived_at", null);
  return json(req, { ok: true, note: "Stored access is deleted. To also remove the app from your Microsoft account: account.microsoft.com > Privacy > Apps and services." });
}

// ---------------------------------------------------------------- status, browsing, sources
async function status(req: Request, uid: string) {
  const [c, s, j] = await Promise.all([
    db.from("onedrive_connection").select("status,account_label,connected_at,last_refresh_at,last_error").eq("user_id", uid).maybeSingle(),
    db.from("knowledge_sources").select("*").eq("user_id", uid).is("archived_at", null).order("created_at"),
    db.from("knowledge_jobs").select("source_id,status,kind,stats,not_before,created_at").eq("user_id", uid).in("status", ["queued", "running"]),
  ]);
  const sources = (s.data || []).map((x) => ({ id: x.id, path: x.display_path, privacy: x.privacy, indexPrivately: x.index_privately, overrides: x.privacy_overrides, zone: x.zone, includeSubfolders: x.include_subfolders, fileTypes: x.file_types, excludes: x.excludes, ocr: x.ocr, maxIndexMb: x.max_index_mb, status: (j.data || []).some((q) => q.source_id === x.id) ? "syncing" : x.status, lastSyncedAt: x.last_synced_at, items: x.item_count, indexed: x.indexed_count, lastError: x.last_error }));
  return json(req, { configured: !!CLIENT_ID && !!CLIENT_SECRET, connected: !!c.data, status: c.data?.status || "disconnected", account: c.data?.account_label || "", connectedAt: c.data?.connected_at || null, sources, commit: BUILD_COMMIT });
}
async function browse(req: Request, uid: string) {
  const body = await req.json().catch(() => ({}));
  const id = body.folderId ? String(body.folderId) : null;
  if (id && !/^[A-Za-z0-9!._-]{1,200}$/.test(id)) return json(req, { error: "bad folder id" }, 400);
  const here = id ? await graph(uid, "/me/drive/items/" + encodeURIComponent(id) + "?$select=id,name,parentReference") : await graph(uid, "/me/drive/root?$select=id,name,parentReference");
  const folders: { id: string; name: string; children: number }[] = [];
  let next: string | null = "/me/drive/items/" + encodeURIComponent(here.id) + "/children?$select=id,name,folder&$top=200";
  for (let i = 0; next && i < 10; i++) {
    const page = await graph(uid, next);
    for (const it of page.value || []) if (it.folder && !it.name.startsWith(".") && !ALWAYS_EXCLUDED_DIRS.includes(it.name.toLowerCase())) folders.push({ id: it.id, name: it.name, children: it.folder.childCount || 0 });
    next = page["@odata.nextLink"] || null;
  }
  const parentPath = here.parentReference?.path ? decodeURIComponent(String(here.parentReference.path).replace(/^\/drive\/root:?/, "")) : "";
  return json(req, { folder: { id: here.id, name: id ? here.name : "OneDrive", path: id ? (parentPath + "/" + here.name).replace(/^\/+/, "") : "", parentId: id ? here.parentReference?.id || null : null }, folders: folders.sort((a, b) => a.name.localeCompare(b.name)) });
}
const PRIV = ["index", "links", "private"];
// deno-lint-ignore no-explicit-any
function sourceFields(b: any, forNew: boolean): Record<string, unknown> | string {
  const f: Record<string, unknown> = {};
  if (b.privacy !== undefined) { if (!PRIV.includes(b.privacy)) return "privacy must be index, links or private"; f.privacy = b.privacy; } else if (forNew) f.privacy = "links";
  if (b.zone !== undefined) { if (!/^[a-z][a-z0-9_-]{1,29}$/.test(b.zone)) return "zone must be a short lower-case name"; f.zone = b.zone; }
  if (b.includeSubfolders !== undefined) f.include_subfolders = !!b.includeSubfolders;
  if (b.indexPrivately !== undefined) f.index_privately = !!b.indexPrivately;
  if (b.ocr !== undefined) f.ocr = !!b.ocr;
  if (b.maxIndexMb !== undefined) { const n = Math.round(+b.maxIndexMb); if (!(n >= 1 && n <= 500)) return "maxIndexMb must be 1 to 500"; f.max_index_mb = n; }
  if (b.fileTypes !== undefined) { if (!Array.isArray(b.fileTypes) || b.fileTypes.length > 40) return "fileTypes must be a list"; f.file_types = b.fileTypes.map((x: string) => String(x).toLowerCase().replace(/^\./, "").slice(0, 10)); }
  if (b.excludes !== undefined) { if (!Array.isArray(b.excludes) || b.excludes.length > 40) return "excludes must be a list"; f.excludes = b.excludes.map((x: string) => String(x).slice(0, 80)); }
  if (b.overrides !== undefined) { if (typeof b.overrides !== "object" || Array.isArray(b.overrides)) return "overrides must be { subfolder: level }"; for (const v of Object.values(b.overrides)) if (!PRIV.includes(v as string)) return "each override must be index, links or private"; f.privacy_overrides = b.overrides; }
  return f;
}
async function addSource(req: Request, uid: string) {
  const b = await req.json().catch(() => ({}));
  const fields = sourceFields(b, true); if (typeof fields === "string") return json(req, { error: fields }, 400);
  if (!b.folderId) return json(req, { error: "folderId is required (from browse)" }, 400);
  const it = await graph(uid, "/me/drive/items/" + encodeURIComponent(b.folderId) + "?$select=id,name,folder,parentReference");
  if (!it.folder) return json(req, { error: "that is a file, not a folder" }, 400);
  const parentPath = it.parentReference?.path ? decodeURIComponent(String(it.parentReference.path).replace(/^\/drive\/root:?/, "")) : "";
  const path = (parentPath + "/" + it.name).replace(/^\/+/, "");
  const dup = await db.from("knowledge_sources").select("id").eq("user_id", uid).eq("folder_item_id", it.id).is("archived_at", null).maybeSingle();
  if (dup.data) return json(req, { ok: true, alreadyExisted: true, id: dup.data.id });
  const ins = await db.from("knowledge_sources").insert({ user_id: uid, provider: "onedrive", drive_id: it.parentReference?.driveId || "", folder_item_id: it.id, display_path: path, zone: "documents", ...fields }).select("id").single();
  if (ins.error) return json(req, { error: ins.error.message }, 500);
  await enqueue(uid, ins.data.id, "full");
  await runJobs(uid, 1);
  return json(req, { ok: true, id: ins.data.id, path });
}
async function updateSource(req: Request, uid: string) {
  const b = await req.json().catch(() => ({}));
  const fields = sourceFields(b, false); if (typeof fields === "string") return json(req, { error: fields }, 400);
  const cur = await db.from("knowledge_sources").select("*").eq("id", b.id).eq("user_id", uid).is("archived_at", null).maybeSingle();
  if (!cur.data) return json(req, { error: "no source with that id" }, 404);
  const up = await db.from("knowledge_sources").update(fields).eq("id", b.id).eq("user_id", uid);
  if (up.error) return json(req, { error: up.error.message }, 500);
  // a change that affects which files are kept or how they are treated: walk the folder again
  const rescan = ["privacy", "index_privately", "privacy_overrides", "include_subfolders", "file_types", "excludes", "ocr", "max_index_mb"].some((k) => k in fields);
  if ("zone" in fields) await db.from("knowledge_items").update({ zone: fields.zone, updated_at: new Date().toISOString() }).eq("user_id", uid).eq("source_id", b.id);
  if (rescan) { await db.from("knowledge_sources").update({ delta_link: null }).eq("id", b.id); await enqueue(uid, b.id, "full"); await runJobs(uid, 1); }
  return json(req, { ok: true, rescanning: rescan });
}
async function removeSource(req: Request, uid: string) {
  const b = await req.json().catch(() => ({}));
  const now = new Date().toISOString();
  const up = await db.from("knowledge_sources").update({ archived_at: now }).eq("id", b.id).eq("user_id", uid).is("archived_at", null).select("id").maybeSingle();
  if (!up.data) return json(req, { error: "no source with that id" }, 404);
  const items = await db.from("knowledge_items").update({ archived_at: now, updated_at: now }).eq("user_id", uid).eq("source_id", b.id).is("archived_at", null).select("id");
  await db.from("knowledge_jobs").update({ status: "failed", error: "source removed", finished_at: now }).eq("source_id", b.id).in("status", ["queued", "running"]);
  return json(req, { ok: true, itemsArchived: (items.data || []).length, note: "Nothing in OneDrive was touched." });
}

// ---------------------------------------------------------------- sync queue
async function enqueue(uid: string, sourceId: string, kind: "delta" | "full") {
  const open = await db.from("knowledge_jobs").select("id").eq("source_id", sourceId).in("status", ["queued", "running"]).maybeSingle();
  if (open.data) return open.data.id;
  if (kind === "full") await db.from("knowledge_sources").update({ delta_link: null }).eq("id", sourceId);
  const ins = await db.from("knowledge_jobs").insert({ user_id: uid, source_id: sourceId, kind }).select("id").single();
  await db.from("knowledge_sources").update({ status: "syncing" }).eq("id", sourceId);
  return ins.data?.id;
}
async function syncNow(req: Request, uid: string) {
  const b = await req.json().catch(() => ({}));
  const src = await db.from("knowledge_sources").select("id").eq("id", b.id).eq("user_id", uid).is("archived_at", null).maybeSingle();
  if (!src.data) return json(req, { error: "no source with that id" }, 404);
  await enqueue(uid, b.id, b.full ? "full" : "delta");
  const done = await runJobs(uid, 1);
  return json(req, { ok: true, ...done });
}
// Run queued jobs until the time budget is spent. Each job resumes from its saved page link.
async function runJobs(uid: string | null, maxJobs = 5) {
  const t0 = Date.now(); let ran = 0, finished = 0;
  while (ran < maxJobs && Date.now() - t0 < CHUNK_MS) {
    let q = db.from("knowledge_jobs").select("*").in("status", ["queued", "running"]).lte("not_before", new Date().toISOString()).order("created_at").limit(1);
    if (uid) q = q.eq("user_id", uid);
    const j = await q.maybeSingle();
    if (!j.data) break;
    const job = j.data;
    // a "running" job whose worker died more than 2 minutes ago may be picked up again
    if (job.status === "running" && job.locked_at && Date.now() - new Date(job.locked_at).getTime() < 120000) break;
    const lock = await db.from("knowledge_jobs").update({ status: "running", locked_at: new Date().toISOString(), attempts: job.attempts + 1 }).eq("id", job.id).eq("status", job.status).select("id").maybeSingle();
    if (!lock.data) break;
    ran++;
    try { if (await runJob(job, t0)) finished++; }
    catch (e) {
      if (e instanceof Throttled) await db.from("knowledge_jobs").update({ status: "queued", not_before: new Date(Date.now() + e.seconds * 1000).toISOString() }).eq("id", job.id);
      else if (e instanceof Reconnect) await db.from("knowledge_jobs").update({ status: "failed", error: "reconnect needed", finished_at: new Date().toISOString() }).eq("id", job.id);
      else {
        const msg = String((e as Error).message || e).slice(0, 300), giveUp = job.attempts + 1 >= 5;
        await db.from("knowledge_jobs").update({ status: giveUp ? "failed" : "queued", error: msg, not_before: new Date(Date.now() + 60000 * (job.attempts + 1)).toISOString(), finished_at: giveUp ? new Date().toISOString() : null }).eq("id", job.id);
        if (giveUp) await db.from("knowledge_sources").update({ status: "error", last_error: "Sync stopped after 5 tries: " + msg.slice(0, 120) }).eq("id", job.source_id);
      }
    }
  }
  return { jobsRun: ran, jobsFinished: finished };
}
// deno-lint-ignore no-explicit-any
async function runJob(job: any, t0: number): Promise<boolean> {
  const src = (await db.from("knowledge_sources").select("*").eq("id", job.source_id).maybeSingle()).data;
  if (!src || src.archived_at) { await db.from("knowledge_jobs").update({ status: "done", finished_at: new Date().toISOString() }).eq("id", job.id); return true; }
  const uid = src.user_id, stats = { added: 0, updated: 0, moved: 0, archived: 0, skipped: 0, ...(job.stats || {}) };
  // folders under the source: id -> { name, parent }, kept in the job so paths can be built from delta pages
  const folders: Record<string, { n: string; p: string | null }> = (job.stats && job.stats.folders) || {};
  let next: string = job.cursor || src.delta_link || ("/me/drive/items/" + encodeURIComponent(src.folder_item_id) + "/delta?$select=id,name,file,folder,deleted,parentReference,size,createdDateTime,lastModifiedDateTime,webUrl,eTag,cTag,root");
  if (job.kind === "delta" && !job.cursor && src.delta_link) {
    // the folder map lives on the previous finished job
    const prev = await db.from("knowledge_jobs").select("stats").eq("source_id", src.id).eq("status", "done").order("finished_at", { ascending: false }).limit(1).maybeSingle();
    Object.assign(folders, prev.data?.stats?.folders || {});
  }
  const seen = job.kind === "full" ? new Set<string>((job.stats && job.stats.seen) || []) : null;
  while (true) {
    const page = await graph(uid, next);
    await applyPage(src, page.value || [], folders, stats, seen);
    if (page["@odata.nextLink"]) {
      next = page["@odata.nextLink"];
      if (Date.now() - t0 > CHUNK_MS) {
        await db.from("knowledge_jobs").update({ cursor: next, status: "queued", stats: { ...stats, folders, seen: seen ? Array.from(seen) : undefined } }).eq("id", job.id);
        return false;
      }
      continue;
    }
    // finished: on a full scan, anything of this source not seen any more is gone
    if (seen) {
      const all = await db.from("knowledge_items").select("id,provider_item_id").eq("source_id", src.id).is("archived_at", null).limit(20000);
      const gone = (all.data || []).filter((x) => !seen.has(x.provider_item_id)).map((x) => x.id);
      for (let i = 0; i < gone.length; i += 200) await db.from("knowledge_items").update({ archived_at: new Date().toISOString(), gone_at: new Date().toISOString() }).in("id", gone.slice(i, i + 200));
      stats.archived += gone.length;
    }
    const [cnt, idx] = await Promise.all([
      db.from("knowledge_items").select("id", { count: "exact", head: true }).eq("source_id", src.id).is("archived_at", null),
      db.from("knowledge_items").select("id", { count: "exact", head: true }).eq("source_id", src.id).is("archived_at", null).eq("index_status", "indexed"),
    ]);
    await db.from("knowledge_sources").update({ delta_link: page["@odata.deltaLink"] || null, last_synced_at: new Date().toISOString(), status: "ok", last_error: null, item_count: cnt.count || 0, indexed_count: idx.count || 0 }).eq("id", src.id);
    await db.from("knowledge_jobs").update({ status: "done", cursor: null, finished_at: new Date().toISOString(), stats: { ...stats, folders, seen: undefined } }).eq("id", job.id);
    return true;
  }
}
// the folder as the page shows it under "Group by Folder": the OneDrive path, " / " between levels
// deno-lint-ignore no-explicit-any
const folderOf = (src: any, rel: string | null) => (src.display_path + (rel ? "/" + rel : "")).split("/").filter(Boolean).join(" / ");
// relative folder path of a parent id inside the source ("" = the source folder itself)
function relOf(folders: Record<string, { n: string; p: string | null }>, rootId: string, parentId: string | null): string | null {
  const parts: string[] = []; let cur = parentId;
  for (let i = 0; i < 64 && cur; i++) { if (cur === rootId) return parts.reverse().join("/"); const f = folders[cur]; if (!f) return null; parts.push(f.n); cur = f.p; }
  return null;
}
// deno-lint-ignore no-explicit-any
async function applyPage(src: any, items: any[], folders: Record<string, { n: string; p: string | null }>, stats: any, seen: Set<string> | null) {
  for (const it of items) if (it.folder && it.id !== src.folder_item_id) { if (it.deleted) delete folders[it.id]; else folders[it.id] = { n: it.name, p: it.parentReference?.id || null }; }
  const files = items.filter((it) => it.file || (it.deleted && !it.folder));
  if (!files.length) return;
  const ids = files.map((f) => f.id);
  const have = await db.from("knowledge_items").select("id,provider_item_id,ctag,etag,remote_path,title,index_status,archived_at,source_id").eq("user_id", src.user_id).eq("provider", "onedrive").in("provider_item_id", ids);
  // deno-lint-ignore no-explicit-any
  const byPid: Record<string, any> = {}; for (const h of have.data || []) byPid[h.provider_item_id] = h;
  const now = new Date().toISOString();
  for (const f of files) {
    const cur = byPid[f.id];
    const rel = f.deleted ? null : relOf(folders, src.folder_item_id, f.parentReference?.id || null);
    const verdict = f.deleted || rel === null ? { keep: false, reason: "gone" } : classify(src, rel, f.name, f.size || 0);
    if (!verdict.keep) {
      // deleted, moved out of the source, or now excluded: archive what we had
      if (cur && !cur.archived_at && cur.source_id === src.id) { await db.from("knowledge_items").update({ archived_at: now, gone_at: f.deleted || rel === null ? now : null, updated_at: now }).eq("id", cur.id); stats.archived++; }
      else stats.skipped++;
      continue;
    }
    seen?.add(f.id);
    const remotePath = (src.display_path + "/" + (rel ? rel + "/" : "") + f.name).replace(/^\/+/, "");
    const row: Record<string, unknown> = {
      title: f.name, remote_path: remotePath, mime_type: f.file?.mimeType || null, size_bytes: f.size || 0,
      remote_created_at: f.createdDateTime || null, remote_modified_at: f.lastModifiedDateTime || null, web_url: f.webUrl || null, url: f.webUrl || null,
      etag: f.eTag || null, ctag: f.cTag || null, content_hash: f.file?.hashes?.sha1Hash || f.file?.hashes?.quickXorHash || null,
      privacy: verdict.privacy, zone: src.zone, source_id: src.id, archived_at: null, gone_at: null, updated_at: now,
    };
    if (!cur) {
      const ins = await db.from("knowledge_items").insert({ ...row, user_id: src.user_id, provider: "onedrive", provider_item_id: f.id, type: typeFor(src.zone, verdict.kind || "other"), summary: "", why: "", tags: [], meta: { folder: folderOf(src, rel), ext: ext(f.name) }, source: "onedrive", index_status: verdict.status });
      if (ins.error && /url/.test(ins.error.message)) await db.from("knowledge_items").insert({ ...row, url: null, user_id: src.user_id, provider: "onedrive", provider_item_id: f.id, type: typeFor(src.zone, verdict.kind || "other"), summary: "", why: "", tags: [], meta: { folder: folderOf(src, rel), ext: ext(f.name) }, source: "onedrive", index_status: verdict.status });
      stats.added++;
      continue;
    }
    const changed = cur.ctag !== f.cTag;
    if (cur.remote_path !== remotePath) stats.moved++; else if (changed || cur.archived_at) stats.updated++;
    // content changed, or the treatment changed: re-read (or stop reading) as the new level says
    if (changed || cur.index_status !== verdict.status && !(cur.index_status === "indexed" && verdict.status === "pending")) row.index_status = verdict.status;
    if (verdict.status !== "pending" && cur.index_status === "indexed") await db.from("knowledge_chunks").delete().eq("item_id", cur.id);   // stop keeping text the owner no longer allows
    if (changed && verdict.status === "pending") await db.from("knowledge_chunks").delete().eq("item_id", cur.id);
    const meta = { folder: folderOf(src, rel), ext: ext(f.name) };
    await db.from("knowledge_items").update({ ...row, meta }).eq("id", cur.id);
  }
}

// ---------------------------------------------------------------- one file's bytes, for the page only
async function fetchFile(req: Request, uid: string) {
  const b = await req.json().catch(() => ({}));
  const it = await db.from("knowledge_items").select("id,provider_item_id,privacy,index_status,source_id,size_bytes,title").eq("id", b.itemId).eq("user_id", uid).eq("provider", "onedrive").is("archived_at", null).maybeSingle();
  if (!it.data) return json(req, { error: "no OneDrive item with that id" }, 404);
  const purpose = b.purpose === "save" ? "save" : "index";
  // reading content is only allowed for Index items (and Private ones the owner indexes privately), or an explicit "save a copy"
  if (purpose === "index" && it.data.index_status !== "pending" && it.data.index_status !== "indexed" && it.data.index_status !== "failed") return json(req, { error: "this file is not set to be read" }, 403);
  const src = await db.from("knowledge_sources").select("max_index_mb").eq("id", it.data.source_id).maybeSingle();
  const cap = purpose === "save" ? 250 : (src.data?.max_index_mb || 50);
  if ((it.data.size_bytes || 0) > cap * 1048576) return json(req, { error: "file is larger than " + cap + " MB" }, 413);
  const asPdf = !!b.pdf && purpose === "index";
  const r = await fetch(GRAPH + "/me/drive/items/" + encodeURIComponent(it.data.provider_item_id) + "/content" + (asPdf ? "?format=pdf" : ""), { headers: { Authorization: "Bearer " + await accessToken(uid) }, redirect: "follow" });
  if (r.status === 429) return json(req, { error: "OneDrive asked to wait", retryAfter: +(r.headers.get("retry-after") || 30) }, 429);
  if (!r.ok || !r.body) return json(req, { error: "OneDrive returned " + r.status }, 502);
  return new Response(r.body, { status: 200, headers: { "Content-Type": asPdf ? "application/pdf" : (r.headers.get("content-type") || "application/octet-stream"), "Cache-Control": "no-store", ...cors(req) } });
}

// ---------------------------------------------------------------- router
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  const path = new URL(req.url).pathname.replace(/^.*\/knowledge-onedrive/, "") || "/";
  try {
    if (path === "/callback" && req.method === "GET") return await callback(req);
    if (path === "/cron/enqueue" || path === "/cron/work") {
      if (!(await cronOk(req))) return json(req, { error: "unauthorized" }, 401);
      if (path === "/cron/enqueue") {
        const s = await db.from("knowledge_sources").select("id,user_id").is("archived_at", null).neq("status", "reconnect");
        for (const x of s.data || []) await enqueue(x.user_id, x.id, "delta");
        return json(req, { ok: true, queued: (s.data || []).length });
      }
      return json(req, { ok: true, ...(await runJobs(null, 10)) });
    }
    if (path === "/" && req.method === "GET") return json(req, { service: "knowledge-onedrive", configured: !!CLIENT_ID && !!CLIENT_SECRET, commit: BUILD_COMMIT });
    if (req.method !== "POST") return json(req, { error: "not found" }, 404);
    const who = await caller(req);
    if (!who) return json(req, { error: "unauthorized" }, 401);
    switch (path) {
      case "/start": return who.via === "page" ? await start(req, who.uid) : json(req, { error: "connect from the Knowledge page" }, 403);
      case "/status": return await status(req, who.uid);
      case "/disconnect": return who.via === "page" ? await disconnect(req, who.uid) : json(req, { error: "disconnect from the Knowledge page" }, 403);
      case "/browse": return await browse(req, who.uid);
      case "/sources/add": return await addSource(req, who.uid);
      case "/sources/update": return await updateSource(req, who.uid);
      case "/sources/remove": return await removeSource(req, who.uid);
      case "/sync": return await syncNow(req, who.uid);
      case "/fetch": return who.via === "page" ? await fetchFile(req, who.uid) : json(req, { error: "file contents are only read in the owner's browser" }, 403);
    }
    return json(req, { error: "not found" }, 404);
  } catch (e) {
    if (e instanceof Reconnect) return json(req, { error: "reconnect", message: "OneDrive needs to be reconnected" }, 409);
    if (e instanceof Throttled) return json(req, { error: "OneDrive asked to wait", retryAfter: e.seconds }, 429);
    return json(req, { error: String((e as Error).message || e).slice(0, 300) }, 500);
  }
});
