// ============================================================================
// comm-mail: read-only bridge between the owner's iCloud Mail and the Communication page.
//
// - Sign-in: iCloud has no OAuth for mail, only IMAP with an app-specific password. The owner pastes it
//   into the page once; it goes straight here, is checked against iCloud, and is stored encrypted in
//   Supabase Vault (public.comm_secret_*). It is never sent back to the browser or logged.
// - Sync: Inbox and Sent, newest first. Only sender, recipients, subject, date, flags and a short preview
//   are stored (public.comm_messages). New mail arrives through pg_cron every 10 minutes or "Sync now".
// - Reading: /body fetches one full email from iCloud when the owner opens it and keeps nothing.
// - Nothing is ever written to iCloud: no flags are changed, nothing is moved, sent or deleted.
//
// Callers: the page (Supabase user JWT), the planner-mcp connector (x-internal-key = service role key,
// acting for OWNER_USER_ID) and the cron schedule (x-cron-key from knowledge_cron_key).
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OWNER = Deno.env.get("OWNER_USER_ID") ?? "";
const ORIGINS = (Deno.env.get("COMM_ORIGINS") ?? "https://majdmurad-mm.github.io,http://localhost:8977,http://127.0.0.1:8977").split(",").map((s) => s.trim()).filter(Boolean);
const BUILD_COMMIT = "__BUILD_COMMIT__";
const HOST = "imap.mail.me.com", PORT = 993;
const FIRST_DAYS = 180;          // the first sync reaches back this far
const FIRST_MAX = 400;           // and at most this many messages per folder
const PER_RUN = 60;              // messages read per call (keeps each call well inside the CPU limit)
const RUN_MS = 35000;            // and stop after this long; the next call carries on
const COMM_HINT = " (run _Memory/migration_communication.sql in the Supabase SQL editor first)";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------- http helpers
function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) } });
function safeEqual(a: string, b: string) { if (!a || !b || a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
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

// ---------------------------------------------------------------- pure helpers (exported for tests)
export const ids = (s: string) => (String(s || "").match(/<[^<>\s]+>/g) || []).map((x) => x.toLowerCase());
export function threadKeyOf(messageId: string | undefined, inReplyTo: string | undefined, references: string, fallback: string) {
  return ids(references)[0] || ids(inReplyTo || "")[0] || (messageId ? messageId.toLowerCase() : "") || fallback;
}
export const cleanSubject = (s: string) => String(s || "").replace(/^\s*((re|fw|fwd|aw|wg|antw|sv|vs)\s*(\[\d+\])?\s*:\s*)+/i, "").trim() || "(no subject)";
export function previewOf(text: string, html = false) {
  let t = String(text || "");
  if (html) t = t.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const lines = t.split(/\r?\n/), out: string[] = [];
  for (const l of lines) { if (/^\s*>/.test(l)) continue; if (/^(on .{4,80} wrote:|am .{4,80} schrieb .{1,80}:|-----\s*original message|von:\s)/i.test(l.trim())) break; out.push(l); }
  return out.join(" ").replace(/\s+/g, " ").trim().slice(0, 280);
}
// deno-lint-ignore no-explicit-any
export function textPart(node: any): { part: string; html: boolean } | null {
  if (!node) return null;
  let html: { part: string; html: boolean } | null = null;
  // deno-lint-ignore no-explicit-any
  const walk = (n: any): { part: string; html: boolean } | null => {
    const type = String(n.type || "").toLowerCase(), att = n.disposition === "attachment";
    if (!att && type === "text/plain") return { part: n.part || "1", html: false };
    if (!att && type === "text/html" && !html) html = { part: n.part || "1", html: true };
    for (const c of n.childNodes || []) { const r = walk(c); if (r) return r; }
    return null;
  };
  return walk(node) || html;
}
// deno-lint-ignore no-explicit-any
export const hasAttachment = (n: any): boolean => !!n && (n.disposition === "attachment" || (n.childNodes || []).some(hasAttachment));
const addr = (a?: { name?: string; address?: string }[]) => (a || []).map((x) => ({ name: x.name || "", address: (x.address || "").toLowerCase() }));

// ---------------------------------------------------------------- IMAP
class Reconnect extends Error {}
async function open(user: string, pass: string) {
  const c = new ImapFlow({ host: HOST, port: PORT, secure: true, auth: { user, pass }, logger: false, emitLogs: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000 });
  // deno-lint-ignore no-explicit-any
  c.on("error", () => {});
  try { await c.connect(); } catch (e) {
    // deno-lint-ignore no-explicit-any
    const m = String((e as any)?.responseText || (e as any)?.message || e);
    // deno-lint-ignore no-explicit-any
    if ((e as any)?.authenticationFailed || /auth|login|credentials|invalid/i.test(m)) throw new Reconnect("iCloud did not accept the address and app-specific password");
    throw new Error("Could not reach iCloud Mail: " + m.slice(0, 160));
  }
  return c;
}
async function streamBytes(stream: AsyncIterable<Uint8Array>, max: number) {
  const parts: Uint8Array[] = []; let n = 0;
  for await (const ch of stream) { const b = ch instanceof Uint8Array ? ch : new TextEncoder().encode(String(ch)); parts.push(b); n += b.length; if (n >= max) break; }
  const out = new Uint8Array(Math.min(n, max)); let o = 0; for (const p of parts) { const take = Math.min(p.length, out.length - o); out.set(p.subarray(0, take), o); o += take; if (o >= out.length) break; }
  return out;
}
// deno-lint-ignore no-explicit-any
async function folders(c: any) {
  // deno-lint-ignore no-explicit-any
  const list: any[] = await c.list();
  const inbox = list.find((b) => String(b.path).toUpperCase() === "INBOX");
  const sent = list.find((b) => b.specialUse === "\\Sent") || list.find((b) => /^sent( messages| items)?$/i.test(b.name || ""));
  return [inbox ? { path: inbox.path, out: false } : null, sent ? { path: sent.path, out: true } : null].filter(Boolean) as { path: string; out: boolean }[];
}

// deno-lint-ignore no-explicit-any
async function syncAccount(acc: any, budget = PER_RUN): Promise<{ added: number; more: boolean }> {
  const pass = await db.rpc("comm_secret_get", { p_account: acc.id });
  if (pass.error || !pass.data) { await db.from("comm_accounts").update({ status: "reconnect", last_error: "The app-specific password is missing; connect again" }).eq("id", acc.id); return { added: 0, more: false }; }
  const t0 = Date.now(), state = { ...(acc.state || {}) };
  let c, added = 0, more = false;
  await db.from("comm_accounts").update({ status: "syncing" }).eq("id", acc.id);
  try {
    c = await open(acc.address, pass.data as string);
    for (const f of await folders(c)) {
      const lock = await c.getMailboxLock(f.path);
      try {
        const mb = c.mailbox, uv = String(mb.uidValidity);
        let st = state[f.path] || {};
        if (st.uidValidity !== uv) st = { uidValidity: uv, lastUid: 0 };
        // which messages are new: on the first run the newest FIRST_MAX of the last FIRST_DAYS days
        let uids: number[] = [];
        if (!st.lastUid) uids = ((await c.search({ since: new Date(Date.now() - FIRST_DAYS * 864e5) }, { uid: true })) || []).slice(-FIRST_MAX);
        else uids = ((await c.search({ uid: (st.lastUid + 1) + ":*" }, { uid: true })) || []).filter((u: number) => u > st.lastUid);
        uids.sort((a, b) => a - b);
        if (!st.lastUid && st.firstFrom == null) st.firstFrom = uids[0] || 0;
        // newest first, so the page fills from the top; lastUid only moves once everything below it is in
        const todo = uids.slice().reverse(), rows: Record<string, unknown>[] = [];
        let done: number[] = st.done || [];
        for (const uid of todo) {
          if (done.includes(uid)) continue;
          if (added >= budget || Date.now() - t0 > RUN_MS) { more = true; break; }
          // deno-lint-ignore no-explicit-any
          const m: any = await c.fetchOne(String(uid), { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, headers: ["references"] }, { uid: true });
          if (!m) { done.push(uid); continue; }
          const env = m.envelope || {}, refs = m.headers ? new TextDecoder().decode(m.headers).replace(/^references:\s*/i, "") : "";
          let preview = "";
          const tp = textPart(m.bodyStructure);
          if (tp) { try { const d = await c.download(String(uid), tp.part, { uid: true, maxBytes: 6000 }); preview = previewOf(new TextDecoder().decode(await streamBytes(d.content, 6000)), tp.html); } catch { /* preview stays empty */ } }
          const ext = f.path + ":" + uv + ":" + uid, from = addr(env.from)[0] || { name: "", address: "" };
          rows.push({
            user_id: acc.user_id, account_id: acc.id, provider: "icloud", external_id: ext,
            thread_key: threadKeyOf(env.messageId, env.inReplyTo, refs, ext), thread_title: cleanSubject(env.subject || ""),
            folder: f.path, direction: f.out ? "out" : "in", from_name: from.name, from_addr: from.address,
            to_list: addr(env.to).concat(addr(env.cc)).slice(0, 30), subject: String(env.subject || "").slice(0, 300), preview,
            message_id: env.messageId || null, sent_at: new Date(env.date || m.internalDate || Date.now()).toISOString(),
            unread: !(m.flags && (m.flags.has ? m.flags.has("\\Seen") : [...m.flags].includes("\\Seen"))), has_attachments: hasAttachment(m.bodyStructure),
          });
          done.push(uid); added++;
          if (rows.length >= 20) { const up = await db.from("comm_messages").upsert(rows.splice(0), { onConflict: "user_id,provider,external_id" }); if (up.error) throw new Error(up.error.message); }
        }
        if (rows.length) { const up = await db.from("comm_messages").upsert(rows, { onConflict: "user_id,provider,external_id" }); if (up.error) throw new Error(up.error.message); }
        if (uids.length && uids.every((u) => done.includes(u))) { st.lastUid = Math.max(st.lastUid || 0, ...uids); done = []; }
        st.done = done.slice(-2000);
        // read/unread and messages that left the folder, for the last 30 days (never changes iCloud)
        if (!more) {
          const recent: number[] = (await c.search({ since: new Date(Date.now() - 30 * 864e5) }, { uid: true })) || [];
          if (recent.length) {
            const unread: string[] = [], read: string[] = [];
            for await (const x of c.fetch(recent.slice(-300).join(","), { uid: true, flags: true }, { uid: true })) {
              // deno-lint-ignore no-explicit-any
              const seen = (x as any).flags && ((x as any).flags.has ? (x as any).flags.has("\\Seen") : false);
              (seen ? read : unread).push(f.path + ":" + uv + ":" + (x as { uid: number }).uid);
            }
            if (unread.length) await db.from("comm_messages").update({ unread: true }).eq("account_id", acc.id).in("external_id", unread).eq("unread", false);
            if (read.length) await db.from("comm_messages").update({ unread: false }).eq("account_id", acc.id).in("external_id", read).eq("unread", true);
            const keep = new Set(recent.map((u) => f.path + ":" + uv + ":" + u));
            const mine = await db.from("comm_messages").select("id,external_id").eq("account_id", acc.id).eq("folder", f.path).is("archived_at", null).gte("sent_at", new Date(Date.now() - 29 * 864e5).toISOString()).limit(1000);
            const gone = (mine.data || []).filter((r) => !keep.has(r.external_id)).map((r) => r.id);
            if (gone.length) await db.from("comm_messages").update({ archived_at: new Date().toISOString() }).in("id", gone);
          }
        }
        state[f.path] = st;
      } finally { lock.release(); }
      await db.from("comm_accounts").update({ state }).eq("id", acc.id);
      if (more) break;
    }
    await db.from("comm_accounts").update({ status: "ok", last_error: null, last_sync_at: new Date().toISOString(), state }).eq("id", acc.id);
  } catch (e) {
    const rc = e instanceof Reconnect;
    await db.from("comm_accounts").update({ status: rc ? "reconnect" : "error", last_error: String((e as Error).message || e).slice(0, 300), state }).eq("id", acc.id);
    if (rc) throw e;
    throw e;
  } finally { if (c) { try { await c.logout(); } catch { /* closed */ } } }
  return { added, more };
}

// ---------------------------------------------------------------- routes
async function connect(req: Request, uid: string) {
  // deno-lint-ignore no-explicit-any
  const b: any = await req.json().catch(() => ({}));
  const address = String(b.address || "").trim().toLowerCase(), pass = String(b.password || "").replace(/\s+/g, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return json(req, { error: "Enter your iCloud email address" }, 400);
  if (pass.length < 12) return json(req, { error: "Paste the app-specific password from account.apple.com (it looks like abcd-efgh-ijkl-mnop)" }, 400);
  // check it with iCloud before anything is stored
  try { const c = await open(address, pass); await c.logout(); } catch (e) { return json(req, { error: e instanceof Reconnect ? "iCloud did not accept that. Check the address and create a new app-specific password." : String((e as Error).message) }, 400); }
  const f = await db.from("comm_accounts").select("id").eq("user_id", uid).eq("provider", "icloud").ilike("address", address).is("archived_at", null).maybeSingle();
  if (f.error) return json(req, { error: f.error.message + COMM_HINT }, 500);
  let id = f.data?.id;
  if (!id) {
    const i = await db.from("comm_accounts").insert({ user_id: uid, provider: "icloud", address, label: "iCloud Mail" }).select("id").single();
    if (i.error) return json(req, { error: i.error.message + COMM_HINT }, 500);
    id = i.data.id;
  }
  const s = await db.rpc("comm_secret_set", { p_account: id, p_secret: pass });
  if (s.error) return json(req, { error: "Could not store the password safely: " + s.error.message }, 500);
  await db.from("comm_accounts").update({ status: "ok", last_error: null }).eq("id", id);
  return json(req, { ok: true, id });
}
async function syncNow(req: Request, uid: string) {
  // deno-lint-ignore no-explicit-any
  const b: any = await req.json().catch(() => ({}));
  const q = db.from("comm_accounts").select("*").eq("user_id", uid).eq("provider", "icloud").is("archived_at", null);
  const a = b.accountId ? await q.eq("id", b.accountId) : await q;
  if (a.error) return json(req, { error: a.error.message + COMM_HINT }, 500);
  let added = 0, more = false;
  for (const acc of a.data || []) { try { const r = await syncAccount(acc); added += r.added; more = more || r.more; } catch (e) { return json(req, { error: String((e as Error).message), reconnect: e instanceof Reconnect }, e instanceof Reconnect ? 409 : 502); } }
  return json(req, { ok: true, added, more });
}
async function body(req: Request, uid: string) {
  // deno-lint-ignore no-explicit-any
  const b: any = await req.json().catch(() => ({}));
  const m = await db.from("comm_messages").select("id,account_id,external_id,provider").eq("id", String(b.id || "")).eq("user_id", uid).maybeSingle();
  if (!m.data || m.data.provider !== "icloud") return json(req, { error: "no email with that id" }, 404);
  const acc = await db.from("comm_accounts").select("id,address").eq("id", m.data.account_id).maybeSingle();
  const pass = await db.rpc("comm_secret_get", { p_account: m.data.account_id });
  if (!acc.data || pass.error || !pass.data) return json(req, { error: "iCloud Mail needs to be connected again", reconnect: true }, 409);
  const parts = m.data.external_id.split(":"), uidNo = parts.pop()!, uv = parts.pop()!, path = parts.join(":");
  const c = await open(acc.data.address, pass.data as string);
  try {
    const lock = await c.getMailboxLock(path, { readOnly: true });
    try {
      if (String(c.mailbox.uidValidity) !== uv) return json(req, { error: "This email moved in iCloud since it was synced" }, 410);
      const d = await c.download(uidNo, undefined, { uid: true, maxBytes: 8 * 1048576 });
      const raw = await streamBytes(d.content, 8 * 1048576);
      const p = await PostalMime.parse(raw);
      return json(req, {
        text: p.text || "", html: p.html || "",
        // deno-lint-ignore no-explicit-any
        attachments: (p.attachments || []).filter((x: any) => x.disposition !== "inline").map((x: any) => ({ name: x.filename || "attachment", type: x.mimeType, size: x.content ? (x.content.byteLength || x.content.length || 0) : 0 })),
      });
    } finally { lock.release(); }
  } finally { try { await c.logout(); } catch { /* closed */ } }
}
async function disconnect(req: Request, uid: string) {
  // deno-lint-ignore no-explicit-any
  const b: any = await req.json().catch(() => ({}));
  const a = await db.from("comm_accounts").select("id").eq("id", String(b.accountId || "")).eq("user_id", uid).maybeSingle();
  if (!a.data) return json(req, { error: "no such account" }, 404);
  await db.rpc("comm_secret_delete", { p_account: a.data.id });
  // the account and its messages are archived, not deleted
  await db.from("comm_accounts").update({ archived_at: new Date().toISOString(), status: "disconnected" }).eq("id", a.data.id);
  return json(req, { ok: true });
}
async function access(req: Request, uid: string) {
  // deno-lint-ignore no-explicit-any
  const b: any = await req.json().catch(() => ({}));
  const r = await db.from("comm_accounts").update({ claude_access: !!b.on }).eq("id", String(b.accountId || "")).eq("user_id", uid).select("id");
  if (r.error || !r.data?.length) return json(req, { error: r.error?.message || "no such account" }, 400);
  return json(req, { ok: true });
}
// can this function reach iCloud's mail server at all (no sign-in)
async function probe(req: Request) {
  try {
    const conn = await Deno.connectTls({ hostname: HOST, port: PORT });
    const buf = new Uint8Array(200), n = await Promise.race([conn.read(buf), new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
    conn.close();
    const greet = n ? new TextDecoder().decode(buf.subarray(0, n as number)) : "";
    return json(req, { reachable: /^\* OK/.test(greet), greeting: greet.slice(0, 40).trim() });
  } catch (e) { return json(req, { reachable: false, error: String((e as Error).message).slice(0, 200) }); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  const path = new URL(req.url).pathname.replace(/^.*\/comm-mail/, "") || "/";
  try {
    if (path === "/" && req.method === "GET") return json(req, { service: "comm-mail", commit: BUILD_COMMIT });
    if (path === "/probe" && req.method === "GET") return await probe(req);
    if (path === "/cron/sync") {
      if (!(await cronOk(req))) return json(req, { error: "unauthorized" }, 401);
      const a = await db.from("comm_accounts").select("*").eq("provider", "icloud").is("archived_at", null).neq("status", "reconnect");
      let added = 0; for (const acc of a.data || []) { try { added += (await syncAccount(acc)).added; } catch { /* recorded on the account */ } }
      return json(req, { ok: true, accounts: (a.data || []).length, added });
    }
    if (req.method !== "POST") return json(req, { error: "not found" }, 404);
    const who = await caller(req);
    if (!who) return json(req, { error: "unauthorized" }, 401);
    switch (path) {
      case "/connect": return who.via === "page" ? await connect(req, who.uid) : json(req, { error: "connect from the Communication page" }, 403);
      case "/sync": return await syncNow(req, who.uid);
      case "/body": return await body(req, who.uid);
      case "/disconnect": return who.via === "page" ? await disconnect(req, who.uid) : json(req, { error: "disconnect from the Communication page" }, 403);
      case "/access": return who.via === "page" ? await access(req, who.uid) : json(req, { error: "change this on the Communication page" }, 403);
    }
    return json(req, { error: "not found" }, 404);
  } catch (e) {
    if (e instanceof Reconnect) return json(req, { error: "iCloud Mail needs to be connected again", reconnect: true }, 409);
    return json(req, { error: String((e as Error).message || e).slice(0, 300) }, 500);
  }
});
