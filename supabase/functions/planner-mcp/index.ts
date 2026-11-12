// ============================================================================
// planner-mcp — a remote MCP server that exposes this personal planner's data
// to Claude Cowork (or any MCP client) as a custom connector.
//
// Runs as a Supabase Edge Function, sitting right next to the Postgres data it
// serves. It authenticates ONE way: a fixed bearer token checked against the
// MCP_TOKEN secret (see auth middleware at the bottom). In Cowork you paste
//   Authorization: Bearer <that token>
// into the connector's "Request headers" field — no OAuth server to stand up.
//
// Because the whole app is single-user with per-user RLS (auth.uid() = user_id),
// this function talks to Postgres with the SERVICE ROLE key (which bypasses RLS)
// and manually scopes EVERY read and write to one owner id (the OWNER_USER_ID
// secret). The service key never leaves the server; Cowork only ever sees the
// bearer token and the tool results.
//
// Endpoint (after deploy):
//   https://<project-ref>.supabase.co/functions/v1/planner-mcp/mcp
//
// The tool surface mirrors the app's own in-page "Agent" tools (create/edit
// goals, projects, actions, events, notes, people, decisions) plus read
// tools for pulling the current state. Like the in-app agent, it can create and
// edit but NEVER delete — deletion stays a manual action in the app. That
// includes scenarios and the links between them: link_scenarios can remove an
// arrow (a link is an edit to a row, not a row), but nothing here drops a row.
// ============================================================================

import { Hono } from "hono";
import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { AsyncLocalStorage } from "node:async_hooks";
import "../_shared/freetime.js"; // sets globalThis.PPFree: the same free-time function the page uses
import { openPdf, scanPages, imageFileMime, isPdf, b64, MAX_IMAGE_BYTES } from "../_shared/scanpages.ts"; // scanned pages as pictures

// ---- Secrets / environment -------------------------------------------------
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically into
// every Edge Function; OWNER_USER_ID and MCP_TOKEN you set yourself via
// `supabase secrets set` (see the README).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OWNER = Deno.env.get("OWNER_USER_ID") ?? "";
const MCP_TOKEN = Deno.env.get("MCP_TOKEN") ?? "";
// Optional second token for agents (Agent PgM). Unset = agents can't connect at all.
const AGENT_TOKEN = Deno.env.get("AGENT_TOKEN") ?? "";

// Every write runs as the service role; the activity log names that "claude". Calls from the voice
// endpoint run inside actorStore with a client that also sends x-planner-actor: voice, so the log trigger
// (with _Memory/migration_voice_actor.sql applied) records them as "voice". Same key, same rights.
const dbBase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const dbVoice = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { "x-planner-actor": "voice" } } });
const actorStore = new AsyncLocalStorage<typeof dbBase>();
// deno-lint-ignore no-explicit-any
const db: typeof dbBase = new Proxy({} as any, { get: (_t, p) => { const c: any = actorStore.getStore() || dbBase; const v = c[p]; return typeof v === "function" ? v.bind(c) : v; } });

// ---- Vocabulary (kept in lockstep with index.html's own constants) ---------
const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
const CATEGORIES = ["Health", "Finance", "Career", "Maintenance", "Growth", "Relationships", "Sol"] as const;
// The pages carry friendlier names than the stored areas; both are accepted everywhere and stored as the area.
const AREA_ALIASES: Record<string, string> = { Money: "Finance", Work: "Career", People: "Relationships", Home: "Maintenance", Admin: "Maintenance", Learning: "Growth", Self: "Growth", Life: "Sol" };
const AREA_INPUT = [...CATEGORIES, ...Object.keys(AREA_ALIASES)] as unknown as readonly [string, ...string[]];
// Which area to set (the Command Center colours follow it): yellow tasks & money, orange work, green health, purple growth, blue people, white Sol.
const AREA_GUIDE = "area (sets the colour): Finance = money, bills, banking (yellow); Maintenance = admin, home, paperwork, errands, appointments that are chores (yellow); Career = job, client work, career (orange); Health = sleep, workouts, gym, energy, body, medical (green only for health); Growth = learning, reading, papers, concerts, club nights, culture, hobbies, events you go to for yourself (purple); Relationships = family, friends, calls, messages, meetings and meals with people, birthdays (blue); Sol = the owner's own Sol category (white). Page names also work: Money, Work, People, Home, Admin, Learning, Self, Life.";
const normArea = (a: unknown) => typeof a === "string" && AREA_ALIASES[a] ? AREA_ALIASES[a] : a;
// Stamped by .github/workflows/deploy-connector.yml at deploy time; left as placeholders for a dashboard deploy.
const BUILD_COMMIT = "__BUILD_COMMIT__", BUILD_TIME = "__BUILD_TIME__";
const BOOTED_AT = new Date().toISOString();
const OWNER_TOOLS: string[] = [];
const ACTION_TYPES = ["Call", "Email", "Meeting", "Research", "Write", "Review", "Task", "Follow-up"] as const;
const RELATIONSHIPS = ["Family", "Friend", "Colleague", "Mentor", "Partner", "Ex", "Acquaintance", "Other"] as const;
const LINK_KINDS = ["parent_of", "spouse", "partner", "ex_partner", "sibling", "other"] as const;
// For parent_of, from_person is the parent (personA unless parent names personB). Other kinds have no direction.
async function linkDirection(kind: string, aId: string, bId: string, parentRef?: string): Promise<{ from?: string | null; error?: string }> {
  if (kind !== "parent_of") return { from: null };
  if (!parentRef) return { from: aId };
  const f = await findPerson(parentRef); if (!f.person) return { error: f.error };
  if (f.person.id !== aId && f.person.id !== bId) return { error: "parent must be one of the two people" };
  return { from: f.person.id };
}
const NOTE_TYPES = ["reflection", "reference", "idea", "decision"] as const;
const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Decision-canvas layout constants, mirrored from index.html's own (SC_ORIGIN_X etc).
// A scenario created through this connector has to land somewhere sensible on the
// canvas — without this every one would stack at 0,0 in the corner and the user
// would have to drag them apart by hand before the tree was readable.
const SC_ORIGIN_X = 1500, SC_ORIGIN_Y = 1000, SC_COL_W = 260, SC_ROW_H = 200;

// ---- Small helpers ---------------------------------------------------------
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}
// Server-side "today" is UTC. The user's local date can differ near midnight, so
// tools that default to today also accept an explicit `date` the caller can pass.
// The user's calendar day (Berlin). The main thing is set per day, so UTC would be wrong near midnight.
function berlinToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}
// Kept under its old name: every "today" default is the user's Berlin day.
function todayUTC(): string {
  return berlinToday();
}

// A scoped SELECT: every read is pinned to the owner's rows.
function owned(table: string) {
  return db.from(table).select("*").eq("user_id", OWNER);
}

// ---- Geocoding -------------------------------------------------------------
// Same Nominatim endpoint the app's own address autocomplete uses, so a place added
// here resolves exactly the way it would if you'd typed it into the app.
//
// This exists because the alternative is unusable: every location column is lat/lng,
// and a model asked for coordinates will invent plausible-looking ones rather than
// admit it doesn't know — silently dropping a pin in the wrong country. Callers pass
// an address; the server resolves it or fails loudly.
//
// Nominatim's usage policy wants a descriptive User-Agent (browsers send their own,
// so the in-app calls don't set one; a server has to) and caps traffic at ~1 req/sec.
// Fine for one person's connector, but a model creating places in a tight loop can
// still get throttled — hence the explicit "pass lat/lng instead" escape hatch in the
// failure message rather than a silent null.
const NOMINATIM_UA = "personal-planner-mcp/1.0 (single-user personal planner connector)";
type GeoHit = { lat: number; lng: number; displayName: string };
async function geocode(query: string, limit = 1): Promise<{ hits: GeoHit[]; error?: string }> {
  try {
    const res = await fetch(
      "https://nominatim.openstreetmap.org/search?format=json&limit=" + limit + "&q=" + encodeURIComponent(query),
      { headers: { "Accept": "application/json", "User-Agent": NOMINATIM_UA } },
    );
    if (!res.ok) return { hits: [], error: "geocoder returned HTTP " + res.status };
    const rows = await res.json();
    if (!Array.isArray(rows)) return { hits: [], error: "geocoder returned an unexpected response" };
    return {
      hits: rows.map((r: any) => ({
        lat: Number(r.lat), lng: Number(r.lon), displayName: String(r.display_name || query),
      })).filter((h: GeoHit) => Number.isFinite(h.lat) && Number.isFinite(h.lng)),
    };
  } catch (e) {
    return { hits: [], error: "geocoder unreachable: " + ((e as Error).message || String(e)) };
  }
}
function validCoords(lat: unknown, lng: unknown): boolean {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) &&
    Number(lat) >= -90 && Number(lat) <= 90 && Number(lng) >= -180 && Number(lng) <= 180;
}
// Shared by every tool that accepts a place: explicit coordinates always win (the caller
// already knows exactly where it is), otherwise the address is geocoded. Returns null
// coords with no error when neither was supplied — "no location given" is not a failure.
async function resolvePlace(
  args: { address?: string; lat?: number; lng?: number },
): Promise<{ address: string | null; lat: number | null; lng: number | null; error?: string; resolvedFrom?: string }> {
  if (args.lat !== undefined && args.lng !== undefined) {
    if (!validCoords(args.lat, args.lng)) {
      return { address: null, lat: null, lng: null, error: "lat must be between -90 and 90 and lng between -180 and 180" };
    }
    return { address: args.address || null, lat: Number(args.lat), lng: Number(args.lng) };
  }
  if (!args.address) return { address: null, lat: null, lng: null };
  const { hits, error } = await geocode(args.address, 1);
  if (error) return { address: args.address, lat: null, lng: null, error: error + " — pass lat and lng explicitly to skip geocoding" };
  if (!hits.length) {
    return { address: args.address, lat: null, lng: null, error: 'could not find "' + args.address + '" — try a fuller address, or pass lat and lng explicitly' };
  }
  // The typed address is kept, not the geocoder's display_name: it's what the user
  // wrote and what the app shows back in the field, same as the in-app autocomplete.
  return { address: args.address, lat: hits[0].lat, lng: hits[0].lng, resolvedFrom: hits[0].displayName };
}

// ---- Decision-canvas scoring -----------------------------------------------
// Mirrors index.html's scenarioNetScore / scenarioIsScored / scenarioRankMap — MUST
// stay in step with them.
// reported here that disagrees with what the user sees on the canvas is worse than
// no number at all.
type WeightEntry = { text?: string; weight?: number };
function weightSum(list: WeightEntry[] | null | undefined): number {
  return (list || []).reduce((t, e) => t + (Number(e && e.weight) || 0), 0);
}
function scenarioNetScore(s: any): number {
  return weightSum(s.advantages) - weightSum(s.disadvantages);
}
// A scenario with nothing weighed scores 0, which would otherwise let an empty branch
// outrank a genuinely negative one purely by saying nothing. Unscored ones are reported
// as scored:false and left out of the ranking rather than competing on a score they
// never earned.
function scenarioIsScored(s: any): boolean {
  return ((s.advantages || []).length + (s.disadvantages || []).length) > 0;
}
// Entries arrive from a model, so they're clamped rather than trusted: a weight of 40
// (or "high", or a missing one) would quietly distort every ranking that reads it.
// Blank text is dropped, matching the app's own readScWeightList.
function normalizeWeights(list: any): WeightEntry[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e.text === "string" && e.text.trim())
    .map((e) => {
      // A number that's merely OUT of range is clamped; only a non-number falls back to
      // the middle. `Math.round(n) || 3` would conflate the two and turn a weight of 0 —
      // "this barely matters" — into 3, tripling something the caller called negligible.
      const raw = Number(e.weight);
      return {
        text: String(e.text).trim(),
        weight: Number.isFinite(raw) ? Math.max(1, Math.min(5, Math.round(raw))) : 3,
      };
    });
}
const WEIGHT_ENTRY = z.object({
  text: z.string().describe("what the advantage or disadvantage actually is"),
  weight: z.number().optional().describe("1-5, how much it MATTERS (not how likely). Defaults to 3."),
});
function scenarioRankMap(list: any[]): Record<string, { rank: number; of: number }> {
  const scored = list.filter(scenarioIsScored).sort((a, b) => scenarioNetScore(b) - scenarioNetScore(a));
  const map: Record<string, { rank: number; of: number }> = {};
  let lastScore: number | null = null, lastRank = 0;
  scored.forEach((s, i) => {
    const sc = scenarioNetScore(s);
    // Ties share a rank — two branches that weigh out identically genuinely are tied.
    if (lastScore === null || sc !== lastScore) { lastRank = i + 1; lastScore = sc; }
    map[s.id] = { rank: lastRank, of: scored.length };
  });
  return map;
}
// Does `fromId` already reach `toId` by following links? Mirrors scenarioLinksTo — the
// guard that keeps the branching hierarchy from closing into a loop.
function scenarioLinksTo(all: any[], fromId: string, toId: string, seen: Record<string, boolean> = {}): boolean {
  if (seen[fromId]) return false;
  seen[fromId] = true;
  const s = all.find((x) => x.id === fromId);
  return !!s && (s.links || []).some((id: string) => id === toId || scenarioLinksTo(all, id, toId, seen));
}

// Mirrors the app's own safeWrite: run a write, and if the database rejects it for a
// column it doesn't have yet (a migration that wasn't run), drop that column and retry.
// Keeps the connector working against a database that's behind on migrations — the same
// reason SELECT * reads already tolerate missing columns, but a raw insert would not.
function missingColumn(error: any): string | null {
  const msg = String((error && error.message) || "") + " " + String((error && error.details) || "");
  let m = msg.match(/Could not find the '([^']+)' column/);
  if (m) return m[1];
  m = msg.match(/column "([^"]+)"[^"]*does not exist/);
  if (m) return m[1];
  return null;
}
async function safeWrite(op: (p: Record<string, unknown>) => any, payload: Record<string, unknown>) {
  const p: Record<string, unknown> = { ...payload };
  for (let i = 0; i < 15; i++) {
    const res = await op(p);
    if (!res.error) return res;
    const col = missingColumn(res.error);
    if (col && Object.prototype.hasOwnProperty.call(p, col)) { delete p[col]; continue; }
    return res;
  }
  return await op(p);
}

// ---- MCP servers -----------------------------------------------------------
// Two servers over the same tool definitions, chosen per request by which token was presented:
//
//   mcp       — the OWNER (you, via Cowork / claude.ai). Every tool, including direct writes.
//   mcpAgent  — AGENTS (Agent PgM's bots, via AGENT_TOKEN). Reads, plus propose_* and
//               post_report. An agent cannot write to your real lists directly: everything it
//               wants to change becomes a pending row in agent_proposals that you approve in the
//               app's Inbox. Finance, location history and anything that reveals where people
//               live are deliberately not readable with the agent token at all.
//
// A separate token also means agents can be revoked (unset AGENT_TOKEN, redeploy) without
// breaking your own connector.
const schemaAdapter = (schema: unknown) => z.toJSONSchema(schema as z.ZodType);
const mcp = new McpServer({ name: "personal-planner", version: "1.1.0", schemaAdapter });
const mcpAgent = new McpServer({ name: "personal-planner-agents", version: "1.1.0", schemaAdapter });

// Read tools the agent token may use. Everything not listed here is owner-only unless a tool is
// registered with an explicit audience.
const AGENT_READABLE = new Set([
  "get_agenda", "list_goals", "list_projects", "list_actions", "list_events",
  "list_notes", "list_people", "list_decisions", "get_decision", "list_pois", "get_tracker",
  "geocode_address",
]);
type Audience = "owner" | "agent" | "both";
// Served on the owner endpoint only through a merged tool (see MERGED TOOLS below). The agent endpoint
// keeps every tool under its own name.
const FOLD = new Set([
  "archive_action", "archive_goal", "archive_project", "archive_item", "archive_record", "restore_item", "restore_record",
  "complete_action", "complete_item", "uncomplete_item",
  "save_note", "save_idea", "save_link", "save_quote", "save_author", "add_note",
  "list_actions", "list_events", "list_goals", "list_items", "list_notes", "list_people", "list_projects", "list_decisions", "list_proposals", "list_agent_reports", "list_pois", "list_located_items", "list_recent_knowledge", "get_tracker",
  "link_item", "link_people", "set_link_kind", "link_scenarios", "link_knowledge", "add_dependency", "remove_dependency",
  "set_recurrence", "end_recurrence", "skip_occurrence", "edit_occurrence",
  "reschedule", "snooze", "make_someday",
  "get_planner_settings", "set_planner_settings", "get_reminder_settings", "set_reminder_settings", "set_reminders", "list_upcoming_reminders",
  "set_health_condition", "set_health_flag", "set_health_status",
  "log_metric", "log_body_metric",
  "upsert_health_day", "upsert_workout", "upsert_activity", "upsert_routine",
  "list_topics", "rename_topic", "merge_topics",
  "add_knowledge_source", "set_source_privacy", "remove_knowledge_source", "sync_source",
  "memory_get", "memory_search", "memory_overview", "memory_topics",
  "create_place", "edit_place", "create_scenario", "edit_scenario",
  "get_finance", "get_finance_snapshot",
  "get_communication_status", "get_whatsapp_sync_state",
]);
// deno-lint-ignore no-explicit-any
const LEGACY: Record<string, any> = {};   // folded owner tools, by old name
// deno-lint-ignore no-explicit-any
const ALL_DEFS: Record<string, any> = {}; // every tool, by name (the voice tools reuse them)
// deno-lint-ignore no-explicit-any
function tool(name: string, def: any, audience?: Audience) {
  const who = audience || (AGENT_READABLE.has(name) ? "both" : "owner");
  const inner = def.handler;
  // deno-lint-ignore no-explicit-any
  if (inner) def = { ...def, handler: (args: any, ctx: any) => {
    if (args && typeof args === "object") {
      for (const k of ["area"]) if (k in args) args[k] = normArea(args[k]);
      for (const k of ["areas", "secondaryAreas", "secondary_areas"]) if (Array.isArray(args[k])) args[k] = Array.from(new Set(args[k].map(normArea)));
    }
    return inner(args, ctx);
  } };
  ALL_DEFS[name] = def;
  if (who !== "agent") {
    if (FOLD.has(name)) LEGACY[name] = def;
    else { if (!OWNER_TOOLS.includes(name)) OWNER_TOOLS.push(name); mcp.tool(name, def); }
  }
  if (who !== "owner") mcpAgent.tool(name, def);
}

// ============================ READ TOOLS ====================================

// One small call for a spoken or quick check-in ("what's my day?"): times and titles only, no ids
// beyond the main thing, so a voice answer can be read straight from it.
tool("get_today_overview", {
  description:
    "The day at a glance in ONE small call: the main thing, the timed schedule (events, blocks and timed tasks in order), untimed tasks due, how many things are overdue, last night's sleep and the next gym session. Use this first for 'what's my day', morning check-ins and voice conversations; use get_agenda only when you need every detail or ids.",
  inputSchema: z.object({
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today (Berlin)"),
  }),
  handler: async (args: { date?: string }) => {
    const date = args.date || berlinToday();
    const [actionsR, eventsR, sleepR, next] = await Promise.all([
      owned("actions"), owned("events"), owned("health_daily").eq("date", date).maybeSingle(),
      date === berlinToday() ? hvNextSession().catch(() => null) : Promise.resolve(null),
    ]);
    if (actionsR.error) return fail(actionsR.error.message);
    const acts = (actionsR.data || []).filter((a: any) => !a.archived_at && !a.someday);
    const due = acts.filter((a: any) => a.recurrence ? ccDates(a, date, date).length > 0 && !(a.recurrence_done || []).includes(date) : a.date === date && !a.done);
    const evs = eventsR.error ? [] : (eventsR.data || []).filter((e: any) => !e.archived_at && ccDates(e, date, date).length);
    const hhmm = (t: any) => t ? String(t).slice(0, 5) : null;
    const schedule = [
      ...evs.filter((e: any) => e.time_of_day && !e.all_day).map((e: any) => ({ time: hhmm(e.time_of_day), minutes: e.duration_minutes || null, title: e.title, kind: "event" })),
      ...due.filter((a: any) => a.time_of_day && !a.all_day).map((a: any) => ({ time: hhmm(a.time_of_day), minutes: a.duration_minutes || null, title: a.title, kind: ccKind(a, "actions") })),
    ].sort((p, q) => String(p.time).localeCompare(String(q.time)));
    const allDay = evs.filter((e: any) => !e.time_of_day || e.all_day).map((e: any) => e.title);
    const untimed = due.filter((a: any) => !a.time_of_day || a.all_day);
    const overdue = acts.filter((a: any) => a.date && a.date < date && !a.done && !a.recurrence);
    const open = acts.filter((a: any) => !a.done);
    const focused = open.find((a: any) => a.focus_date === date);
    const main = focused || due.filter((a: any) => !a.done).sort((a: any, b: any) => String(a.priority).localeCompare(String(b.priority)))[0] || null;
    const n: any = sleepR && !sleepR.error ? sleepR.data : null;
    const mins = n ? (n.sleep_minutes_corrected != null ? n.sleep_minutes_corrected : n.sleep_minutes) : null;
    const sleep = n && (mins != null || n.bed_time) ? {
      asleep: mins != null ? Math.floor(mins / 60) + "h " + String(mins % 60).padStart(2, "0") + "m" : null,
      bed: hhmm(n.bed_time_corrected || n.bed_time), wake: hhmm(n.wake_time_corrected || n.wake_time), score: n.sleep_score ?? null,
    } : null;
    const nx: any = next;
    const say = [
      schedule.length ? schedule.length + (schedule.length === 1 ? " timed thing" : " timed things") + ", first at " + schedule[0].time : "nothing at a fixed time",
      untimed.length ? untimed.length + (untimed.length === 1 ? " task" : " tasks") + " without a time" : "",
      overdue.length ? overdue.length + " overdue" : "",
    ].filter(Boolean).join(", ") + ".";
    return ok({
      date, weekday: new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
      summary: say.charAt(0).toUpperCase() + say.slice(1),
      mainThing: main ? { id: main.id, title: main.title, time: hhmm(main.time_of_day), chosen: !!focused } : null,
      schedule: schedule.slice(0, 15), allDay: allDay.slice(0, 6),
      tasks: untimed.slice(0, 8).map((a: any) => a.title), moreTasks: Math.max(0, untimed.length - 8),
      overdue: { count: overdue.length, oldest: overdue.sort((a: any, b: any) => String(a.date).localeCompare(String(b.date))).slice(0, 3).map((a: any) => a.title) },
      sleep,
      nextGym: nx && nx.date ? { date: nx.date, time: nx.time, routine: nx.routine, trainedToday: nx.trainedToday } : null,
    });
  },
});

tool("get_agenda", {
  description:
    "The user's plan for one day (defaults to today, Berlin). Returns actions due that day, overdue open actions, undated open actions (backlog), the events happening that day, and any notes written that day. Start here to understand what's on the user's plate.",
  inputSchema: z.object({
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today (Berlin). Pass the user's local date if it might differ."),
  }),
  handler: async (args: { date?: string }) => {
    const date = args.date || todayUTC();
    const [actionsR, notesR, eventsR] = await Promise.all([
      owned("actions"),
      owned("journal").eq("date", date).order("created_at"),
      owned("events"),
    ]);
    if (actionsR.error) return fail(actionsR.error.message);
    if (notesR.error) return fail(notesR.error.message);
    // Events are tolerated as missing rather than fatal: the table only exists once
    // migration_events.sql has been run, and an agenda without events is still useful.
    const events = eventsR.error ? [] : (eventsR.data || []).filter((e) => !e.archived_at && ccDates(e, date, date).length);

    const actions = (actionsR.data || []).filter((a) => !a.archived_at);
    const slimAction = (a: any) => ({
      id: a.id, title: a.title, type: a.type, priority: a.priority,
      date: a.date, timeOfDay: a.time_of_day, area: a.category,
      parentType: a.parent_type, parentId: a.parent_id, done: a.done,
      isMilestone: !!a.is_milestone, isDecision: !!a.is_decision,
      kind: ccKind(a, "actions"), recurrence: a.recurrence || null,
    });

    const openActions = actions.filter((a) => !a.done);
    const focused = openActions.find((a) => a.focus_date === date);
    const autoMain = focused ? null : openActions.filter((a) => a.date === date).sort((a, b) => String(a.priority).localeCompare(String(b.priority)))[0];

    return ok({
      date,
      // The one thing the Today page shows large: chosen with set_main_thing, else the top action due that day.
      mainThing: focused || autoMain ? { ...slimAction(focused || autoMain), chosen: !!focused } : null,
      actions: {
        dueToday: actions.filter((a) => !a.someday && (a.recurrence ? ccDates(a, date, date).length > 0 && !(a.recurrence_done || []).includes(date) : a.date === date && !a.done)).map(slimAction),
        overdue: actions.filter((a) => a.date && a.date < date && !a.done && !a.recurrence && !a.someday).map(slimAction),
        backlog: actions.filter((a) => !a.date && !a.done && !a.someday).map(slimAction),
      },
      // Events are things that HAPPEN at a time (a meeting, an appointment, a trip) —
      // they are not tasks and have no done state or priority, so they're reported as
      // their own list rather than folded in among the actions.
      events: events
        .sort((a, b) => String(a.time_of_day || "99:99").localeCompare(String(b.time_of_day || "99:99")))
        .map((e) => ({
          id: e.id, title: e.title, timeOfDay: e.time_of_day, durationMinutes: e.duration_minutes,
          area: e.category, locationAddress: e.location_address || null,
        })),
      notes: (notesR.data || []).map((n) => ({
        id: n.id, title: n.title, text: n.text, areas: n.categories || [],
        priority: n.priority, timeOfDay: n.time_of_day, sentiment: n.sentiment || [],
      })),
    });
  },
});

// ---- Goal scores (0-100). score_mode: manual | sleep | workout | net_zero | tasks (default).
//   sleep    7-day average Garmin sleep score (a corrected night wins)
//   workout  workout days ÷ planned gym days over the last 28 days, capped at 100
//   net_zero (debt at the first finance snapshot − debt now) ÷ debt at the first snapshot; baseline stored
//   tasks    done ÷ all tasks under the goal (directly or through its projects)
//   manual   whatever the owner or Claude set
// Refreshed by pg_cron each morning, after a health day or workout is saved, and after a finance snapshot.
const SCORE_MODES = ["manual", "sleep", "workout", "net_zero", "tasks"] as const;
// deno-lint-ignore no-explicit-any
const scoreHist = (h: any, day: string, v: number | null) => { const a = (Array.isArray(h) ? h : []).filter((x: any) => x && x.d !== day); if (v != null) a.push({ d: day, s: Math.round(v * 10) / 10 }); return a.slice(-35); };
async function refreshGoalScores(): Promise<{ updated: number; error?: string }> {
  const g = await db.from("goals").select("*").eq("user_id", OWNER).is("archived_at", null);
  if (g.error) return { updated: 0, error: g.error.message };
  // deno-lint-ignore no-explicit-any
  const goals = (g.data || []).filter((x: any) => x.score_mode !== undefined);
  if (!goals.length) return { updated: 0 };
  const today = berlinToday(), d28 = ccAdd(today, -27), d7 = ccAdd(today, -6);
  // deno-lint-ignore no-explicit-any
  const need = (m: string) => goals.some((x: any) => x.score_mode === m);
  const [days, wks, set, snaps, acts, projs] = await Promise.all([
    need("sleep") ? db.from("health_daily").select("date,sleep_score").eq("user_id", OWNER).is("archived_at", null).gte("date", d7) : Promise.resolve({ data: [] }),
    need("workout") ? db.from("workouts").select("date").eq("user_id", OWNER).is("archived_at", null).gte("date", d28).lte("date", today) : Promise.resolve({ data: [] }),
    need("workout") ? db.from("planner_settings").select("gym_days").eq("user_id", OWNER).maybeSingle() : Promise.resolve({ data: null }),
    need("net_zero") ? db.from("finance_snapshots").select("as_of,snapshot").eq("user_id", OWNER).order("as_of") : Promise.resolve({ data: [] }),
    need("tasks") ? db.from("actions").select("id,done,parent_type,parent_id,recurrence,archived_at").eq("user_id", OWNER).is("archived_at", null) : Promise.resolve({ data: [] }),
    need("tasks") ? db.from("projects").select("id,goal_id").eq("user_id", OWNER).is("archived_at", null) : Promise.resolve({ data: [] }),
  ]);
  // deno-lint-ignore no-explicit-any
  const sl = ((days as any).data || []).map((r: any) => r.sleep_score).filter((v: any) => typeof v === "number");
  const sleep = sl.length ? sl.reduce((a: number, b: number) => a + b, 0) / sl.length : null;
  // deno-lint-ignore no-explicit-any
  const doneDays = new Set(((wks as any).data || []).map((w: any) => String(w.date).slice(0, 10)));
  // deno-lint-ignore no-explicit-any
  const gym: number[] = ((set as any).data && (set as any).data.gym_days && (set as any).data.gym_days.length) ? (set as any).data.gym_days : [1, 3, 5];
  let planned = 0; for (let i = 0; i < 28; i++) { const d = ccAdd(d28, i), w = new Date(d + "T12:00:00Z").getUTCDay() || 7; if (gym.includes(w)) planned++; }
  const workout = planned ? Math.min(100, doneDays.size / planned * 100) : null;
  // deno-lint-ignore no-explicit-any
  const debtOf = (sn: any) => { const L = sn && Array.isArray(sn.loans) ? sn.loans : []; const v = L.map((l: any) => typeof l.balance === "number" ? l.balance : null).filter((x: any) => x != null); return v.length ? v.reduce((a: number, b: number) => a + b, 0) : null; };
  // deno-lint-ignore no-explicit-any
  const S = ((snaps as any).data || []) as any[], first = S.find((x) => debtOf(x.snapshot) != null), last = S.slice().reverse().find((x) => debtOf(x.snapshot) != null);
  // deno-lint-ignore no-explicit-any
  const A = ((acts as any).data || []) as any[], P = ((projs as any).data || []) as any[];
  let updated = 0;
  for (const goal of goals) {
    let v: number | null = null, base = goal.score_baseline || null;
    if (goal.score_mode === "sleep") v = sleep;
    else if (goal.score_mode === "workout") v = workout;
    else if (goal.score_mode === "net_zero") {
      const d0 = base && typeof base.debt0 === "number" ? base.debt0 : first ? debtOf(first.snapshot) : null, cur = last ? debtOf(last.snapshot) : null;
      if (d0 && cur != null) { v = Math.max(0, Math.min(100, (d0 - cur) / d0 * 100)); base = { debt0: d0, as_of0: base && base.as_of0 || (first && first.as_of), debt: cur, as_of: last && last.as_of, cleared: Math.max(0, d0 - cur), currency: (last && last.snapshot && last.snapshot.currency) || "EUR" }; }
    } else if (goal.score_mode === "tasks") {
      // deno-lint-ignore no-explicit-any
      const pids = new Set(P.filter((p: any) => p.goal_id === goal.id).map((p: any) => p.id));
      // deno-lint-ignore no-explicit-any
      const mine = A.filter((a: any) => !a.recurrence && ((a.parent_type === "goal" && a.parent_id === goal.id) || (a.parent_type === "project" && pids.has(a.parent_id))));
      v = mine.length ? mine.filter((a: any) => a.done).length / mine.length * 100 : null;
    } else continue;   // manual: left as it is
    const patch: Record<string, unknown> = { score: v == null ? null : Math.round(v * 10) / 10, score_history: scoreHist(goal.score_history, today, v), score_updated_at: new Date().toISOString() };
    if (goal.score_mode === "net_zero") patch.score_baseline = base;
    const u = await db.from("goals").update(patch).eq("id", goal.id).eq("user_id", OWNER);
    if (!u.error) updated++;
  }
  return { updated };
}
const scoreOut = (g: any) => ({ score: g.score ?? null, scoreMode: g.score_mode || "tasks", scoreHistory: (g.score_history || []).slice(-28), netZero: g.score_mode === "net_zero" && g.score_baseline ? { cleared: g.score_baseline.cleared, of: g.score_baseline.debt0, currency: g.score_baseline.currency || "EUR" } : undefined });

tool("list_goals", {
  description: "List the user's goals. Optionally filter by area (category).",
  inputSchema: z.object({
    area: z.enum(AREA_INPUT).optional().describe("only goals in this area"),
  }),
  handler: async (args: { area?: string }) => {
    let q = owned("goals").order("position");
    if (args.area) q = q.eq("category", args.area);
    const { data, error } = await q;
    if (error) return fail(error.message);
    return ok((data || []).map((g) => ({
      id: g.id, title: g.title, priority: g.priority, area: g.category,
      due: g.due, ongoing: g.ongoing, secondaryAreas: g.secondary_categories || [],
      milestones: g.milestones || [], ...scoreOut(g),
    })));
  },
});

tool("list_projects", {
  description: "List the user's projects. Optionally filter by parent goal id.",
  inputSchema: z.object({
    goalId: z.string().optional().describe("only projects under this goal"),
    includeDone: z.boolean().optional().describe("include finished projects (default false)"),
  }),
  handler: async (args: { goalId?: string; includeDone?: boolean }) => {
    let q = owned("projects").order("position");
    if (args.goalId) q = q.eq("goal_id", args.goalId);
    if (!args.includeDone) q = q.eq("done", false);
    const { data, error } = await q;
    if (error) return fail(error.message);
    return ok((data || []).map((p) => ({
      id: p.id, title: p.title, goalId: p.goal_id, priority: p.priority,
      due: p.due, hours: Number(p.hours), done: p.done, areas: p.categories || [],
    })));
  },
});

tool("list_actions", {
  description: "List the user's actions (tasks), most recent first. Filter by done state and/or date range.",
  inputSchema: z.object({
    done: z.boolean().optional().describe("filter by completion state; omit for both"),
    from: z.string().optional().describe("YYYY-MM-DD inclusive lower bound on the action's date"),
    to: z.string().optional().describe("YYYY-MM-DD inclusive upper bound on the action's date"),
    area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE),
    limit: z.number().optional().describe("max rows (default 100)"),
    includeArchived: z.boolean().optional().describe("also return archived actions (default false)"),
  }),
  handler: async (args: { done?: boolean; from?: string; to?: string; area?: string; limit?: number; includeArchived?: boolean }) => {
    let q = owned("actions").order("date", { ascending: false, nullsFirst: false });
    if (args.done !== undefined) q = q.eq("done", args.done);
    if (args.from) q = q.gte("date", args.from);
    if (args.to) q = q.lte("date", args.to);
    if (args.area) q = q.eq("category", args.area);
    q = q.limit(args.limit && args.limit > 0 ? args.limit : 100);
    const { data, error } = await q;
    if (error) return fail(error.message);
    return ok((data || []).filter((a) => args.includeArchived || !a.archived_at).map((a) => ({
      id: a.id, title: a.title, type: a.type, priority: a.priority, date: a.date,
      timeOfDay: a.time_of_day, durationMinutes: a.duration_minutes, area: a.category,
      secondaryAreas: a.secondary_categories || [],
      parentType: a.parent_type, parentId: a.parent_id, done: a.done,
      isMilestone: !!a.is_milestone, focusDate: a.focus_date || null,
      // An action flagged as a decision is a fork the user hasn't settled, not a task
      // they're about to do — call get_decision on it to see the scenarios and scores.
      isDecision: !!a.is_decision,
      // [{id, requiresDone}] — a hard prerequisite (requiresDone) blocks this action
      // until the other one is done; a plain link is only an ordering hint.
      dependencies: a.dependencies || [],
      notes: a.notes_md || "",
      locationAddress: a.location_address || null, lat: a.location_lat, lng: a.location_lng,
      // null = the user made it; otherwise the agent's name, or "claude" for Cowork.
      source: a.source || null, externalId: a.external_id || null,
    })));
  },
});

tool("list_notes", {
  description: "List the user's notes (journal entries), newest first. Optionally filter by date range or a text search.",
  inputSchema: z.object({
    from: z.string().optional().describe("YYYY-MM-DD inclusive lower bound"),
    to: z.string().optional().describe("YYYY-MM-DD inclusive upper bound"),
    query: z.string().optional().describe("case-insensitive substring match on the note text"),
    limit: z.number().optional().describe("max rows (default 50)"),
  }),
  handler: async (args: { from?: string; to?: string; query?: string; limit?: number }) => {
    let q = owned("journal").order("date", { ascending: false }).order("created_at", { ascending: false });
    if (args.from) q = q.gte("date", args.from);
    if (args.to) q = q.lte("date", args.to);
    if (args.query) q = q.ilike("text", "%" + args.query + "%");
    q = q.limit(args.limit && args.limit > 0 ? args.limit : 50);
    const { data, error } = await q;
    if (error) return fail(error.message);
    return ok((data || []).map((n) => ({
      id: n.id, date: n.date, title: n.title, text: n.text, areas: n.categories || [],
      noteType: n.note_type || "reflection",
      priority: n.priority, timeOfDay: n.time_of_day, sentiment: n.sentiment || [],
      linkedObjects: n.linked_objects || [], recordingId: n.recording_id || null, createdAt: n.created_at || null,
      source: n.source || null, externalId: n.external_id || null,
    })));
  },
});

tool("list_people", {
  description: "List people in the user's network, with their full profile fields. Optionally filter by relationship or a name search.",
  inputSchema: z.object({
    relationship: z.enum(RELATIONSHIPS).optional(),
    query: z.string().optional().describe("case-insensitive substring match on the person's name"),
    limit: z.number().optional().describe("max rows (default 100)"),
  }),
  handler: async (args: { relationship?: string; query?: string; limit?: number }) => {
    let q = owned("people").is("archived_at", null).order("position");
    if (args.relationship) q = q.eq("relationship", args.relationship);
    if (args.query) q = q.ilike("name", "%" + args.query + "%");
    q = q.limit(args.limit && args.limit > 0 ? args.limit : 100);
    const { data, error } = await q;
    if (error) return fail(error.message);
    return ok((data || []).map((p) => ({
      id: p.id, name: p.name, relationship: p.relationship, contact: p.contact, notes: p.notes,
      socialGroup: p.social_group, location: p.location, personalityType: p.personality_type,
      relationshipStatus: p.relationship_status, verified: !!p.verified,
      likeScore: p.like_score, contactScore: p.contact_score, yearMet: p.year_met,
      relatedPeople: p.related_people, planets: p.planets, homeLat: p.home_lat, homeLng: p.home_lng,
      circle: p.circle, quality: p.quality, energy: p.energy, lastContactAt: p.last_contact_at,
      lastContactKind: p.last_contact_kind, rhythmDays: p.rhythm_days, inMemory: !!p.in_memory,
    })));
  },
});

tool("get_tracker", {
  description: "The user's self-tracking variables (mood, metrics) and their logged entries over a date range (defaults to the last 14 days).",
  inputSchema: z.object({
    from: z.string().optional().describe("YYYY-MM-DD inclusive lower bound (default: 14 days ago)"),
    to: z.string().optional().describe("YYYY-MM-DD inclusive upper bound (default: today)"),
  }),
  handler: async (args: { from?: string; to?: string }) => {
    const to = args.to || todayUTC();
    const from = args.from || new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const [varsR, entriesR] = await Promise.all([
      owned("tracker_variables").order("position"),
      owned("tracker_entries").gte("date", from).lte("date", to).order("date"),
    ]);
    if (varsR.error) return fail(varsR.error.message);
    if (entriesR.error) return fail(entriesR.error.message);
    return ok({
      from, to,
      variables: (varsR.data || []).map((v) => ({
        id: v.id, name: v.name, type: v.type, unit: v.unit, scaleMax: v.scale_max,
      })),
      entries: (entriesR.data || []).map((e) => ({ date: e.date, variableId: e.variable_id, value: e.value })),
    });
  },
});

tool("list_events", {
  description:
    "List the user's events. An event is something that HAPPENS at a time — a meeting, an appointment, a trip — not a task to complete: it has no done state and no priority. Use this (not list_actions) when the user asks what's on their calendar.",
  inputSchema: z.object({
    from: z.string().optional().describe("YYYY-MM-DD inclusive lower bound on the event's date"),
    to: z.string().optional().describe("YYYY-MM-DD inclusive upper bound on the event's date"),
    area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE),
    limit: z.number().optional().describe("max rows (default 100)"),
  }),
  handler: async (args: { from?: string; to?: string; area?: string; limit?: number }) => {
    let q = owned("events").order("date", { ascending: true, nullsFirst: false });
    if (args.from) q = q.gte("date", args.from);
    if (args.to) q = q.lte("date", args.to);
    if (args.area) q = q.eq("category", args.area);
    q = q.limit(args.limit && args.limit > 0 ? args.limit : 100);
    const { data, error } = await q;
    if (error) return fail(error.message + " (has migration_events.sql been run?)");
    return ok((data || []).map((e) => ({
      id: e.id, title: e.title, date: e.date, timeOfDay: e.time_of_day,
      durationMinutes: e.duration_minutes, area: e.category,
      secondaryAreas: e.secondary_categories || [],
      locationAddress: e.location_address || null,
      linkedPeopleIds: e.linked_people_ids || [], notes: e.notes_md || "",
      source: e.source || null, externalId: e.external_id || null,
    })));
  },
});

tool("list_decisions", {
  description:
    "List the actions the user has flagged as DECISIONS — forks they haven't settled yet, each with a canvas of scenarios (plausible futures) weighed against each other. Returns a summary per decision; call get_decision for one decision's full canvas.",
  inputSchema: z.object({}),
  handler: async () => {
    const [actionsR, scenR] = await Promise.all([
      owned("actions").eq("is_decision", true),
      owned("action_scenarios"),
    ]);
    if (actionsR.error) return fail(actionsR.error.message + " (has migration_action_scenarios.sql been run?)");
    const scenarios = scenR.error ? [] : (scenR.data || []);
    return ok((actionsR.data || []).map((a) => {
      const mine = scenarios.filter((s) => s.action_id === a.id);
      const ranked = scenarioRankMap(mine);
      const leaders = mine.filter((s) => ranked[s.id]?.rank === 1);
      return {
        actionId: a.id, title: a.title, date: a.date, area: a.category, done: a.done,
        scenarioCount: mine.length,
        scoredCount: mine.filter(scenarioIsScored).length,
        // Plural on purpose: identical net scores genuinely tie, and naming one of them
        // "the" leader would overstate how settled the decision is.
        leading: leaders.map((s) => ({ id: s.id, title: s.title, netScore: scenarioNetScore(s) })),
      };
    }));
  },
});

tool("get_decision", {
  description:
    "One decision's full scenario canvas: every scenario with its weighted advantages and disadvantages, its computed net score and rank, and the branching links between them. Weights are 1-5 for HOW MUCH SOMETHING MATTERS, not how likely it is; net score = summed advantages minus summed disadvantages. Scenarios with nothing weighed are reported scored:false and left out of the ranking.",
  inputSchema: z.object({
    actionId: z.string().describe("id of the action flagged as a decision (from the decisions list)"),
  }),
  handler: async (args: { actionId: string }) => {
    const [actionR, scenR] = await Promise.all([
      owned("actions").eq("id", args.actionId).maybeSingle(),
      owned("action_scenarios").eq("action_id", args.actionId).order("position"),
    ]);
    if (actionR.error) return fail(actionR.error.message);
    if (!actionR.data) return fail("no action with id " + args.actionId);
    if (scenR.error) return fail(scenR.error.message + " (has migration_action_scenarios.sql been run?)");
    const list = scenR.data || [];
    const ranked = scenarioRankMap(list);
    const linkedTo: Record<string, string[]> = {};
    list.forEach((s) => (s.links || []).forEach((id: string) => {
      (linkedTo[id] = linkedTo[id] || []).push(s.id);
    }));
    return ok({
      action: {
        id: actionR.data.id, title: actionR.data.title, date: actionR.data.date,
        area: actionR.data.category, isDecision: !!actionR.data.is_decision, done: actionR.data.done,
      },
      scenarios: list.map((s) => ({
        id: s.id, title: s.title, notes: s.notes || "",
        advantages: s.advantages || [], disadvantages: s.disadvantages || [],
        netScore: scenarioNetScore(s), scored: scenarioIsScored(s),
        rank: ranked[s.id]?.rank ?? null, rankOf: ranked[s.id]?.of ?? null,
        // links = branches leading OUT of this scenario; linkedFrom = what leads INTO it.
        // Roots (nothing leading in) are where the tree starts.
        links: s.links || [], linkedFrom: linkedTo[s.id] || [],
      })),
      ranking: list.filter(scenarioIsScored)
        .sort((a, b) => scenarioNetScore(b) - scenarioNetScore(a))
        .map((s) => ({ rank: ranked[s.id].rank, id: s.id, title: s.title, netScore: scenarioNetScore(s) })),
      roots: list.filter((s) => !(linkedTo[s.id] || []).length).map((s) => s.id),
      unscored: list.filter((s) => !scenarioIsScored(s)).map((s) => s.id),
    });
  },
});

tool("list_pois", {
  description: "List the user's saved places (points of interest — the named pins on the Location map). Call this before create_place to check whether somewhere is already saved, and to get ids for edit_place.",
  inputSchema: z.object({
    query: z.string().optional().describe("case-insensitive substring match on the place name"),
  }),
  handler: async (args: { query?: string }) => {
    let q = owned("points_of_interest").order("created_at");
    if (args.query) q = q.ilike("name", "%" + args.query + "%");
    const { data, error } = await q;
    if (error) return fail(error.message);
    return ok((data || []).map((p) => ({
      id: p.id, name: p.name, lat: p.lat, lng: p.lng,
      notes: p.notes || "", linkedPeopleIds: p.linked_people_ids || [],
    })));
  },
});

tool("list_located_items", {
  description:
    "Everything in the planner that carries a location, in one place: saved places, the actions/events that have an address, and the people with a home location. Use this to answer 'what do I have near X' or 'where is everything'.",
  inputSchema: z.object({
    kinds: z.array(z.enum(["place", "action", "event", "person"])).optional()
      .describe("restrict to these kinds; omit for all"),
  }),
  handler: async (args: { kinds?: string[] }) => {
    const want = (k: string) => !args.kinds || !args.kinds.length || args.kinds.indexOf(k) !== -1;
    const [poisR, actionsR, eventsR, peopleR] = await Promise.all([
      want("place") ? owned("points_of_interest") : Promise.resolve({ data: [], error: null } as any),
      want("action") ? owned("actions") : Promise.resolve({ data: [], error: null } as any),
      want("event") ? owned("events") : Promise.resolve({ data: [], error: null } as any),
      want("person") ? owned("people") : Promise.resolve({ data: [], error: null } as any),
    ]);
    // Any one of these tables may predate its migration; a partial map beats a hard failure.
    const rows = (r: any) => (r && !r.error && r.data) ? r.data : [];
    const located: any[] = [];
    rows(poisR).forEach((p: any) => located.push({
      kind: "place", id: p.id, title: p.name, lat: p.lat, lng: p.lng, address: null, notes: p.notes || "",
    }));
    [["action", actionsR], ["event", eventsR]].forEach(([kind, r]: any) => {
      rows(r).forEach((x: any) => {
        if (x.archived_at || (x.location_lat == null && x.location_lng == null && !x.location_address)) return;
        located.push({
          kind, id: x.id, title: x.title, lat: x.location_lat, lng: x.location_lng,
          address: x.location_address || null, date: x.date ?? null, done: x.done ?? null,
        });
      });
    });
    rows(peopleR).forEach((p: any) => {
      if (p.home_lat == null && p.home_lng == null) return;
      located.push({ kind: "person", id: p.id, title: p.name, lat: p.home_lat, lng: p.home_lng, address: p.location || null });
    });
    return ok({ count: located.length, items: located });
  },
});

tool("get_location_history", {
  description:
    "The user's own recorded position over time (GPS pings from the app's live-location layer and any imported Google Maps Timeline data). Defaults to the last 7 days. Points can be dense, so this samples down to a readable number rather than returning everything.",
  inputSchema: z.object({
    from: z.string().optional().describe("YYYY-MM-DD inclusive lower bound (default: 7 days ago)"),
    to: z.string().optional().describe("YYYY-MM-DD inclusive upper bound (default: today)"),
    maxPoints: z.number().optional().describe("cap on returned points, evenly sampled (default 300, max 2000)"),
  }),
  handler: async (args: { from?: string; to?: string; maxPoints?: number }) => {
    const to = args.to || todayUTC();
    const from = args.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const { data, error } = await owned("gps_pings")
      .gte("recorded_at", from + "T00:00:00Z").lte("recorded_at", to + "T23:59:59Z")
      .order("recorded_at");
    if (error) return fail(error.message + " (has migration_location.sql been run?)");
    const all = data || [];
    const cap = Math.max(1, Math.min(2000, args.maxPoints && args.maxPoints > 0 ? args.maxPoints : 300));
    // Evenly sampled rather than truncated: the first 300 of a week's pings is one
    // afternoon, which would read as "this is where they were all week".
    const step = all.length > cap ? all.length / cap : 1;
    const sampled = all.length > cap
      ? Array.from({ length: cap }, (_, i) => all[Math.floor(i * step)])
      : all;
    return ok({
      from, to, totalPoints: all.length, returnedPoints: sampled.length,
      sampled: all.length > cap,
      points: sampled.map((p) => ({
        lat: p.lat, lng: p.lng, recordedAt: p.recorded_at, source: p.source, accuracy: p.accuracy,
      })),
    });
  },
});

tool("geocode_address", {
  description:
    "Turn a written address or place name into coordinates, using the same OpenStreetMap geocoder the app's own address box uses. Use it to confirm somewhere before saving it, or when you need coordinates for a tool that takes them. The create/edit tools geocode on their own, so you rarely need to call this first.",
  inputSchema: z.object({
    address: z.string().describe("e.g. 'Alexanderplatz, Berlin' or a full street address"),
    limit: z.number().optional().describe("how many candidates to return (default 3, max 10)"),
  }),
  handler: async (args: { address: string; limit?: number }) => {
    const limit = Math.max(1, Math.min(10, args.limit && args.limit > 0 ? args.limit : 3));
    const { hits, error } = await geocode(args.address, limit);
    if (error) return fail(error);
    if (!hits.length) return fail('no match for "' + args.address + '"');
    return ok({ query: args.address, matches: hits });
  },
});

tool("get_finance", {
  description: "The user's finance accounts with their balances, plus transactions over a date range (defaults to the last 30 days). Amounts are positive for money in, negative for money out.",
  inputSchema: z.object({
    from: z.string().optional().describe("YYYY-MM-DD inclusive lower bound (default: 30 days ago)"),
    to: z.string().optional().describe("YYYY-MM-DD inclusive upper bound (default: today)"),
    includeArchived: z.boolean().optional().describe("include archived accounts (default false)"),
  }),
  handler: async (args: { from?: string; to?: string; includeArchived?: boolean }) => {
    const to = args.to || todayUTC();
    const from = args.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const [accR, txR] = await Promise.all([
      owned("finance_accounts").order("position"),
      owned("finance_transactions").gte("date", from).lte("date", to).order("date", { ascending: false }),
    ]);
    if (accR.error) return fail(accR.error.message);
    if (txR.error) return fail(txR.error.message);
    const accounts = (accR.data || []).filter((a) => args.includeArchived ? true : !a.archived);
    return ok({
      from, to,
      accounts: accounts.map((a) => ({
        id: a.id, name: a.name, type: a.type, balance: Number(a.balance) || 0,
        currency: a.currency || "EUR", archived: !!a.archived,
        loanMonthlyPayment: a.loan_monthly_payment, loanInterestRate: a.loan_interest_rate,
        loanOriginalAmount: a.loan_original_amount, loanPurpose: a.loan_purpose || "",
      })),
      transactions: (txR.data || []).map((t) => ({
        id: t.id, accountId: t.account_id, date: t.date, description: t.description || "",
        amount: Number(t.amount) || 0, area: t.area, subcategory: t.subcategory || "", source: t.source,
      })),
    });
  },
});

// ---- Finance snapshots (the Finance page) ------------------------------------
// One row per as_of in finance_snapshots (see _Memory/migration_finance_snapshots.sql). The same
// rules as F.validate in finance/finance.js. Older snapshots are the history and are never deleted.
const FIN_VERSIONS = ["1", "1.0"];
const FIN_LISTS = ["accounts", "monthly", "balances_eom", "categories", "food", "subscriptions", "loans", "investments", "property", "income_sources", "actions", "monthly_categories", "monthly_income"];
const FIN_HINT = " (if the table is missing, run _Memory/migration_finance_snapshots.sql in the Supabase SQL editor)";
function financeProblems(snap: any): string[] {
  const e: string[] = [];
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) return ["snapshot must be an object"];
  if (!FIN_VERSIONS.includes(String(snap.schema_version))) e.push("unknown schema_version " + JSON.stringify(snap.schema_version) + "; supported: " + FIN_VERSIONS[0]);
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(snap.as_of || ""))) e.push("as_of must be a date like 2026-11-10");
  for (const k of FIN_LISTS) if (snap[k] != null && !Array.isArray(snap[k])) e.push(k + " must be a list");
  if (snap.kpis != null && typeof snap.kpis !== "object") e.push("kpis must be an object");
  (Array.isArray(snap.accounts) ? snap.accounts : []).forEach((x: any, i: number) => {
    if (!["checking", "savings", "credit_card", "investment", "loan", "equity_share"].includes(x?.type)) e.push("accounts[" + i + "].type is not a known account type");
  });
  (Array.isArray(snap.actions) ? snap.actions : []).forEach((x: any, i: number) => {
    if (!["open", "waiting", "done"].includes(x?.status)) e.push("actions[" + i + "].status must be open, waiting or done");
  });
  return e;
}

tool("import_finance_snapshot", {
  description:
    "Store a finance snapshot for the Finance page. The snapshot is one object: schema_version ('1'), as_of (YYYY-MM-DD), currency, period, sources, accounts[], monthly[], balances_eom[], categories[], food[], subscriptions[], loans[], investments[], property[], income_sources[], kpis, actions[], and optionally monthly_categories[] ({month: 'YYYY-MM', category, amount}) and monthly_income[] ({month, source, amount}) so the Finance page's money river can show every stream for each month. Use null for a number that is unknown, never 0. Importing the same as_of again replaces that snapshot; other dates are kept as history.",
  inputSchema: z.object({
    snapshot: z.record(z.any()).describe("the whole snapshot object"),
  }),
  handler: async (args: { snapshot: any }) => {
    const snap = args.snapshot;
    const problems = financeProblems(snap);
    if (problems.length) return fail("snapshot rejected: " + problems.slice(0, 8).join("; "));
    const as_of = String(snap.as_of).slice(0, 10);
    const found = await db.from("finance_snapshots").select("id").eq("user_id", OWNER).eq("as_of", as_of).limit(1);
    if (found.error) return fail(found.error.message + FIN_HINT);
    const row = { schema_version: String(snap.schema_version), snapshot: snap, source: "mcp", imported_at: new Date().toISOString() };
    const existing = found.data && found.data[0];
    const w = existing
      ? await db.from("finance_snapshots").update(row).eq("id", existing.id).eq("user_id", OWNER)
      : await db.from("finance_snapshots").insert({ user_id: OWNER, as_of, ...row });
    if (w.error) return fail(w.error.message + FIN_HINT);
    const count = await db.from("finance_snapshots").select("id", { count: "exact", head: true }).eq("user_id", OWNER);
    await refreshGoalScores().catch(() => null);
    return ok({ ok: true, as_of, result: existing ? "replaced" : "created", snapshotsStored: count.count ?? null });
  },
});

tool("get_finance_snapshot", {
  description: "Read a finance snapshot back: the latest one, or the one for a given as_of date. Also lists the dates of all stored snapshots.",
  inputSchema: z.object({
    as_of: z.string().optional().describe("YYYY-MM-DD; omit for the latest snapshot"),
  }),
  handler: async (args: { as_of?: string }) => {
    const all = await db.from("finance_snapshots").select("as_of,imported_at,source").eq("user_id", OWNER).order("as_of", { ascending: false });
    if (all.error) return fail(all.error.message + FIN_HINT);
    if (!all.data || !all.data.length) return ok({ snapshot: null, available: [], note: "no snapshot stored yet" });
    const want = args.as_of ? String(args.as_of).slice(0, 10) : all.data[0].as_of;
    const one = await db.from("finance_snapshots").select("snapshot,imported_at,source").eq("user_id", OWNER).eq("as_of", want).limit(1);
    if (one.error) return fail(one.error.message);
    if (!one.data || !one.data[0]) return fail("no snapshot for " + want + "; available: " + all.data.map((x) => x.as_of).join(", "));
    return ok({ as_of: want, importedAt: one.data[0].imported_at, source: one.data[0].source, available: all.data.map((x) => x.as_of), snapshot: one.data[0].snapshot });
  },
});

// ---- Command Center: repeating items, free time, planning reads ---------------
// The same rules as command/core.js in the app. Dates are YYYY-MM-DD strings; maths is in UTC.
const CC_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CC_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CC_DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const CC_WORK = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 18 * 60 };   // replaced by planner_settings in ccLoad
// deno-lint-ignore no-explicit-any
async function plannerSettings(): Promise<any> {
  const r = await db.from("planner_settings").select("*").eq("user_id", OWNER).maybeSingle();
  const d = r.data || {}, hh = (x: string | null, def: string) => x ? String(x).slice(0, 5) : def;
  const out = { workDays: d.work_days || [1, 2, 3, 4, 5], workStart: hh(d.work_start, "09:00"), workEnd: hh(d.work_end, "18:00"), gymDays: d.gym_days || [1, 3, 5], timezone: d.timezone || "Europe/Berlin", stored: !!r.data, note: r.error ? "planner_settings table missing (run _Memory/migration_connector_v2.sql); showing defaults" : undefined };
  CC_WORK.days = out.workDays.map((n: number) => n % 7); CC_WORK.start = ccMins(out.workStart) as number; CC_WORK.end = ccMins(out.workEnd) as number;
  return out;
}   // counted as booked
const CC_DAY_START = 7 * 60, CC_DAY_END = 23 * 60;
const ccMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const ccIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ccAdd = (d: string, n: number) => ccIso(ccMs(d) + n * 86400000);
const ccDow = (d: string) => new Date(ccMs(d)).getUTCDay();
const ccMonday = (d: string) => ccAdd(d, -((ccDow(d) + 6) % 7));
const ccDiff = (a: string, b: string) => Math.round((ccMs(b) - ccMs(a)) / 86400000);
const ccMins = (t: string | null) => t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null;
function ccRule(str: string | null) {
  if (!str) return null;
  const r = { freq: "", interval: 1, byday: [] as string[], bymonthday: [] as number[], until: null as string | null, count: null as number | null };
  let okRule = true;
  for (const p of String(str).replace(/^RRULE:/i, "").split(";")) {
    const [k0, v0] = p.split("="); const k = (k0 || "").toUpperCase().trim(), v = (v0 || "").toUpperCase().trim();
    if (!k) continue;
    if (k === "FREQ") r.freq = v;
    else if (k === "INTERVAL") r.interval = Math.max(1, parseInt(v, 10) || 1);
    else if (k === "BYDAY") r.byday = v.split(",").map((x) => x.replace(/^[+-]?\d+/, "")).filter((x) => CC_DOW.includes(x));
    else if (k === "BYMONTHDAY") r.bymonthday = v.split(",").map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= 31);
    else if (k === "UNTIL") r.until = v.length >= 8 ? v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6, 8) : null;
    else if (k === "COUNT") r.count = parseInt(v, 10) || null;
    else if (k !== "WKST") okRule = false;
  }
  return okRule && ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(r.freq) ? r : null;
}
const CC_RULE_HELP = "recurrence must be an RRULE using FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with optional INTERVAL, BYDAY, BYMONTHDAY, UNTIL, COUNT — e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR";
// deno-lint-ignore no-explicit-any
function ccHits(r: any, start: string, d: string): boolean {
  const n = ccDiff(start, d); if (n < 0) return false;
  if (r.until && d > r.until) return false;
  if (r.freq === "DAILY") return n % r.interval === 0;
  if (r.freq === "WEEKLY") {
    if ((ccDiff(ccMonday(start), ccMonday(d)) / 7) % r.interval !== 0) return false;
    return r.byday.length ? r.byday.includes(CC_DOW[ccDow(d)]) : ccDow(d) === ccDow(start);
  }
  const months = (+d.slice(0, 4) - +start.slice(0, 4)) * 12 + (+d.slice(5, 7) - +start.slice(5, 7)), dom = +d.slice(8, 10);
  if (r.freq === "MONTHLY") return months % r.interval === 0 && (r.bymonthday.length ? r.bymonthday.includes(dom) : dom === +start.slice(8, 10));
  return months % (12 * r.interval) === 0 && dom === +start.slice(8, 10);
}
// The dates a row (action or event) falls on between from and to, inclusive.
// deno-lint-ignore no-explicit-any
function ccDates(row: any, from: string, to: string): string[] {
  if (!row.date) return [];
  const r = ccRule(row.recurrence);
  if (!r) return row.date >= from && row.date <= to ? [row.date] : [];
  const out: string[] = [], skip: string[] = row.recurrence_exceptions || [];
  let d = row.date as string, seen = 0, guard = 0;
  while (d <= to && guard++ < 4000) {
    if (ccHits(r, row.date, d)) { seen++; if (r.count && seen > r.count) break; if (d >= from && !skip.includes(d)) out.push(d); }
    d = ccAdd(d, 1);
  }
  return out;
}
// deno-lint-ignore no-explicit-any
const ccKind = (row: any, table: string) => table === "events" ? "event" : (row.kind || (row.is_milestone ? "deadline" : "task"));
// deno-lint-ignore no-explicit-any
function ccSlim(row: any, table: string, date?: string) {
  const kind = ccKind(row, table), hasDone = kind === "task" || kind === "deadline";
  return {
    id: row.id, table, kind, title: row.title, date: date || row.date || null, timeOfDay: row.time_of_day ? String(row.time_of_day).slice(0, 5) : null,
    durationMinutes: row.duration_minutes || null, estimateMinutes: row.estimate_min || null, allDay: !!row.all_day, area: row.category || null,
    priority: table === "events" ? null : row.priority, recurrence: row.recurrence || null, reminders: row.reminders || [],
    done: !hasDone ? null : row.recurrence ? (row.recurrence_done || []).includes(date || row.date) : !!row.done,
    status: row.archived_at ? "archived" : row.someday ? "someday" : hasDone && !row.recurrence && row.done ? "done" : "open",
    parentType: row.parent_type || null, parentId: row.parent_id || null,
  };
}
async function ccLoad() {
  const [a, e] = await Promise.all([owned("actions"), owned("events"), plannerSettings()]);
  if (a.error) return { error: a.error.message, actions: [], events: [] };
  return { error: "", actions: (a.data || []).filter((x) => !x.archived_at), events: e.error ? [] : (e.data || []).filter((x) => !x.archived_at) };
}
// deno-lint-ignore no-explicit-any
function ccOccurrences(actions: any[], events: any[], from: string, to: string) {
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const a of actions) if (!a.someday) for (const d of ccDates(a, from, to)) out.push(ccSlim(a, "actions", d));
  for (const e of events) for (const d of ccDates(e, from, to)) out.push(ccSlim(e, "events", d));
  return out.sort((x, y) => (x.date + (x.timeOfDay || "")).localeCompare(y.date + (y.timeOfDay || "")));
}
// deno-lint-ignore no-explicit-any
function ccFree(occ: any[], date: string) {
  const iv: number[][] = [];
  if (CC_WORK.days.includes(ccDow(date))) iv.push([CC_WORK.start, CC_WORK.end]);
  for (const o of occ) {
    if (o.date !== date || o.allDay || !o.timeOfDay || o.done) continue;
    const st = ccMins(o.timeOfDay) as number, len = o.durationMinutes || o.estimateMinutes || (o.kind === "event" || o.kind === "block" ? 60 : 30);
    iv.push([st, st + len]);
  }
  const cl = iv.map((x) => [Math.max(CC_DAY_START, x[0]), Math.min(CC_DAY_END, x[1])]).filter((x) => x[1] > x[0]).sort((x, y) => x[0] - y[0]);
  const slots: { from: string; to: string; minutes: number }[] = [];
  const hm = (m: number) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  let cur = CC_DAY_START, booked = 0;
  for (const x of cl) {
    if (x[0] > cur) slots.push({ from: hm(cur), to: hm(x[0]), minutes: x[0] - cur });
    if (x[1] > cur) { booked += x[1] - Math.max(cur, x[0]); cur = x[1]; }
  }
  if (cur < CC_DAY_END) slots.push({ from: hm(cur), to: hm(CC_DAY_END), minutes: CC_DAY_END - cur });
  return { bookedMinutes: booked, freeMinutes: CC_DAY_END - CC_DAY_START - booked, freeSlots: slots.filter((x) => x.minutes >= 15), workHours: CC_WORK.days.includes(ccDow(date)) ? "09:00-18:00" : null };
}
// Open, dated, in the past. A repeating task counts once: its latest missed date in the last 14 days.
// deno-lint-ignore no-explicit-any
function ccOverdue(actions: any[], today: string) {
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const a of actions) {
    if (a.someday || !a.date || ccKind(a, "actions") === "block") continue;
    if (!a.recurrence) { if (!a.done && a.date < today) out.push(ccSlim(a, "actions")); continue; }
    const missed = ccDates(a, ccAdd(today, -14), ccAdd(today, -1)).filter((d) => !(a.recurrence_done || []).includes(d));
    if (missed.length) out.push(ccSlim(a, "actions", missed[missed.length - 1]));
  }
  return out;
}
// deno-lint-ignore no-explicit-any
const ccBacklog = (actions: any[]) => actions.filter((a) => !a.date && !a.done && !a.someday).map((a) => ccSlim(a, "actions"));

tool("plan_day", {
  description: "Everything needed to plan one day: the items on it (tasks, events, deadlines, time blocks, with repeating items expanded), free time between 07:00 and 23:00 (work hours Mon-Fri 09:00-18:00 count as booked), open items from earlier days, and the undated backlog. Read this before proposing a plan; then use create_action, create_event or reschedule to apply what the user accepts.",
  inputSchema: z.object({ date: z.string().regex(CC_DAY, "use YYYY-MM-DD").optional().describe("defaults to today (Berlin)") }),
  handler: async (args: { date?: string }) => {
    const date = args.date || berlinToday(), L = await ccLoad();
    if (L.error) return fail(L.error);
    const occ = ccOccurrences(L.actions, L.events, date, date), main = L.actions.find((a) => a.focus_date === date && !a.done);
    return ok({ date, mainThing: main ? ccSlim(main, "actions") : null, items: occ, free: ccFree(occ, date), overdue: ccOverdue(L.actions, date), backlog: ccBacklog(L.actions).slice(0, 40) });
  },
});

tool("plan_week", {
  description: "A week at a glance for planning: for each of the 7 days from start (a Monday by default) the items on it and its free time, plus open items from earlier and the undated backlog. Use it to draft a week the user can accept or change.",
  inputSchema: z.object({ start: z.string().regex(CC_DAY, "use YYYY-MM-DD").optional().describe("first day; defaults to the Monday of the current week (Berlin)") }),
  handler: async (args: { start?: string }) => {
    const today = berlinToday(), start = args.start || ccMonday(today), end = ccAdd(start, 6), L = await ccLoad();
    if (L.error) return fail(L.error);
    const occ = ccOccurrences(L.actions, L.events, start, end);
    const days = Array.from({ length: 7 }, (_, i) => { const d = ccAdd(start, i); return { date: d, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][ccDow(d)], items: occ.filter((o) => o.date === d), free: ccFree(occ, d) }; });
    return ok({ start, end, today, days, overdue: ccOverdue(L.actions, today), backlog: ccBacklog(L.actions).slice(0, 40) });
  },
});

tool("get_backlog", {
  description: "Open tasks with no date, grouped by area, plus the items parked under 'someday'. Nothing here is late. Pass area to see one area only.",
  inputSchema: z.object({ area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE) }),
  handler: async (args: { area?: string }) => {
    const L = await ccLoad();
    if (L.error) return fail(L.error);
    // deno-lint-ignore no-explicit-any
    const byArea: Record<string, any[]> = {};
    for (const a of ccBacklog(L.actions)) if (!args.area || a.area === args.area) (byArea[a.area || "No area"] = byArea[a.area || "No area"] || []).push(a);
    return ok({ byArea, someday: L.actions.filter((a) => a.someday && !a.done && (!args.area || a.category === args.area)).map((a) => ccSlim(a, "actions")) });
  },
});

tool("weekly_review", {
  description: "The material for a weekly review: for the week starting at start (a Monday by default) what got done, what slipped (open and already past), what is still to come this week, and what is already planned for the following week. Summarise it gently and propose next week; nothing is moved until the user agrees.",
  inputSchema: z.object({ start: z.string().regex(CC_DAY, "use YYYY-MM-DD").optional().describe("defaults to the Monday of the current week (Berlin)") }),
  handler: async (args: { start?: string }) => {
    const today = berlinToday(), start = args.start || ccMonday(today), end = ccAdd(start, 6), L = await ccLoad();
    if (L.error) return fail(L.error);
    const occ = ccOccurrences(L.actions, L.events, start, end), tasks = occ.filter((o) => o.kind === "task" || o.kind === "deadline");
    return ok({
      start, end, today,
      done: tasks.filter((o) => o.done), slipped: tasks.filter((o) => !o.done && o.date < today), stillToCome: tasks.filter((o) => !o.done && o.date >= today),
      eventsAndBlocks: occ.filter((o) => o.kind === "event" || o.kind === "block"),
      nextWeek: ccOccurrences(L.actions, L.events, ccAdd(start, 7), ccAdd(start, 13)), backlogCount: ccBacklog(L.actions).length,
    });
  },
});

// Shared by create_action / create_event: a re-sent item (same title, date and kind) updates the
// existing row instead of adding a second one.
// deno-lint-ignore no-explicit-any
async function ccExisting(table: string, title: string, date: string | null, kind: string): Promise<any | null> {
  let q = db.from(table).select("*").eq("user_id", OWNER).is("archived_at", null).ilike("title", title.replace(/[%_\\]/g, "\\$&"));
  q = date ? q.eq("date", date) : q.is("date", null);
  const r = await q.limit(5);
  if (r.error || !r.data) return null;
  return r.data.find((x) => ccKind(x, table) === kind && (table === "events" || !x.done)) || null;
}
// deno-lint-ignore no-explicit-any
function ccCheck(args: any): string {
  if (args.date && !CC_DAY.test(args.date)) return "date must be YYYY-MM-DD";
  if (args.timeOfDay && !CC_TIME.test(args.timeOfDay)) return "timeOfDay must be HH:MM (24h)";
  if (args.recurrence && !ccRule(args.recurrence)) return CC_RULE_HELP;
  if (args.recurrence && args.date === "") return "a repeating item needs a first date";
  return "";
}
const CC_REMINDERS = z.array(z.number().int().min(0).max(40320)).max(5).optional().describe("minutes before the start, e.g. [1440, 30] for a day before and 30 minutes before");
const CC_RECUR = z.string().max(200).optional().describe("RRULE for a repeating item, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR or FREQ=MONTHLY;BYMONTHDAY=1; the date is the first occurrence. Pass an empty string to stop repeating.");

tool("reschedule", {
  description: "Move an item (action or event) to another day and/or time. For a repeating item pass occurrenceDate to move just that one date: it is skipped in the series and a one-off copy is added on the new day. Without occurrenceDate the whole series is re-anchored.",
  inputSchema: z.object({
    id: z.string(),
    date: z.string().regex(CC_DAY, "use YYYY-MM-DD"),
    timeOfDay: z.string().optional().describe("HH:MM 24h; omit to keep the current time, pass an empty string to clear it"),
    occurrenceDate: z.string().regex(CC_DAY, "use YYYY-MM-DD").optional().describe("for a repeating item: the single date to move"),
  }),
  handler: async (args: { id: string; date: string; timeOfDay?: string; occurrenceDate?: string }) => {
    if (args.timeOfDay && !CC_TIME.test(args.timeOfDay)) return fail("timeOfDay must be HH:MM (24h)");
    let table = "actions";
    let found = await db.from("actions").select("*").eq("id", args.id).eq("user_id", OWNER).maybeSingle();
    if (!found.data) { table = "events"; found = await db.from("events").select("*").eq("id", args.id).eq("user_id", OWNER).maybeSingle(); }
    if (found.error) return fail(found.error.message);
    const row = found.data;
    if (!row) return fail("no action or event with that id");
    const time = args.timeOfDay === undefined ? row.time_of_day : (args.timeOfDay || null);
    if (row.recurrence && args.occurrenceDate) {
      if (!ccDates(row, args.occurrenceDate, args.occurrenceDate).length) return fail("the item does not fall on " + args.occurrenceDate);
      const skip = Array.from(new Set([...(row.recurrence_exceptions || []), args.occurrenceDate]));
      const up = await db.from(table).update({ recurrence_exceptions: skip }).eq("id", row.id).eq("user_id", OWNER);
      if (up.error) return fail(up.error.message);
      const copy: Record<string, unknown> = { user_id: OWNER, title: row.title, date: args.date, time_of_day: time, duration_minutes: row.duration_minutes, category: row.category, notes_md: row.notes_md || "", source: "claude" };
      if (table === "actions") Object.assign(copy, { kind: row.kind || "task", priority: row.priority, type: row.type || "Task", parent_type: row.parent_type || "none", parent_id: row.parent_id || null, done: false });
      const ins = await safeWrite((p) => db.from(table).insert(p).select().single(), copy);
      if (ins.error) return fail(ins.error.message);
      return ok({ ok: true, movedOneOccurrence: true, newId: ins.data.id, date: args.date });
    }
    const patch: Record<string, unknown> = { date: args.date, time_of_day: time };
    if (table === "actions") patch.someday = false;
    const { error } = await safeWrite((p) => db.from(table).update(p).eq("id", row.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true, table, date: args.date, timeOfDay: time ? String(time).slice(0, 5) : null });
  },
});

// ---- Knowledge page: saved links, ideas, authors, quotes, notes, and search ----
// Rows live in knowledge_items / knowledge_chunks (see _Memory/migration_knowledge.sql). The owner
// decides, per zone, whether Claude may read it (knowledge_settings.external_zones); personal
// documents are kept from Claude unless the owner switches that on in the Knowledge page.
const KN_HINT = " (if the table is missing, run _Memory/migration_knowledge.sql in the Supabase SQL editor)";
const KN_ZONES = ["documents", "library", "web", "ideas", "thinkers", "mine"] as const;
const KN_ZONE_NAME: Record<string, string> = { documents: "Personal documents", library: "Library", web: "Web & media", ideas: "Ideas", thinkers: "People of thought", mine: "My constellation" };
const KN_TYPES: Record<string, string[]> = {
  documents: ["id", "contract", "letter", "insurance", "certificate", "payslip", "tax", "invoice", "document"],
  library: ["book", "paper", "report", "manual"], web: ["link", "article", "website", "video", "tool"],
  ideas: ["idea", "concept", "question", "quote"], thinkers: ["author"], mine: ["note", "reference", "decision"],
};
const knZoneOfType = (t: string) => KN_ZONES.find((z) => KN_TYPES[z].includes(t)) || null;
function knNormUrl(u: string): string {
  let x = String(u || "").trim(); if (!x) return "";
  if (!/^[a-z]+:\/\//i.test(x)) x = "https://" + x;
  try {
    const p = new URL(x); p.hash = "";
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]) p.searchParams.delete(k);
    return p.protocol + "//" + p.hostname.replace(/^www\./, "").toLowerCase() + p.pathname.replace(/\/+$/, "") + (p.search || "");
  } catch { return x; }
}
// Items from a Private OneDrive source never leave the server: every read of knowledge_items goes through this.
const KN_VISIBLE = "privacy.is.null,privacy.neq.private";
const knItems = (cols: string) => db.from("knowledge_items").select(cols).or(KN_VISIBLE);
async function knAllowed(): Promise<string[]> {
  const r = await db.from("knowledge_settings").select("external_zones").eq("user_id", OWNER).maybeSingle();
  return r.data ? (r.data.external_zones || []) : ["library", "web", "ideas", "thinkers", "mine"];
}
// A OneDrive file follows its source's level: "links" shows name, path, type, dates and webUrl (never text), "index" also its text.
// Private files are already left out by knItems. Everything else follows the zone's "Claude may read" switch.
// deno-lint-ignore no-explicit-any
const knCan = (r: any, allowed: string[]) => r.provider ? r.privacy !== "private" : allowed.includes(r.zone);
// deno-lint-ignore no-explicit-any
const knNoText = (r: any) => !!r.provider && r.privacy !== "index";
const knKept = (zones: string[]) => "Kept from Claude by the owner: " + zones.map((z) => (KN_ZONE_NAME as Record<string, string>)[z] || z).join(", ") + ". The owner can allow a zone under Privacy and search on the Knowledge page.";
// deno-lint-ignore no-explicit-any
const knSlim = (r: any) => ({ webUrl: r.web_url || undefined, onedrive: r.provider ? { path: r.remote_path, modified: r.remote_modified_at, indexStatus: r.index_status, noLongerInOneDrive: !!r.gone_at } : undefined, id: r.id, zone: r.zone, type: r.type, title: r.title, summary: r.summary || "", why: r.why || "", url: r.url || null, tags: r.tags || [], meta: r.meta || {}, source: r.source, needsSort: !!r.needs_sort, createdAt: r.created_at });
// Insert, or update the open item that is already there (same URL, or same title in the same zone).
// deno-lint-ignore no-explicit-any
async function knSave(row: Record<string, any>, text: string) {
  let q = knItems("*").eq("user_id", OWNER).is("archived_at", null);
  q = row.url ? q.eq("url", row.url) : q.eq("zone", row.zone).ilike("title", String(row.title).replace(/[%_\\]/g, "\\$&"));
  const found = await q.limit(1);
  if (found.error) return fail(found.error.message + KN_HINT);
  const cur = found.data && found.data[0];
  if (cur) {
    // deno-lint-ignore no-explicit-any
    const patch: Record<string, any> = { updated_at: new Date().toISOString() };
    if (row.why) patch.why = row.why;
    if (row.summary) patch.summary = row.summary;
    if (row.tags && row.tags.length) patch.tags = Array.from(new Set([...(cur.tags || []), ...row.tags]));
    if (row.meta && Object.keys(row.meta).length) patch.meta = { ...(cur.meta || {}), ...row.meta };
    const up = await db.from("knowledge_items").update(patch).eq("id", cur.id).eq("user_id", OWNER);
    if (up.error) return fail(up.error.message);
    return ok({ ok: true, id: cur.id, alreadySaved: true });
  }
  const ins = await db.from("knowledge_items").insert({ user_id: OWNER, source: "claude", summary: "", why: "", tags: [], meta: {}, ...row }).select("id").single();
  if (ins.error) return fail(ins.error.message + KN_HINT);
  if (text.trim()) await db.from("knowledge_chunks").insert({ user_id: OWNER, item_id: ins.data.id, page: null, content: text.slice(0, 8000) });
  return ok({ ok: true, id: ins.data.id, zone: row.zone, type: row.type });
}
const KN_TAGS = z.array(z.string().min(1).max(40)).max(8).optional().describe("short topic tags, e.g. ['gis', 'urban planning']");

tool("save_link", {
  description: "Save a link, article, video or tool to the owner's Knowledge page (zone: Web & media). Saving the same URL again updates the existing item instead of adding a second one. Use 'why' for one line, in the owner's own words, on why it matters.",
  inputSchema: z.object({
    url: z.string().min(4).max(2000), title: z.string().max(200).optional(), why: z.string().max(400).optional(), tags: KN_TAGS,
    type: z.enum(["link", "article", "website", "video", "tool"]).optional().describe("defaults to link"), summary: z.string().max(1200).optional(),
  }),
  handler: (a: { url: string; title?: string; why?: string; tags?: string[]; type?: string; summary?: string }) => {
    const url = knNormUrl(a.url);
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(url)) return fail("url must be a web address");
    const title = (a.title || url.replace(/^https?:\/\//, "")).slice(0, 200);
    return knSave({ zone: "web", type: a.type || "link", title, url, why: a.why || "", summary: a.summary || "", tags: a.tags || [] }, [title, a.why, a.summary].filter(Boolean).join("\n"));
  },
});

tool("save_idea", {
  description: "Save an idea, a product concept or a question the owner is exploring to the Knowledge page (zone: Ideas).",
  inputSchema: z.object({ text: z.string().min(2).max(4000), title: z.string().max(200).optional(), kind: z.enum(["idea", "concept", "question"]).optional(), tags: KN_TAGS }),
  handler: (a: { text: string; title?: string; kind?: string; tags?: string[] }) => {
    const title = (a.title || a.text.split("\n")[0]).slice(0, 120);
    return knSave({ zone: "ideas", type: a.kind || "idea", title, summary: a.text.length > title.length ? a.text : "", tags: a.tags || [] }, a.text);
  },
});

tool("save_author", {
  description: "Save an author, researcher or creator worth following to the Knowledge page (zone: People of thought). This is a knowledge entry, not a contact; it does not touch the People page.",
  inputSchema: z.object({ name: z.string().min(2).max(120), notes: z.string().max(1200).optional(), works: z.array(z.string().max(200)).max(20).optional().describe("titles of their books, papers or channels"), tags: KN_TAGS }),
  handler: (a: { name: string; notes?: string; works?: string[]; tags?: string[] }) =>
    knSave({ zone: "thinkers", type: "author", title: a.name.trim(), summary: a.notes || "", tags: a.tags || [], meta: a.works && a.works.length ? { works: a.works } : {} }, [a.name, a.notes, (a.works || []).join(", ")].filter(Boolean).join("\n")),
});

tool("save_quote", {
  description: "Save a quote to the Knowledge page (zone: Ideas), with where it comes from.",
  inputSchema: z.object({ text: z.string().min(2).max(2000), source: z.string().max(200).optional().describe("who said it or where it is from"), tags: KN_TAGS }),
  handler: (a: { text: string; source?: string; tags?: string[] }) =>
    knSave({ zone: "ideas", type: "quote", title: a.text.replace(/\s+/g, " ").slice(0, 90), summary: a.text, tags: a.tags || [], meta: a.source ? { author: a.source } : {} }, a.text + (a.source ? "\n" + a.source : "")),
});

tool("save_note", {
  description: "Save something the owner asks you to keep (a fact, a preference, a reference) to the Knowledge page (zone: My constellation).",
  inputSchema: z.object({ text: z.string().min(2).max(4000), title: z.string().max(200).optional(), tags: KN_TAGS }),
  handler: (a: { text: string; title?: string; tags?: string[] }) => {
    const title = (a.title || a.text.split("\n")[0]).slice(0, 120);
    return knSave({ zone: "mine", type: "note", title, summary: a.text.length > title.length ? a.text : "", tags: a.tags || [] }, a.text);
  },
});

tool("search_knowledge", {
  description: "Search the owner's Knowledge page by keyword and return the best matching passages with the item, the page number and a snippet, so you can answer a question from the text and cite the page. Try the owner's own wording and the document's language (many documents are German), and search again with other words if nothing comes back. Zones the owner has kept from Claude are not searched; the result says which.",
  inputSchema: z.object({
    query: z.string().min(2).max(200), zone: z.enum(KN_ZONES).optional(), type: z.string().max(40).optional(), limit: z.number().int().min(1).max(30).optional(),
  }),
  handler: async (a: { query: string; zone?: string; type?: string; limit?: number }) => {
    const allowed = await knAllowed(), limit = a.limit || 12;
    const hits = await db.from("knowledge_chunks").select("item_id,page,content").eq("user_id", OWNER).textSearch("fts", a.query, { type: "websearch", config: "simple" }).limit(80);
    if (hits.error) return fail(hits.error.message + KN_HINT);
    const like = "%" + a.query.replace(/[%_\\]/g, "\\$&") + "%";
    const titled = await knItems("id").eq("user_id", OWNER).is("archived_at", null).or("title.ilike." + like.replace(/,/g, " ") + ",summary.ilike." + like.replace(/,/g, " ")).limit(20);
    const ids = Array.from(new Set([...(hits.data || []).map((h) => h.item_id), ...((titled.data || []).map((t) => t.id))]));
    if (!ids.length) return ok({ passages: [], note: "nothing matched; try other words or the document's language" });
    const items = await knItems("*").eq("user_id", OWNER).is("archived_at", null).in("id", ids);
    if (items.error) return fail(items.error.message);
    // deno-lint-ignore no-explicit-any
    const byId: Record<string, any> = {}; let hidden = 0;
    for (const it of items.data || []) { if (!knCan(it, allowed)) { hidden++; continue; } if (a.zone && it.zone !== a.zone) continue; if (a.type && it.type !== a.type) continue; byId[it.id] = it; }
    const words = a.query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    const snip = (text: string) => { const low = text.toLowerCase(); let at = -1; for (const w of words) { at = low.indexOf(w); if (at >= 0) break; } const from = Math.max(0, at - 160); return (from > 0 ? "…" : "") + text.slice(from, from + 420).trim() + (from + 420 < text.length ? "…" : ""); };
    // deno-lint-ignore no-explicit-any
    const passages: any[] = [];
    for (const h of hits.data || []) { const it = byId[h.item_id]; if (it && !knNoText(it) && passages.length < limit) passages.push({ itemId: it.id, title: it.title, zone: it.zone, type: it.type, page: h.page, snippet: snip(h.content) }); }
    for (const t of titled.data || []) { const it = byId[t.id]; if (it && passages.length < limit && !passages.some((p) => p.itemId === it.id)) passages.push({ itemId: it.id, title: it.title, zone: it.zone, type: it.type, page: null, snippet: it.summary || it.why || "", webUrl: it.web_url || undefined, path: it.remote_path || undefined }); }
    return ok({ passages, note: hidden ? hidden + " matching item(s) are in zones kept from Claude. " + knKept(KN_ZONES.filter((z) => !allowed.includes(z))) : undefined });
  },
});

tool("get_knowledge_item", {
  description: "One Knowledge item in full: its details and its text by page (for documents, books and papers). Pass page to read around one page.",
  inputSchema: z.object({ id: z.string(), page: z.number().int().min(1).optional().describe("return only this page and its neighbours") }),
  handler: async (a: { id: string; page?: number }) => {
    const r = await knItems("*").eq("id", a.id).eq("user_id", OWNER).maybeSingle();
    if (r.error) return fail(r.error.message + KN_HINT);
    if (!r.data) return fail("no knowledge item with that id");
    const allowed = await knAllowed();
    if (!knCan(r.data, allowed)) return fail(knKept([r.data.zone]));
    if (knNoText(r.data)) { await knTrace("read", a.id, null, r.data.title); return ok({ ...knSlim(r.data), archived: !!r.data.archived_at, passages: [], note: "Links only: the owner shares this file's name, path, dates and link, not its text. Open it with webUrl." }); }
    let q = db.from("knowledge_chunks").select("page,content").eq("item_id", a.id).eq("user_id", OWNER).order("page", { ascending: true, nullsFirst: true });
    if (a.page) q = q.gte("page", Math.max(1, a.page - 1)).lte("page", a.page + 1);
    const c = await q.limit(40);
    await knTrace("read", a.id, null, r.data.title);
    return ok({ ...knSlim(r.data), archived: !!r.data.archived_at, passages: (c.data || []).map((x) => ({ page: x.page, text: x.content })), truncated: (c.data || []).length === 40 });
  },
});

// ---- the Knowledge spider: Claude reading, grouping and linking, visible on the page ----
async function knTrace(action: string, itemId: string | null, otherId: string | null, note: string) {
  await db.from("knowledge_agent_events").insert({ user_id: OWNER, action, item_id: itemId, other_id: otherId, note: String(note || "").slice(0, 300) });
}
async function knTopicId(zone: string, name: string): Promise<string | null> {
  const f = await db.from("knowledge_topics").select("id").eq("user_id", OWNER).eq("zone", zone).eq("name", name).maybeSingle();
  if (f.data) return f.data.id;
  const i = await db.from("knowledge_topics").insert({ user_id: OWNER, zone, name }).select("id").single();
  return i.data ? i.data.id : null;
}

tool("map_knowledge", {
  description: "The whole Knowledge page at a glance, for sorting it: every item Claude may read (id, title, zone, type, topic, folder, tags, a short summary, whether it has text to read) and the links between them. Start here before reading items with get_knowledge_item and grouping them with cluster_knowledge and link (kind knowledge). Zones the owner keeps from Claude are only counted. OneDrive files come as a list of folders (file count, newest change, a few sample titles); pass folder to list that folder's files with id, title, type, modified date, path and webUrl (get_knowledge_item gives one file).",
  inputSchema: z.object({ folder: z.string().max(300).optional().describe("only OneDrive files whose folder starts with this, with path and webUrl") }),
  handler: async (a: { folder?: string }) => {
    const allowed = await knAllowed();
    const [it, tp, ed, ch] = await Promise.all([
      knItems("*").eq("user_id", OWNER).is("archived_at", null).order("created_at", { ascending: false }).limit(3000),
      db.from("knowledge_topics").select("id,name").eq("user_id", OWNER),
      db.from("knowledge_edges").select("from_id,to_id,kind").eq("user_id", OWNER).limit(2000),
      db.from("knowledge_chunks").select("item_id").eq("user_id", OWNER).limit(20000),
    ]);
    if (it.error) return fail(it.error.message + KN_HINT);
    const tn: Record<string, string> = {}; for (const t of tp.data || []) tn[t.id] = t.name;
    const withText = new Set((ch.data || []).map((c) => c.item_id));
    const rows = it.data || [], shown = rows.filter((r) => knCan(r, allowed)), ids = new Set(shown.map((r) => r.id));
    // what stays hidden, and why: counts only, never names
    const hz: Record<string, number> = {}; for (const r of rows) if (!knCan(r, allowed)) hz[r.zone] = (hz[r.zone] || 0) + 1;
    const [pv, src] = await Promise.all([
      db.from("knowledge_items").select("id", { count: "exact", head: true }).eq("user_id", OWNER).is("archived_at", null).eq("privacy", "private"),
      db.from("knowledge_sources").select("id,privacy,zone,privacy_overrides").eq("user_id", OWNER).is("archived_at", null),
    ]);
    const hidden: { what: string; items: number; why: string }[] = Object.keys(hz).map((z2) => ({ what: "zone: " + ((KN_ZONE_NAME as Record<string, string>)[z2] || z2), items: hz[z2], why: "'Claude may read' is off for this zone (Knowledge page, Privacy and search)" }));
    if (pv.count) hidden.push({ what: "OneDrive files marked private", items: pv.count, why: "their source or subfolder is set to private, which never reaches Claude" });
    await knTrace("note", null, null, "Looking over " + shown.length + " items");
    // OneDrive files: grouped by folder and kept short, so several hundred files still fit in one answer
    const want = a.folder ? a.folder.replace(/^\/+|\/+$/g, "").toLowerCase() : null;
    // deno-lint-ignore no-explicit-any
    const groups: Record<string, any> = {};
    for (const r of shown) {
      if (!r.provider) continue;
      const p = String(r.remote_path || ""), dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : String((r.meta || {}).folder || "");
      if (want != null && !dir.toLowerCase().startsWith(want)) continue;
      const g = groups[dir + "|" + r.zone + "|" + r.privacy] = groups[dir + "|" + r.zone + "|" + r.privacy] || { folder: dir, zone: r.zone, access: r.privacy === "index" ? "text" : "links only", files: [] };
      g.files.push({ id: r.id, title: r.title, type: r.type, modified: r.remote_modified_at ? String(r.remote_modified_at).slice(0, 10) : undefined, topic: r.topic_id ? tn[r.topic_id] || undefined : undefined, tags: (r.tags || []).length ? r.tags : undefined, hasText: (withText.has(r.id) && !knNoText(r)) || undefined, ...(want != null ? { path: p, webUrl: r.web_url || undefined } : {}) });
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({
      items: want != null ? [] : shown.filter((r) => !r.provider).map((r) => ({ id: r.id, title: r.title, zone: r.zone, type: r.type, topic: r.topic_id ? tn[r.topic_id] || null : null, folder: (r.meta || {}).folder || null, tags: r.tags || [], summary: String(r.summary || r.why || "").slice(0, 240), hasText: withText.has(r.id), toSort: !!r.needs_sort })),
      oneDrive: Object.values(groups).sort((p, q) => String(p.folder).localeCompare(String(q.folder))).map((g) => want != null ? g : {
        folder: g.folder, zone: g.zone, access: g.access, files: g.files.length,
        newest: g.files.map((f: { modified?: string }) => f.modified || "").sort().pop() || undefined,
        sample: g.files.slice(0, 3).map((f: { title: string }) => f.title),
      }),
      next: want == null && Object.keys(groups).length ? "Call map_knowledge with folder set to one of these folders to list its files." : undefined,
      oneDriveFiles: shown.filter((r) => r.provider).length,
      links: (ed.data || []).filter((e) => ids.has(e.from_id) && ids.has(e.to_id)),
      keptFromClaude: rows.length - shown.length + (pv.count || 0),
      hidden,
      oneDriveSources: (src.data || []).map((x) => ({ id: x.id, privacy: x.privacy, zone: x.zone, privateSubfolders: Object.values(x.privacy_overrides || {}).filter((v) => v === "private").length })),
      truncated: rows.length === 3000 || undefined,
    }) }] };
  },
});

tool("cluster_knowledge", {
  description: "Put several Knowledge items into one topic (the page groups items by topic), optionally also into a folder. Use a short, plain topic name the owner would use, e.g. 'Housing & tenancy' or 'Remote sensing'. Reuse an existing topic name from map_knowledge when one fits. Items in zones kept from Claude are skipped.",
  inputSchema: z.object({ itemIds: z.array(z.string()).min(1).max(100), topic: z.string().min(2).max(60), folder: z.string().max(80).optional(), why: z.string().max(300).optional() }),
  handler: async (a: { itemIds: string[]; topic: string; folder?: string; why?: string }) => {
    const allowed = await knAllowed();
    const r = await knItems("id,zone,title,meta,provider,privacy").eq("user_id", OWNER).is("archived_at", null).in("id", a.itemIds);
    if (r.error) return fail(r.error.message + KN_HINT);
    let done = 0, skipped = 0;
    for (const it of r.data || []) {
      if (!knCan(it, allowed)) { skipped++; continue; }
      // deno-lint-ignore no-explicit-any
      const patch: Record<string, any> = { topic_id: await knTopicId(it.zone, a.topic.trim()), updated_at: new Date().toISOString() };
      if (a.folder) patch.meta = { ...(it.meta || {}), folder: a.folder.trim() };
      const up = await db.from("knowledge_items").update(patch).eq("id", it.id).eq("user_id", OWNER);
      if (!up.error) { done++; await knTrace("cluster", it.id, null, a.topic.trim() + (a.why ? " — " + a.why : "")); }
    }
    return ok({ ok: true, grouped: done, skipped, notFound: a.itemIds.length - (r.data || []).length, topic: a.topic.trim() });
  },
});

tool("link_knowledge", {
  description: "Connect two Knowledge items that belong together (one cites the other, an idea came from a book, two papers about the same flat, an author and their work). Say why in a few words; it is shown on the page. Linking the same pair twice does nothing.",
  inputSchema: z.object({ fromId: z.string(), toId: z.string(), why: z.string().max(200).optional() }),
  handler: async (a: { fromId: string; toId: string; why?: string }) => {
    if (a.fromId === a.toId) return fail("an item cannot be linked to itself");
    const allowed = await knAllowed();
    const r = await knItems("id,zone,title,provider,privacy").eq("user_id", OWNER).is("archived_at", null).in("id", [a.fromId, a.toId]);
    if (r.error) return fail(r.error.message + KN_HINT);
    if ((r.data || []).length !== 2) return fail("one or both items were not found");
    if ((r.data || []).some((x) => !knCan(x, allowed))) return fail(knKept((r.data || []).filter((x) => !knCan(x, allowed)).map((x) => x.zone)));
    const ins = await db.from("knowledge_edges").insert({ user_id: OWNER, from_id: a.fromId, to_id: a.toId, kind: "related" });
    if (ins.error && !/duplicate/i.test(ins.error.message)) return fail(ins.error.message);
    await knTrace("link", a.fromId, a.toId, a.why || "");
    return ok({ ok: true, alreadyLinked: !!ins.error });
  },
});

tool("spider_note", {
  description: "Leave a short line on the Knowledge page about what you are doing or what you found, e.g. 'Grouped 6 tenancy papers under Housing & tenancy'. Call it once at the end of a sorting pass with a one-sentence summary.",
  inputSchema: z.object({ text: z.string().min(2).max(300) }),
  handler: async (a: { text: string }) => { await knTrace("note", null, null, a.text); return ok({ ok: true }); },
});

// ---- Scanned documents: the spider reads the pictures ----
// Knowledge files whose pages have no text (scans the browser could not read, or skipped) are found here, their
// pages handed to Claude as pictures, and what Claude reads is saved as that item's text, so search and the web
// can use it. Files come from the planner's own storage (uploads, saved copies) or from OneDrive, read-only and
// only for folders set to "Index". Nothing is written to OneDrive; the text is kept in Supabase only.
const SCAN_EXT = /^(pdf|jpe?g|png)$/i;
// deno-lint-ignore no-explicit-any
const scanExt = (r: any) => String((r.meta && r.meta.ext) || (/\.([a-z0-9]+)$/i.exec(r.title || "") || [])[1] || "").toLowerCase();
// deno-lint-ignore no-explicit-any
const scanCurrent = (r: any) => { const s = r.meta && r.meta.scan_read; return s && (!r.remote_modified_at || s.at >= r.remote_modified_at) ? s : null; };
// deno-lint-ignore no-explicit-any
async function scanBytes(r: any): Promise<{ bytes?: Uint8Array; why?: string }> {
  const f = await db.from("knowledge_files").select("storage_path").eq("item_id", r.id).limit(1).maybeSingle();
  if (f.data && f.data.storage_path) {
    const d = await db.storage.from("knowledge").download(f.data.storage_path);
    if (d.data) return { bytes: new Uint8Array(await d.data.arrayBuffer()) };
  }
  if (r.provider === "onedrive") {
    if (r.privacy !== "index") return { why: "this OneDrive file is set to links only, so its content is never opened" };
    const res = await fetch(SUPABASE_URL + "/functions/v1/knowledge-onedrive/fetch", { method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": SERVICE_KEY }, body: JSON.stringify({ itemId: r.id }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); return { why: j.error === "reconnect" ? "OneDrive needs to be reconnected: the owner presses Reconnect OneDrive on the Knowledge page" : String(j.error || "OneDrive returned " + res.status) }; }
    return { bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  return { why: "no file is kept for this item, only its text" };
}
// deno-lint-ignore no-explicit-any
async function scanItem(id: string): Promise<{ r?: any; err?: ReturnType<typeof fail> }> {
  const q = await knItems("*").eq("id", id).eq("user_id", OWNER).is("archived_at", null).maybeSingle();
  if (q.error) return { err: fail(q.error.message + KN_HINT) };
  if (!q.data) return { err: fail("no open knowledge item with that id") };
  const allowed = await knAllowed();
  if (!knCan(q.data, allowed)) return { err: fail(knKept([q.data.zone])) };
  if (knNoText(q.data)) return { err: fail("Links only: the owner shares this file's name and link, not its content, so its pages are not opened.") };
  return { r: q.data };
}
const scanRange = (ps: number[]) => { const s = Array.from(new Set(ps)).sort((a, b) => a - b), out: string[] = []; for (let i = 0; i < s.length; i++) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; out.push(j > i ? s[i] + "–" + s[j] : String(s[i])); i = j; } return out.join(", "); };
tool("read_scans", {
  description: "Scanned documents in Knowledge, read by you. Three steps: (1) no id: lists items whose pages have no text or weak text (scans), most in need first. (2) id: returns up to 4 of its pages as pictures (default: the first pages without text; pass pages to choose) plus which pages still need reading. Read them carefully, keeping names, numbers, dates and amounts exact. (3) id + save: keeps what you read as that page's text, so search and the spider web can use it; pass done: true after the last page. Read-only for the files: nothing in OneDrive changes. Pages stored as fax-style or JPEG 2000 scans cannot be shown and are listed with the reason.",
  inputSchema: z.object({
    id: z.string().optional().describe("the knowledge item; leave out to list scans that need reading"),
    pages: z.array(z.number().int().min(1)).max(4).optional().describe("pages to return as pictures (1-based)"),
    save: z.array(z.object({ page: z.number().int().min(1), text: z.string().min(1).max(20000) })).max(8).optional().describe("the text you read, one entry per page"),
    done: z.boolean().optional().describe("with save: every page of this document has now been read"),
    folder: z.string().max(300).optional().describe("listing: only OneDrive files whose folder starts with this"),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  // deno-lint-ignore no-explicit-any
  handler: async (a: any) => {
    // (1) the list
    if (!a.id) {
      const allowed = await knAllowed();
      const it = await knItems("id,title,zone,type,meta,provider,privacy,index_status,remote_path,remote_modified_at,web_url").eq("user_id", OWNER).is("archived_at", null).limit(3000);
      if (it.error) return fail(it.error.message + KN_HINT);
      // deno-lint-ignore no-explicit-any
      let cand = (it.data || []).filter((r: any) => knCan(r, allowed) && !knNoText(r) && (SCAN_EXT.test(scanExt(r)) || r.index_status === "failed") && !(scanCurrent(r) || {}).complete);
      if (a.folder) cand = cand.filter((r: any) => String(r.remote_path || "").toLowerCase().startsWith(String(a.folder).toLowerCase().replace(/^\/+/, "")));
      const ids = cand.map((r: any) => r.id), pagesOf: Record<string, Set<number>> = {}, chunksOf: Record<string, number> = {}, totalOf: Record<string, number> = {};
      for (let i = 0; i < ids.length; i += 150) {
        const part = ids.slice(i, i + 150);
        const [ch, fl] = await Promise.all([db.from("knowledge_chunks").select("item_id,page").eq("user_id", OWNER).in("item_id", part).limit(20000), db.from("knowledge_files").select("item_id,pages").in("item_id", part)]);
        for (const c of ch.data || []) { (pagesOf[c.item_id] = pagesOf[c.item_id] || new Set()).add(c.page || 1); chunksOf[c.item_id] = (chunksOf[c.item_id] || 0) + 1; }
        for (const f of fl.data || []) if (f.pages) totalOf[f.item_id] = f.pages;
      }
      const rows = cand.map((r: any) => {
        const has = pagesOf[r.id] ? pagesOf[r.id].size : 0, total = totalOf[r.id] || null, done = scanCurrent(r);
        let why = "", rank = 9;
        if (r.index_status === "failed") { why = "the browser could not read this file"; rank = 0; }
        else if (!has) { why = "no text at all (probably a scan)"; rank = 1; }
        else if (total && has < total * 0.8) { why = has + " of " + total + " pages have text"; rank = 2; }
        else if (/not read/i.test(String((r.meta && r.meta.note) || ""))) { why = "some scanned pages were skipped"; rank = 3; }
        else if (r.meta && r.meta.ocr) { why = "its text came from quick OCR in the browser and may be weak"; rank = 5; }
        return why ? { id: r.id, title: r.title, zone: r.zone, type: r.type, folder: r.remote_path || (r.meta && r.meta.folder) || undefined, pages: total || undefined, pagesWithText: has, why, rank, readByClaude: done ? scanRange(done.pages || []) : undefined } : null;
      }).filter(Boolean).sort((x: any, y: any) => x.rank - y.rank).slice(0, a.limit || 30).map(({ rank: _r, ...x }: any) => x);
      return ok({ count: rows.length, items: rows, next: rows.length ? "Call read_scans with an id to see its pages." : "Nothing needs reading: every readable scan has text." });
    }
    const got = await scanItem(a.id); if (got.err) return got.err; const r = got.r;
    // (3) keep what was read
    if (a.save && a.save.length) {
      const pages: number[] = [];
      for (const s of a.save) {
        const text = String(s.text).trim(); if (!text) continue;
        await db.from("knowledge_chunks").delete().eq("item_id", r.id).eq("user_id", OWNER).eq("page", s.page);
        const parts: string[] = []; for (let i = 0; i < text.length; i += 4000) parts.push(text.slice(i, i + 4000));
        const ins = await db.from("knowledge_chunks").insert(parts.map((content) => ({ user_id: OWNER, item_id: r.id, page: s.page, content })));
        if (ins.error) return fail("could not save page " + s.page + ": " + ins.error.message);
        pages.push(s.page);
      }
      const prev = scanCurrent(r), all = Array.from(new Set([...(prev ? prev.pages || [] : []), ...pages])).sort((x, y) => x - y);
      const patch: Record<string, unknown> = { meta: { ...(r.meta || {}), scan_read: { pages: all, at: new Date().toISOString(), complete: !!a.done } } };
      if (r.provider === "onedrive" && r.index_status === "failed") patch.index_status = "indexed";
      if (!r.summary && a.save[0]) patch.summary = String(a.save[0].text).replace(/\s+/g, " ").trim().slice(0, 240);
      await db.from("knowledge_items").update(patch).eq("id", r.id).eq("user_id", OWNER);
      await knTrace("note", r.id, null, "Read and saved the text of scanned page" + (pages.length === 1 ? " " : "s ") + scanRange(pages) + " of “" + r.title + "”");
      return ok({ saved: pages, pagesReadSoFar: scanRange(all), complete: !!a.done, note: "The text is searchable now; the Knowledge page adds meaning search for it the next time it is open." });
    }
    // (2) the pages as pictures
    const f = await scanBytes(r); if (!f.bytes) return fail(f.why || "the file could not be opened");
    const img = imageFileMime(f.bytes);
    if (img) {
      if (f.bytes.length > MAX_IMAGE_BYTES) return fail("this picture is too large to pass on (" + Math.round(f.bytes.length / 1e5) / 10 + " MB)");
      await knTrace("read", r.id, null, "Reading the scan “" + r.title + "”");
      return { content: [{ type: "text" as const, text: JSON.stringify({ id: r.id, title: r.title, pageCount: 1, returned: [1], next: "Read it, then call read_scans with id and save: [{ page: 1, text }] and done: true." }) }, { type: "image" as const, data: b64(f.bytes), mimeType: img }] };
    }
    if (!isPdf(f.bytes)) return fail("this file is not a PDF or a picture, so it has no scanned pages to show");
    const doc = await openPdf(f.bytes); if (!doc) return fail("this PDF could not be opened (damaged or locked with a password)");
    const n = doc.getPageCount(), ch = await db.from("knowledge_chunks").select("page").eq("item_id", r.id).eq("user_id", OWNER).limit(20000);
    const withText = new Set((ch.data || []).map((c: { page: number | null }) => c.page || 1)), need: number[] = [];
    for (let p = 1; p <= n; p++) if (!withText.has(p)) need.push(p);
    // named pages as asked; otherwise walk the pages without text until 4 can be shown (looking at 12 at most)
    const pool = a.pages && a.pages.length ? a.pages.filter((p: number) => p <= n) : (need.length ? need : Array.from({ length: n }, (_, i) => i + 1)).slice(0, 12);
    const shots: ReturnType<typeof scanPages> = [];
    for (const p of pool) { const s1 = scanPages(doc, [p])[0]; shots.push(s1); if (shots.filter((x) => x.data).length >= 4) break; }
    const out: { type: "image"; data: string; mimeType: string }[] = [], returned: number[] = [], skipped: { page: number; why: string }[] = [];
    let total = 0;
    for (const s of shots) {
      if (!s.data || !s.mime) { skipped.push({ page: s.page, why: s.why || "no picture" }); continue; }
      if (total + s.data.length > 7_000_000) { skipped.push({ page: s.page, why: "left for the next call (size)" }); continue; }
      total += s.data.length; out.push({ type: "image", data: b64(s.data), mimeType: s.mime }); returned.push(s.page);
      if (s.why) skipped.push({ page: s.page, why: "shown, but " + s.why });
    }
    if (returned.length) await knTrace("read", r.id, null, "Reading scanned page" + (returned.length === 1 ? " " : "s ") + scanRange(returned) + " of “" + r.title + "”");
    const left = need.filter((p) => !returned.includes(p));
    return { content: [{ type: "text" as const, text: JSON.stringify({ id: r.id, title: r.title, pageCount: n, pagesWithText: withText.size, returned, skipped: skipped.length ? skipped : undefined, stillWithoutText: left.length ? scanRange(left) : "none", next: returned.length ? "Read the pictures in order, then call read_scans with id and save: [{ page, text }, …]" + (left.length ? "; then ask for the next pages." : " and done: true.") : "Nothing could be shown; see skipped." }) }, ...out] };
  },
});

// ---- The spider's web: a structure Claude weaves over the knowledge. Themes (inside themes), each item
// in one theme, and threads between items or themes, each with a reason. Stored as one JSON value on
// knowledge_settings.spider_map; the Knowledge page draws it as its first view, "Spider". Weaving only
// changes this structure, never the items. Items kept from Claude never enter it.
const SP_HINT = " (the web needs one new column first: run _Memory/migration_knowledge_spidermap.sql in the Supabase SQL editor)";
type SpTheme = { id: string; name: string; parent: string | null; why: string; items: string[] };
type SpThread = { from: string; to: string; why: string };
type SpMap = { version: 1; startedAt: string; updatedAt: string; summary: string; themes: SpTheme[]; threads: SpThread[]; previous?: unknown };
const SP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const spOk = (d: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(d) }] });
const spEmpty = (): SpMap => { const t = new Date().toISOString(); return { version: 1, startedAt: t, updatedAt: t, summary: "", themes: [], threads: [] }; };
async function spLoad(): Promise<{ map?: SpMap; error?: string }> {
  const r = await db.from("knowledge_settings").select("spider_map").eq("user_id", OWNER).maybeSingle();
  if (r.error) return { error: r.error.message + (/spider_map/.test(r.error.message) ? SP_HINT : "") };
  // deno-lint-ignore no-explicit-any
  const m = r.data && (r.data as any).spider_map;
  return { map: m && Array.isArray(m.themes) ? m as SpMap : spEmpty() };
}
async function spSave(map: SpMap): Promise<string | null> {
  map.updatedAt = new Date().toISOString();
  const r = await db.from("knowledge_settings").upsert({ user_id: OWNER, spider_map: map, updated_at: map.updatedAt }, { onConflict: "user_id" });
  return r.error ? r.error.message + (/spider_map/.test(r.error.message) ? SP_HINT : "") : null;
}
const spFind = (m: SpMap, name: string) => m.themes.find((t) => t.name.toLowerCase() === String(name || "").trim().toLowerCase());
const spName = (m: SpMap, id: string | null) => (id && m.themes.find((t) => t.id === id)?.name) || null;
async function spAllowed(ids: string[]): Promise<{ ok: Set<string>; titles: Record<string, string>; error?: string }> {
  const want = Array.from(new Set(ids.filter((x) => SP_UUID.test(x)))), out = new Set<string>(), titles: Record<string, string> = {};
  if (!want.length) return { ok: out, titles };
  const allowed = await knAllowed();
  for (let i = 0; i < want.length; i += 200) {
    const r = await knItems("id,zone,title,provider,privacy").eq("user_id", OWNER).is("archived_at", null).in("id", want.slice(i, i + 200));
    if (r.error) return { ok: out, titles, error: r.error.message + KN_HINT };
    for (const x of r.data || []) if (knCan(x, allowed)) { out.add(x.id); titles[x.id] = x.title; }
  }
  return { ok: out, titles };
}
// "item:<id>" or "theme:<id>" from an item id or a theme name
async function spEnd(m: SpMap, ref: string): Promise<{ key?: string; label?: string; error?: string }> {
  if (SP_UUID.test(ref)) { const A = await spAllowed([ref]); if (A.error) return { error: A.error }; if (!A.ok.has(ref)) return { error: "item " + ref + " was not found or is kept from Claude" }; return { key: "item:" + ref, label: A.titles[ref] }; }
  const t = spFind(m, ref); if (!t) return { error: "no theme called '" + ref + "' and not an item id" };
  return { key: "theme:" + t.id, label: t.name };
}

tool("get_spider_web", {
  description: "The web the spider has woven over the Knowledge page so far: every theme (parent, reason, item count), the threads between items or themes, the summary, and items not in the web yet (id, title, folder) so you can place them. Call this first, so you extend the web instead of starting over. Pass theme to list that theme's items.",
  inputSchema: z.object({
    unplaced: z.number().int().min(0).max(300).optional().describe("how many items not yet in the web to list (default 60)"),
    theme: z.string().max(60).optional().describe("list this theme's items with their titles"),
  }),
  handler: async (a: { unplaced?: number; theme?: string }) => {
    const L = await spLoad(); if (L.error) return fail(L.error); const m = L.map!;
    const allowed = await knAllowed();
    const r = await knItems("id,zone,title,provider,privacy,meta,remote_path").eq("user_id", OWNER).is("archived_at", null).limit(3000);
    if (r.error) return fail(r.error.message + KN_HINT);
    // deno-lint-ignore no-explicit-any
    const vis = (r.data || []).filter((x: any) => knCan(x, allowed)), title: Record<string, string> = {};
    // deno-lint-ignore no-explicit-any
    vis.forEach((x: any) => { title[x.id] = x.title; });
    const placed = new Set<string>(); m.themes.forEach((t) => t.items.forEach((i) => { if (title[i]) placed.add(i); }));
    // deno-lint-ignore no-explicit-any
    const folderOf = (x: any) => x.remote_path ? String(x.remote_path).split("/").slice(0, -1).join("/") : (x.meta && x.meta.folder) || "";
    // deno-lint-ignore no-explicit-any
    const un = vis.filter((x: any) => !placed.has(x.id));
    const th = a.theme ? spFind(m, a.theme) : null;
    if (a.theme && !th) return fail("no theme called '" + a.theme + "'");
    const lab = (k: string) => k.startsWith("theme:") ? "theme " + (spName(m, k.slice(6)) || "?") : title[k.slice(5)] || "(an item kept from Claude)";
    return spOk({
      summary: m.summary || null, updatedAt: m.updatedAt, items: vis.length, inWeb: placed.size, notInWebYet: un.length,
      themes: m.themes.map((t) => ({ name: t.name, parent: spName(m, t.parent), why: t.why || undefined, items: t.items.filter((i) => title[i]).length })),
      threads: m.threads.map((t) => ({ from: lab(t.from), to: lab(t.to), why: t.why })),
      themeItems: th ? th.items.filter((i) => title[i]).map((i) => ({ id: i, title: title[i] })) : undefined,
      // deno-lint-ignore no-explicit-any
      unplaced: un.slice(0, a.unplaced ?? 60).map((x: any) => ({ id: x.id, title: x.title, folder: folderOf(x) || undefined })),
      hasPrevious: !!m.previous,
    });
  },
});

tool("weave_theme", {
  description: "Create or change one theme in the spider's web and place items in it. Leave parent out for a main theme, or name the theme it sits inside. An item lives in one theme, so placing it here takes it out of any other. Give a short reason the owner would understand. Use rename to rename. Only the web changes; the items themselves are never edited.",
  inputSchema: z.object({
    name: z.string().min(2).max(60),
    parent: z.string().max(60).optional().describe("the theme this one sits inside; an empty string moves it back to the top"),
    why: z.string().max(300).optional(),
    itemIds: z.array(z.string()).max(200).optional(),
    rename: z.string().min(2).max(60).optional(),
  }),
  handler: async (a: { name: string; parent?: string; why?: string; itemIds?: string[]; rename?: string }) => {
    const L = await spLoad(); if (L.error) return fail(L.error); const m = L.map!;
    let t = spFind(m, a.name), created = false;
    if (!t) {
      if (m.themes.length >= 150) return fail("the web already has 150 themes; fold some together first");
      t = { id: "t" + crypto.randomUUID().slice(0, 8), name: a.name.trim(), parent: null, why: "", items: [] }; m.themes.push(t); created = true;
    }
    const me = t;
    if (a.parent !== undefined) {
      if (!a.parent.trim()) me.parent = null;
      else {
        const p = spFind(m, a.parent); if (!p) return fail("no theme called '" + a.parent + "' yet; weave it first");
        for (let cur: SpTheme | undefined = p; cur; cur = cur.parent ? m.themes.find((x) => x.id === cur!.parent) : undefined) if (cur.id === me.id) return fail("that would put a theme inside itself");
        me.parent = p.id;
      }
    }
    if (a.rename) { const clash = spFind(m, a.rename); if (clash && clash.id !== me.id) return fail("a theme called '" + a.rename + "' already exists"); me.name = a.rename.trim(); }
    if (a.why !== undefined) me.why = a.why.trim();
    let added = 0, refused: string[] = [], first: string | null = null;
    if (a.itemIds && a.itemIds.length) {
      const A = await spAllowed(a.itemIds); if (A.error) return fail(A.error);
      refused = a.itemIds.filter((x) => !A.ok.has(x));
      m.themes.forEach((o) => { if (o.id !== me.id) o.items = o.items.filter((i) => !A.ok.has(i)); });
      A.ok.forEach((i) => { if (!first) first = i; if (!me.items.includes(i)) { me.items.push(i); added++; } });
    }
    const e = await spSave(m); if (e) return fail(e);
    await knTrace("cluster", first, null, "Web: " + me.name + (a.why ? " — " + a.why : ""));
    return spOk({ ok: true, theme: me.name, created, parent: spName(m, me.parent), items: me.items.length, added, refused: refused.length ? refused : undefined });
  },
});

tool("spin_thread", {
  description: "Spin a thread in the spider's web between two things that relate across themes: an item and an item, an item and a theme, or two themes. Pass an item id or a theme name for each end, and say why in a few words (shown on the page). Spinning the same pair again updates the reason.",
  inputSchema: z.object({ from: z.string().min(1), to: z.string().min(1), why: z.string().min(2).max(200) }),
  handler: async (a: { from: string; to: string; why: string }) => {
    const L = await spLoad(); if (L.error) return fail(L.error); const m = L.map!;
    const f = await spEnd(m, a.from); if (f.error) return fail(f.error);
    const t = await spEnd(m, a.to); if (t.error) return fail(t.error);
    if (f.key === t.key) return fail("a thread needs two different ends");
    const had = m.threads.find((x) => (x.from === f.key && x.to === t.key) || (x.from === t.key && x.to === f.key));
    if (had) had.why = a.why.trim(); else { if (m.threads.length >= 400) return fail("the web already has 400 threads"); m.threads.push({ from: f.key!, to: t.key!, why: a.why.trim() }); }
    const e = await spSave(m); if (e) return fail(e);
    const fi = f.key!.startsWith("item:") ? f.key!.slice(5) : null, ti = t.key!.startsWith("item:") ? t.key!.slice(5) : null;
    await knTrace("link", fi || ti, fi ? ti : null, "Thread: " + f.label + " ↔ " + t.label + " — " + a.why);
    return spOk({ ok: true, from: f.label, to: t.label, updated: !!had, threads: m.threads.length });
  },
});

tool("unweave", {
  description: "Take something out of the spider's web: a theme (its sub-themes move up to its parent, its items wait to be placed again), some items, or one thread (from and to). Only the web changes; nothing is archived or edited.",
  inputSchema: z.object({ theme: z.string().max(60).optional(), itemIds: z.array(z.string()).max(200).optional(), threadFrom: z.string().optional(), threadTo: z.string().optional() }),
  handler: async (a: { theme?: string; itemIds?: string[]; threadFrom?: string; threadTo?: string }) => {
    const L = await spLoad(); if (L.error) return fail(L.error); const m = L.map!; const did: string[] = [];
    if (a.theme) {
      const t = spFind(m, a.theme); if (!t) return fail("no theme called '" + a.theme + "'");
      m.themes.forEach((x) => { if (x.parent === t.id) x.parent = t.parent; });
      m.themes = m.themes.filter((x) => x.id !== t.id); m.threads = m.threads.filter((x) => x.from !== "theme:" + t.id && x.to !== "theme:" + t.id);
      did.push("theme " + t.name);
    }
    if (a.itemIds && a.itemIds.length) {
      const drop = new Set(a.itemIds);
      m.themes.forEach((x) => { x.items = x.items.filter((i) => !drop.has(i)); });
      m.threads = m.threads.filter((x) => !drop.has(x.from.slice(5)) && !drop.has(x.to.slice(5)));
      did.push(a.itemIds.length + " items");
    }
    if (a.threadFrom && a.threadTo) {
      const f = await spEnd(m, a.threadFrom), t = await spEnd(m, a.threadTo);
      if (f.error || t.error) return fail(f.error || t.error || "");
      const n = m.threads.length; m.threads = m.threads.filter((x) => !((x.from === f.key && x.to === t.key) || (x.from === t.key && x.to === f.key)));
      if (n !== m.threads.length) did.push("thread " + f.label + " ↔ " + t.label);
    }
    if (!did.length) return fail("say what to take out: theme, itemIds, or threadFrom with threadTo");
    const e = await spSave(m); if (e) return fail(e);
    return spOk({ ok: true, removed: did });
  },
});

tool("start_spider_web", {
  description: "Start a fresh web when the current structure no longer fits. The current web is kept as the previous one (one level back), so nothing is lost; the items are never touched. Usually you extend the web with weave_theme instead.",
  inputSchema: z.object({ reason: z.string().max(200).optional() }),
  handler: async (a: { reason?: string }) => {
    const L = await spLoad(); if (L.error) return fail(L.error); const m = L.map!;
    const fresh = spEmpty();
    if (m.themes.length || m.threads.length) fresh.previous = { savedAt: new Date().toISOString(), summary: m.summary, themes: m.themes, threads: m.threads };
    const e = await spSave(fresh); if (e) return fail(e);
    await knTrace("note", null, null, "Started a fresh web" + (a.reason ? ": " + a.reason : ""));
    return spOk({ ok: true, keptPrevious: !!fresh.previous });
  },
});

tool("finish_spider_web", {
  description: "Finish a weaving pass: two or three plain sentences on how the web is structured and why, shown at the top of the Spider view.",
  inputSchema: z.object({ summary: z.string().min(10).max(600) }),
  handler: async (a: { summary: string }) => {
    const L = await spLoad(); if (L.error) return fail(L.error); const m = L.map!;
    m.summary = a.summary.trim();
    const e = await spSave(m); if (e) return fail(e);
    await knTrace("note", null, null, a.summary.slice(0, 300));
    return spOk({ ok: true, themes: m.themes.length, threads: m.threads.length });
  },
});

tool("set_item_type", {
  description: "Change what a Knowledge item is (for example from 'document' to 'contract'). The zone follows from the type. Also clears the 'to sort' flag.",
  inputSchema: z.object({ id: z.string(), type: z.string().max(40) }),
  handler: async (a: { id: string; type: string }) => {
    const zone = knZoneOfType(a.type);
    if (!zone) return fail("unknown type; use one of: " + KN_ZONES.map((z) => KN_TYPES[z].join(", ")).join(", "));
    const up = await db.from("knowledge_items").update({ type: a.type, zone, needs_sort: false, updated_at: new Date().toISOString() }).eq("id", a.id).eq("user_id", OWNER).select("id");
    if (up.error) return fail(up.error.message + KN_HINT);
    if (!up.data || !up.data.length) return fail("no knowledge item with that id");
    return ok({ ok: true, id: a.id, zone, type: a.type });
  },
});

tool("list_recent_knowledge", {
  description: "What was added to the Knowledge page recently (default: the last 7 days), newest first. Items in zones kept from Claude are only counted.",
  inputSchema: z.object({ days: z.number().int().min(1).max(365).optional() }),
  handler: async (a: { days?: number }) => {
    const since = new Date(Date.now() - (a.days || 7) * 86400000).toISOString(), allowed = await knAllowed();
    const r = await knItems("*").eq("user_id", OWNER).is("archived_at", null).gte("created_at", since).order("created_at", { ascending: false }).limit(100);
    if (r.error) return fail(r.error.message + KN_HINT);
    const rows = r.data || [], shown = rows.filter((x) => knCan(x, allowed));
    return ok({ since, items: shown.map(knSlim), keptFromClaude: rows.length - shown.length, toSort: shown.filter((x) => x.needs_sort).length });
  },
});

// ============================ WRITE TOOLS ===================================
// These mirror the app's in-page Agent tools (executeAgentTool in index.html).
// Every insert sets user_id explicitly because the service-role client has no
// auth.uid() to fall back on for the column default.

tool("create_goal", {
  description: "Create a new goal.",
  inputSchema: z.object({
    title: z.string(),
    priority: z.enum(PRIORITIES),
    area: z.enum(AREA_INPUT).describe("the goal's primary area. " + AREA_GUIDE),
    due: z.string().optional().describe("YYYY-MM-DD; omit if ongoing or no due date"),
    ongoing: z.boolean().optional(),
    score_mode: z.enum(SCORE_MODES).optional().describe("how the 0-100 score is worked out; default tasks"),
    score: z.number().min(0).max(100).nullable().optional().describe("for score_mode manual (8.5/10 = 85)"),
    secondary_areas: z.array(z.enum(AREA_INPUT)).max(3).optional(),
  }),
  handler: async (args: { title: string; priority: string; area: string; due?: string; ongoing?: boolean; score_mode?: string; score?: number | null; secondary_areas?: string[] }) => {
    const ongoing = !!args.ongoing, mode = args.score_mode || (args.score != null ? "manual" : undefined);
    const { data, error } = await safeWrite((p) => db.from("goals").insert(p).select().single(), {
      user_id: OWNER, title: args.title, priority: args.priority, category: args.area,
      due: ongoing ? null : (args.due || null), ongoing,
      ...(mode ? { score_mode: mode } : {}), ...(args.score !== undefined ? { score: args.score, score_history: scoreHist([], berlinToday(), args.score), score_updated_at: new Date().toISOString() } : {}),
      ...(args.secondary_areas ? { secondary_categories: args.secondary_areas.map(normArea) } : {}),
    });
    if (error) return fail(error.message);
    if (mode && mode !== "manual") await refreshGoalScores();
    return ok({ ok: true, id: data.id });
  },
});

tool("edit_goal", {
  description: "Edit an existing goal by id: title, priority, area, secondary areas, due date, or its score (score_mode manual | sleep | workout | net_zero | tasks; score for manual). Only the fields you pass are changed.",
  inputSchema: z.object({
    id: z.string(),
    title: z.string().optional(),
    priority: z.enum(PRIORITIES).optional(),
    area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE),
    due: z.string().optional(),
    ongoing: z.boolean().optional(),
    score_mode: z.enum(SCORE_MODES).optional().describe("manual | sleep | workout | net_zero | tasks"),
    score: z.number().min(0).max(100).nullable().optional().describe("sets a manual score (8.5/10 = 85); switches the goal to manual"),
    secondary_areas: z.array(z.enum(AREA_INPUT)).max(3).optional(),
  }),
  handler: async (args: any) => {
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.area !== undefined) patch.category = args.area;
    if (args.due !== undefined) patch.due = args.due || null;
    if (args.ongoing !== undefined) patch.ongoing = args.ongoing;
    if (args.ongoing === true) patch.due = null;
    if (args.secondary_areas !== undefined) patch.secondary_categories = args.secondary_areas.map(normArea);
    if (args.score_mode !== undefined) patch.score_mode = args.score_mode;
    if (args.score !== undefined) {
      if (!args.score_mode) patch.score_mode = "manual";
      const cur = await db.from("goals").select("score_history").eq("id", args.id).eq("user_id", OWNER).maybeSingle();
      patch.score = args.score; patch.score_history = scoreHist(cur.data && cur.data.score_history, berlinToday(), args.score); patch.score_updated_at = new Date().toISOString();
    }
    const { error } = await safeWrite((p) => db.from("goals").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    if (args.score_mode && args.score_mode !== "manual") await refreshGoalScores();
    return ok({ ok: true });
  },
});

tool("create_project", {
  description: "Create a new project, optionally attached to a goal.",
  inputSchema: z.object({
    title: z.string(),
    priority: z.enum(PRIORITIES),
    goalId: z.string().optional().describe("id of the parent goal; omit for no parent"),
    due: z.string().optional(),
    hours: z.number().optional(),
    areas: z.array(z.enum(AREA_INPUT)).optional().describe("the project's own area(s); omit to inherit the parent goal's area"),
  }),
  handler: async (args: any) => {
    const { data, error } = await safeWrite((p) => db.from("projects").insert(p).select().single(), {
      user_id: OWNER, goal_id: args.goalId || null, title: args.title, priority: args.priority,
      due: args.due || null, hours: args.hours || 0, done: false, categories: args.areas || [],
    });
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id });
  },
});

tool("edit_project", {
  description: "Edit an existing project by id. Only the fields you pass are changed.",
  inputSchema: z.object({
    id: z.string(),
    title: z.string().optional(),
    goalId: z.string().optional(),
    priority: z.enum(PRIORITIES).optional(),
    due: z.string().optional(),
    hours: z.number().optional(),
    done: z.boolean().optional(),
    areas: z.array(z.enum(AREA_INPUT)).optional(),
  }),
  handler: async (args: any) => {
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.goalId !== undefined) patch.goal_id = args.goalId || null;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.due !== undefined) patch.due = args.due || null;
    if (args.hours !== undefined) patch.hours = args.hours;
    if (args.done !== undefined) patch.done = args.done;
    if (args.areas !== undefined) patch.categories = args.areas;
    const { error } = await safeWrite((p) => db.from("projects").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

tool("create_action", {
  description: "Create a new single-shot action (task), optionally attached to a goal or project and scheduled for a date. This is how you 'schedule something' for the user.",
  inputSchema: z.object({
    title: z.string(),
    type: z.enum(ACTION_TYPES),
    priority: z.enum(PRIORITIES),
    parentType: z.enum(["goal", "project", "none"]).describe("what this action hangs off of"),
    parentId: z.string().optional().describe("id of the parent goal or project; omit if parentType is none"),
    date: z.string().optional().describe("YYYY-MM-DD the action is scheduled for; omit for backlog"),
    timeOfDay: z.string().optional().describe("HH:MM 24h, optional"),
    durationMinutes: z.number().optional(),
    area: z.enum(AREA_INPUT).optional().describe("the action's own area; otherwise inferred from its parent. " + AREA_GUIDE),
    secondaryAreas: z.array(z.enum(AREA_INPUT)).optional().describe("other areas this action also touches"),
    isMilestone: z.boolean().optional().describe("mark it a milestone — a dated checkpoint rather than ordinary work"),
    isDecision: z.boolean().optional().describe("mark it a decision — a fork with a scenario canvas rather than a task. Add scenarios with scenario (action create)."),
    notes: z.string().optional().describe("longer free-form notes for the action's own page (Markdown)"),
    location: z.string().optional().describe("where it happens — an address or place name, geocoded for you and pinned on the Location map"),
    kind: z.enum(["task", "deadline", "block"]).optional().describe("task = something to tick off (default); deadline = a date something is due; block = time reserved, e.g. gym or deep work (no done state). For something that simply happens, use create_event."),
    estimateMinutes: z.number().int().min(1).max(1440).optional().describe("how long the task should take"),
    allDay: z.boolean().optional(),
    someday: z.boolean().optional().describe("park it: no date, never shown as open or late"),
    recurrence: CC_RECUR,
    reminders: CC_REMINDERS,
  }),
  handler: async (args: any) => {
    const pt = args.parentType || "none";
    const bad = ccCheck(args); if (bad) return fail(bad);
    if (args.recurrence && !args.date) return fail("a repeating item needs a first date");
    const kind = args.kind || (args.isMilestone ? "deadline" : "task");
    const extra = {
      kind, estimate_min: args.estimateMinutes || null, all_day: !!args.allDay, someday: !!args.someday,
      recurrence: args.recurrence || null, reminders: args.reminders || [],
    };
    // Sent twice? Update the open item with the same title, date and kind rather than adding another.
    const dup = await ccExisting("actions", args.title, args.date || null, kind);
    if (dup) {
      const patch: Record<string, unknown> = { priority: args.priority, recurrence: extra.recurrence, reminders: extra.reminders };
      if (args.timeOfDay !== undefined) patch.time_of_day = args.timeOfDay || null;
      if (args.durationMinutes !== undefined) patch.duration_minutes = args.durationMinutes;
      if (args.estimateMinutes !== undefined) patch.estimate_min = args.estimateMinutes;
      if (args.notes) patch.notes_md = args.notes;
      const up = await safeWrite((p) => db.from("actions").update(p).eq("id", dup.id).eq("user_id", OWNER), patch);
      if (up.error) return fail(up.error.message);
      return ok({ ok: true, id: dup.id, alreadyExisted: true });
    }
    const place = await resolvePlace({ address: args.location });
    if (place.error) return fail(place.error);
    const { data, error } = await safeWrite((p) => db.from("actions").insert(p).select().single(), {
      ...extra,
      user_id: OWNER, title: args.title, type: args.type, priority: args.priority,
      parent_type: pt, parent_id: pt === "none" ? null : (args.parentId || null),
      date: args.date || null, done: false, time_of_day: args.timeOfDay || null,
      duration_minutes: args.durationMinutes || null, category: args.area || null,
      secondary_categories: args.secondaryAreas || [],
      is_milestone: !!args.isMilestone || kind === "deadline", is_decision: !!args.isDecision,
      notes_md: args.notes || "",
      location_address: place.address, location_lat: place.lat, location_lng: place.lng,
      source: "claude",
    });
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id, lat: place.lat, lng: place.lng });
  },
});

tool("edit_action", {
  description: "Edit an existing action by id (reschedule, rename, re-prioritize, re-parent, mark done). Only the fields you pass are changed.",
  inputSchema: z.object({
    id: z.string(),
    title: z.string().optional(),
    type: z.enum(ACTION_TYPES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    parentType: z.enum(["goal", "project", "none"]).optional(),
    parentId: z.string().optional(),
    date: z.string().optional().describe("YYYY-MM-DD; pass an empty string to clear the date"),
    timeOfDay: z.string().optional(),
    durationMinutes: z.number().optional(),
    area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE),
    secondaryAreas: z.array(z.enum(AREA_INPUT)).optional().describe("replaces the existing set"),
    isMilestone: z.boolean().optional(),
    notes: z.string().optional().describe("free-form notes for the action's own page (Markdown); replaces what's there"),
    done: z.boolean().optional(),
    kind: z.enum(["task", "deadline", "block"]).optional(),
    estimateMinutes: z.number().int().min(1).max(1440).optional(),
    someday: z.boolean().optional().describe("true parks it (clears the date); false brings it back to the backlog"),
    recurrence: CC_RECUR,
    reminders: CC_REMINDERS,
    allDay: z.boolean().optional(),
    muted: z.boolean().optional().describe("no reminders for this item"),
    skipDates: z.array(z.string().regex(CC_DAY)).max(200).optional().describe("for a repeating item: dates to leave out (replaces the existing list)"),
  }),
  handler: async (args: any) => {
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.type !== undefined) patch.type = args.type;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.parentType !== undefined) patch.parent_type = args.parentType;
    if (args.parentId !== undefined) patch.parent_id = args.parentType === "none" ? null : (args.parentId || null);
    if (args.date !== undefined) patch.date = args.date || null;
    if (args.timeOfDay !== undefined) patch.time_of_day = args.timeOfDay || null;
    if (args.durationMinutes !== undefined) patch.duration_minutes = args.durationMinutes;
    if (args.area !== undefined) patch.category = args.area;
    if (args.secondaryAreas !== undefined) patch.secondary_categories = args.secondaryAreas;
    if (args.isMilestone !== undefined) patch.is_milestone = args.isMilestone;
    if (args.notes !== undefined) patch.notes_md = args.notes;
    if (args.done !== undefined) patch.done = args.done;
    const bad = ccCheck(args); if (bad) return fail(bad);
    if (args.kind !== undefined) { patch.kind = args.kind; patch.is_milestone = args.kind === "deadline"; }
    if (args.estimateMinutes !== undefined) patch.estimate_min = args.estimateMinutes;
    if (args.allDay !== undefined) patch.all_day = args.allDay;
    if (args.someday !== undefined) { patch.someday = args.someday; if (args.someday) { patch.date = null; patch.time_of_day = null; } }
    if (args.recurrence !== undefined) patch.recurrence = args.recurrence || null;
    if (args.reminders !== undefined) patch.reminders = args.reminders;
    if (args.muted !== undefined) patch.muted = args.muted;
    if (args.skipDates !== undefined) patch.recurrence_exceptions = args.skipDates;
    if (Object.keys(patch).length === 0) return fail("nothing to update — pass at least one field");
    const { error } = await safeWrite((p) => db.from("actions").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

tool("complete_action", {
  description: "Mark an action done (or not done). Convenience wrapper over edit_action.",
  inputSchema: z.object({
    id: z.string(),
    done: z.boolean().optional().describe("defaults to true"),
    occurrenceDate: z.string().regex(CC_DAY, "use YYYY-MM-DD").optional().describe("for a repeating action: which date to tick off (defaults to today, Berlin)"),
  }),
  handler: async (args: { id: string; done?: boolean; occurrenceDate?: string }) => {
    const cur = await db.from("actions").select("recurrence,recurrence_done").eq("id", args.id).eq("user_id", OWNER).maybeSingle();
    if (cur.data && cur.data.recurrence) {
      // A repeating action is ticked off per date; the series itself stays open.
      const d = args.occurrenceDate || berlinToday(), list: string[] = (cur.data.recurrence_done || []).filter((x: string) => x !== d);
      if (args.done !== false) list.push(d);
      const up = await db.from("actions").update({ recurrence_done: list }).eq("id", args.id).eq("user_id", OWNER);
      if (up.error) return fail(up.error.message);
      return ok({ ok: true, repeating: true, date: d, done: args.done !== false });
    }
    const { error } = await safeWrite((p) => db.from("actions").update(p).eq("id", args.id).eq("user_id", OWNER), { done: args.done === undefined ? true : args.done });
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

// ---- Events ----------------------------------------------------------------

tool("set_main_thing", {
  description: "Choose the one action shown large on the Today page for a day (defaults to today, Berlin time). Replaces any earlier choice for that day. Pass clear=true to go back to the automatic choice.",
  inputSchema: z.object({
    id: z.string().optional().describe("the action; omit only with clear=true"),
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today in Berlin"),
    clear: z.boolean().optional(),
  }),
  handler: async (args: { id?: string; date?: string; clear?: boolean }) => {
    if (!args.id && !args.clear) return fail("pass id, or clear=true");
    const date = args.date || berlinToday();
    const off = await db.from("actions").update({ focus_date: null }).eq("user_id", OWNER).eq("focus_date", date);
    if (off.error) return fail(off.error.message);
    if (args.clear) return ok({ ok: true, date, cleared: true });
    const { error } = await db.from("actions").update({ focus_date: date }).eq("id", args.id).eq("user_id", OWNER);
    if (error) return fail(error.message);
    return ok({ ok: true, date });
  },
});

tool("archive_action", {
  description: "Archive an action that is no longer relevant, or restore one with archived=false. Archived actions disappear from every list but are never deleted.",
  inputSchema: z.object({ id: z.string(), archived: z.boolean().optional().describe("defaults to true") }),
  handler: async (args: { id: string; archived?: boolean }) => {
    const archived = args.archived === undefined ? true : args.archived;
    const { error } = await db.from("actions").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", args.id).eq("user_id", OWNER);
    if (error) return fail(error.message);
    return ok({ ok: true, archived });
  },
});

tool("create_event", {
  description:
    "Create an event — something that HAPPENS at a time (a meeting, an appointment, a trip). Use this rather than create_action when there is nothing to complete: an event has no done state and no priority. If the user needs to DO something, that's an action.",
  inputSchema: z.object({
    title: z.string(),
    date: z.string().optional().describe("YYYY-MM-DD when it happens"),
    timeOfDay: z.string().optional().describe("HH:MM 24h, optional"),
    durationMinutes: z.number().optional(),
    area: z.enum(AREA_INPUT).optional().describe("the event's primary area. " + AREA_GUIDE),
    secondaryAreas: z.array(z.enum(AREA_INPUT)).optional(),
    location: z.string().optional().describe("where it happens — an address or place name, geocoded for you and pinned on the Location map"),
    linkedPeopleIds: z.array(z.string()).optional().describe("ids from list (kind people) — who it's with"),
    notes: z.string().optional(),
    allDay: z.boolean().optional(),
    recurrence: CC_RECUR,
    reminders: CC_REMINDERS,
  }),
  handler: async (args: any) => {
    const bad = ccCheck(args); if (bad) return fail(bad);
    if (args.recurrence && !args.date) return fail("a repeating item needs a first date");
    const dup = await ccExisting("events", args.title, args.date || null, "event");
    if (dup) {
      const patch: Record<string, unknown> = { recurrence: args.recurrence || null, reminders: args.reminders || [] };
      if (args.timeOfDay !== undefined) patch.time_of_day = args.timeOfDay || null;
      if (args.durationMinutes !== undefined) patch.duration_minutes = args.durationMinutes;
      if (args.notes) patch.notes_md = args.notes;
      const up = await safeWrite((p) => db.from("events").update(p).eq("id", dup.id).eq("user_id", OWNER), patch);
      if (up.error) return fail(up.error.message);
      return ok({ ok: true, id: dup.id, alreadyExisted: true });
    }
    const place = await resolvePlace({ address: args.location });
    if (place.error) return fail(place.error);
    const { data, error } = await safeWrite((p) => db.from("events").insert(p).select().single(), {
      all_day: !!args.allDay, recurrence: args.recurrence || null, reminders: args.reminders || [],
      user_id: OWNER, title: args.title, date: args.date || null,
      time_of_day: args.timeOfDay || null, duration_minutes: args.durationMinutes || null,
      category: args.area || null, secondary_categories: args.secondaryAreas || [],
      location_address: place.address, location_lat: place.lat, location_lng: place.lng,
      linked_people_ids: args.linkedPeopleIds || [], notes_md: args.notes || "",
      source: "claude",
    });
    if (error) return fail(error.message + " (has migration_events.sql been run?)");
    return ok({ ok: true, id: data.id, lat: place.lat, lng: place.lng });
  },
});

tool("edit_event", {
  description: "Edit an existing event by id (reschedule, rename, move). Only the fields you pass are changed.",
  inputSchema: z.object({
    id: z.string(),
    title: z.string().optional(),
    date: z.string().optional().describe("YYYY-MM-DD; pass an empty string to clear it"),
    timeOfDay: z.string().optional().describe("HH:MM 24h; pass an empty string to clear it"),
    durationMinutes: z.number().optional(),
    area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE),
    secondaryAreas: z.array(z.enum(AREA_INPUT)).optional().describe("replaces the existing set"),
    location: z.string().optional().describe("new address or place name, geocoded for you; pass an empty string to remove the location"),
    linkedPeopleIds: z.array(z.string()).optional().describe("replaces the existing set"),
    notes: z.string().optional(),
    recurrence: CC_RECUR,
    reminders: CC_REMINDERS,
    allDay: z.boolean().optional(),
    muted: z.boolean().optional().describe("no reminders for this item"),
    skipDates: z.array(z.string().regex(CC_DAY)).max(200).optional().describe("for a repeating item: dates to leave out (replaces the existing list)"),
  }),
  handler: async (args: any) => {
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.date !== undefined) patch.date = args.date || null;
    if (args.timeOfDay !== undefined) patch.time_of_day = args.timeOfDay || null;
    if (args.durationMinutes !== undefined) patch.duration_minutes = args.durationMinutes;
    if (args.area !== undefined) patch.category = args.area;
    if (args.secondaryAreas !== undefined) patch.secondary_categories = args.secondaryAreas;
    if (args.location !== undefined) {
      if (!args.location) {
        // Clearing the address clears the coordinates with it — leaving a stale pin behind
        // for an address the user just removed is worse than removing both.
        patch.location_address = null; patch.location_lat = null; patch.location_lng = null;
      } else {
        const place = await resolvePlace({ address: args.location });
        if (place.error) return fail(place.error);
        patch.location_address = place.address; patch.location_lat = place.lat; patch.location_lng = place.lng;
      }
    }
    if (args.linkedPeopleIds !== undefined) patch.linked_people_ids = args.linkedPeopleIds;
    if (args.notes !== undefined) patch.notes_md = args.notes;
    const bad = ccCheck(args); if (bad) return fail(bad);
    if (args.allDay !== undefined) patch.all_day = args.allDay;
    if (args.recurrence !== undefined) patch.recurrence = args.recurrence || null;
    if (args.reminders !== undefined) patch.reminders = args.reminders;
    if (args.muted !== undefined) patch.muted = args.muted;
    if (args.skipDates !== undefined) patch.recurrence_exceptions = args.skipDates;
    if (Object.keys(patch).length === 0) return fail("nothing to update — pass at least one field");
    const { error } = await safeWrite((p) => db.from("events").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

// ---- Decisions and their scenarios -----------------------------------------

tool("set_action_decision", {
  description:
    "Flag an action as a DECISION (or clear the flag), which gives it a scenario canvas in the app. Turning it off only hides the canvas — the scenarios are kept, and turning it back on restores them.",
  inputSchema: z.object({
    id: z.string().describe("the action's id"),
    isDecision: z.boolean().optional().describe("defaults to true"),
  }),
  handler: async (args: { id: string; isDecision?: boolean }) => {
    const { error } = await safeWrite(
      (p) => db.from("actions").update(p).eq("id", args.id).eq("user_id", OWNER),
      { is_decision: args.isDecision === undefined ? true : args.isDecision },
    );
    if (error) return fail(error.message + " (has migration_action_scenarios.sql been run?)");
    return ok({ ok: true });
  },
});

tool("create_scenario", {
  description:
    "Add a scenario — one plausible future — to an action that's flagged as a decision. Weight each advantage and disadvantage 1-5 by HOW MUCH IT MATTERS, not how likely it is; the app ranks the branches by advantages minus disadvantages. Pass parentScenarioId to grow a branch from an existing scenario, which also draws the arrow between them. Placement on the canvas is automatic.",
  inputSchema: z.object({
    actionId: z.string().describe("the decision action's id"),
    title: z.string(),
    notes: z.string().optional().describe("a sentence or two on what actually happens if it goes this way"),
    advantages: z.array(WEIGHT_ENTRY).optional(),
    disadvantages: z.array(WEIGHT_ENTRY).optional(),
    parentScenarioId: z.string().optional().describe("branch from this scenario instead of starting a new root"),
  }),
  handler: async (args: any) => {
    const existingR = await owned("action_scenarios").eq("action_id", args.actionId);
    if (existingR.error) return fail(existingR.error.message + " (has migration_action_scenarios.sql been run?)");
    const existing = existingR.data || [];
    const parent = args.parentScenarioId ? existing.find((s) => s.id === args.parentScenarioId) : null;
    if (args.parentScenarioId && !parent) return fail("no scenario with id " + args.parentScenarioId + " on that decision");

    // Mirrors scenarioAutoPlace: a branch lands under its parent and to the right of
    // each sibling already there; a root fills the top row.
    let x: number, y: number;
    if (parent) {
      x = Number(parent.x) + (parent.links || []).length * SC_COL_W;
      y = Number(parent.y) + SC_ROW_H;
    } else {
      const linked = new Set<string>();
      existing.forEach((s) => (s.links || []).forEach((id: string) => linked.add(id)));
      x = SC_ORIGIN_X + existing.filter((s) => !linked.has(s.id)).length * SC_COL_W;
      y = SC_ORIGIN_Y;
    }

    const { data, error } = await safeWrite((p) => db.from("action_scenarios").insert(p).select().single(), {
      user_id: OWNER, action_id: args.actionId, title: args.title, notes: args.notes || "",
      advantages: normalizeWeights(args.advantages), disadvantages: normalizeWeights(args.disadvantages),
      links: [], x, y, position: existing.length,
    });
    if (error) return fail(error.message);

    if (parent) {
      const links = (parent.links || []).concat([data.id]);
      const lr = await safeWrite((p) => db.from("action_scenarios").update(p).eq("id", parent.id).eq("user_id", OWNER), { links });
      if (lr.error) return fail("scenario created (" + data.id + ") but linking it to its parent failed: " + lr.error.message);
    }
    return ok({ ok: true, id: data.id, netScore: scenarioNetScore(data) });
  },
});

tool("edit_scenario", {
  description:
    "Edit a scenario by id. Only the fields you pass are changed. Passing advantages or disadvantages REPLACES that whole list — read it back with get_decision first if you mean to add one entry rather than start over.",
  inputSchema: z.object({
    id: z.string(),
    title: z.string().optional(),
    notes: z.string().optional(),
    advantages: z.array(WEIGHT_ENTRY).optional().describe("replaces the whole list"),
    disadvantages: z.array(WEIGHT_ENTRY).optional().describe("replaces the whole list"),
  }),
  handler: async (args: any) => {
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.advantages !== undefined) patch.advantages = normalizeWeights(args.advantages);
    if (args.disadvantages !== undefined) patch.disadvantages = normalizeWeights(args.disadvantages);
    if (Object.keys(patch).length === 0) return fail("nothing to update — pass at least one field");
    const { error } = await safeWrite((p) => db.from("action_scenarios").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

tool("link_scenarios", {
  description:
    "Draw or remove a branching arrow between two scenarios of the same decision — 'this path leads to that one'. Refuses links that would close the hierarchy into a loop, the same guard the app applies.",
  inputSchema: z.object({
    fromId: z.string().describe("the scenario the arrow leaves"),
    toId: z.string().describe("the scenario the arrow points at"),
    remove: z.boolean().optional().describe("remove this link instead of adding it (default false)"),
  }),
  handler: async (args: { fromId: string; toId: string; remove?: boolean }) => {
    if (args.fromId === args.toId) return fail("a scenario can't link to itself");
    const fromR = await owned("action_scenarios").eq("id", args.fromId).maybeSingle();
    if (fromR.error) return fail(fromR.error.message);
    if (!fromR.data) return fail("no scenario with id " + args.fromId);
    const from = fromR.data;
    const links: string[] = from.links || [];

    if (args.remove) {
      if (links.indexOf(args.toId) === -1) return fail("those scenarios aren't linked");
      const { error } = await safeWrite((p) => db.from("action_scenarios").update(p).eq("id", from.id).eq("user_id", OWNER), { links: links.filter((id) => id !== args.toId) });
      if (error) return fail(error.message);
      return ok({ ok: true, removed: true });
    }

    const siblingsR = await owned("action_scenarios").eq("action_id", from.action_id);
    if (siblingsR.error) return fail(siblingsR.error.message);
    const all = siblingsR.data || [];
    if (!all.some((s) => s.id === args.toId)) return fail("both scenarios must belong to the same decision");
    if (links.indexOf(args.toId) !== -1) return fail("already linked");
    if (scenarioLinksTo(all, args.toId, args.fromId)) return fail("that would create a circular branch");
    const { error } = await safeWrite((p) => db.from("action_scenarios").update(p).eq("id", from.id).eq("user_id", OWNER), { links: links.concat([args.toId]) });
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

tool("add_note", {
  description: "Add a new note (journal entry). Defaults the date to today.",
  inputSchema: z.object({
    text: z.string(),
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today (Berlin)"),
    title: z.string().optional().describe("optional short heading"),
    priority: z.enum(PRIORITIES).optional(),
    areas: z.array(z.enum(AREA_INPUT)).optional().describe("optional area(s); a note can span more than one"),
    noteType: z.enum(NOTE_TYPES).optional()
      .describe("what kind of note this is (default reflection). Only 'reflection' gets sentiment analysis in the app — a reference or a decision record isn't a mood."),
    timeOfDay: z.string().optional().describe("HH:MM 24h, optional"),
  }),
  handler: async (args: any) => {
    const { data, error } = await safeWrite((p) => db.from("journal").insert(p).select().single(), {
      user_id: OWNER, date: args.date || todayUTC(), text: args.text,
      title: args.title || null, priority: args.priority || null,
      categories: args.areas || [], note_type: args.noteType || "reflection",
      time_of_day: args.timeOfDay || null, source: "claude",
    });
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id });
  },
});

tool("edit_note", {
  description: "Edit an existing note (journal entry) by id. Only the fields you pass are changed. (Sentiment tags and note-tag links are managed by the app and left untouched.)",
  inputSchema: z.object({
    id: z.string(),
    text: z.string().optional(),
    title: z.string().optional().describe("short heading; pass an empty string to clear it"),
    priority: z.enum(PRIORITIES).optional(),
    areas: z.array(z.enum(AREA_INPUT)).optional().describe("the note's area(s); replaces the existing set"),
    noteType: z.enum(NOTE_TYPES).optional(),
    date: z.string().optional().describe("YYYY-MM-DD"),
    timeOfDay: z.string().optional().describe("HH:MM 24h; pass an empty string to clear it"),
  }),
  handler: async (args: any) => {
    const patch: Record<string, unknown> = {};
    if (args.text !== undefined) patch.text = args.text;
    if (args.title !== undefined) patch.title = args.title || null;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.areas !== undefined) patch.categories = args.areas;
    if (args.noteType !== undefined) patch.note_type = args.noteType;
    if (args.date !== undefined) patch.date = args.date;
    if (args.timeOfDay !== undefined) patch.time_of_day = args.timeOfDay || null;
    if (Object.keys(patch).length === 0) return fail("nothing to update — pass at least one field");
    const { error } = await safeWrite((p) => db.from("journal").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

tool("create_person", {
  description: "Add a new person to the user's network.",
  inputSchema: z.object({
    name: z.string(),
    relationship: z.enum(RELATIONSHIPS),
    contact: z.string().optional(),
    notes: z.string().optional(),
    socialGroup: z.string().optional(),
  }),
  handler: async (args: any) => {
    const { data, error } = await safeWrite((p) => db.from("people").insert(p).select().single(), {
      user_id: OWNER, name: args.name, relationship: args.relationship,
      contact: args.contact || "", notes: args.notes || "", social_group: args.socialGroup || null,
    });
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id });
  },
});

tool("edit_person", {
  description: "Edit an existing person by id: name, relationship, contact, notes, group, job, about (what they do), or birthday (shows in People's Coming up). Only the fields you pass are changed. For things found online use save_person_research instead of notes.",
  inputSchema: z.object({
    id: z.string(),
    name: z.string().optional(),
    relationship: z.enum(RELATIONSHIPS).optional(),
    contact: z.string().optional(),
    notes: z.string().optional(),
    socialGroup: z.string().optional(),
    birthdayMonth: z.number().int().min(1).max(12).nullable().optional().describe("1-12; null clears the birthday"),
    birthdayDay: z.number().int().min(1).max(31).nullable().optional(),
    birthdayYear: z.number().int().min(1900).max(2100).nullable().optional(),
    job: z.string().max(160).nullable().optional().describe("what they work as; null clears it"),
    about: z.string().max(4000).nullable().optional().describe("what they do: work, projects, what they spend their time on; null clears it"),
  }),
  handler: async (args: any) => {
    const patch: Record<string, unknown> = {};
    if (args.job !== undefined) patch.job = args.job || null;
    if (args.about !== undefined) patch.about = args.about || null;
    if (args.birthdayMonth !== undefined) patch.birthday_month = args.birthdayMonth;
    if (args.birthdayDay !== undefined) patch.birthday_day = args.birthdayDay;
    if (args.birthdayYear !== undefined) patch.birthday_year = args.birthdayYear;
    if (args.name !== undefined) patch.name = args.name;
    if (args.relationship !== undefined) patch.relationship = args.relationship;
    if (args.contact !== undefined) patch.contact = args.contact;
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.socialGroup !== undefined) patch.social_group = args.socialGroup || null;
    const { error } = await safeWrite((p) => db.from("people").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

// ---- People: how things are with someone ------------------------------------
// These write as the service role, so the activity log records them as "claude" and the app's
// Today page shows each change with an undo. Nothing here deletes: notes and links are archived.
const DAY_OPT = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").optional().describe("YYYY-MM-DD; defaults to today (Berlin)");
const PERSON_REF = z.string().describe("the person's id, or their name (must match exactly one person)");
const QUALITY = ["strong", "ok", "weak", "strained", "conflict", "cut_off"] as const;
const ENERGY = ["nourishing", "neutral", "draining"] as const;
const CONTACT_KIND = ["call", "met", "message", "other"] as const;
const CIRCLE_NAMES = ["", "Inner", "Close", "Good", "Wider", "Outer"];
// deno-lint-ignore no-explicit-any
async function findPerson(ref: string): Promise<{ person?: any; error?: string }> {
  const r = String(ref || "").trim();
  if (!r) return { error: "Say which person: pass an id or a name." };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r)) {
    const { data, error } = await owned("people").eq("id", r).maybeSingle();
    if (error) return { error: error.message };
    return data ? { person: data } : { error: "No person with that id." };
  }
  const { data, error } = await owned("people").is("archived_at", null).ilike("name", "%" + r.replace(/[%_]/g, " ") + "%").limit(20);
  if (error) return { error: error.message };
  const rows = data || [], low = r.toLowerCase();
  const exact = rows.filter((p) => String(p.name).trim().toLowerCase() === low);
  if (exact.length === 1) return { person: exact[0] };
  if (rows.length === 1) return { person: rows[0] };
  if (!rows.length) return { error: 'Nobody called "' + r + '" in People. Use list (kind people) to check the name, or create_person first.' };
  return { error: 'More than one person matches "' + r + '": ' + rows.map((p) => p.name + " (" + p.id + ")").join(", ") + ". Pass the id." };
}

tool("set_person_situation", {
  description:
    "Record how things currently are with someone, in a sentence or three, as the user described it. It becomes the 'Current situation' on that person's panel in the People page; earlier notes stay as history. Use it whenever the user tells you something about where a relationship stands (a rift, a reconciliation, what someone is going through, what is open between them). Write it plainly in the user's own framing, no judgement, no scores. Do not use it for tasks: an open thread is an action linked to the person.",
  inputSchema: z.object({
    person: PERSON_REF,
    text: z.string().min(1).max(2000).describe("the situation, in plain words"),
    date: DAY_OPT(),
  }),
  handler: async (args: { person: string; text: string; date?: string }) => {
    const f = await findPerson(args.person);
    if (!f.person) return fail(f.error!);
    const { data, error } = await db.from("person_situations").insert({
      user_id: OWNER, person_id: f.person.id, text: args.text.trim(), noted_on: args.date || berlinToday(), author: "claude",
    }).select().single();
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id, person: f.person.name, notedOn: data.noted_on });
  },
});

tool("log_contact", {
  description:
    "Note that the user was in touch with someone (talked, met, messaged). Sets that person's last contact, which is what the People page uses for its gentle 'a little longer than your rhythm' signal. Defaults to today.",
  inputSchema: z.object({
    person: PERSON_REF,
    kind: z.enum(CONTACT_KIND).optional().describe("call, met, message or other (default other)"),
    date: DAY_OPT(),
  }),
  handler: async (args: { person: string; kind?: string; date?: string }) => {
    const f = await findPerson(args.person);
    if (!f.person) return fail(f.error!);
    const date = args.date || berlinToday();
    if (f.person.last_contact_at && f.person.last_contact_at > date) {
      return ok({ ok: true, unchanged: true, person: f.person.name, lastContactAt: f.person.last_contact_at, note: "A later contact is already noted, so nothing changed." });
    }
    const { error } = await db.from("people").update({ last_contact_at: date, last_contact_kind: args.kind || "other" }).eq("id", f.person.id).eq("user_id", OWNER);
    if (error) return fail(error.message);
    return ok({ ok: true, person: f.person.name, lastContactAt: date, kind: args.kind || "other" });
  },
});

tool("set_relationship", {
  description:
    "Change where someone stands with the user. Only the fields you pass change. circle: 1 Inner, 2 Close, 3 Good, 4 Wider, 5 Outer. quality: strong, ok, weak, strained, conflict, cut_off (cut_off takes the person off the map without archiving them). energy: nourishing, neutral or draining, meaning what the relationship does to the user's energy. rhythmDays: how often the user would like to be in touch (0 or null for no rhythm; only people with a rhythm can show as drifting). archived: true hides the person everywhere, false brings them back; nothing is ever deleted. Only set these from what the user actually said.",
  inputSchema: z.object({
    person: PERSON_REF,
    circle: z.number().int().min(1).max(5).optional(),
    quality: z.enum(QUALITY).optional(),
    energy: z.enum(ENERGY).optional(),
    rhythmDays: z.number().int().min(0).max(3650).nullable().optional(),
    birthdayMonth: z.number().int().min(1).max(12).nullable().optional(),
    birthdayDay: z.number().int().min(1).max(31).nullable().optional(),
    inMemory: z.boolean().optional().describe("true for someone who has died: kept quietly, off the map"),
    archived: z.boolean().optional(),
  }),
  // deno-lint-ignore no-explicit-any
  handler: async (args: any) => {
    const f = await findPerson(args.person);
    if (!f.person) return fail(f.error!);
    const patch: Record<string, unknown> = {};
    if (args.circle !== undefined) patch.circle = args.circle;
    if (args.quality !== undefined) patch.quality = args.quality;
    if (args.energy !== undefined) patch.energy = args.energy;
    if (args.rhythmDays !== undefined) patch.rhythm_days = args.rhythmDays || null;
    if (args.birthdayMonth !== undefined) patch.birthday_month = args.birthdayMonth;
    if (args.birthdayDay !== undefined) patch.birthday_day = args.birthdayDay;
    if (args.inMemory !== undefined) patch.in_memory = args.inMemory;
    if (args.archived !== undefined) patch.archived_at = args.archived ? (f.person.archived_at || new Date().toISOString()) : null;
    if (!Object.keys(patch).length) return fail("Nothing to change: pass at least one field.");
    const { data, error } = await db.from("people").update(patch).eq("id", f.person.id).eq("user_id", OWNER).select().single();
    if (error) return fail(error.message);
    return ok({ ok: true, person: data.name, circle: data.circle, circleName: CIRCLE_NAMES[data.circle] || null, quality: data.quality, energy: data.energy, rhythmDays: data.rhythm_days, archived: !!data.archived_at, inMemory: !!data.in_memory });
  },
});

tool("link_people", {
  description:
    "Record that two people in the user's network are connected, how (kind) and how things are between them (quality defaults to ok on a new link). kind: parent_of (personA is the parent of personB, unless parent names the other), spouse, partner (not married), ex_partner, sibling, other. Family kinds build the People page's family tree. Calling again updates the link; pass remove: true to take it away (archived, not deleted).",
  inputSchema: z.object({
    personA: PERSON_REF,
    personB: PERSON_REF,
    kind: z.enum(LINK_KINDS).optional(),
    parent: PERSON_REF.optional().describe("for parent_of: which of the two is the parent (default personA)"),
    quality: z.enum(QUALITY).optional(),
    note: z.string().max(500).optional(),
    remove: z.boolean().optional(),
  }),
  // deno-lint-ignore no-explicit-any
  handler: async (args: any) => {
    const fa = await findPerson(args.personA), fb = await findPerson(args.personB);
    if (!fa.person) return fail(fa.error!);
    if (!fb.person) return fail(fb.error!);
    if (fa.person.id === fb.person.id) return fail("Those are the same person.");
    const a = fa.person.id < fb.person.id ? fa.person.id : fb.person.id, b = a === fa.person.id ? fb.person.id : fa.person.id;
    if (args.remove) {
      const { error } = await db.from("person_links").update({ archived_at: new Date().toISOString() }).eq("user_id", OWNER).eq("person_a", a).eq("person_b", b).is("archived_at", null);
      if (error) return fail(error.message);
      return ok({ ok: true, removed: true, between: [fa.person.name, fb.person.name] });
    }
    const prev = await db.from("person_links").select("id,quality").eq("person_a", a).eq("person_b", b).maybeSingle();
    const row: Record<string, unknown> = { user_id: OWNER, person_a: a, person_b: b, quality: args.quality || (prev.data ? prev.data.quality : "ok"), archived_at: null };
    if (args.note !== undefined) row.note = args.note;
    if (args.kind !== undefined) {
      const dir = await linkDirection(args.kind, fa.person.id, fb.person.id, args.parent);
      if (dir.error) return fail(dir.error);
      row.kind = args.kind; row.from_person = dir.from;
    }
    const { data, error } = await safeWrite((p) => db.from("person_links").upsert(p, { onConflict: "person_a,person_b" }).select().single(), row);
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id, between: [fa.person.name, fb.person.name], quality: data.quality, kind: data.kind || null, parent: data.from_person ? (data.from_person === fa.person.id ? fa.person.name : fb.person.name) : null });
  },
});

tool("set_link_kind", {
  description: "Fix the kind of an existing link between two people without recreating it (note and quality stay). kind: parent_of (personA is the parent unless parent names the other), spouse, partner, ex_partner, sibling, other.",
  inputSchema: z.object({ personA: PERSON_REF, personB: PERSON_REF, kind: z.enum(LINK_KINDS), parent: PERSON_REF.optional() }),
  // deno-lint-ignore no-explicit-any
  handler: async (args: any) => {
    const fa = await findPerson(args.personA), fb = await findPerson(args.personB);
    if (!fa.person) return fail(fa.error!); if (!fb.person) return fail(fb.error!);
    const a = fa.person.id < fb.person.id ? fa.person.id : fb.person.id, b = a === fa.person.id ? fb.person.id : fa.person.id;
    const cur = await db.from("person_links").select("id").eq("user_id", OWNER).eq("person_a", a).eq("person_b", b).is("archived_at", null).maybeSingle();
    if (!cur.data) return fail("Those two are not linked yet; use link (kind people).");
    const dir = await linkDirection(args.kind, fa.person.id, fb.person.id, args.parent);
    if (dir.error) return fail(dir.error);
    const up = await db.from("person_links").update({ kind: args.kind, from_person: dir.from }).eq("id", cur.data.id).select().single();
    if (up.error) return fail(up.error.message + (/kind/.test(up.error.message) ? " (run _Memory/migration_people_link_kinds.sql)" : ""));
    return ok({ ok: true, link: { id: up.data.id, between: [fa.person.name, fb.person.name], kind: up.data.kind, parent: up.data.from_person ? (up.data.from_person === fa.person.id ? fa.person.name : fb.person.name) : null, note: up.data.note, quality: up.data.quality } });
  },
});
tool("get_family_tree", {
  description: "The family tree the People page draws, rooted at the user: grandparents, parents, siblings, partner, and each side (the father's and the mother's siblings) as family units with partners and children, down the generations. Built from typed links (parent_of, spouse, partner, sibling) and the father/mother/brother/sister/partner roles. Also lists relatives not yet connected, exes (hidden on the page by default) and people in memory. Use it to check the tree after changes.",
  inputSchema: z.object({}),
  handler: async () => {
    const [pp, ll] = await Promise.all([owned("people").is("archived_at", null), owned("person_links").is("archived_at", null)]);
    if (pp.error) return fail(pp.error.message);
    // deno-lint-ignore no-explicit-any
    const P: Record<string, any> = {}; (pp.data || []).forEach((p: any) => { P[p.id] = p; });
    // deno-lint-ignore no-explicit-any
    const L = (ll.data || []).filter((l: any) => P[l.person_a] && P[l.person_b] && l.kind);
    const other = (l: any, id: string) => l.person_a === id ? l.person_b : l.person_a;
    const rel = (id: string, kinds: string[]) => L.filter((l: any) => (l.person_a === id || l.person_b === id) && kinds.includes(l.kind)).map((l: any) => other(l, id));
    const children = (id: string) => L.filter((l: any) => l.kind === "parent_of" && l.from_person === id).map((l: any) => other(l, id));
    const parents = (id: string) => L.filter((l: any) => l.kind === "parent_of" && l.from_person && l.from_person !== id && (l.person_a === id || l.person_b === id)).map((l: any) => l.from_person);
    const placed = new Set<string>();
    const tag = (id: string) => { placed.add(id); const p = P[id]; return { id, name: p.name, ...(p.in_memory ? { inMemory: true } : {}) }; };
    // deno-lint-ignore no-explicit-any
    const unit = (id: string, depth: number): any => {
      const partners = rel(id, ["spouse", "partner"]).filter((x: string) => !placed.has(x) || x === id);
      const me = tag(id), ps = partners.map((x: string) => ({ ...tag(x), kind: L.find((l: any) => l.kind !== "parent_of" && ((l.person_a === id && l.person_b === x) || (l.person_b === id && l.person_a === x)))?.kind }));
      const kids = Array.from(new Set([id, ...partners].flatMap(children))).filter((k) => !placed.has(k));
      return { ...me, partners: ps, exes: rel(id, ["ex_partner"]).map((x: string) => P[x].name), children: depth > 6 ? [] : kids.map((k) => unit(k, depth + 1)) };
    };
    const role = (r: string) => (pp.data || []).filter((p: any) => p.kin_role === r).map((p: any) => p.id);
    const father = role("father")[0], mother = role("mother")[0];
    const grand = (id?: string) => id ? parents(id).map(tag) : [];
    const out: Record<string, unknown> = { root: "you" };
    out.grandparents = { paternal: grand(father), maternal: grand(mother) };
    out.parents = [father, mother].filter(Boolean).map((id) => tag(id as string));
    const sibs = Array.from(new Set([...role("brother"), ...role("sister"), ...[father, mother].filter(Boolean).flatMap((id) => children(id as string))]));
    out.siblings = sibs.map((id) => unit(id, 1));
    out.partner = role("partner").map(tag);
    const side = (id?: string) => id ? rel(id, ["sibling"]).filter((x: string) => !placed.has(x)).map((x: string) => unit(x, 0)) : [];
    out.paternalSide = side(father);
    out.maternalSide = side(mother);
    out.notConnected = (pp.data || []).filter((p: any) => (p.relationship === "Family" || p.kin_role) && !placed.has(p.id) && p.kin_role !== "ex").map((p: any) => p.name);
    out.exes = L.filter((l: any) => l.kind === "ex_partner").map((l: any) => [P[l.person_a].name, P[l.person_b].name]);
    out.counts = { inTree: placed.size, links: L.length, untypedLinks: (ll.data || []).filter((l: any) => !l.kind).length };
    return ok(out);
  },
});

// ---- People: research found online, kept apart from the owner's own view ----
// The owner's opinions (kind 'opinion') are never read or written here.
tool("save_person_research", {
  description: "Save what you found online about one person (their work, role, projects, public talks or writing) as a Research note on their People page, with the links you used. Kept separate from the owner's own view, which you cannot see. Only save public, relevant facts; no addresses, health, finances or private life. Also see edit_person for job and about.",
  inputSchema: z.object({
    person: PERSON_REF,
    text: z.string().min(10).max(6000).describe("a short summary in plain words, facts only, no speculation"),
    sources: z.array(z.object({ url: z.string().url().max(800), title: z.string().max(200).optional() })).min(1).max(10).describe("the pages the facts come from"),
  }),
  handler: async (args: { person: string; text: string; sources: { url: string; title?: string }[] }) => {
    const f = await findPerson(args.person);
    if (!f.person) return fail(f.error!);
    const src = args.sources.filter((s) => /^https?:\/\//i.test(s.url)).map((s) => ({ url: s.url, title: s.title || undefined }));
    if (!src.length) return fail("each source needs an http(s) link");
    const { data, error } = await db.from("person_profile_notes").insert({ user_id: OWNER, person_id: f.person.id, kind: "research", text: args.text.trim(), sources: src, author: "claude", noted_on: berlinToday() }).select("id").single();
    if (error) return fail(error.message + (/person_profile_notes/.test(error.message) ? " (the owner needs to run _Memory/migration_person_profile.sql first)" : ""));
    return ok({ ok: true, id: data.id, person: f.person.name, note: "Saved under Research on their People page. The owner can hide it there." });
  },
});

tool("get_person_context", {
  description:
    "Everything the planner knows about one person, in one call: profile, where they stand (circle, quality, energy, rhythm), last contact, the current situation note and recent history, who they are linked to, open actions and upcoming events linked to them, and recent notes that mention them. Call this before advising the user about someone or before writing a new situation note.",
  inputSchema: z.object({
    person: PERSON_REF,
    history: z.number().int().min(0).max(30).optional().describe("how many earlier situation notes to include (default 5)"),
  }),
  handler: async (args: { person: string; history?: number }) => {
    const f = await findPerson(args.person);
    if (!f.person) return fail(f.error!);
    const p = f.person, today = berlinToday();
    const [sitR, linkR, actR, evR, noteR, resR] = await Promise.all([
      owned("person_situations").eq("person_id", p.id).is("archived_at", null).order("noted_on", { ascending: false }).order("created_at", { ascending: false }).limit(1 + (args.history ?? 5)),
      owned("person_links").is("archived_at", null).or("person_a.eq." + p.id + ",person_b.eq." + p.id),
      owned("actions").contains("linked_people_ids", [p.id]).eq("done", false).is("archived_at", null),
      owned("events").contains("linked_people_ids", [p.id]).gte("date", today).order("date").limit(20),
      owned("journal").is("archived_at", null).ilike("text", "%" + String(p.name).replace(/[%_]/g, " ") + "%").order("date", { ascending: false }).limit(8),
      owned("person_profile_notes").eq("person_id", p.id).eq("kind", "research").is("archived_at", null).order("noted_on", { ascending: false }).limit(10),   // never kind 'opinion'
    ]);
    const err = sitR.error || linkR.error;
    if (err) return fail(err.message);
    const otherIds = (linkR.data || []).map((l) => (l.person_a === p.id ? l.person_b : l.person_a));
    const names: Record<string, string> = {};
    if (otherIds.length) {
      const { data } = await owned("people").in("id", otherIds);
      (data || []).forEach((o) => { names[o.id] = o.name; });
    }
    const sits = (sitR.data || []).map((x) => ({ id: x.id, text: x.text, notedOn: x.noted_on, author: x.author }));
    const days = p.last_contact_at ? Math.round((Date.parse(today) - Date.parse(p.last_contact_at)) / 86400000) : null;
    return ok({
      id: p.id, name: p.name, relationship: p.relationship, socialGroup: p.social_group, location: p.location, yearMet: p.year_met, notes: p.notes, job: p.job || null, about: p.about || null,
      research: resR.error ? [] : (resR.data || []).map((x) => ({ id: x.id, text: x.text, sources: x.sources, notedOn: x.noted_on, author: x.author })),
      circle: p.circle, circleName: CIRCLE_NAMES[p.circle] || null, quality: p.quality, energy: p.energy,
      rhythmDays: p.rhythm_days, lastContactAt: p.last_contact_at, lastContactKind: p.last_contact_kind, daysSinceContact: days,
      birthday: p.birthday_month && p.birthday_day ? { month: p.birthday_month, day: p.birthday_day, year: p.birthday_year || null } : null,
      archived: !!p.archived_at, inMemory: !!p.in_memory,
      currentSituation: sits[0] || null, earlierSituations: sits.slice(1),
      linkedPeople: (linkR.data || []).map((l) => { const o = l.person_a === p.id ? l.person_b : l.person_a; return { id: o, name: names[o] || null, quality: l.quality, note: l.note || null }; }),
      openActions: (actR.data || []).map((a) => ({ id: a.id, title: a.title, date: a.date, priority: a.priority })),
      upcomingEvents: (evR.data || []).map((e) => ({ id: e.id, title: e.title, date: e.date })),
      recentMentions: (noteR.data || []).map((n) => ({ id: n.id, date: n.date, title: n.title || null, text: String(n.text || "").slice(0, 400) })),
    });
  },
});

tool("log_metric", {
  description: "Record a self-tracking value for a date (mood, weight, etc.). The variable must already exist — call get_tracker to see available variables and their ids. Upserts, so re-logging the same day overwrites.",
  inputSchema: z.object({
    variableId: z.string().describe("id of an existing tracker variable (from list kind=tracker)"),
    value: z.string().describe('the value as text — e.g. "4", "true", "72.5", or a category label'),
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today (Berlin)"),
  }),
  handler: async (args: { variableId: string; value: string; date?: string }) => {
    const date = args.date || todayUTC();
    // Matches the app's unique (user_id, date, variable_id) constraint.
    const { error } = await db.from("tracker_entries")
      .upsert({ user_id: OWNER, date, variable_id: args.variableId, value: args.value },
        { onConflict: "user_id,date,variable_id" });
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

tool("create_place", {
  description:
    "Save a place — a named pin on the user's Location map. Give it an `address` and it's geocoded for you; pass `lat`/`lng` instead only if you already know the exact coordinates. Never guess coordinates: pass the address and let the server resolve it.",
  inputSchema: z.object({
    name: z.string().describe("what the user calls it, e.g. 'the good bakery'"),
    address: z.string().optional().describe("address or place name to geocode, e.g. 'Torstraße 100, Berlin'"),
    lat: z.number().optional().describe("latitude, decimal degrees — only if you already know it"),
    lng: z.number().optional().describe("longitude, decimal degrees — only if you already know it"),
    notes: z.string().optional(),
    linkedPeopleIds: z.array(z.string()).optional().describe("ids from list_people"),
  }),
  handler: async (args: any) => {
    const place = await resolvePlace(args);
    if (place.error) return fail(place.error);
    if (place.lat == null || place.lng == null) return fail("pass either an address to geocode, or both lat and lng");
    const { data, error } = await safeWrite((p) => db.from("points_of_interest").insert(p).select().single(), {
      user_id: OWNER, name: args.name, lat: place.lat, lng: place.lng,
      notes: args.notes || "", linked_people_ids: args.linkedPeopleIds || [],
    });
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id, lat: place.lat, lng: place.lng, resolvedFrom: place.resolvedFrom || null });
  },
});

tool("edit_place", {
  description:
    "Edit a saved place by id — rename it, move it, or change its notes. Only the fields you pass are changed. Passing `address` re-geocodes and moves the pin; passing `lat`/`lng` moves it to exactly those coordinates.",
  inputSchema: z.object({
    id: z.string().describe("the place's id (from list kind=pois)"),
    name: z.string().optional(),
    address: z.string().optional().describe("new address to geocode and move the pin to"),
    lat: z.number().optional(),
    lng: z.number().optional(),
    notes: z.string().optional(),
    linkedPeopleIds: z.array(z.string()).optional().describe("replaces the existing set"),
  }),
  handler: async (args: any) => {
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.linkedPeopleIds !== undefined) patch.linked_people_ids = args.linkedPeopleIds;
    // Only touch the coordinates when the caller actually asked to move it — an edit that
    // only renames a place must not silently re-geocode and shift the existing pin.
    if (args.address !== undefined || args.lat !== undefined || args.lng !== undefined) {
      const place = await resolvePlace(args);
      if (place.error) return fail(place.error);
      if (place.lat == null || place.lng == null) return fail("to move a place, pass an address to geocode, or both lat and lng");
      patch.lat = place.lat; patch.lng = place.lng;
    }
    if (Object.keys(patch).length === 0) return fail("nothing to update — pass at least one field");
    const { error } = await safeWrite((p) => db.from("points_of_interest").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true, lat: patch.lat ?? null, lng: patch.lng ?? null });
  },
});

tool("set_item_location", {
  description:
    "Attach a location to an action, event, or person (a person's is their home). Give an `address` and it's geocoded; pass `lat`/`lng` only if you already know them. Pass `clear: true` to remove the location instead.",
  inputSchema: z.object({
    kind: z.enum(["action", "event", "person"]),
    id: z.string(),
    address: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    clear: z.boolean().optional().describe("remove the location from this item"),
  }),
  handler: async (args: any) => {
    const TABLES: Record<string, string> = { action: "actions", event: "events", person: "people" };
    const table = TABLES[args.kind];
    // A person's home lives in home_lat/home_lng with no address column of its own —
    // the other three share the location_address/lat/lng shape.
    const isPerson = args.kind === "person";
    if (args.clear) {
      const cleared = isPerson
        ? { home_lat: null, home_lng: null }
        : { location_address: null, location_lat: null, location_lng: null };
      const { error } = await safeWrite((p) => db.from(table).update(p).eq("id", args.id).eq("user_id", OWNER), cleared);
      if (error) return fail(error.message);
      return ok({ ok: true, cleared: true });
    }
    const place = await resolvePlace(args);
    if (place.error) return fail(place.error);
    if (place.lat == null || place.lng == null) return fail("pass either an address to geocode, or both lat and lng (or clear: true)");
    const patch = isPerson
      ? { home_lat: place.lat, home_lng: place.lng }
      : { location_address: place.address, location_lat: place.lat, location_lng: place.lng };
    const { error } = await safeWrite((p) => db.from(table).update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true, lat: place.lat, lng: place.lng, resolvedFrom: place.resolvedFrom || null });
  },
});

tool("log_transaction", {
  description:
    "Record a finance transaction against an existing account. Amount is POSITIVE for money in and NEGATIVE for money out — a €12 lunch is -12. Call get_finance (view summary) first for account ids.",
  inputSchema: z.object({
    accountId: z.string().describe("id of an existing account (from get_finance, view summary)"),
    amount: z.number().describe("positive = money in, negative = money out"),
    description: z.string(),
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today (Berlin)"),
    area: z.enum(AREA_INPUT).optional().describe("which life area this spend belongs to"),
    subcategory: z.string().optional(),
  }),
  handler: async (args: any) => {
    const { data, error } = await safeWrite((p) => db.from("finance_transactions").insert(p).select().single(), {
      user_id: OWNER, account_id: args.accountId, date: args.date || todayUTC(),
      description: args.description, amount: args.amount, area: args.area || null,
      // source is free text (the app writes "manual", importers write "csv"/"pdf", and
      // nothing branches on it) — "mcp" keeps the provenance visible so a transaction
      // this connector added can be told apart from one the user typed in themselves.
      subcategory: args.subcategory || "", source: "mcp",
    });
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id });
  },
});

// ============================ HEALTH ========================================
// What Claude reads from Garmin Connect and Hevy, written here so the app's Health page can show
// it. Owner-only: none of these are in AGENT_READABLE, so the agent token cannot read or write
// health data.
//
// Every write is an idempotent upsert on a natural key (the day, the workout's source id, ...):
//   * a field you leave out is left alone, so a partial day (steps at noon, sleep in the morning)
//     can be sent as it becomes known;
//   * a value that was not measured is left out or sent as null, never 0;
//   * sending the same data twice changes nothing and writes nothing, so the activity log gets
//     one entry per real change;
//   * nothing is deleted: a set that disappears from a re-synced workout is marked superseded.
// Tables: migration_health_v2.sql.
const HEALTH_HINT = " (has migration_health_v2.sql been run?)";
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const CLOCK = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use 24h HH:MM, local time");
const MUSCLE_KEYS = ["chest", "shoulders", "rear", "traps", "lats", "lower_back", "biceps", "triceps", "forearms", "abs", "obliques", "quads", "hamstrings", "glutes", "adductors", "calves"] as const;
// Hevy's muscle names (and a few common spellings) → the page's keys. Anything else is ignored.
const MUSCLE_ALIAS: Record<string, string> = {
  abdominals: "abs", core: "abs", quadriceps: "quads", upper_back: "lats", back: "lats", abductors: "glutes",
  rear_delts: "rear", rear_deltoids: "rear", deltoids: "shoulders", delts: "shoulders", trapezius: "traps",
  pectorals: "chest", pecs: "chest", hamstring: "hamstrings", calf: "calves", glute: "glutes", lower_back: "lower_back",
};
function muscleKey(v: unknown): string | null {
  const k = String(v || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!k) return null;
  if ((MUSCLE_KEYS as readonly string[]).includes(k)) return k;
  return MUSCLE_ALIAS[k] || null;
}
function addDays(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Key order inside jsonb is not preserved by Postgres, so compare JSON with sorted keys.
function stable(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
// "Is this the value already stored?" — tolerant of how Postgres hands values back
// (time as HH:MM:SS, timestamps in UTC, numerics as numbers or strings).
function sameVal(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "object" || typeof b === "object") return stable(a) === stable(b);
  const sa = String(a), sb = String(b);
  if (sa === sb) return true;
  const clock = /^\d\d:\d\d(:\d\d(\.\d+)?)?$/;
  if (clock.test(sa) && clock.test(sb)) return sa.slice(0, 5) === sb.slice(0, 5);
  if (sa.includes("T") && sb.includes("T")) {
    const ta = Date.parse(sa), tb = Date.parse(sb);
    if (!isNaN(ta) && !isNaN(tb)) return ta === tb;
  }
  if (sa.trim() !== "" && sb.trim() !== "" && !isNaN(Number(sa)) && !isNaN(Number(sb))) return Number(sa) === Number(sb);
  return false;
}
// Insert the row, or update only the fields that actually differ. Returns what happened.
async function healthUpsert(
  table: string, key: Record<string, unknown>, fields: Record<string, unknown>, stamps: string[] = ["updated_at"],
): Promise<{ error?: string; id?: string; result?: "created" | "updated" | "unchanged"; changed?: string[] }> {
  let q = db.from(table).select("*").eq("user_id", OWNER);
  for (const [k, v] of Object.entries(key)) q = q.eq(k, v as any);
  const found = await q.limit(1);
  if (found.error) return { error: found.error.message + HEALTH_HINT };
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) patch[k] = v;
  const existing = found.data && found.data[0];
  if (!existing) {
    const ins = await db.from(table).insert({ user_id: OWNER, ...key, ...patch }).select("id").single();
    if (ins.error) return { error: ins.error.message + HEALTH_HINT };
    return { id: ins.data.id, result: "created", changed: Object.keys(patch) };
  }
  const changed = Object.keys(patch).filter((k) => !sameVal(existing[k], patch[k]));
  if (!changed.length) return { id: existing.id, result: "unchanged", changed: [] };
  const upd: Record<string, unknown> = {};
  changed.forEach((k) => { upd[k] = patch[k]; });
  const now = new Date().toISOString();
  stamps.forEach((s) => { upd[s] = now; });
  const res = await db.from(table).update(upd).eq("id", existing.id).eq("user_id", OWNER);
  if (res.error) return { error: res.error.message + HEALTH_HINT };
  return { id: existing.id, result: "updated", changed };
}
const pct = () => z.number().int().min(0).max(100).nullable().optional();
const mins = () => z.number().int().min(0).max(1440).nullable().optional();

tool("upsert_health_day", {
  description:
    "Save one day of Garmin data (sleep, heart, Body Battery, stress, movement) for the Health page. Idempotent per date: call it again as the day fills in, sending only the fields you actually read. NEVER send 0 or a guess for something that was not measured — leave the field out (or send null to clear a wrong value). If the watch was not worn at night, simply omit the sleep fields. Read the overnight HRV (hrvAvg, hrvStatus), Body Battery high and low, and training readiness too whenever Garmin shows them: the reply lists which of these the day still lacks. Sleep belongs to the date the night ENDED on. Clock times are local 24h HH:MM.",
  inputSchema: z.object({
    date: DAY.optional().describe("the day; defaults to today (Berlin)"),
    sleepScore: pct(), sleepMinutes: mins().describe("time asleep, in minutes"),
    bedTime: CLOCK.nullable().optional().describe("fell asleep at, e.g. 01:42"),
    wakeTime: CLOCK.nullable().optional(),
    deepMinutes: mins(), lightMinutes: mins(), remMinutes: mins(), awakeMinutes: mins(),
    sleepStress: z.number().min(0).max(100).nullable().optional(),
    restingHr: z.number().int().min(20).max(150).nullable().optional(),
    hrvAvg: z.number().int().min(1).max(300).nullable().optional().describe("overnight HRV average, ms"),
    hrvStatus: z.string().nullable().optional().describe("Garmin's word: balanced, unbalanced, low, poor"),
    maxHr: z.number().int().min(30).max(250).nullable().optional(),
    bodyBatteryNow: pct(), bodyBatteryHigh: pct().describe("the morning peak"), bodyBatteryLow: pct(),
    bodyBatteryCharged: z.number().int().min(0).max(200).nullable().optional(),
    bodyBatteryDrained: z.number().int().min(0).max(200).nullable().optional(),
    bodyBatteryCurve: z.array(z.tuple([z.number().min(0).max(24), z.number().min(0).max(100)])).max(96).nullable().optional()
      .describe("optional points across the day as [hour, value], e.g. [[0,41],[6.5,78]]"),
    stressAvg: pct(), stressLowMinutes: mins(), stressMediumMinutes: mins(), stressHighMinutes: mins(),
    steps: z.number().int().min(0).max(100000).nullable().optional(),
    stepsGoal: z.number().int().min(0).max(100000).nullable().optional().describe("Garmin's goal for that day"),
    intensityMinutes: z.number().int().min(0).max(1440).nullable().optional().describe("that day's intensity minutes"),
    activeCalories: z.number().int().min(0).max(20000).nullable().optional(),
    vo2Max: z.number().min(10).max(90).nullable().optional(),
    trainingReadiness: pct().describe("Garmin's own training readiness, shown beside the page's score"),
    source: z.string().optional().describe("defaults to 'garmin'"),
  }),
  handler: async (a: any) => {
    const date = a.date || berlinToday();
    const fields: Record<string, unknown> = {
      sleep_score: a.sleepScore, sleep_minutes: a.sleepMinutes, bed_time: a.bedTime, wake_time: a.wakeTime,
      deep_minutes: a.deepMinutes, light_minutes: a.lightMinutes, rem_minutes: a.remMinutes, awake_minutes: a.awakeMinutes,
      sleep_stress: a.sleepStress, resting_hr: a.restingHr, hrv_avg: a.hrvAvg, hrv_status: a.hrvStatus, max_hr: a.maxHr,
      body_battery_now: a.bodyBatteryNow, body_battery_high: a.bodyBatteryHigh, body_battery_low: a.bodyBatteryLow,
      body_battery_charged: a.bodyBatteryCharged, body_battery_drained: a.bodyBatteryDrained, body_battery_curve: a.bodyBatteryCurve,
      stress_avg: a.stressAvg, stress_low_minutes: a.stressLowMinutes, stress_medium_minutes: a.stressMediumMinutes,
      stress_high_minutes: a.stressHighMinutes, steps: a.steps, steps_goal: a.stepsGoal, intensity_minutes: a.intensityMinutes,
      active_calories: a.activeCalories, vo2_max: a.vo2Max, training_readiness: a.trainingReadiness, source: a.source,
    };
    if (!Object.values(fields).some((v) => v !== undefined)) return fail("Nothing to save: send at least one measured field.");
    const r = await healthUpsert("health_daily", { date }, fields, ["updated_at", "synced_at"]);
    if (r.error) return fail(r.error);
    // which recovery readings this day still lacks, so a sync that never reads them is visible
    const row = await owned("health_daily").eq("date", date).maybeSingle();
    const want: Record<string, string> = { hrv_avg: "hrvAvg", hrv_status: "hrvStatus", body_battery_high: "bodyBatteryHigh", body_battery_low: "bodyBatteryLow", training_readiness: "trainingReadiness" };
    const stillEmpty = row.data ? Object.keys(want).filter((k) => row.data[k] == null).map((k) => want[k]) : [];
    await refreshGoalScores().catch(() => null);
    return ok({ ok: true, date, result: r.result, changed: r.changed, stillEmpty: stillEmpty.length ? stillEmpty : undefined });
  },
});

tool("upsert_workout", {
  description:
    "Save one strength session (from Hevy) with its exercises and sets. Idempotent per sourceId: re-sending the same workout changes nothing; re-sending an edited one updates it, and sets that are no longer there are marked superseded, not deleted. Send every exercise in order with every set. Weight in kg. If Hevy shows which muscles an exercise works, pass primaryMuscle/secondaryMuscles so the body model can use them.",
  inputSchema: z.object({
    sourceId: z.string().min(1).describe("Hevy's workout id (from its URL). If there is none, use 'manual-YYYY-MM-DD-1'"),
    date: DAY,
    startedAt: z.string().optional().describe("ALWAYS send it when Hevy shows it: the workout's start_time as an ISO timestamp with offset, e.g. 2026-11-08T18:30:00+01:00. Without it the Command Center cannot place the workout on the timeline"),
    durationMinutes: z.number().int().min(1).max(600).optional().describe("Hevy's end_time minus start_time, in whole minutes (not the sum of set times)"),
    routine: z.string().optional().describe("e.g. 'Full Body A' — used for the A → B → C rotation"),
    title: z.string().optional(),
    notes: z.string().optional(),
    source: z.string().optional().describe("defaults to 'hevy'"),
    exercises: z.array(z.object({
      name: z.string().min(1),
      templateId: z.string().optional().describe("Hevy's exercise template id, if visible"),
      primaryMuscle: z.string().optional().describe("Hevy's muscle name, e.g. chest, lats, quadriceps, abdominals"),
      secondaryMuscles: z.array(z.string()).optional(),
      sets: z.array(z.object({
        weightKg: z.number().min(0).max(1000).nullable().optional(),
        reps: z.number().int().min(0).max(1000).nullable().optional(),
        distanceM: z.number().min(0).nullable().optional(),
        durationSeconds: z.number().int().min(0).nullable().optional(),
        rpe: z.number().min(1).max(10).nullable().optional(),
        type: z.enum(["normal", "warmup", "dropset", "failure"]).optional(),
        isPr: z.boolean().optional().describe("true if Hevy marked this set as a personal record"),
      })).min(1),
    })).min(1),
  }),
  handler: async (a: any) => {
    const source = a.source || "hevy";
    let volume = 0, prs = 0, setCount = 0;
    const rows: any[] = [];
    a.exercises.forEach((ex: any, ei: number) => {
      ex.sets.forEach((s: any, si: number) => {
        const type = s.type || "normal";
        if (type !== "warmup" && s.weightKg != null && s.reps != null) volume += s.weightKg * s.reps;
        if (s.isPr) prs++;
        setCount++;
        rows.push({
          exercise_index: ei, set_index: si, exercise: ex.name, exercise_template_id: ex.templateId ?? null, set_type: type,
          weight_kg: s.weightKg ?? null, reps: s.reps ?? null, distance_m: s.distanceM ?? null,
          duration_seconds: s.durationSeconds ?? null, rpe: s.rpe ?? null, is_pr: !!s.isPr,
        });
      });
    });
    const head = await healthUpsert("workouts", { source, source_id: a.sourceId }, {
      date: a.date, started_at: a.startedAt, duration_minutes: a.durationMinutes, routine: a.routine, title: a.title,
      notes: a.notes, volume_kg: Math.round(volume * 10) / 10, pr_count: prs,
    });
    if (head.error) return fail(head.error);
    const workoutId = head.id!;

    // Sets: write only what differs, mark what vanished.
    const cur = await db.from("workout_sets").select("*").eq("workout_id", workoutId).eq("user_id", OWNER);
    if (cur.error) return fail(cur.error.message + HEALTH_HINT);
    const byKey: Record<string, any> = {};
    (cur.data || []).forEach((r: any) => { byKey[r.exercise_index + ":" + r.set_index] = r; });
    const cols = ["exercise", "exercise_template_id", "set_type", "weight_kg", "reps", "distance_m", "duration_seconds", "rpe", "is_pr"];
    const toWrite = rows.filter((r) => {
      const e = byKey[r.exercise_index + ":" + r.set_index];
      return !e || e.superseded_at || cols.some((c) => !sameVal(e[c], r[c]));
    });
    if (toWrite.length) {
      const up = await db.from("workout_sets").upsert(
        toWrite.map((r) => ({ ...r, user_id: OWNER, workout_id: workoutId, superseded_at: null })),
        { onConflict: "workout_id,exercise_index,set_index" },
      );
      if (up.error) return fail(up.error.message + HEALTH_HINT);
    }
    const keep = new Set(rows.map((r) => r.exercise_index + ":" + r.set_index));
    const gone = (cur.data || []).filter((r: any) => !r.superseded_at && !keep.has(r.exercise_index + ":" + r.set_index)).map((r: any) => r.id);
    if (gone.length) {
      const sup = await db.from("workout_sets").update({ superseded_at: new Date().toISOString() }).in("id", gone).eq("user_id", OWNER);
      if (sup.error) return fail(sup.error.message);
    }

    // Remember which muscles each exercise works, when Hevy told us.
    const unknownMuscles: string[] = [];
    for (const ex of a.exercises) {
      if (!ex.primaryMuscle) continue;
      const primary = muscleKey(ex.primaryMuscle);
      if (!primary) { unknownMuscles.push(ex.name + ": " + ex.primaryMuscle); continue; }
      const secondary = Array.from(new Set((ex.secondaryMuscles || []).map(muscleKey).filter((m: string | null) => m && m !== primary)));
      const m = await healthUpsert("exercise_muscle_map", { exercise_key: String(ex.name).trim().toLowerCase() }, {
        exercise: ex.name, exercise_template_id: ex.templateId, primary_muscle: primary, secondary_muscles: secondary,
      });
      if (m.error) return fail(m.error);
    }
    const setsChanged = toWrite.length + gone.length;
    await refreshGoalScores().catch(() => null);
    return ok({
      ok: true, id: workoutId,
      result: head.result === "created" ? "created" : (head.result === "updated" || setsChanged ? "updated" : "unchanged"),
      sets: setCount, setsWritten: toWrite.length, setsSuperseded: gone.length, volumeKg: Math.round(volume * 10) / 10, prs,
      ...(unknownMuscles.length ? { unmappedMuscles: unknownMuscles } : {}),
      ...(a.startedAt ? {} : { missingStartedAt: "No startedAt was sent, so this workout cannot be placed on the calendar. Read Hevy's start_time and end_time and send this workout again with startedAt and durationMinutes." }),
    });
  },
});

tool("upsert_activity", {
  description:
    "Save one non-strength activity from Garmin: a swim, sauna, walk, run or row. Idempotent per sourceId (Garmin's activity id).",
  inputSchema: z.object({
    sourceId: z.string().min(1).describe("Garmin's activity id. If there is none, use 'manual-YYYY-MM-DD-swim'"),
    date: DAY,
    type: z.enum(["swim", "sauna", "walk", "run", "row", "bike", "hike", "other"]),
    name: z.string().optional(),
    startedAt: z.string().optional().describe("ISO timestamp with offset"),
    durationMinutes: z.number().min(0).max(1440).nullable().optional(),
    distanceM: z.number().min(0).nullable().optional().describe("metres — a 225 m swim is 225"),
    calories: z.number().int().min(0).nullable().optional(),
    avgHr: z.number().int().min(20).max(250).nullable().optional(),
    maxHr: z.number().int().min(20).max(250).nullable().optional(),
    source: z.string().optional().describe("defaults to 'garmin'"),
  }),
  handler: async (a: any) => {
    const r = await healthUpsert("activities", { source: a.source || "garmin", source_id: a.sourceId }, {
      date: a.date, type: a.type, name: a.name, started_at: a.startedAt, duration_minutes: a.durationMinutes,
      distance_m: a.distanceM, calories: a.calories, avg_hr: a.avgHr, max_hr: a.maxHr,
    });
    if (r.error) return fail(r.error);
    return ok({ ok: true, id: r.id, result: r.result });
  },
});

tool("log_body_metric", {
  description:
    "Record a body measurement for a day: weight_kg, body_fat_pct, muscle_mass_kg or waist_cm (one value per metric per day; logging again for the same day replaces it), or blood_pressure with systolic, diastolic and optional pulse (several readings a day are kept; the same time again updates that reading).",
  inputSchema: z.object({
    metric: z.enum(["weight_kg", "body_fat_pct", "muscle_mass_kg", "waist_cm", "blood_pressure"]),
    value: z.number().positive().max(500).optional().describe("for every metric except blood_pressure"),
    systolic: z.number().int().min(50).max(260).optional(), diastolic: z.number().int().min(30).max(180).optional(), pulse: z.number().int().min(25).max(230).optional(),
    measuredAt: z.string().optional().describe("blood pressure: ISO time with offset; default now"),
    note: z.string().max(200).optional(),
    date: DAY.optional().describe("defaults to today (Berlin)"),
    source: z.string().optional().describe("where it came from: garmin, scale, manual"),
  }),
  handler: async (a: any) => {
    if (a.metric === "blood_pressure") {
      if (a.systolic == null || a.diastolic == null) return fail("blood_pressure needs systolic and diastolic.");
      if (a.diastolic >= a.systolic) return fail("diastolic should be lower than systolic; check the order.");
      const at = a.measuredAt ? new Date(a.measuredAt) : new Date();
      if (isNaN(at.getTime())) return fail("measuredAt is not a valid time.");
      const day = a.date || at.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
      const r = await healthUpsert("bp_readings", { measured_at: at.toISOString() }, { date: day, systolic: a.systolic, diastolic: a.diastolic, pulse: a.pulse ?? null, note: a.note ?? null, source: a.source || "manual" });
      if (r.error) return fail(r.error + " (run _Memory/migration_health_v3.sql)");
      const row = (await owned("bp_readings").eq("id", r.id!).single()).data;
      return ok({ ok: true, result: r.result, reading: row });
    }
    if (a.value == null) return fail("value is required for " + a.metric + ".");
    const date = a.date || berlinToday();
    const r = await healthUpsert("body_metrics", { date, metric: a.metric }, { value: a.value, source: a.source });
    if (r.error) return fail(r.error);
    return ok({ ok: true, id: r.id, date, result: r.result });
  },
});

tool("set_health_status", {
  description:
    "Mark a period as sick, injured or on a break — the Health page then pauses targets and streaks and marks the period on its charts — or set 'normal' to end the current period. Use it when the user says they are ill, hurt, travelling, or well again.",
  inputSchema: z.object({
    status: z.enum(["normal", "sick", "injured", "break"]),
    startDate: DAY.optional().describe("first day of the period; defaults to today (Berlin). Ignored for 'normal'"),
    endDate: DAY.optional().describe("last day of the period. For 'normal': the last day of the period being closed, default yesterday"),
    note: z.string().optional(),
  }),
  handler: async (a: any) => {
    const today = berlinToday();
    const open = await owned("health_status").is("end_date", null).is("archived_at", null);
    if (open.error) return fail(open.error.message + HEALTH_HINT);
    const now = new Date().toISOString();
    const close = async (row: any, end: string) => {
      const e = end < row.start_date ? row.start_date : end;
      return await db.from("health_status").update({ end_date: e, updated_at: now }).eq("id", row.id).eq("user_id", OWNER);
    };
    if (a.status === "normal") {
      const end = a.endDate || addDays(today, -1);
      for (const row of open.data || []) { const r = await close(row, end); if (r.error) return fail(r.error.message); }
      return ok({ ok: true, status: "normal", closed: (open.data || []).length });
    }
    const start = a.startDate || today;
    const same = (open.data || []).find((r: any) => r.status === a.status);
    if (same && !a.endDate) {
      const patch: Record<string, unknown> = {};
      if (a.note !== undefined && a.note !== same.note) patch.note = a.note;
      if (a.startDate && a.startDate !== same.start_date) patch.start_date = a.startDate;
      if (!Object.keys(patch).length) return ok({ ok: true, id: same.id, result: "unchanged" });
      const r = await db.from("health_status").update({ ...patch, updated_at: now }).eq("id", same.id).eq("user_id", OWNER);
      if (r.error) return fail(r.error.message);
      return ok({ ok: true, id: same.id, result: "updated" });
    }
    // A closed period sent again (same status + start) is the same period, not a new one.
    const dup = await owned("health_status").eq("status", a.status).eq("start_date", start).is("archived_at", null).limit(1);
    if (dup.error) return fail(dup.error.message + HEALTH_HINT);
    if (dup.data && dup.data[0]) {
      const r = await healthUpsert("health_status", { id: dup.data[0].id }, { end_date: a.endDate ?? undefined, note: a.note });
      if (r.error) return fail(r.error);
      return ok({ ok: true, id: r.id, result: r.result });
    }
    if (a.endDate && a.endDate < start) return fail("endDate is before startDate.");
    if (!a.endDate) for (const row of open.data || []) { const r = await close(row, addDays(start, -1)); if (r.error) return fail(r.error.message); }
    const ins = await db.from("health_status").insert({
      user_id: OWNER, status: a.status, start_date: start, end_date: a.endDate || null, note: a.note || null,
    }).select("id").single();
    if (ins.error) return fail(ins.error.message + HEALTH_HINT);
    return ok({ ok: true, id: ins.data.id, result: "created" });
  },
});

tool("set_health_flag", {
  description:
    "Track a body region that needs attention, e.g. lower_back = recovering. One flag per region; setting it again updates it. 'cleared' keeps the history visible as resolved. Regions: lower_back, upper_back, neck, shoulder, elbow, wrist, hip, knee, ankle (or any short name — unknown regions show in the list but not on the figure).",
  inputSchema: z.object({
    region: z.string().min(1).describe("snake_case, e.g. lower_back"),
    state: z.enum(["watch", "recovering", "cleared"]),
    note: z.string().optional().describe("one calm sentence: what it is and how it is going"),
    since: DAY.optional().describe("when it started"),
  }),
  handler: async (a: any) => {
    const region = String(a.region).trim().toLowerCase().replace(/[\s-]+/g, "_");
    const r = await healthUpsert("health_flags", { region }, { state: a.state, note: a.note, since: a.since });
    if (r.error) return fail(r.error);
    return ok({ ok: true, id: r.id, region, result: r.result });
  },
});

tool("write_health_brief", {
  description:
    "Write today's brief for the Health page ('Today's plan'): a one-line headline, an optional short summary, and up to four recommendations, each with a reason drawn from the data. Call get_health_summary first. Tone: calm, encouraging, honest, never guilt-tripping; no medical claims. One brief per day — writing again replaces it. If the user is sick, injured or on a break, recommend rest and do not set training targets.",
  inputSchema: z.object({
    date: DAY.optional().describe("defaults to today (Berlin)"),
    headline: z.string().min(1).max(160).describe("the verdict in one sentence, e.g. 'Recovery is strong — good day for Full Body C.'"),
    summary: z.string().max(600).optional(),
    readiness: z.number().int().min(0).max(100).optional().describe("your read of readiness, if you computed one; the page also computes its own"),
    recommendations: z.array(z.object({
      kind: z.enum(["train", "move", "sleep", "recover", "eat"]),
      title: z.string().min(1).max(80).describe("short and concrete: 'In bed by 00:30'"),
      why: z.string().min(1).max(300).describe("the reason, from the data"),
    })).max(4),
    nextSession: z.object({
      routine: z.string().describe("e.g. 'Full Body C'"),
      targets: z.array(z.object({
        exercise: z.string(),
        weightKg: z.number().min(0).max(1000).optional(),
        reps: z.string().optional().describe("e.g. '3 × 10–12'"),
        change: z.enum(["up", "hold", "down"]).optional().describe("compared with last time"),
        lastWeightKg: z.number().min(0).max(1000).optional(),
      })).max(12),
    }).optional(),
    writtenBy: z.string().optional().describe("defaults to 'Claude'"),
  }),
  handler: async (a: any) => {
    const date = a.date || berlinToday();
    const r = await healthUpsert("health_briefs", { date }, {
      headline: a.headline, summary: a.summary, readiness: a.readiness, recommendations: a.recommendations,
      next_session: a.nextSession, written_by: a.writtenBy || "Claude",
    });
    if (r.error) return fail(r.error);
    return ok({ ok: true, id: r.id, date, result: r.result });
  },
});

tool("get_health_summary", {
  description:
    "Everything the Health page knows, for writing a brief or answering a health question: the last N days of Garmin data, strength sessions with their exercises, other activities, body measurements, the current status (normal / sick / injured / break), flags, settings, and the user's own 30-day baselines (median and usual range) for resting HR, HRV and sleep score. Missing values are null — they were not measured; do not treat them as zero.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(120).optional().describe("how many days back; default 14"),
  }),
  handler: async (a: any) => {
    const today = berlinToday();
    const n = a.days || 14;
    const from = addDays(today, -(n - 1));
    const baseFrom = addDays(today, -30);
    const live = (t: string) => owned(t).is("archived_at", null);
    const [daily, workouts, acts, metrics, status, flags, briefs, settings] = await Promise.all([
      live("health_daily").gte("date", from < baseFrom ? from : baseFrom).order("date"),
      live("workouts").gte("date", from).order("date"),
      live("activities").gte("date", from).order("date"),
      live("body_metrics").gte("date", from).order("date"),
      live("health_status").order("start_date", { ascending: false }).limit(10),
      live("health_flags"),
      live("health_briefs").order("date", { ascending: false }).limit(1),
      owned("health_settings").limit(1),
    ]);
    const firstErr = [daily, workouts, acts, metrics, status, flags, briefs].find((r) => r.error);
    if (firstErr) return fail(firstErr.error!.message + HEALTH_HINT);
    const ids = (workouts.data || []).map((w: any) => w.id);
    const sets = ids.length
      ? await db.from("workout_sets").select("*").in("workout_id", ids).is("superseded_at", null).order("exercise_index").order("set_index")
      : { data: [], error: null };
    if (sets.error) return fail(sets.error.message);
    const quant = (arr: number[], p: number) => {
      const s = arr.slice().sort((x, y) => x - y);
      if (!s.length) return null;
      const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
      return Math.round((s[lo] + (s[hi] - s[lo]) * (i - lo)) * 10) / 10;
    };
    const baseline = (col: string) => {
      const v = (daily.data || []).filter((d: any) => d.date >= baseFrom && d.date < today && d[col] != null).map((d: any) => Number(d[col]));
      return { median: quant(v, 0.5), usualLow: quant(v, 0.25), usualHigh: quant(v, 0.75), days: v.length };
    };
    const strip = (r: any) => { const { user_id: _u, archived_at: _a, created_at: _c, ...rest } = r; return rest; };
    const current = (status.data || []).find((s: any) => s.start_date <= today && (!s.end_date || s.end_date >= today));
    return ok({
      today,
      status: current ? { status: current.status, since: current.start_date, note: current.note } : { status: "normal" },
      recentStatusPeriods: (status.data || []).map(strip),
      flags: (flags.data || []).map(strip),
      baselines30d: { restingHr: baseline("resting_hr"), hrv: baseline("hrv_avg"), sleepScore: baseline("sleep_score"), steps: baseline("steps") },
      days: (daily.data || []).filter((d: any) => d.date >= from).map(strip),
      workouts: (workouts.data || []).map((w: any) => {
        const mine = (sets.data || []).filter((s: any) => s.workout_id === w.id);
        const byEx: Record<string, any> = {};
        mine.forEach((s: any) => {
          const e = byEx[s.exercise_index] = byEx[s.exercise_index] || { exercise: s.exercise, sets: [] };
          e.sets.push({ weightKg: s.weight_kg, reps: s.reps, type: s.set_type, isPr: s.is_pr });
        });
        return { ...strip(w), exercises: Object.keys(byEx).sort((x, y) => Number(x) - Number(y)).map((k) => byEx[k]) };
      }),
      activities: (acts.data || []).map(strip),
      bodyMetrics: (metrics.data || []).map(strip),
      latestBrief: briefs.data && briefs.data[0] ? strip(briefs.data[0]) : null,
      settings: settings.data && settings.data[0] ? strip(settings.data[0]) : null,
      sleepNote: "Where a night has *_corrected fields, those are the user's corrections and win over the watch's values.",
      ...(await (async () => {
        const [ci, cond, ms, bp] = await Promise.all([
          owned("health_checkins").is("archived_at", null).order("date", { ascending: false }).order("updated_at", { ascending: false }).limit(3),
          owned("health_conditions").is("archived_at", null),
          owned("health_milestones").is("archived_at", null),
          owned("bp_readings").is("archived_at", null).gte("date", addDays(today, -90)).order("measured_at"),
        ]);
        const latest = (ci.data || [])[0] || null;
        return {
          latestCheckin: latest ? { date: latest.date, energy: latest.energy, note: latest.note, pains: latest.pains, by: latest.source } : null,
          activePains: (flags.data || []).filter((f: any) => f.state !== "cleared").map((f: any) => ({ region: f.region, state: f.state, since: f.since, note: f.note })),
          nextSession: await hvNextSession(),
          nextCheckup: (cond.data || []).filter((c: any) => c.next_checkup).sort((p: any, q: any) => p.next_checkup.localeCompare(q.next_checkup)).map((c: any) => ({ date: c.next_checkup, condition: c.name }))[0] || null,
          conditions: (cond.data || []).map((c: any) => ({ id: c.id, name: c.name, note: c.note, checkupEveryMonths: c.checkup_every_months, nextCheckup: c.next_checkup, metrics: c.metrics })),
          milestones: (ms.data || []).map((m: any) => ({ kind: m.kind, since: m.since_date, days: -ccDiff(today, m.since_date) })),
          bloodPressure90d: (bp.data || []).map((r: any) => ({ at: r.measured_at, systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse })),
        };
      })()),
      rules: "Readiness on the page = sleep 30%, resting HR 25%, HRV 20%, morning Body Battery 15%, previous-day stress 10%, each compared with the user's own 30-day baseline; missing inputs are re-weighted. Progression: every working set at the top of the rep range → add weight next time.",
    });
  },
});

// ==== HV3-BEGIN ====
// ---- Health v3: routines and rotation, check-ins, sleep corrections, conditions, milestones, history ----
// Tables: migration_health_v3.sql. Condition names stay inside Health: the Command Center reminder a
// condition creates is titled only "Health check-up".
const PAIN = z.object({ region: z.string().min(1).describe("snake_case body region: lower_back, upper_back, neck, shoulder, left_knee ..."), level: z.number().int().min(1).max(3).optional().describe("1 mild, 2 noticeable, 3 strong"), note: z.string().max(200).optional() });
const e1rm = (w: number | null, r: number | null) => w != null && r != null && r > 0 ? Math.round(w * (1 + Math.min(r, 12) / 30) * 10) / 10 : null;
async function hvRotation(): Promise<string[]> {
  const r = await owned("health_routines").is("archived_at", null).not("position", "is", null).order("position");
  if (!r.error && r.data && r.data.length) return r.data.map((x: any) => x.title);
  const s = await owned("health_settings").limit(1);
  const rot = s.data && s.data[0] && s.data[0].rotation;
  return Array.isArray(rot) && rot.length ? rot : ["Full Body A", "Full Body B", "Full Body C"];
}
// The next planned session: the next gym block in the Command Center (or a base gym day), and the routine
// that follows the last completed workout in the rotation.
async function hvNextSession() {
  const today = berlinToday(), rotation = await hvRotation();
  const last = await owned("workouts").is("archived_at", null).order("date", { ascending: false }).order("started_at", { ascending: false }).limit(1);
  const lastRoutine = last.data && last.data[0] ? (last.data[0].routine || last.data[0].title) : null;
  const idx = lastRoutine ? rotation.findIndex((t) => t.toLowerCase() === String(lastRoutine).toLowerCase()) : -1;
  const routine = rotation.length ? rotation[(idx + 1) % rotation.length] : null;
  const blocks = await owned("actions").is("archived_at", null).eq("kind", "block");
  const t = berlinNow(new Date()), GYM = /gym|workout|training|lift|strength|full body/i;
  let when: { date: string; time: string | null; from: string } | null = null;
  const trained = await owned("workouts").is("archived_at", null).gte("date", today);
  const doneDays = new Set((trained.data || []).map((x: any) => String(x.date).slice(0, 10)));
  for (const b of (blocks.data || []).filter((x: any) => GYM.test(x.title || ""))) {
    for (const d of ccDates(b, today, ccAdd(today, 21))) {
      const tm = b.time_of_day ? String(b.time_of_day).slice(0, 5) : null;
      if (doneDays.has(d)) continue;
      if (d === today && tm && (ccMins(tm) as number) < t.nowMin) continue;
      if (!when || d + (tm || "") < when.date + (when.time || "")) when = { date: d, time: tm, from: "Command Center: " + b.title };
      break;
    }
  }
  if (!when) {
    const ps = await plannerSettings();
    for (let i = 0; i < 8 && !when; i++) { const d = ccAdd(today, i), dow = ccDow(d) || 7; if (!doneDays.has(d) && (ps.gymDays || []).includes(dow)) when = { date: d, time: null, from: "base gym days" }; }
  }
  return { date: when ? when.date : null, time: when ? when.time : null, scheduledBy: when ? when.from : "nothing scheduled", trainedToday: doneDays.has(today), routine, lastRoutine, lastWorkoutDate: last.data && last.data[0] ? last.data[0].date : null, rotation };
}

tool("upsert_routine", {
  description: "Save Hevy routines and the rotation order, so the planner knows which routine comes next. Idempotent per routine (Hevy's routine id, or its title). Pass rotation as the routine titles in order (e.g. ['Full Body A','Full Body B','Full Body C']); routines left out of a given rotation are taken out of it. Returns the routines and the rotation.",
  inputSchema: z.object({
    routines: z.array(z.object({ sourceId: z.string().optional().describe("Hevy's routine id"), title: z.string().min(1).max(80), exercises: z.array(z.object({ name: z.string().min(1), templateId: z.string().optional(), sets: z.number().int().min(0).max(20).optional() })).max(40).optional(), notes: z.string().max(500).optional() })).max(20).optional(),
    rotation: z.array(z.string().min(1)).max(20).optional(),
  }),
  handler: async (a: any) => {
    if (!a.routines && !a.rotation) return fail("Send routines, a rotation, or both.");
    for (const r of a.routines || []) {
      const u = await healthUpsert("health_routines", { source: "hevy", source_id: r.sourceId || r.title }, { title: r.title, exercises: r.exercises, notes: r.notes });
      if (u.error) return fail(u.error);
    }
    if (a.rotation) {
      const all = await owned("health_routines").is("archived_at", null);
      if (all.error) return fail(all.error.message + HEALTH_HINT);
      const lower = a.rotation.map((x: string) => x.toLowerCase());
      for (const t of a.rotation) if (!(all.data || []).some((r: any) => r.title.toLowerCase() === t.toLowerCase())) { const u = await healthUpsert("health_routines", { source: "hevy", source_id: t }, { title: t }); if (u.error) return fail(u.error); }
      const fresh = await owned("health_routines").is("archived_at", null);
      for (const r of fresh.data || []) { const pos = lower.indexOf(r.title.toLowerCase()); const want = pos >= 0 ? pos + 1 : null; if (r.position !== want) await db.from("health_routines").update({ position: want, updated_at: new Date().toISOString() }).eq("id", r.id).eq("user_id", OWNER); }
    }
    const out = await owned("health_routines").is("archived_at", null).order("position", { nullsFirst: false });
    return ok({ ok: true, rotation: await hvRotation(), routines: (out.data || []).map((r: any) => ({ id: r.id, title: r.title, position: r.position, exercises: r.exercises })) });
  },
});
tool("get_next_session", {
  description: "When the next workout is and which routine it should be: the next gym block in the Command Center (or the base gym days), and the routine after the last completed workout in the rotation.",
  inputSchema: z.object({}),
  handler: async () => ok(await hvNextSession()),
});
tool("get_workout_history", {
  description: "Workouts newest first, each with date, routine, duration, volume and every exercise with its sets (warm-ups marked). Default: the last 30 days.",
  inputSchema: z.object({ from: DAY.optional(), to: DAY.optional(), limit: z.number().int().min(1).max(200).optional() }),
  handler: async (a: any) => {
    const to = a.to || berlinToday(), from = a.from || addDays(to, -30);
    const w = await owned("workouts").is("archived_at", null).gte("date", from).lte("date", to).order("date", { ascending: false }).limit(a.limit || 60);
    if (w.error) return fail(w.error.message + HEALTH_HINT);
    const ids = (w.data || []).map((x: any) => x.id);
    const sets = ids.length ? await db.from("workout_sets").select("*").in("workout_id", ids).is("superseded_at", null).order("exercise_index").order("set_index") : { data: [] as any[] };
    return ok({ from, to, workouts: (w.data || []).map((x: any) => {
      const byEx: Record<string, any> = {};
      (sets.data || []).filter((s: any) => s.workout_id === x.id).forEach((s: any) => { const e = byEx[s.exercise_index] = byEx[s.exercise_index] || { exercise: s.exercise, sets: [] }; e.sets.push({ weightKg: s.weight_kg, reps: s.reps, type: s.set_type, isPr: s.is_pr }); });
      return { id: x.id, date: x.date, routine: x.routine || x.title, durationMinutes: x.duration_minutes, volumeKg: x.volume_kg, prs: x.pr_count, exercises: Object.keys(byEx).sort((p, q) => +p - +q).map((k) => byEx[k]) };
    }) });
  },
});
tool("get_exercise_progress", {
  description: "Progress for one exercise over the last year: per session the top set, its reps, estimated 1RM (Epley) and total volume; personal records; days since it was last trained. Matches the exercise name loosely (case-insensitive, part of the name).",
  inputSchema: z.object({ exercise: z.string().min(2).max(80) }),
  handler: async (a: any) => {
    const since = addDays(berlinToday(), -365);
    const s = await db.from("workout_sets").select("workout_id,exercise,weight_kg,reps,set_type,is_pr").eq("user_id", OWNER).is("superseded_at", null).ilike("exercise", "%" + a.exercise.replace(/[%_]/g, " ") + "%").limit(5000);
    if (s.error) return fail(s.error.message + HEALTH_HINT);
    if (!(s.data || []).length) return ok({ exercise: a.exercise, sessions: [], note: "No sets logged for that exercise." });
    const ids = Array.from(new Set((s.data || []).map((x: any) => x.workout_id)));
    const w = await owned("workouts").is("archived_at", null).gte("date", since).in("id", ids);
    const byW: Record<string, any> = {}; (w.data || []).forEach((x: any) => { byW[x.id] = x; });
    const names = Array.from(new Set((s.data || []).map((x: any) => x.exercise)));
    const sessions: any[] = [];
    for (const id of Object.keys(byW)) {
      const work = (s.data || []).filter((x: any) => x.workout_id === id && x.set_type !== "warmup");
      const ws = work.filter((x: any) => x.weight_kg != null);
      const top = ws.length ? Math.max(...ws.map((x: any) => Number(x.weight_kg))) : null;
      const topReps = top == null ? null : Math.max(...ws.filter((x: any) => Number(x.weight_kg) === top).map((x: any) => Number(x.reps) || 0));
      sessions.push({ date: byW[id].date, routine: byW[id].routine, topSetKg: top, topReps, e1rmKg: e1rm(top, topReps), volumeKg: Math.round(work.reduce((t: number, x: any) => t + (Number(x.weight_kg) || 0) * (Number(x.reps) || 0), 0)), sets: work.length, hevyPr: work.some((x: any) => x.is_pr) });
    }
    sessions.sort((p, q) => p.date.localeCompare(q.date));
    let best = -1; for (const x of sessions) { x.record = x.topSetKg != null && x.topSetKg > best && best >= 0; if (x.topSetKg != null) best = Math.max(best, x.topSetKg); }
    const lastDate = sessions.length ? sessions[sessions.length - 1].date : null;
    return ok({ exercise: names.length === 1 ? names[0] : a.exercise, matchedNames: names, lastTrained: lastDate, daysSinceLastTrained: lastDate ? -ccDiff(berlinToday(), lastDate) : null, bestTopSetKg: best >= 0 ? best : null, bestE1rmKg: sessions.reduce((m: number | null, x: any) => x.e1rmKg != null && (m == null || x.e1rmKg > m) ? x.e1rmKg : m, null), sessions });
  },
});
tool("log_checkin", {
  description: "Record how the body feels today: energy 1 (very low) to 5 (great), a short note in the user's words, and any pains. One check-in per day per author; sending again the same day updates it. Pains also mark the region on the body figure (as a 'watch' flag, unless one is already open). Returns the check-in.",
  inputSchema: z.object({ energy: z.number().int().min(1).max(5), note: z.string().max(400).optional(), pains: z.array(PAIN).max(8).optional(), date: DAY.optional().describe("defaults to today (Berlin)"), source: z.enum(["claude", "me"]).optional().describe("who wrote it; default claude") }),
  handler: async (a: any) => {
    const date = a.date || berlinToday(), source = a.source || "claude";
    const pains = (a.pains || []).map((p: any) => ({ region: String(p.region).trim().toLowerCase().replace(/[\s-]+/g, "_"), level: p.level || 1, note: p.note || "" }));
    const r = await healthUpsert("health_checkins", { date, source }, { energy: a.energy, note: a.note ?? null, pains });
    if (r.error) return fail(r.error);
    for (const p of pains) {
      const cur = await owned("health_flags").eq("region", p.region).maybeSingle();
      if (!cur.data || cur.data.state === "cleared" || cur.data.archived_at) await healthUpsert("health_flags", { region: p.region }, { state: "watch", note: p.note || "Mentioned in a check-in.", since: date, archived_at: null });
    }
    const row = await owned("health_checkins").eq("id", r.id!).single();
    return ok({ ok: true, result: r.result, checkin: row.data });
  },
});
tool("set_sleep_correction", {
  description: "Correct one night when the watch got the bedtime or wake time wrong. date is the day the night ENDED on. The corrected times (and the time asleep worked out from them, unless you pass minutes) are used everywhere on the page; the watch's own values are kept for reference. Send clear: true to remove a correction.",
  inputSchema: z.object({ date: DAY, bedtime: CLOCK.optional(), waketime: CLOCK.optional(), asleepMinutes: z.number().int().min(0).max(1440).optional().describe("if you know the actual time asleep; otherwise wake minus bed"), clear: z.boolean().optional() }),
  handler: async (a: any) => {
    if (a.clear) { const r = await healthUpsert("health_daily", { date: a.date }, { bed_time_corrected: null, wake_time_corrected: null, sleep_minutes_corrected: null, corrected_at: null }); if (r.error) return fail(r.error); }
    else {
      if (!a.bedtime || !a.waketime) return fail("Send both bedtime and waketime (HH:MM), or clear: true.");
      let m = (ccMins(a.waketime) as number) - (ccMins(a.bedtime) as number); if (m <= 0) m += 1440;
      if (m > 960) return fail("That is more than 16 hours in bed; check the times (bedtime is the evening before the date).");
      const r = await healthUpsert("health_daily", { date: a.date }, { bed_time_corrected: a.bedtime, wake_time_corrected: a.waketime, sleep_minutes_corrected: a.asleepMinutes ?? m, corrected_at: new Date().toISOString() });
      if (r.error) return fail(r.error);
    }
    const row = await owned("health_daily").eq("date", a.date).single();
    const d = row.data || {};
    return ok({ ok: true, date: a.date, used: { bedtime: hhmm(d.bed_time_corrected || d.bed_time), waketime: hhmm(d.wake_time_corrected || d.wake_time), asleepMinutes: d.sleep_minutes_corrected ?? d.sleep_minutes, corrected: !!d.corrected_at }, watch: { bedtime: hhmm(d.bed_time), waketime: hhmm(d.wake_time), asleepMinutes: d.sleep_minutes } });
  },
});
const BODY_AREAS = ["heart", "lungs", "brain", "liver", "kidneys", "stomach", "skin", "joints", "eyes", "other"] as const;
tool("set_health_condition", {
  description: "Add or update a monitored condition (matched by name; private, shown only on the Health page): a short note, a check-up rhythm, the next check-up date and the metrics to watch (e.g. blood_pressure, weight_kg). A next check-up creates or moves one Command Center reminder titled only 'Health check-up' (the name stays private). archived: true hides it and archives its reminder. Returns the condition.",
  inputSchema: z.object({ name: z.string().min(1).max(80), note: z.string().max(400).optional(), checkup_every_months: z.number().int().min(1).max(120).nullable().optional(), next_checkup: DAY.nullable().optional(), metrics: z.array(z.string().max(40)).max(10).optional(), body_area: z.enum(BODY_AREAS).nullable().optional().describe("where the quiet 'monitored' marker sits on the body figure"), archived: z.boolean().optional() }),
  handler: async (a: any) => {
    const all = await owned("health_conditions").is("archived_at", null);
    if (all.error) return fail(all.error.message + " (run _Memory/migration_health_v3.sql)");
    const cur = (all.data || []).find((c: any) => c.name.toLowerCase() === a.name.trim().toLowerCase());
    const now = new Date().toISOString();
    if (a.archived) {
      if (!cur) return fail("No condition with that name.");
      await db.from("health_conditions").update({ archived_at: now }).eq("id", cur.id).eq("user_id", OWNER);
      if (cur.action_id) await db.from("actions").update({ archived_at: now }).eq("id", cur.action_id).eq("user_id", OWNER);
      return ok({ ok: true, archived: true, id: cur.id });
    }
    const f: Record<string, unknown> = { name: a.name.trim() };
    for (const k of ["note", "checkup_every_months", "next_checkup", "metrics", "body_area"]) if (a[k] !== undefined) f[k] = a[k];
    let id = cur && cur.id;
    if (cur) { const u = await db.from("health_conditions").update({ ...f, updated_at: now }).eq("id", cur.id).eq("user_id", OWNER); if (u.error) return fail(u.error.message); }
    else { const i = await db.from("health_conditions").insert({ user_id: OWNER, ...f }).select("id").single(); if (i.error) return fail(i.error.message); id = i.data.id; }
    const row = (await owned("health_conditions").eq("id", id).single()).data;
    // the Command Center reminder
    if (row.next_checkup) {
      const fields = { title: "Health check-up", date: row.next_checkup, kind: "deadline", is_milestone: true, category: "Health", reminders: [1440], archived_at: null, done: false };
      const ex = row.action_id ? await owned("actions").eq("id", row.action_id).maybeSingle() : { data: null };
      if (ex.data) await safeWrite((p) => db.from("actions").update(p).eq("id", row.action_id).eq("user_id", OWNER), fields);
      else { const ins = await safeWrite((p) => db.from("actions").insert(p).select("id").single(), { user_id: OWNER, source: "claude", priority: "P2", type: "Task", parent_type: "none", parent_id: null, notes_md: "", ...fields }); if (!ins.error) { await db.from("health_conditions").update({ action_id: ins.data.id }).eq("id", id); row.action_id = ins.data.id; } }
    } else if (row.action_id) await db.from("actions").update({ archived_at: now }).eq("id", row.action_id).eq("user_id", OWNER);
    return ok({ ok: true, created: !cur, condition: row, reminder: row.next_checkup ? { id: row.action_id, date: row.next_checkup, title: "Health check-up" } : null });
  },
});
tool("set_milestone", {
  description: "Set a milestone date the page counts from, e.g. kind smoke_free with the date it started. One per kind; setting it again moves the date. archived: true hides it.",
  inputSchema: z.object({ kind: z.enum(["smoke_free"]), since_date: DAY, note: z.string().max(200).optional(), archived: z.boolean().optional() }),
  handler: async (a: any) => {
    if (a.since_date > berlinToday()) return fail("since_date is in the future.");
    const r = await healthUpsert("health_milestones", { kind: a.kind }, { since_date: a.since_date, note: a.note, archived_at: a.archived ? new Date().toISOString() : null });
    if (r.error) return fail(r.error + " (run _Memory/migration_health_v3.sql)");
    const row = (await owned("health_milestones").eq("id", r.id!).single()).data;
    return ok({ ok: true, result: r.result, milestone: row, days: -ccDiff(berlinToday(), row.since_date) });
  },
});
// ==== HV3-END ====

// ============================ AGENT HUB =====================================
// Everything an agent wants to change is filed as a proposal: a pending row carrying the exact
// columns the write would make (`payload`) plus one human-readable line (`summary`). You approve
// or reject it in the app's Inbox; the app performs the write and stamps the result with the
// agent's name, run id and external id. Nothing here touches actions/journal/events directly.
//
// Every proposal tool shares the same envelope:
//   agent       the bot's name as you'll see it in the Inbox ("Middler", "Briefer")
//   runId       the agent run that produced it — lets you trace a change back to its report
//   externalId  a stable id for the INPUT (an email message-id, a calendar UID). The same
//               externalId is never filed twice: a repeat returns {duplicate:true} with the
//               first proposal's status, so re-running a bot over the same inbox is harmless.
//   reason      one sentence on why — shown under the summary in the Inbox
const AGENT_ENVELOPE = {
  agent: z.string().min(1).describe("the bot's name as it should appear in the user's Inbox, e.g. 'Middler'"),
  runId: z.string().optional().describe("id of the agent run that produced this"),
  externalId: z.string().optional().describe("stable id of the source item (email message-id, calendar UID…) — the same id is never filed twice"),
  reason: z.string().optional().describe("one sentence on why, shown to the user"),
};
const PROPOSAL_HINT = " (has migration_agent_hub.sql been run?)";
function fmtDay(d?: string | null): string {
  if (!d) return "no date";
  // Parsed AND printed in UTC. Parsing "YYYY-MM-DDT00:00:00" without the Z reads local midnight,
  // which toUTCString then shows as the previous day anywhere east of UTC.
  const dt = new Date(d + "T00:00:00Z");
  return isNaN(dt.getTime()) ? d : dt.toUTCString().slice(0, 11).replace(",", "");
}
async function fileProposal(p: {
  agent: string; runId?: string; externalId?: string; reason?: string;
  kind: string; op: string; targetId?: string | null;
  payload: Record<string, unknown>; meta?: Record<string, unknown>; summary: string;
}) {
  if (p.externalId) {
    const dup = await owned("agent_proposals").eq("external_id", p.externalId).maybeSingle();
    if (dup.error) return fail(dup.error.message + PROPOSAL_HINT);
    if (dup.data) {
      return ok({ duplicate: true, proposalId: dup.data.id, status: dup.data.status, summary: dup.data.summary });
    }
  }
  const { data, error } = await db.from("agent_proposals").insert({
    user_id: OWNER, agent: p.agent, client: "agent-pgm", run_id: p.runId || null,
    external_id: p.externalId || null, kind: p.kind, op: p.op, target_id: p.targetId || null,
    payload: p.payload, meta: p.meta || {}, summary: p.summary, reason: p.reason || null,
  }).select().single();
  if (error) {
    // Lost a race with an identical externalId filed a moment earlier — same answer as above.
    if ((error as { code?: string }).code === "23505") return ok({ duplicate: true, externalId: p.externalId });
    return fail(error.message + PROPOSAL_HINT);
  }
  return ok({ ok: true, proposalId: data.id, status: "pending", summary: p.summary });
}
async function targetTitle(table: string, id: string, col = "title"): Promise<string | null> {
  const r = await owned(table).eq("id", id).maybeSingle();
  return r.data ? String(r.data[col] ?? "") : null;
}

tool("propose_action", {
  description:
    "Propose creating, editing or completing an ACTION (a task the user will do). Nothing changes until the user approves it in their Inbox. op=create needs title; op=edit/complete need actionId (from list_actions). For something that simply happens at a time — a meeting, an appointment — use propose_event instead.",
  inputSchema: z.object({
    ...AGENT_ENVELOPE,
    op: z.enum(["create", "edit", "complete"]),
    actionId: z.string().optional().describe("required for edit / complete"),
    title: z.string().optional(),
    priority: z.enum(PRIORITIES).optional().describe("defaults to P2 on create"),
    type: z.enum(ACTION_TYPES).optional(),
    parentType: z.enum(["goal", "project", "none"]).optional(),
    parentId: z.string().optional(),
    date: z.string().optional().describe("YYYY-MM-DD; empty string clears it on edit"),
    timeOfDay: z.string().optional().describe("HH:MM 24h"),
    durationMinutes: z.number().optional(),
    area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE),
    notes: z.string().optional(),
    location: z.string().optional().describe("address or place name — geocoded now, so the Inbox shows where it resolved"),
  }),
  handler: async (args: any) => {
    if (args.op === "create") {
      if (!args.title) return fail("title is required to create an action");
      const place = await resolvePlace({ address: args.location });
      if (place.error) return fail(place.error);
      const pt = args.parentType || "none";
      const payload = {
        title: args.title, priority: args.priority || "P2", type: args.type || "Task",
        parent_type: pt, parent_id: pt === "none" ? null : (args.parentId || null),
        date: args.date || null, time_of_day: args.timeOfDay || null,
        duration_minutes: args.durationMinutes || null, category: args.area || null,
        notes_md: args.notes || "", done: false,
        location_address: place.address, location_lat: place.lat, location_lng: place.lng,
      };
      return fileProposal({ ...args, kind: "action", op: "create", payload,
        summary: `New action: "${args.title}" · ${fmtDay(args.date)}${args.timeOfDay ? " " + args.timeOfDay : ""}` });
    }
    if (!args.actionId) return fail("actionId is required for " + args.op);
    const title = await targetTitle("actions", args.actionId);
    if (title === null) return fail("no action with id " + args.actionId);
    if (args.op === "complete") {
      return fileProposal({ ...args, kind: "action", op: "complete", targetId: args.actionId,
        payload: { done: true }, summary: `Complete "${title}"` });
    }
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    const set = (col: string, val: unknown, label: string) => { patch[col] = val; changed.push(label); };
    if (args.title !== undefined) set("title", args.title, `title → "${args.title}"`);
    if (args.priority !== undefined) set("priority", args.priority, `priority → ${args.priority}`);
    if (args.type !== undefined) set("type", args.type, `type → ${args.type}`);
    if (args.parentType !== undefined) {
      set("parent_type", args.parentType, `parent → ${args.parentType}`);
      patch.parent_id = args.parentType === "none" ? null : (args.parentId || null);
    }
    if (args.date !== undefined) set("date", args.date || null, `date → ${args.date ? fmtDay(args.date) : "none"}`);
    if (args.timeOfDay !== undefined) set("time_of_day", args.timeOfDay || null, `time → ${args.timeOfDay || "none"}`);
    if (args.durationMinutes !== undefined) set("duration_minutes", args.durationMinutes, `duration → ${args.durationMinutes} min`);
    if (args.area !== undefined) set("category", args.area, `area → ${args.area}`);
    if (args.notes !== undefined) set("notes_md", args.notes, "notes");
    if (args.location !== undefined) {
      const place = await resolvePlace({ address: args.location });
      if (place.error) return fail(place.error);
      patch.location_address = place.address; patch.location_lat = place.lat; patch.location_lng = place.lng;
      changed.push(`location → ${args.location || "none"}`);
    }
    if (!changed.length) return fail("nothing to change — pass at least one field");
    return fileProposal({ ...args, kind: "action", op: "edit", targetId: args.actionId, payload: patch,
      summary: `Edit "${title}": ${changed.join(", ")}` });
  },
}, "agent");

tool("propose_event", {
  description:
    "Propose creating or editing an EVENT — something that happens at a time (meeting, appointment, trip), with no done state. Calendar entries belong here, not in propose_action. Nothing changes until the user approves it.",
  inputSchema: z.object({
    ...AGENT_ENVELOPE,
    op: z.enum(["create", "edit"]),
    eventId: z.string().optional().describe("required for edit"),
    title: z.string().optional(),
    date: z.string().optional().describe("YYYY-MM-DD"),
    timeOfDay: z.string().optional().describe("HH:MM 24h"),
    durationMinutes: z.number().optional(),
    area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE),
    location: z.string().optional().describe("address or place name — geocoded now"),
    linkedPeopleIds: z.array(z.string()).optional().describe("ids from list_people"),
    notes: z.string().optional(),
  }),
  handler: async (args: any) => {
    const place = args.location !== undefined ? await resolvePlace({ address: args.location }) : null;
    if (place && place.error) return fail(place.error);
    if (args.op === "create") {
      if (!args.title) return fail("title is required to create an event");
      const payload = {
        title: args.title, date: args.date || null, time_of_day: args.timeOfDay || null,
        duration_minutes: args.durationMinutes || null, category: args.area || null,
        secondary_categories: [], linked_people_ids: args.linkedPeopleIds || [], notes_md: args.notes || "",
        location_address: place ? place.address : null, location_lat: place ? place.lat : null, location_lng: place ? place.lng : null,
      };
      return fileProposal({ ...args, kind: "event", op: "create", payload,
        summary: `New event: "${args.title}" · ${fmtDay(args.date)}${args.timeOfDay ? " " + args.timeOfDay : ""}` });
    }
    if (!args.eventId) return fail("eventId is required for edit");
    const title = await targetTitle("events", args.eventId);
    if (title === null) return fail("no event with id " + args.eventId);
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    if (args.title !== undefined) { patch.title = args.title; changed.push(`title → "${args.title}"`); }
    if (args.date !== undefined) { patch.date = args.date || null; changed.push(`date → ${fmtDay(args.date)}`); }
    if (args.timeOfDay !== undefined) { patch.time_of_day = args.timeOfDay || null; changed.push(`time → ${args.timeOfDay || "none"}`); }
    if (args.durationMinutes !== undefined) { patch.duration_minutes = args.durationMinutes; changed.push(`duration → ${args.durationMinutes} min`); }
    if (args.area !== undefined) { patch.category = args.area; changed.push(`area → ${args.area}`); }
    if (args.linkedPeopleIds !== undefined) { patch.linked_people_ids = args.linkedPeopleIds; changed.push("people"); }
    if (args.notes !== undefined) { patch.notes_md = args.notes; changed.push("notes"); }
    if (place) {
      patch.location_address = place.address; patch.location_lat = place.lat; patch.location_lng = place.lng;
      changed.push(`location → ${args.location || "none"}`);
    }
    if (!changed.length) return fail("nothing to change — pass at least one field");
    return fileProposal({ ...args, kind: "event", op: "edit", targetId: args.eventId, payload: patch,
      summary: `Edit event "${title}": ${changed.join(", ")}` });
  },
}, "agent");

tool("propose_person", {
  description:
    "Propose adding a PERSON to the user's People (e.g. someone who writes on WhatsApp and isn't listed yet). Nothing changes until the user approves it in their Inbox. Use socialGroup 'Automatically added' for people an agent found on its own.",
  inputSchema: z.object({
    ...AGENT_ENVELOPE,
    op: z.literal("create").optional(),
    name: z.string(),
    relationship: z.enum(RELATIONSHIPS).optional(),
    contact: z.string().optional().describe("How to reach them: phone, email, 'WhatsApp +49…'"),
    notes: z.string().optional(),
    socialGroup: z.string().optional(),
  }),
  handler: async (args: any) => {
    const payload = {
      user_id: OWNER, name: args.name, relationship: args.relationship || "Other",
      contact: args.contact || "", notes: args.notes || "", social_group: args.socialGroup || null,
    };
    return fileProposal({ ...args, kind: "person", op: "create", payload, summary: `New person: "${args.name}"${args.socialGroup ? ` (${args.socialGroup})` : ""}` });
  },
}, "agent");

tool("propose_note", {
  description:
    "Propose adding a NOTE (journal entry) or editing one. Use noteType 'reference' for facts and summaries an agent gathered — only 'reflection' notes are treated as the user's own mood. Nothing changes until the user approves it.",
  inputSchema: z.object({
    ...AGENT_ENVELOPE,
    op: z.enum(["create", "edit"]),
    noteId: z.string().optional().describe("required for edit"),
    text: z.string().optional(),
    title: z.string().optional(),
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today on create"),
    areas: z.array(z.enum(AREA_INPUT)).optional(),
    noteType: z.enum(NOTE_TYPES).optional().describe("defaults to 'reference' for agent notes"),
    priority: z.enum(PRIORITIES).optional(),
    timeOfDay: z.string().optional(),
  }),
  handler: async (args: any) => {
    if (args.op === "create") {
      if (!args.text) return fail("text is required to create a note");
      const payload = {
        text: args.text, title: args.title || null, date: args.date || todayUTC(),
        categories: args.areas || [], note_type: args.noteType || "reference",
        priority: args.priority || null, time_of_day: args.timeOfDay || null,
      };
      const label = args.title || String(args.text).slice(0, 60);
      return fileProposal({ ...args, kind: "note", op: "create", payload, summary: `New note: "${label}"` });
    }
    if (!args.noteId) return fail("noteId is required for edit");
    const r = await owned("journal").eq("id", args.noteId).maybeSingle();
    if (!r.data) return fail("no note with id " + args.noteId);
    const patch: Record<string, unknown> = {};
    if (args.text !== undefined) patch.text = args.text;
    if (args.title !== undefined) patch.title = args.title || null;
    if (args.date !== undefined) patch.date = args.date;
    if (args.areas !== undefined) patch.categories = args.areas;
    if (args.noteType !== undefined) patch.note_type = args.noteType;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.timeOfDay !== undefined) patch.time_of_day = args.timeOfDay || null;
    if (!Object.keys(patch).length) return fail("nothing to change — pass at least one field");
    const label = r.data.title || String(r.data.text || "").slice(0, 40);
    return fileProposal({ ...args, kind: "note", op: "edit", targetId: args.noteId, payload: patch,
      summary: `Edit note "${label}": ${Object.keys(patch).join(", ")}` });
  },
}, "agent");

tool("propose_metric", {
  description:
    "Propose logging a tracker value for a day (weight, steps…). The variable must exist — see get_tracker for ids. Re-logging the same day overwrites once approved.",
  inputSchema: z.object({
    ...AGENT_ENVELOPE,
    variableId: z.string(),
    value: z.string().describe('the value as text, e.g. "7400" or "true"'),
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
  }),
  handler: async (args: any) => {
    const v = await owned("tracker_variables").eq("id", args.variableId).maybeSingle();
    if (!v.data) return fail("no tracker variable with id " + args.variableId);
    const date = args.date || todayUTC();
    return fileProposal({ ...args, kind: "metric", op: "create",
      payload: { date, variable_id: args.variableId, value: args.value },
      summary: `Log ${v.data.name}: ${args.value}${v.data.unit ? " " + v.data.unit : ""} on ${fmtDay(date)}` });
  },
}, "agent");

tool("propose_scenario", {
  description:
    "Propose adding a scenario (one plausible future) to a decision — an action flagged as a decision, see list_decisions. Weight advantages/disadvantages 1-5 by how much they MATTER. Pass parentScenarioId to branch from an existing scenario. Placed on the canvas when approved.",
  inputSchema: z.object({
    ...AGENT_ENVELOPE,
    actionId: z.string().describe("the decision's action id"),
    title: z.string(),
    notes: z.string().optional(),
    advantages: z.array(WEIGHT_ENTRY).optional(),
    disadvantages: z.array(WEIGHT_ENTRY).optional(),
    parentScenarioId: z.string().optional(),
  }),
  handler: async (args: any) => {
    const decision = await targetTitle("actions", args.actionId);
    if (decision === null) return fail("no action with id " + args.actionId);
    if (args.parentScenarioId) {
      const parent = await owned("action_scenarios").eq("id", args.parentScenarioId).maybeSingle();
      if (!parent.data || parent.data.action_id !== args.actionId) return fail("parentScenarioId must be a scenario of the same decision");
    }
    const payload = {
      action_id: args.actionId, title: args.title, notes: args.notes || "",
      advantages: normalizeWeights(args.advantages), disadvantages: normalizeWeights(args.disadvantages), links: [],
    };
    return fileProposal({ ...args, kind: "scenario", op: "create", payload,
      meta: { parentScenarioId: args.parentScenarioId || null },
      summary: `New scenario for "${decision}": "${args.title}" (net ${scenarioNetScore(payload) >= 0 ? "+" : ""}${scenarioNetScore(payload)})` });
  },
}, "agent");

tool("post_report", {
  description:
    "Post a report to the user's Inbox — a morning brief, a digest, a run summary, or an alert. Markdown body. Reports are informational and need no approval; to change the planner, use the propose_* tools.",
  inputSchema: z.object({
    agent: AGENT_ENVELOPE.agent,
    runId: AGENT_ENVELOPE.runId,
    kind: z.enum(["brief", "digest", "summary", "alert"]).optional().describe("defaults to summary"),
    title: z.string(),
    body: z.string().describe("Markdown"),
  }),
  handler: async (args: any) => {
    const { data, error } = await db.from("agent_reports").insert({
      user_id: OWNER, agent: args.agent, client: "agent-pgm", run_id: args.runId || null,
      kind: args.kind || "summary", title: args.title, body_md: args.body,
    }).select().single();
    if (error) return fail(error.message + PROPOSAL_HINT);
    return ok({ ok: true, reportId: data.id });
  },
}, "agent");

tool("list_proposals", {
  description:
    "Proposals agents have filed and what the user decided. Agents: check this before re-proposing, and learn from what gets rejected.",
  inputSchema: z.object({
    status: z.enum(["pending", "approved", "rejected"]).optional(),
    agent: z.string().optional(),
    limit: z.number().optional().describe("max rows (default 50)"),
  }),
  handler: async (args: { status?: string; agent?: string; limit?: number }) => {
    let q = owned("agent_proposals").order("created_at", { ascending: false });
    if (args.status) q = q.eq("status", args.status);
    if (args.agent) q = q.eq("agent", args.agent);
    q = q.limit(args.limit && args.limit > 0 ? args.limit : 50);
    const { data, error } = await q;
    if (error) return fail(error.message + PROPOSAL_HINT);
    return ok((data || []).map((p) => ({
      id: p.id, agent: p.agent, kind: p.kind, op: p.op, summary: p.summary, reason: p.reason,
      status: p.status, externalId: p.external_id, runId: p.run_id, resultId: p.result_id,
      createdAt: p.created_at, decidedAt: p.decided_at,
    })));
  },
}, "both");

tool("list_agent_reports", {
  description: "Reports agents have posted to the Inbox — briefs, digests, run summaries, alerts — newest first.",
  inputSchema: z.object({
    agent: z.string().optional(),
    unreadOnly: z.boolean().optional(),
    limit: z.number().optional().describe("max rows (default 20)"),
    includeArchived: z.boolean().optional().describe("also return archived reports (default false)"),
  }),
  handler: async (args: { agent?: string; unreadOnly?: boolean; limit?: number; includeArchived?: boolean }) => {
    let q = owned("agent_reports").order("created_at", { ascending: false });
    if (args.agent) q = q.eq("agent", args.agent);
    if (args.unreadOnly) q = q.is("read_at", null);
    q = q.limit(args.limit && args.limit > 0 ? args.limit : 20);
    const { data, error } = await q;
    if (error) return fail(error.message + PROPOSAL_HINT);
    return ok((data || []).filter((r) => args.includeArchived || !r.archived_at).map((r) => ({
      id: r.id, agent: r.agent, kind: r.kind, title: r.title, body: r.body_md,
      runId: r.run_id, read: !!r.read_at, createdAt: r.created_at,
    })));
  },
}, "both");

// ============================ AGENT MEMORY ==================================
// The agents' own knowledge base (agent_memory), shown on the app's Memory page. Unlike proposals,
// writes here are direct: it's the agents' space and doesn't change the user's planner. Entries are
// keyed by a stable id the agent chooses, so saving the same thing twice updates one entry instead of
// accumulating near-duplicates. Agents can archive but never delete. Available to both tokens — from
// Cowork, memory_save is "remember this", and entries are attributed to "claude".
const MEMORY_HINT = " (has migration_agent_memory.sql been run?)";
// deno-lint-ignore no-explicit-any
function memoryOut(r: any, full: boolean) {
  const body = String(r.body_md || "");
  return {
    id: r.id, key: r.key, title: r.title, topic: r.topic, tags: r.tags || [],
    kind: memoryKind(r), section: memorySection(r),
    contributors: r.contributors || [], pinned: !!r.pinned, archived: !!r.archived_at,
    createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at,
    ...(full ? { body, sources: r.sources || [] } : { excerpt: body.length > 280 ? body.slice(0, 280) + "…" : body }),
  };
}
// How the knowledge base is organised. Agent PgM's bots key their entries by namespace:
//   area/<area>/status   an area's current status (rewritten each run)
//   area/<area>/journal  the area's running log (appended)
//   project/<slug>       a project dossier (and project/<slug>-<facet>)
//   person/<slug>        what the agents know about someone
// Anything else is a fact/note under its topic. The same rules drive the app's Agent Memory page.
// deno-lint-ignore no-explicit-any
function memoryKind(r: any): string {
  const key = String(r.key || "");
  if (/^area\/[^/]+\/status$/.test(key)) return "status";
  if (/^area\/[^/]+\/journal$/.test(key)) return "journal";
  if (key.startsWith("project/")) return "project";
  if (key.startsWith("person/")) return "person";
  return "fact";
}
const MEMORY_AREAS: readonly string[] = CATEGORIES;
// deno-lint-ignore no-explicit-any
function memorySection(r: any): string {
  const kind = memoryKind(r);
  if (kind === "person") return "People";
  if (kind === "project") return "Projects";
  if (kind === "status" || kind === "journal" || MEMORY_AREAS.includes(r.topic)) return "Areas";
  if (r.created_by === "me" || r.created_by === "claude") return "From you";
  return "Topics";
}
// Keeps the version an entry is about to lose (best effort: without migration_agent_memory_history.sql
// the save still goes through, just without history). Trims each entry's history to the newest 50.
// deno-lint-ignore no-explicit-any
async function keepRevision(existing: any, replacedBy: string) {
  const { error } = await db.from("agent_memory_revisions").insert({
    user_id: OWNER, memory_id: existing.id, title: existing.title, body_md: existing.body_md || "",
    topic: existing.topic || "General", tags: existing.tags || [], written_by: existing.updated_by || "me",
    written_at: existing.updated_at || null, replaced_by: replacedBy,
  });
  if (error) return;
  const { data } = await db.from("agent_memory_revisions").select("id").eq("memory_id", existing.id)
    .eq("user_id", OWNER).order("created_at", { ascending: false }).range(50, 500);
  if (data && data.length) await db.from("agent_memory_revisions").delete().in("id", data.map((r) => r.id));
}
// deno-lint-ignore no-explicit-any
function whoFor(args: any, role: "owner" | "agent"): string {
  return role === "agent" ? String(args.agent || "agent") : "claude";
}
// deno-lint-ignore no-explicit-any
async function memorySave(args: any, who: string) {
  const now = new Date().toISOString();
  const source = (args.runId || args.sourceRef)
    ? [{ agent: who, runId: args.runId || null, ref: args.sourceRef || null, at: now }] : [];
  let existing = null;
  if (args.key) {
    const r = await owned("agent_memory").eq("key", args.key).maybeSingle();
    if (r.error) return fail(r.error.message + MEMORY_HINT);
    existing = r.data;
  }
  if (!existing) {
    if (!args.title) return fail("title is required for a new entry");
    const { data, error } = await db.from("agent_memory").insert({
      user_id: OWNER, key: args.key || null, title: args.title, body_md: args.body || "",
      topic: args.topic || "General", tags: args.tags || [], contributors: [who], sources: source,
      created_by: who, updated_by: who, created_at: now, updated_at: now,
    }).select().single();
    if (error) {
      if ((error as { code?: string }).code === "23505") return fail("an entry with key '" + args.key + "' was just created — save again to update it");
      return fail(error.message + MEMORY_HINT);
    }
    return ok({ ok: true, status: "created", id: data.id, key: data.key });
  }
  const append = args.mode === "append";
  const stamp = now.slice(0, 10);
  const body = append
    ? (existing.body_md ? existing.body_md + "\n\n" : "") + "**" + stamp + " · " + who + "** — " + (args.body || "")
    : (args.body !== undefined ? args.body : existing.body_md);
  const contributors: string[] = existing.contributors || [];
  const patch: Record<string, unknown> = {
    body_md: body,
    contributors: contributors.includes(who) ? contributors : contributors.concat([who]),
    sources: (existing.sources || []).concat(source).slice(-50),
    updated_by: who, updated_at: now,
  };
  if (args.title !== undefined) patch.title = args.title;
  if (args.topic !== undefined) patch.topic = args.topic;
  if (args.tags !== undefined) patch.tags = args.tags;
  // A real change to the text loses the old version, so keep it first (appends extend the log instead).
  if (!append && (body !== existing.body_md || (args.title !== undefined && args.title !== existing.title))) await keepRevision(existing, who);
  const { error } = await db.from("agent_memory").update(patch).eq("id", existing.id).eq("user_id", OWNER);
  if (error) return fail(error.message);
  // An entry the user archived stays archived — a bot re-saving it shouldn't overrule that. The
  // flag tells the bot so it can stop writing to it.
  return ok({ ok: true, status: append ? "appended" : "updated", id: existing.id, key: existing.key, archived: !!existing.archived_at });
}
const MEMORY_SAVE_SCHEMA = {
  key: z.string().max(200).optional().describe("stable id you choose, e.g. 'apartment/oranienstr-12' — saving again under it updates that entry. Omit only for one-off notes."),
  title: z.string().max(300).optional().describe("required when creating"),
  body: z.string().max(50000).optional().describe("Markdown"),
  mode: z.enum(["replace", "append"]).optional().describe("replace (default) overwrites the body; append adds a dated paragraph — use for running logs"),
  topic: z.string().max(80).optional().describe("grouping shown on the Memory page, e.g. 'Apartments', 'People'. Reuse existing topics (see memory_topics) rather than inventing near-synonyms."),
  tags: z.array(z.string().max(40)).max(20).optional().describe("replaces the existing tags"),
  sourceRef: z.string().max(500).optional().describe("where this came from — an email message-id, a URL, a calendar UID"),
};
tool("memory_save", {
  description:
    "Save something worth remembering to the agents' knowledge base (the app's Memory page). Writes directly — no approval needed. Use a stable key so repeated saves update one entry; use mode='append' for running logs. This is for knowledge, not tasks: to change the user's planner, use the propose_* tools.",
  inputSchema: z.object({ agent: AGENT_ENVELOPE.agent, runId: AGENT_ENVELOPE.runId, ...MEMORY_SAVE_SCHEMA }),
  handler: async (args: any) => memorySave(args, whoFor(args, "agent")),
}, "agent");
tool("memory_save", {
  description:
    "Save something to the agents' knowledge base (the app's Memory page) — 'remember this'. Use a stable key so a later save updates the same entry. Attributed to 'claude'.",
  inputSchema: z.object({ ...MEMORY_SAVE_SCHEMA }),
  handler: async (args: any) => memorySave(args, whoFor(args, "owner")),
}, "owner");

// The user's own memories reach the planner as notes (add_note from Claude, or written in the app).
// "Keepers" are the ones meant to be remembered: everything Claude saved, plus reference notes.
// Decision notes are no part of the memory (left out of keepers and of memory_search).
// notes. Searches can cover all notes; the overview counts the keepers.
// deno-lint-ignore no-explicit-any
const isKeeperNote = (n: any) => n.note_type !== "decision" && (n.source === "claude" || n.note_type === "reference");
// deno-lint-ignore no-explicit-any
function noteMemoryOut(n: any) {
  const text = String(n.text || "");
  return {
    from: "your_note", id: n.id, title: n.title || text.split("\n")[0].slice(0, 80), date: n.date,
    noteType: n.note_type || "reflection", areas: n.categories || [], viaClaude: n.source === "claude",
    excerpt: text.length > 280 ? text.slice(0, 280) + "…" : text,
  };
}

tool("memory_search", {
  description:
    "Search the memory: the agents' knowledge base (what the Agent PgM bots keep — area status and journals, project dossiers, people, facts) and, by default, the user's own notes. Returns excerpts, newest first, each marked from:'agent_memory' or from:'your_note' — call memory_get for a full entry (or list_notes for a note). Start with memory_overview if you don't know what's there.",
  inputSchema: z.object({
    query: z.string().optional().describe("case-insensitive match on title and text (all words must match)"),
    topic: z.string().optional().describe("an area or topic, e.g. 'Health'"),
    kind: z.enum(["status", "journal", "project", "person", "fact"]).optional(),
    tag: z.string().optional(),
    includeNotes: z.boolean().optional().describe("also search the user's notes (default true)"),
    includeArchived: z.boolean().optional(),
    limit: z.number().optional().describe("max rows (default 20)"),
  }),
  handler: async (args: { query?: string; topic?: string; kind?: string; tag?: string; includeNotes?: boolean; includeArchived?: boolean; limit?: number }) => {
    let q = owned("agent_memory").order("updated_at", { ascending: false }).limit(1000);
    if (args.topic) q = q.eq("topic", args.topic);
    const { data, error } = await q;
    if (error) return fail(error.message + MEMORY_HINT);
    const words = (args.query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const hits = (text: string) => words.every((w) => text.includes(w));
    const limit = args.limit && args.limit > 0 ? args.limit : 20;
    const rows = (data || []).filter((r) =>
      (args.includeArchived || !r.archived_at) &&
      (!args.kind || memoryKind(r) === args.kind) &&
      (!args.tag || (r.tags || []).includes(args.tag)) &&
      (!words.length || hits((r.title + "\n" + r.body_md + "\n" + (r.tags || []).join(" ")).toLowerCase())));
    // deno-lint-ignore no-explicit-any
    const out: any[] = rows.slice(0, limit).map((r) => ({ from: "agent_memory", ...memoryOut(r, false) }));
    // Notes have no kind or tags, so a kind/tag filter means "agent memory only".
    if (args.includeNotes !== false && !args.kind && !args.tag && (words.length || args.topic)) {
      const notes = await owned("journal").order("date", { ascending: false }).limit(3000);
      if (!notes.error) {
        const found = (notes.data || []).filter((n) => n.note_type !== "decision" &&
          (!args.topic || (n.categories || []).includes(args.topic)) &&
          (!words.length || hits(((n.title || "") + "\n" + (n.text || "")).toLowerCase())));
        out.push(...found.slice(0, limit).map(noteMemoryOut));
      }
    }
    return ok(out);
  },
}, "both");

tool("memory_overview", {
  description:
    "The map of the memory — start here. Everything the agents keep, organised the way the app's Agent Memory page shows it: Areas (each area's status and journal), Projects, People, other Topics, and what the user added themselves; plus the latest changes and how many of the user's notes are keepers. Each entry is listed by key and title only — use memory_get for its content.",
  inputSchema: z.object({ includeArchived: z.boolean().optional() }),
  handler: async (args: { includeArchived?: boolean }) => {
    const { data, error } = await owned("agent_memory").order("updated_at", { ascending: false }).limit(2000);
    if (error) return fail(error.message + MEMORY_HINT);
    const rows = (data || []).filter((r) => args.includeArchived || !r.archived_at);
    // section -> topic -> entries
    const tree: Record<string, Record<string, unknown[]>> = {};
    for (const r of rows) {
      const s = memorySection(r);
      ((tree[s] ||= {})[r.topic] ||= []).push({ key: r.key, id: r.id, title: r.title, kind: memoryKind(r), updatedAt: r.updated_at, updatedBy: r.updated_by, pinned: !!r.pinned });
    }
    const order = ["Areas", "Projects", "People", "Topics", "From you"];
    const writers: Record<string, number> = {};
    rows.forEach((r) => (r.contributors || []).forEach((c: string) => { writers[c] = (writers[c] || 0) + 1; }));
    const notes = await db.from("journal").select("id,source,note_type").eq("user_id", OWNER).limit(5000);
    return ok({
      entries: rows.length,
      sections: order.filter((s) => tree[s]).map((s) => ({
        section: s,
        topics: Object.entries(tree[s]).sort((a, b) => a[0].localeCompare(b[0])).map(([topic, entries]) => ({ topic, entries })),
      })),
      writers: Object.entries(writers).sort((a, b) => b[1] - a[1]).map(([name, entries]) => ({ name, entries })),
      latest: rows.slice(0, 10).map((r) => ({ key: r.key, title: r.title, updatedBy: r.updated_by, updatedAt: r.updated_at })),
      yourNotes: notes.error ? null : { total: (notes.data || []).length, keepers: (notes.data || []).filter(isKeeperNote).length, hint: "search them with memory_search, or list_notes" },
    });
  },
}, "both");

tool("memory_get", {
  description: "One memory entry in full — body, sources and who contributed. Look it up by key or id. history=true adds the earlier versions (an entry like 'Health · status' is rewritten every run, so this is how to see how things changed).",
  inputSchema: z.object({ key: z.string().optional(), id: z.string().optional(), history: z.boolean().optional().describe("include earlier versions, newest first (max 50)") }),
  handler: async (args: { key?: string; id?: string; history?: boolean }) => {
    if (!args.key && !args.id) return fail("pass key or id");
    let q = owned("agent_memory");
    q = args.key ? q.eq("key", args.key) : q.eq("id", args.id);
    const { data, error } = await q.maybeSingle();
    if (error) return fail(error.message + MEMORY_HINT);
    if (!data) return fail("no entry with " + (args.key ? "key " + args.key : "id " + args.id));
    // deno-lint-ignore no-explicit-any
    const out: any = memoryOut(data, true);
    if (args.history) {
      const h = await owned("agent_memory_revisions").eq("memory_id", data.id).order("created_at", { ascending: false }).limit(50);
      out.history = h.error ? { unavailable: "run migration_agent_memory_history.sql to keep versions" }
        : (h.data || []).map((v) => ({ title: v.title, body: v.body_md, topic: v.topic, writtenBy: v.written_by, writtenAt: v.written_at, replacedBy: v.replaced_by, replacedAt: v.created_at }));
    }
    return ok(out);
  },
}, "both");

tool("memory_topics", {
  description: "The topics the knowledge base is organised under, with how many entries each holds. Check this before choosing a topic so entries don't scatter across near-synonyms.",
  inputSchema: z.object({}),
  handler: async () => {
    const { data, error } = await owned("agent_memory");
    if (error) return fail(error.message + MEMORY_HINT);
    const counts: Record<string, number> = {};
    (data || []).filter((r) => !r.archived_at).forEach((r) => { counts[r.topic] = (counts[r.topic] || 0) + 1; });
    return ok(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([topic, entries]) => ({ topic, entries })));
  },
}, "both");

tool("memory_archive", {
  description: "Archive a knowledge-base entry that's no longer true or useful (or restore one with archived=false). Archived entries are hidden but kept; nothing is ever deleted from here.",
  inputSchema: z.object({ key: z.string().optional(), id: z.string().optional(), archived: z.boolean().optional().describe("defaults to true") }),
  handler: async (args: { key?: string; id?: string; archived?: boolean }) => {
    if (!args.key && !args.id) return fail("pass key or id");
    let q = owned("agent_memory");
    q = args.key ? q.eq("key", args.key) : q.eq("id", args.id);
    const found = await q.maybeSingle();
    if (found.error) return fail(found.error.message + MEMORY_HINT);
    if (!found.data) return fail("no such entry");
    const archived = args.archived === undefined ? true : args.archived;
    const { error } = await db.from("agent_memory").update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("id", found.data.id).eq("user_id", OWNER);
    if (error) return fail(error.message);
    return ok({ ok: true, archived });
  },
}, "both");

// ---- HTTP wiring -----------------------------------------------------------
// ==== V2-BEGIN ====
// ============================ COMMAND CENTER: UNIFIED ITEMS ============================
// One way to read and change anything with a time or a done state. An item is either a row in
// `actions` (kind task | deadline | block) or a row in `events` (kind event); the tools find the
// right table from the id. Every write returns the full item afterwards. Nothing is ever deleted:
// archive_item / restore_item hide and bring back. Writes run as the service role, so the activity
// log records them with author "claude" and Today's "What Claude changed" feed shows them.
const ITEM_KINDS = ["task", "event", "deadline", "block"] as const;
const ITEM_STATUS = ["open", "done", "archived", "someday"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hhmm = (t: string | null | undefined) => t ? String(t).slice(0, 5) : null;
const minsToHHMM = (m: number) => String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
// deno-lint-ignore no-explicit-any
async function itemFind(id: string): Promise<{ table: "actions" | "events"; row: any } | null> {
  if (!UUID_RE.test(String(id || ""))) return null;
  const a = await db.from("actions").select("*").eq("id", id).eq("user_id", OWNER).maybeSingle();
  if (a.data) return { table: "actions", row: a.data };
  const e = await db.from("events").select("*").eq("id", id).eq("user_id", OWNER).maybeSingle();
  return e.data ? { table: "events", row: e.data } : null;
}
// ids → still open (not done, not archived), to tell whether an item is blocked
async function itemOpenSet(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>(); if (!ids.length) return out;
  const r = await db.from("actions").select("id,done,archived_at,recurrence").eq("user_id", OWNER).in("id", ids.slice(0, 500));
  for (const x of r.data || []) if (!x.archived_at && (x.recurrence || !x.done)) out.add(x.id);
  return out;
}
// deno-lint-ignore no-explicit-any
function itemOut(row: any, table: string, openDeps?: Set<string>) {
  const kind = ccKind(row, table), hasDone = kind === "task" || kind === "deadline";
  const start = hhmm(row.time_of_day), dur = row.duration_minutes || null, deps = table === "actions" ? (row.dependencies || []).map((d: { id: string }) => d.id) : [];
  return {
    id: row.id, kind, title: row.title, notes: row.notes_md || "",
    area: row.category || null, secondaryAreas: row.secondary_categories || [],
    goalId: table === "actions" && row.parent_type === "goal" ? row.parent_id : null,
    projectId: table === "actions" && row.parent_type === "project" ? row.parent_id : null,
    priority: table === "actions" ? row.priority : null,
    status: row.archived_at ? "archived" : row.someday ? "someday" : hasDone && !row.recurrence && row.done ? "done" : "open",
    date: row.date || null, start, end: start && dur ? minsToHHMM((ccMins(start) as number) + dur) : null, durationMin: dur,
    allDay: !!row.all_day, estimateMin: row.estimate_min || null,
    recurrence: row.recurrence || null, exceptions: row.recurrence_exceptions || [], doneDates: row.recurrence_done || [],
    reminders: row.reminders || [], muted: !!row.muted,
    location: row.location_address || null, people: row.linked_people_ids || [],
    dependsOn: deps, blocked: openDeps ? deps.some((d: string) => openDeps.has(d)) : undefined,
    isFocus: !!row.focus_date, source: row.source || null, dedupeKey: row.dedupe_key || null, createdAt: row.created_at,
  };
}
// deno-lint-ignore no-explicit-any
async function itemOutFull(table: string, id: string): Promise<any> {
  const r = await db.from(table).select("*").eq("id", id).eq("user_id", OWNER).maybeSingle();
  if (!r.data) return null;
  const deps = table === "actions" ? (r.data.dependencies || []).map((d: { id: string }) => d.id) : [];
  return itemOut(r.data, table, await itemOpenSet(deps));
}
const ITEM_FIELDS = {
  title: z.string().min(1).max(300).optional(),
  notes: z.string().max(20000).optional().describe("Markdown notes"),
  area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE),
  secondary_areas: z.array(z.enum(AREA_INPUT)).max(7).optional(),
  goal_id: z.string().nullable().optional().describe("attach to a goal (tasks, deadlines and blocks only)"),
  project_id: z.string().nullable().optional().describe("attach to a project (wins over goal_id)"),
  priority: z.enum(PRIORITIES).optional().describe("P0 most urgent … P3; tasks, deadlines and blocks only (default P2)"),
  date: z.string().nullable().optional().describe("YYYY-MM-DD; null or omit for the backlog. For a repeating item: the first occurrence"),
  start: z.string().nullable().optional().describe("HH:MM 24h start time"),
  end: z.string().nullable().optional().describe("HH:MM 24h end time (sets duration_min)"),
  duration_min: z.number().int().min(1).max(1440).nullable().optional(),
  all_day: z.boolean().optional(),
  estimate_min: z.number().int().min(1).max(1440).nullable().optional().describe("how long a task should take"),
  recurrence: z.string().max(200).nullable().optional().describe(CC_RULE_HELP),
  exceptions: z.array(z.string().regex(CC_DAY)).max(400).optional().describe("dates left out of a repeating item"),
  reminders: z.array(z.number().int().min(0).max(40320)).max(5).optional().describe("minutes before the start: 0, 10, 30, 60, 1440 …"),
  muted: z.boolean().optional(),
  location: z.string().max(300).nullable().optional().describe("address or place name; geocoded for the Location map"),
  people: z.array(z.string()).max(30).optional().describe("person ids from list_people"),
  depends_on: z.array(z.string()).max(30).optional().describe("ids of tasks that must be done first"),
  source: z.string().max(40).optional().describe("who made it: claude (default), me, agent, google"),
};
// Build the table row from the tool input. Returns { row } or { error }.
// deno-lint-ignore no-explicit-any
async function itemRow(a: any, table: "actions" | "events", existing?: any): Promise<{ row?: Record<string, unknown>; error?: string }> {
  const row: Record<string, unknown> = {};
  if (a.date && !CC_DAY.test(a.date)) return { error: "date must be YYYY-MM-DD" };
  for (const k of ["start", "end"]) if (a[k] && !CC_TIME.test(a[k])) return { error: k + " must be HH:MM (24h)" };
  if (a.recurrence && !ccRule(a.recurrence)) return { error: CC_RULE_HELP };
  const date = a.date !== undefined ? a.date : existing ? existing.date : null;
  if (a.recurrence && !date) return { error: "a repeating item needs a first date" };
  if (a.title !== undefined) row.title = a.title.trim();
  if (a.notes !== undefined) row.notes_md = a.notes;
  if (a.area !== undefined) row.category = a.area || null;
  if (a.secondary_areas !== undefined) row.secondary_categories = a.secondary_areas;
  if (a.date !== undefined) row.date = a.date || null;
  if (a.start !== undefined) row.time_of_day = a.start || null;
  const start = a.start !== undefined ? a.start : existing ? hhmm(existing.time_of_day) : null;
  if (a.end) { if (!start) return { error: "end needs a start time" }; const d = (ccMins(a.end) as number) - (ccMins(start) as number); if (d <= 0) return { error: "end must be after start" }; row.duration_minutes = d; }
  else if (a.duration_min !== undefined) row.duration_minutes = a.duration_min || null;
  if (a.all_day !== undefined) row.all_day = a.all_day;
  if (a.recurrence !== undefined) row.recurrence = a.recurrence || null;
  if (a.exceptions !== undefined) row.recurrence_exceptions = a.exceptions;
  if (a.reminders !== undefined) row.reminders = Array.from(new Set(a.reminders as number[])).sort((x, y) => x - y);
  if (a.muted !== undefined) row.muted = a.muted;
  if (a.people !== undefined) row.linked_people_ids = a.people;
  if (a.source !== undefined) row.source = a.source;
  if (a.dedupe_key !== undefined) row.dedupe_key = a.dedupe_key || null;
  if (a.location !== undefined) {
    if (!a.location) { row.location_address = null; row.location_lat = null; row.location_lng = null; }
    else { const p = await resolvePlace({ address: a.location }); if (p.error) return { error: p.error }; row.location_address = p.address; row.location_lat = p.lat; row.location_lng = p.lng; }
  }
  if (table === "actions") {
    if (a.kind !== undefined) { row.kind = a.kind; row.is_milestone = a.kind === "deadline"; }
    if (a.priority !== undefined) row.priority = a.priority;
    if (a.estimate_min !== undefined) row.estimate_min = a.estimate_min || null;
    if (a.project_id) { const p = await owned("projects").eq("id", a.project_id).maybeSingle(); if (!p.data) return { error: "no project with that id" }; row.parent_type = "project"; row.parent_id = a.project_id; }
    else if (a.goal_id) { const g = await owned("goals").eq("id", a.goal_id).maybeSingle(); if (!g.data) return { error: "no goal with that id" }; row.parent_type = "goal"; row.parent_id = a.goal_id; }
    else if (a.project_id === null || a.goal_id === null) { row.parent_type = "none"; row.parent_id = null; }
    if (a.depends_on !== undefined) {
      const ids = (a.depends_on as string[]).filter((x) => !existing || x !== existing.id);
      const found = await itemOpenSet(ids), all = await db.from("actions").select("id").eq("user_id", OWNER).in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
      const known = new Set((all.data || []).map((x) => x.id)), bad = ids.filter((x) => !known.has(x));
      if (bad.length) return { error: "depends_on: not a task id: " + bad.join(", ") };
      void found; row.dependencies = ids.map((id) => ({ id, requiresDone: true }));
    }
  } else {
    for (const k of ["priority", "estimate_min", "goal_id", "project_id", "depends_on"]) if (a[k] !== undefined && a[k] !== null) return { error: k + " does not apply to an event" };
  }
  return { row };
}
// deno-lint-ignore no-explicit-any
function statusPatch(status: string, row: any, table: string): Record<string, unknown> | string {
  const p: Record<string, unknown> = {};
  if (status === "archived") { p.archived_at = row.archived_at || new Date().toISOString(); return p; }
  p.archived_at = null;
  if (table === "events") { if (status === "done" || status === "someday") return "an event has no " + status + " state"; return p; }
  if (status === "someday") { p.someday = true; p.date = null; p.time_of_day = null; }
  else if (status === "done") { if (row.recurrence) return "a repeating task is ticked off per date: use set_done (kind item) with the date"; p.done = true; p.someday = false; }
  else { p.done = false; p.someday = false; }
  return p;
}
// deno-lint-ignore no-explicit-any
async function itemCreate(a: any): Promise<{ item?: any; created?: boolean; error?: string }> {
  const kind = a.kind || "task", table = kind === "event" ? "events" : "actions";
  if (!a.title) return { error: "title is required" };
  // re-sent? update the one that is already there instead of adding a second
  // deno-lint-ignore no-explicit-any
  let dup: any = null;
  if (a.dedupe_key) { const d = await db.from(table).select("*").eq("user_id", OWNER).eq("dedupe_key", a.dedupe_key).is("archived_at", null).limit(1); dup = d.data && d.data[0]; }
  if (!dup) dup = await ccExisting(table, a.title, a.date || null, kind);
  const built = await itemRow({ ...a, kind }, table, dup || undefined);
  if (built.error) return { error: built.error };
  if (dup) {
    const up = await safeWrite((p) => db.from(table).update(p).eq("id", dup.id).eq("user_id", OWNER), built.row!);
    if (up.error) return { error: up.error.message };
    return { item: await itemOutFull(table, dup.id), created: false };
  }
  const row: Record<string, unknown> = { user_id: OWNER, source: "claude", ...built.row };
  if (table === "actions") Object.assign(row, { kind, priority: a.priority || "P2", type: "Task", done: false, parent_type: row.parent_type || "none", parent_id: row.parent_id || null, someday: a.status === "someday" });
  if (a.status === "someday" && table === "actions") { row.date = null; row.time_of_day = null; }
  const ins = await safeWrite((p) => db.from(table).insert(p).select("id").single(), row);
  if (ins.error) return { error: ins.error.message };
  return { item: await itemOutFull(table, ins.data.id), created: true };
}
// deno-lint-ignore no-explicit-any
async function itemEdit(id: string, a: any): Promise<{ item?: any; error?: string }> {
  const f = await itemFind(id); if (!f) return { error: "no item with that id (use list with kind items, or search_items)" };
  if (a.kind && (a.kind === "event") !== (f.table === "events")) return { error: "an event and a task are stored differently and cannot be converted; create a new item with create_item and archive this one" };
  const built = await itemRow(a, f.table, f.row); if (built.error) return { error: built.error };
  const patch = built.row!;
  if (a.status) { const sp = statusPatch(a.status, f.row, f.table); if (typeof sp === "string") return { error: sp }; Object.assign(patch, sp); }
  if (a.date && f.table === "actions" && patch.someday === undefined && f.row.someday) patch.someday = false;
  if (!Object.keys(patch).length) return { error: "nothing to change: pass at least one field" };
  const up = await safeWrite((p) => db.from(f.table).update(p).eq("id", id).eq("user_id", OWNER), patch);
  if (up.error) return { error: up.error.message };
  return { item: await itemOutFull(f.table, id) };
}
const ITEM_ID = z.string().describe("item id (from list kind=items, search_items, plan_day …)");
const itemResult = (r: { item?: unknown; error?: string; created?: boolean }) => r.error ? fail(r.error) : ok(r.created === undefined ? { ok: true, item: r.item } : { ok: true, created: r.created, alreadyExisted: !r.created, item: r.item });

tool("create_item", {
  description: "Create anything with a time or a done state, in one tool. kind: task (something to tick off, default), event (happens at a time, no done state), deadline (a date something is due), block (time reserved: gym, deep work). Use this instead of create_action / create_event, which stay for compatibility. Re-sending the same item (same title + date + kind, or the same dedupe_key) updates it instead of adding a second. Returns the full item.",
  inputSchema: z.object({ kind: z.enum(ITEM_KINDS).optional(), status: z.enum(["open", "someday"]).optional().describe("someday parks a task with no date"), dedupe_key: z.string().max(120).optional().describe("your own stable key for this item, to avoid duplicates on retries"), ...ITEM_FIELDS, title: z.string().min(1).max(300) }),
  handler: async (a: Record<string, unknown>) => itemResult(await itemCreate(a)),
});
tool("edit_item", {
  description: "Change any field of an item (task, event, deadline or block). Only the fields you pass change. status: open | done | archived | someday (done for a repeating task needs set_done (kind item) with a date). To move one date of a repeating item use recurrence (action edit_occurrence) or recurrence (action skip). Returns the full item.",
  inputSchema: z.object({ id: ITEM_ID, kind: z.enum(ITEM_KINDS).optional().describe("task, deadline and block can switch between each other; event cannot"), status: z.enum(ITEM_STATUS).optional(), ...ITEM_FIELDS }),
  handler: async (a: Record<string, unknown>) => { const { id, ...rest } = a; return itemResult(await itemEdit(String(id), rest)); },
});
tool("get_item", {
  description: "One item in full, with whether it is blocked, what waits for it, and (for a repeating item) its next five dates.",
  inputSchema: z.object({ id: ITEM_ID }),
  handler: async (a: { id: string }) => {
    const f = await itemFind(a.id); if (!f) return fail("no item with that id");
    const item = await itemOutFull(f.table, a.id), today = berlinToday();
    const waiting = f.table === "actions" ? ((await owned("actions").is("archived_at", null).contains("dependencies", [{ id: a.id }])).data || []).map((x) => ({ id: x.id, title: x.title })) : [];
    return ok({ item, waitingOnThis: waiting, nextDates: f.row.recurrence ? ccDates(f.row, today, ccAdd(today, 400)).slice(0, 5) : undefined });
  },
});

// deno-lint-ignore no-explicit-any
async function itemsLoad(includeArchived: boolean): Promise<{ rows: { row: any; table: string }[]; error?: string }> {
  let qa = owned("actions"), qe = owned("events");
  if (!includeArchived) { qa = qa.is("archived_at", null); qe = qe.is("archived_at", null); }
  const [a, e] = await Promise.all([qa.limit(5000), qe.limit(5000)]);
  if (a.error) return { rows: [], error: a.error.message };
  return { rows: [...(a.data || []).map((row) => ({ row, table: "actions" })), ...(e.error ? [] : (e.data || []).map((row) => ({ row, table: "events" })))] };
}
tool("list_items", {
  description: "List items with filters. Without from/to it lists items as stored (a repeating item once). With from and to it lists every occurrence in that range, repeating items expanded, sorted by date and time — use that for 'what is on next week'. Default status is open. Use plan_day / plan_week for planning views with free time; search_items for a word search.",
  inputSchema: z.object({
    kind: z.array(z.enum(ITEM_KINDS)).optional(), status: z.enum([...ITEM_STATUS, "any"]).optional().describe("default open"),
    area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE), from: z.string().regex(CC_DAY).optional(), to: z.string().regex(CC_DAY).optional(),
    goal_id: z.string().optional(), project_id: z.string().optional(), source: z.string().optional(),
    recurring: z.boolean().optional().describe("true: only repeating items; false: only one-off items"), blocked: z.boolean().optional().describe("true: only tasks waiting on another task"),
    undated: z.boolean().optional().describe("true: only items with no date (the backlog)"), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional(),
  }),
  // deno-lint-ignore no-explicit-any
  handler: async (a: any) => {
    const status = a.status || "open", L = await itemsLoad(status === "archived" || status === "any");
    if (L.error) return fail(L.error);
    const allDeps = L.rows.flatMap((x) => x.table === "actions" ? (x.row.dependencies || []).map((d: { id: string }) => d.id) : []);
    const openDeps = await itemOpenSet(Array.from(new Set(allDeps)));
    let items = L.rows.map((x) => ({ x, o: itemOut(x.row, x.table, openDeps) }));
    items = items.filter(({ o }) => (status === "any" || o.status === status) && (!a.kind || a.kind.includes(o.kind)) && (!a.area || o.area === a.area || o.secondaryAreas.includes(a.area)) &&
      (!a.goal_id || o.goalId === a.goal_id) && (!a.project_id || o.projectId === a.project_id) && (!a.source || o.source === a.source) &&
      (a.recurring === undefined || !!o.recurrence === a.recurring) && (a.blocked === undefined || !!o.blocked === a.blocked) && (a.undated === undefined || !o.date === a.undated));
    const limit = a.limit || 100, offset = a.offset || 0;
    if (a.from && a.to) {
      if (a.to < a.from) return fail("to must not be before from");
      // deno-lint-ignore no-explicit-any
      const occ: any[] = [];
      for (const { x, o } of items) for (const d of ccDates(x.row, a.from, a.to)) occ.push({ ...o, date: d, occurrenceDone: o.recurrence ? (x.row.recurrence_done || []).includes(d) : undefined });
      occ.sort((p, q) => (p.date + (p.start || "")).localeCompare(q.date + (q.start || "")));
      return ok({ from: a.from, to: a.to, total: occ.length, occurrences: occ.slice(offset, offset + limit) });
    }
    const list = items.map(({ o }) => o).sort((p, q) => String(p.date || "9999").localeCompare(String(q.date || "9999")) || String(p.priority || "P9").localeCompare(String(q.priority || "P9")));
    return ok({ total: list.length, items: list.slice(offset, offset + limit) });
  },
});
tool("search_items", {
  description: "Find items (tasks, events, deadlines, blocks) whose title or notes contain the words. Archived items are included only when asked. For one search across everything (notes, people, knowledge, memory too) use search_everything.",
  inputSchema: z.object({ query: z.string().min(2).max(200), include_archived: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }),
  handler: async (a: { query: string; include_archived?: boolean; limit?: number }) => {
    const like = "%" + a.query.replace(/[%_\\,()]/g, " ").trim() + "%", lim = a.limit || 30;
    let qa = owned("actions").or("title.ilike." + like + ",notes_md.ilike." + like), qe = owned("events").or("title.ilike." + like + ",notes_md.ilike." + like);
    if (!a.include_archived) { qa = qa.is("archived_at", null); qe = qe.is("archived_at", null); }
    const [ra, re] = await Promise.all([qa.limit(lim), qe.limit(lim)]);
    if (ra.error) return fail(ra.error.message);
    const items = [...(ra.data || []).map((r) => itemOut(r, "actions")), ...(re.data || []).map((r) => itemOut(r, "events"))].slice(0, lim);
    return ok({ total: items.length, items });
  },
});

// ---- status ----
async function itemComplete(id: string, done: boolean, date?: string) {
  const f = await itemFind(id); if (!f) return fail("no item with that id");
  if (f.table === "events" || ccKind(f.row, f.table) === "block") return fail("events and time blocks have no done state");
  if (f.row.recurrence) {
    const d = date || berlinToday();
    if (!ccDates(f.row, d, d).length) return fail("this repeating item does not fall on " + d + "; its next dates: " + ccDates(f.row, d, ccAdd(d, 120)).slice(0, 3).join(", "));
    const list: string[] = (f.row.recurrence_done || []).filter((x: string) => x !== d); if (done) list.push(d);
    const up = await db.from("actions").update({ recurrence_done: list }).eq("id", id).eq("user_id", OWNER); if (up.error) return fail(up.error.message);
    return ok({ ok: true, date: d, item: await itemOutFull("actions", id) });
  }
  const up = await db.from("actions").update({ done }).eq("id", id).eq("user_id", OWNER); if (up.error) return fail(up.error.message);
  return ok({ ok: true, item: await itemOutFull("actions", id) });
}
tool("complete_item", {
  description: "Tick a task or deadline off. For a repeating one, pass the date of the occurrence (default today, Berlin); the series stays.",
  inputSchema: z.object({ id: ITEM_ID, date: z.string().regex(CC_DAY).optional() }),
  handler: (a: { id: string; date?: string }) => itemComplete(a.id, true, a.date),
});
tool("uncomplete_item", {
  description: "Undo complete_item: mark a task or deadline (or one date of a repeating one) as not done.",
  inputSchema: z.object({ id: ITEM_ID, date: z.string().regex(CC_DAY).optional() }),
  handler: (a: { id: string; date?: string }) => itemComplete(a.id, false, a.date),
});
tool("archive_item", {
  description: "Hide an item from every list. Nothing is deleted; restore_item brings it back.",
  inputSchema: z.object({ id: ITEM_ID }),
  handler: async (a: { id: string }) => itemResult(await itemEdit(a.id, { status: "archived" })),
});
tool("restore_item", {
  description: "Bring back an archived item (it returns as open).",
  inputSchema: z.object({ id: ITEM_ID }),
  handler: async (a: { id: string }) => itemResult(await itemEdit(a.id, { status: "open" })),
});

// ---- scheduling ----
// Move an item, or one date of a repeating item (skip that date, add a one-off copy on the new day).
// deno-lint-ignore no-explicit-any
async function itemMove(id: string, date: string, time?: string | null, occurrence?: string): Promise<any> {
  const f = await itemFind(id); if (!f) return fail("no item with that id");
  if (!CC_DAY.test(date)) return fail("date must be YYYY-MM-DD");
  if (time && !CC_TIME.test(time)) return fail("time must be HH:MM (24h)");
  const row = f.row, t = time === undefined ? row.time_of_day : (time || null);
  if (row.recurrence && occurrence) {
    if (!ccDates(row, occurrence, occurrence).length) return fail("the item does not fall on " + occurrence);
    const skip = Array.from(new Set([...(row.recurrence_exceptions || []), occurrence]));
    const up = await db.from(f.table).update({ recurrence_exceptions: skip }).eq("id", id).eq("user_id", OWNER); if (up.error) return fail(up.error.message);
    const copy: Record<string, unknown> = { user_id: OWNER, title: row.title, date, time_of_day: t, duration_minutes: row.duration_minutes, category: row.category, secondary_categories: row.secondary_categories || [], notes_md: row.notes_md || "", reminders: row.reminders || [], linked_people_ids: row.linked_people_ids || [], location_address: row.location_address, location_lat: row.location_lat, location_lng: row.location_lng, source: "claude" };
    if (f.table === "actions") Object.assign(copy, { kind: row.kind || "task", priority: row.priority, type: row.type || "Task", parent_type: row.parent_type || "none", parent_id: row.parent_id || null, done: false, estimate_min: row.estimate_min, is_milestone: !!row.is_milestone });
    const ins = await safeWrite((p) => db.from(f.table).insert(p).select("id").single(), copy); if (ins.error) return fail(ins.error.message);
    return ok({ ok: true, movedOneOccurrence: true, from: occurrence, series: await itemOutFull(f.table, id), item: await itemOutFull(f.table, ins.data.id) });
  }
  const patch: Record<string, unknown> = { date, time_of_day: t }; if (f.table === "actions") patch.someday = false;
  const up = await safeWrite((p) => db.from(f.table).update(p).eq("id", id).eq("user_id", OWNER), patch); if (up.error) return fail(up.error.message);
  return ok({ ok: true, item: await itemOutFull(f.table, id) });
}
tool("snooze", {
  description: "Push an item to a later day (default tomorrow, Berlin), keeping its time. For a repeating item pass occurrence_date to snooze just that date. Use reschedule to pick an exact new date and time.",
  inputSchema: z.object({ id: ITEM_ID, until: z.string().regex(CC_DAY).optional(), occurrence_date: z.string().regex(CC_DAY).optional() }),
  handler: (a: { id: string; until?: string; occurrence_date?: string }) => itemMove(a.id, a.until || ccAdd(berlinToday(), 1), undefined, a.occurrence_date),
});
tool("make_someday", {
  description: "Park a task with no date: it leaves the calendar and is never shown as late. schedule_from_backlog brings it back.",
  inputSchema: z.object({ id: ITEM_ID }),
  handler: async (a: { id: string }) => itemResult(await itemEdit(a.id, { status: "someday" })),
});
tool("schedule_from_backlog", {
  description: "Give an undated (backlog or someday) task a date, and optionally a time.",
  inputSchema: z.object({ id: ITEM_ID, date: z.string().regex(CC_DAY), time: z.string().optional() }),
  handler: (a: { id: string; date: string; time?: string }) => itemMove(a.id, a.date, a.time === undefined ? null : a.time),
});

// ---- repeating items ----
const ruleWithout = (rule: string, keys: string[]) => String(rule).replace(/^RRULE:/i, "").split(";").filter((p) => p && !keys.includes(p.split("=")[0].toUpperCase())).join(";");
const untilOf = (d: string) => d.replace(/-/g, "");
tool("set_recurrence", {
  description: "Make an item repeat, or change how it repeats. rule is an RRULE: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with optional INTERVAL, BYDAY (MO,TU,…), BYMONTHDAY, UNTIL, COUNT. Examples: gym Mon/Wed/Fri = FREQ=WEEKLY;BYDAY=MO,WE,FR; rent on the 1st = FREQ=MONTHLY;BYMONTHDAY=1. start_date sets the first occurrence (defaults to the item's date, or today).",
  inputSchema: z.object({ id: ITEM_ID, rule: z.string().min(8).max(200), start_date: z.string().regex(CC_DAY).optional() }),
  handler: async (a: { id: string; rule: string; start_date?: string }) => {
    const f = await itemFind(a.id); if (!f) return fail("no item with that id");
    return itemResult(await itemEdit(a.id, { recurrence: a.rule, date: a.start_date || f.row.date || berlinToday() }));
  },
});
tool("end_recurrence", {
  description: "Stop a repeating item after a date (default today): earlier dates and what was ticked off stay. Pass stop_repeating: true instead to turn it into a single item on its first date.",
  inputSchema: z.object({ id: ITEM_ID, last_date: z.string().regex(CC_DAY).optional(), stop_repeating: z.boolean().optional() }),
  handler: async (a: { id: string; last_date?: string; stop_repeating?: boolean }) => {
    const f = await itemFind(a.id); if (!f) return fail("no item with that id");
    if (!f.row.recurrence) return fail("this item does not repeat");
    if (a.stop_repeating) return itemResult(await itemEdit(a.id, { recurrence: null }));
    const last = a.last_date || berlinToday();
    return itemResult(await itemEdit(a.id, { recurrence: ruleWithout(f.row.recurrence, ["UNTIL", "COUNT"]) + ";UNTIL=" + untilOf(last) }));
  },
});
tool("skip_occurrence", {
  description: "Leave one date out of a repeating item (it simply does not happen that day). Use edit_occurrence to move or change it instead.",
  inputSchema: z.object({ id: ITEM_ID, date: z.string().regex(CC_DAY) }),
  handler: async (a: { id: string; date: string }) => {
    const f = await itemFind(a.id); if (!f) return fail("no item with that id");
    if (!f.row.recurrence) return fail("this item does not repeat; use reschedule (mode snooze or date) or archive (kind item)");
    if (!ccDates(f.row, a.date, a.date).length) return fail("the item does not fall on " + a.date);
    return itemResult(await itemEdit(a.id, { exceptions: Array.from(new Set([...(f.row.recurrence_exceptions || []), a.date])) }));
  },
});
const OCC_CHANGES = z.object({ title: z.string().min(1).max(300).optional(), date: z.string().regex(CC_DAY).optional().describe("move to this day"), start: z.string().nullable().optional(), duration_min: z.number().int().min(1).max(1440).nullable().optional(), notes: z.string().optional(), area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE), location: z.string().nullable().optional(), reminders: z.array(z.number().int().min(0).max(40320)).max(5).optional() });
tool("edit_occurrence", {
  description: "Change a repeating item from one date on. scope: this (only that date: it is skipped in the series and a changed one-off copy is made), this_and_following (the series ends the day before and a changed new series starts on that date), all (the whole series changes). changes can include a new date (moves it), start, duration_min, title, notes, area, location, reminders.",
  inputSchema: z.object({ id: ITEM_ID, date: z.string().regex(CC_DAY).describe("the occurrence being changed"), scope: z.enum(["this", "this_and_following", "all"]), changes: OCC_CHANGES }),
  // deno-lint-ignore no-explicit-any
  handler: async (a: { id: string; date: string; scope: string; changes: any }) => {
    const f = await itemFind(a.id); if (!f) return fail("no item with that id");
    const row = f.row; if (!row.recurrence) return fail("this item does not repeat; use edit_item");
    if (!ccDates(row, a.date, a.date).length) return fail("the item does not fall on " + a.date);
    if (a.scope === "all") return itemResult(await itemEdit(a.id, a.changes));
    const base = itemOut(row, f.table), fields = { kind: base.kind, title: base.title, notes: base.notes, area: base.area || undefined, secondary_areas: base.secondaryAreas, start: base.start, duration_min: base.durationMin, all_day: base.allDay, reminders: base.reminders, muted: base.muted, people: base.people, ...(f.table === "actions" ? { priority: base.priority, estimate_min: base.estimateMin, goal_id: base.goalId, project_id: base.projectId } : {}) };
    // deno-lint-ignore no-explicit-any
    const clean = (o: any) => { for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k]; return o; };
    if (a.scope === "this") {
      const skip = await itemEdit(a.id, { exceptions: Array.from(new Set([...(row.recurrence_exceptions || []), a.date])) }); if (skip.error) return fail(skip.error);
      const made = await itemCreate(clean({ ...fields, ...a.changes, date: a.changes.date || a.date, recurrence: null, location: a.changes.location !== undefined ? a.changes.location : (row.location_address || undefined) }));
      if (made.error) return fail(made.error);
      return ok({ ok: true, scope: "this", series: skip.item, item: made.item });
    }
    const prevDay = ccAdd(a.date, -1), rest = ruleWithout(row.recurrence, ["COUNT"]);
    const end = await itemEdit(a.id, { recurrence: ruleWithout(rest, ["UNTIL"]) + ";UNTIL=" + untilOf(prevDay) }); if (end.error) return fail(end.error);
    const later = (d: string) => d >= a.date;
    const made = await itemCreate(clean({ ...fields, ...a.changes, date: a.changes.date || a.date, recurrence: rest, exceptions: (row.recurrence_exceptions || []).filter(later), location: a.changes.location !== undefined ? a.changes.location : (row.location_address || undefined) }));
    if (made.error) return fail(made.error);
    if (f.table === "actions" && (row.recurrence_done || []).some(later)) await db.from("actions").update({ recurrence_done: (row.recurrence_done || []).filter(later) }).eq("id", made.item.id).eq("user_id", OWNER);
    return ok({ ok: true, scope: "this_and_following", endedSeries: end.item, newSeries: await itemOutFull(f.table, made.item.id) });
  },
});

// ---- reminders ----
tool("set_reminders", {
  description: "Set when the phone reminds about an item: minutes before its start (0 = at the time, 10, 30, 60, 1440 = a day before). An item without a time counts from 09:00. Replaces the existing list; pass [] to remove all.",
  inputSchema: z.object({ id: ITEM_ID, offsets: z.array(z.number().int().min(0).max(40320)).max(5) }),
  handler: async (a: { id: string; offsets: number[] }) => itemResult(await itemEdit(a.id, { reminders: a.offsets })),
});
tool("mute_item", {
  description: "Silence (or, with muted: false, un-silence) all reminders for one item without losing its reminder settings.",
  inputSchema: z.object({ id: ITEM_ID, muted: z.boolean().optional().describe("default true") }),
  handler: async (a: { id: string; muted?: boolean }) => itemResult(await itemEdit(a.id, { muted: a.muted !== false })),
});
tool("list_upcoming_reminders", {
  description: "The reminders due in the next hours (default 48), in Berlin time, with whether they fall in quiet hours (those are skipped, not sent late). Also lists the morning digest and deadline heads-ups that are switched on.",
  inputSchema: z.object({ hours: z.number().int().min(1).max(336).optional() }),
  handler: async (a: { hours?: number }) => {
    const L = await ccLoad(); if (L.error) return fail(L.error);
    const set = await db.from("push_settings").select("*").eq("user_id", OWNER).maybeSingle(), S = { ...PUSH_DEFAULTS, ...(set.data || {}) };
    const t = berlinNow(new Date()), H = (a.hours || 48) * 60, hm = (x: string | null, d: number) => x ? +String(x).slice(0, 2) * 60 + +String(x).slice(3, 5) : d;
    const qf = hm(S.quiet_from, 1380), qt = hm(S.quiet_to, 480), quiet = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return qf === qt ? false : qf < qt ? x >= qf && x < qt : x >= qf || x < qt; };
    const days = Math.ceil((t.nowMin + H) / 1440) + 2, last = ccAdd(t.today, days);
    // deno-lint-ignore no-explicit-any
    const out: any[] = [];
    // deno-lint-ignore no-explicit-any
    const each = (rows: any[], table: string) => { for (const r of rows) { if (r.someday || !(r.reminders || []).length) continue; const kind = ccKind(r, table); for (const d of ccDates(r, t.today, last)) { if (table === "actions" && (kind === "task" || kind === "deadline") && (r.recurrence ? (r.recurrence_done || []).includes(d) : r.done)) continue; const timed = !!r.time_of_day && !r.all_day, start = ccDiff(t.today, d) * 1440 + (timed ? hm(r.time_of_day, 540) : 540); for (const off of r.reminders) { const at = start - Number(off); if (at > t.nowMin && at <= t.nowMin + H) out.push({ at: ccAdd(t.today, Math.floor(at / 1440)) + " " + minsToHHMM(((at % 1440) + 1440) % 1440), id: r.id, title: r.title, kind, offsetMin: Number(off), muted: !!r.muted, inQuietHours: quiet(at), willSend: S.enabled !== false && !r.muted && !quiet(at) }); } } } };
    each(L.actions, "actions"); each(L.events, "events");
    out.sort((p, q) => p.at.localeCompare(q.at));
    return ok({ now: t.today + " " + minsToHHMM(t.nowMin), settings: { enabled: S.enabled !== false, quietFrom: hhmm(S.quiet_from), quietTo: hhmm(S.quiet_to), digestOn: S.digest_on !== false, digestTime: hhmm(S.digest_time), deadlineHeadsUp: S.deadline_on !== false }, reminders: out.slice(0, 200) });
  },
});
tool("get_reminder_settings", {
  description: "Quiet hours, the morning digest time and the deadline heads-up, plus how many devices have reminders switched on.",
  inputSchema: z.object({}),
  handler: async () => {
    const [s, d] = await Promise.all([db.from("push_settings").select("*").eq("user_id", OWNER).maybeSingle(), db.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", OWNER).is("failed_at", null)]);
    if (s.error) return fail(s.error.message + " (run _Memory/migration_push.sql)");
    const S = { ...PUSH_DEFAULTS, ...(s.data || {}) };
    return ok({ enabled: S.enabled !== false, quietFrom: hhmm(S.quiet_from), quietTo: hhmm(S.quiet_to), digestOn: S.digest_on !== false, digestTime: hhmm(S.digest_time), deadlineHeadsUp: S.deadline_on !== false, devices: d.count || 0 });
  },
});
tool("set_reminder_settings", {
  description: "Change quiet hours (nothing is sent between quiet_from and quiet_to), the morning digest (on/off and time) and the deadline heads-up (the evening before, 18:00). Only the fields you pass change.",
  inputSchema: z.object({ enabled: z.boolean().optional().describe("false pauses every reminder"), quiet_from: z.string().optional(), quiet_to: z.string().optional(), digest_on: z.boolean().optional(), digest_time: z.string().optional(), deadline_heads_up: z.boolean().optional() }),
  // deno-lint-ignore no-explicit-any
  handler: async (a: any) => {
    const p: Record<string, unknown> = { user_id: OWNER, updated_at: new Date().toISOString() };
    for (const k of ["quiet_from", "quiet_to", "digest_time"]) if (a[k] !== undefined) { if (!CC_TIME.test(a[k])) return fail(k + " must be HH:MM"); p[k] = a[k]; }
    if (a.enabled !== undefined) p.enabled = a.enabled; if (a.digest_on !== undefined) p.digest_on = a.digest_on; if (a.deadline_heads_up !== undefined) p.deadline_on = a.deadline_heads_up;
    const r = await db.from("push_settings").upsert(p, { onConflict: "user_id" }).select().single();
    if (r.error) return fail(r.error.message + " (run _Memory/migration_push.sql)");
    return ok({ ok: true, enabled: r.data.enabled, quietFrom: hhmm(r.data.quiet_from), quietTo: hhmm(r.data.quiet_to), digestOn: r.data.digest_on, digestTime: hhmm(r.data.digest_time), deadlineHeadsUp: r.data.deadline_on });
  },
});

// ---- dependencies ----
tool("add_dependency", {
  description: "Say that a task has to wait for another task: id waits for depends_on. The waiting task then shows as blocked until the other is done.",
  inputSchema: z.object({ id: ITEM_ID, depends_on: z.string() }),
  handler: async (a: { id: string; depends_on: string }) => {
    if (a.id === a.depends_on) return fail("a task cannot wait for itself");
    const f = await itemFind(a.id), g = await itemFind(a.depends_on);
    if (!f || !g) return fail("both ids must be existing items");
    if (f.table !== "actions" || g.table !== "actions") return fail("dependencies are between tasks, deadlines or blocks, not events");
    // no loops: walk what depends_on itself waits for
    const seen = new Set<string>(); let frontier = [a.depends_on];
    for (let i = 0; i < 20 && frontier.length; i++) { const r = await db.from("actions").select("id,dependencies").eq("user_id", OWNER).in("id", frontier); frontier = []; for (const x of r.data || []) for (const d of (x.dependencies || [])) { if (d.id === a.id) return fail("that would make a loop: " + g.row.title + " already waits for " + f.row.title); if (!seen.has(d.id)) { seen.add(d.id); frontier.push(d.id); } } }
    const deps = (f.row.dependencies || []).filter((d: { id: string }) => d.id !== a.depends_on).concat([{ id: a.depends_on, requiresDone: true }]);
    const up = await db.from("actions").update({ dependencies: deps }).eq("id", a.id).eq("user_id", OWNER); if (up.error) return fail(up.error.message);
    return ok({ ok: true, item: await itemOutFull("actions", a.id) });
  },
});
tool("remove_dependency", {
  description: "Undo add_dependency: the task no longer waits for the other.",
  inputSchema: z.object({ id: ITEM_ID, depends_on: z.string() }),
  handler: async (a: { id: string; depends_on: string }) => {
    const f = await itemFind(a.id); if (!f || f.table !== "actions") return fail("no task with that id");
    const up = await db.from("actions").update({ dependencies: (f.row.dependencies || []).filter((d: { id: string }) => d.id !== a.depends_on) }).eq("id", a.id).eq("user_id", OWNER); if (up.error) return fail(up.error.message);
    return ok({ ok: true, item: await itemOutFull("actions", a.id) });
  },
});

// ---- read views ----
tool("get_month", {
  description: "A month at a glance: for each day, the events, deadlines, blocks and open tasks on it (repeating items expanded). month is YYYY-MM (default this month, Berlin).",
  inputSchema: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
  handler: async (a: { month?: string }) => {
    const m = a.month || berlinToday().slice(0, 7), first = m + "-01", last = ccAdd(ccIso(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)), -1), L = await ccLoad();
    if (L.error) return fail(L.error);
    const occ = ccOccurrences(L.actions, L.events, first, last), days: Record<string, unknown>[] = [];
    for (let d = first; d <= last; d = ccAdd(d, 1)) { const on = occ.filter((o) => o.date === d); days.push({ date: d, weekday: WEEKDAY_ABBR[ccDow(d)], events: on.filter((o) => o.kind === "event" || o.kind === "block").map((o) => ({ id: o.id, title: o.title, kind: o.kind, start: o.timeOfDay })), deadlines: on.filter((o) => o.kind === "deadline").map((o) => ({ id: o.id, title: o.title, done: o.done })), openTasks: on.filter((o) => o.kind === "task" && !o.done).length, doneTasks: on.filter((o) => o.kind === "task" && o.done).length }); }
    return ok({ month: m, days });
  },
});
tool("get_horizon", {
  description: "Goals and projects over a stretch of months (default the next six): each goal with its progress, due date and open count; each project with its date span (first planned task to due date), progress and deadlines; plus every deadline in the range. Use it for roadmap questions.",
  inputSchema: z.object({ from: z.string().regex(CC_DAY).optional(), to: z.string().regex(CC_DAY).optional() }),
  handler: async (a: { from?: string; to?: string }) => {
    const today = berlinToday(), from = a.from || today.slice(0, 8) + "01", to = a.to || ccAdd(ccIso(Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1 + 6, 1)), -1);
    const [g, p, ac] = await Promise.all([owned("goals").order("position"), owned("projects").order("position"), owned("actions").is("archived_at", null)]);
    if (g.error) return fail(g.error.message);
    const acts = ac.data || [], goals = (g.data || []).filter((x) => !x.archived_at), projects = (p.data || []).filter((x) => !x.archived_at);
    const under = (pid: string) => acts.filter((x) => x.parent_type === "project" && x.parent_id === pid), pct = (list: { done: boolean }[]) => list.length ? Math.round(list.filter((x) => x.done).length / list.length * 100) : 0;
    return ok({
      from, to,
      goals: goals.map((gl) => { const ps = projects.filter((x) => x.goal_id === gl.id), all = acts.filter((x) => (x.parent_type === "goal" && x.parent_id === gl.id) || ps.some((q) => x.parent_type === "project" && x.parent_id === q.id)); return { id: gl.id, title: gl.title, area: gl.category, due: gl.ongoing ? null : gl.due, ongoing: !!gl.ongoing, progress: pct(all), open: all.filter((x) => !x.done).length, projects: ps.map((q) => q.id) }; }),
      projects: projects.map((q) => { const list = under(q.id), dates = list.map((x) => x.date).filter(Boolean).sort(); return { id: q.id, goalId: q.goal_id, title: q.title, done: !!q.done, start: dates[0] || null, due: q.due || null, progress: q.done ? 100 : pct(list), open: list.filter((x) => !x.done).length, inRange: (!q.due || q.due >= from) && (!dates[0] || dates[0] <= to) }; }),
      deadlines: ccOccurrences(acts, [], from, to).filter((o) => o.kind === "deadline").map((o) => ({ id: o.id, title: o.title, date: o.date, done: o.done, parentType: o.parentType, parentId: o.parentId })),
    });
  },
});

// ---- planning writes ----
const PLAN_STEP = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), item: z.object({ kind: z.enum(ITEM_KINDS).optional(), dedupe_key: z.string().max(120).optional(), ...ITEM_FIELDS, title: z.string().min(1).max(300) }) }),
  z.object({ op: z.literal("reschedule"), id: z.string(), date: z.string().regex(CC_DAY), time: z.string().nullable().optional(), occurrence_date: z.string().regex(CC_DAY).optional() }),
  z.object({ op: z.literal("edit"), id: z.string(), changes: z.object({ status: z.enum(ITEM_STATUS).optional(), ...ITEM_FIELDS }) }),
]);
tool("apply_plan", {
  description: "Apply a whole plan in one call: a list of steps, each create (a new item), reschedule (move an item or one occurrence) or edit (change fields). Every step is checked first; if any step is invalid nothing is changed. If a step fails while applying, the steps already done are undone (created items archived, edited items put back). Pass dry_run: true to only check. Use it after plan_day / plan_week when the user accepts a proposal.",
  inputSchema: z.object({ steps: z.array(PLAN_STEP).min(1).max(60), dry_run: z.boolean().optional() }),
  // deno-lint-ignore no-explicit-any
  handler: async (a: { steps: any[]; dry_run?: boolean }) => {
    const problems: string[] = [], found: Record<string, { table: string; row: unknown }> = {};
    for (let i = 0; i < a.steps.length; i++) {
      const s = a.steps[i];
      if (s.op === "create") { const kind = s.item.kind || "task", chk = await itemRow({ ...s.item, location: undefined, kind }, kind === "event" ? "events" : "actions"); if (chk.error) problems.push("step " + (i + 1) + ": " + chk.error); continue; }
      const f = await itemFind(s.id); if (!f) { problems.push("step " + (i + 1) + ": no item " + s.id); continue; } found[s.id] = f;
      if (s.op === "reschedule") { if (s.time && !CC_TIME.test(s.time)) problems.push("step " + (i + 1) + ": time must be HH:MM"); if (s.occurrence_date && !ccDates(f.row, s.occurrence_date, s.occurrence_date).length) problems.push("step " + (i + 1) + ": the item does not fall on " + s.occurrence_date); }
      else { const chk = await itemRow({ ...s.changes, location: undefined }, f.table, f.row); if (chk.error) problems.push("step " + (i + 1) + ": " + chk.error); if (s.changes.status) { const sp = statusPatch(s.changes.status, f.row, f.table); if (typeof sp === "string") problems.push("step " + (i + 1) + ": " + sp); } }
    }
    if (problems.length) return fail("nothing was changed: " + problems.join("; "));
    if (a.dry_run) return ok({ ok: true, dryRun: true, steps: a.steps.length, note: "all steps are valid" });
    // deno-lint-ignore no-explicit-any
    const results: any[] = [], undo: (() => Promise<unknown>)[] = [];
    for (let i = 0; i < a.steps.length; i++) {
      const s = a.steps[i];
      // deno-lint-ignore no-explicit-any
      let r: any;
      if (s.op === "create") { r = await itemCreate(s.item); if (!r.error && r.created) { const t = r.item.kind === "event" ? "events" : "actions", id = r.item.id; undo.push(() => db.from(t).update({ archived_at: new Date().toISOString() }).eq("id", id).eq("user_id", OWNER)); } }
      else {
        // deno-lint-ignore no-explicit-any
        const f = found[s.id] as any, prev = { ...f.row };
        const res = s.op === "reschedule" ? await itemMove(s.id, s.date, s.time, s.occurrence_date) : itemResult(await itemEdit(s.id, s.changes));
        const body = JSON.parse(res.content[0].text); r = body.error ? { error: body.error } : body;
        if (!body.error) { undo.push(() => { const back: Record<string, unknown> = {}; for (const k of ["title", "notes_md", "category", "secondary_categories", "date", "time_of_day", "duration_minutes", "all_day", "recurrence", "recurrence_exceptions", "recurrence_done", "reminders", "muted", "linked_people_ids", "location_address", "location_lat", "location_lng", "archived_at", ...(f.table === "actions" ? ["kind", "priority", "estimate_min", "parent_type", "parent_id", "done", "someday", "dependencies", "is_milestone"] : [])]) back[k] = prev[k]; return db.from(f.table).update(back).eq("id", s.id).eq("user_id", OWNER); }); if (body.movedOneOccurrence) { const nid = body.item.id, t = f.table; undo.push(() => db.from(t).update({ archived_at: new Date().toISOString() }).eq("id", nid).eq("user_id", OWNER)); } }
      }
      if (r.error) { for (const u of undo.reverse()) await u(); return fail("step " + (i + 1) + " failed (" + r.error + "); the " + i + " step(s) before it were undone"); }
      results.push({ step: i + 1, op: s.op, item: r.item || r.series || null });
    }
    return ok({ ok: true, applied: results.length, results });
  },
});

// The Command Center's natural-language parser (command/core.js parseQuick), ported as-is.
// deno-lint-ignore no-explicit-any
function qaParse(text: string, today: string, areas: readonly string[]): any {
  const pad = (n: number) => (n < 10 ? "0" : "") + n;
  const DAYN: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  const MONN: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const nextDow = (d: number) => ccAdd(today, (d - ccDow(today) + 7) % 7);
  const nextDom = (dom: number) => { let d = today; for (let i = 0; i < 62; i++) { if (+d.slice(8, 10) === dom) return d; d = ccAdd(d, 1); } return today; };
  // deno-lint-ignore no-explicit-any
  const out: any = { title: "", kind: "task", date: null, time: null, dur: null, recurrence: null, priority: null, area: null, allDay: false }, used: string[] = [];
  let s = " " + String(text || "").replace(/\s+/g, " ").trim() + " ";
  const take = (re: RegExp, fn: (m: RegExpExecArray) => unknown) => { const m = re.exec(s); if (!m) return false; if (fn(m) === false) return false; s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length); used.push(m[0].trim()); return true; };
  take(/\s[pP]([0-3])(?=\s)/, (m) => { out.priority = "P" + m[1]; });
  take(/\s#([A-Za-z]+)(?=\s)/, (m) => { const a = areas.filter((x) => x.toLowerCase().indexOf(m[1].toLowerCase()) === 0)[0] || AREA_ALIASES[m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()]; if (!a) return false; out.area = a; });
  const tm = (h0: string | number, mi0: string | number | undefined, ap?: string) => { let h = +h0; const mi = +(mi0 || 0); if (ap) { const x = ap.toLowerCase(); if (x === "pm" && h < 12) h += 12; if (x === "am" && h === 12) h = 0; } return h > 23 || mi > 59 ? null : pad(h) + ":" + pad(mi); };
  take(/\s(\d{1,2})[:.](\d{2})\s?(?:-|–|to)\s?(\d{1,2})[:.](\d{2})(?=\s)/i, (m) => { const a = tm(m[1], m[2]), b = tm(m[3], m[4]); if (!a || !b || b <= a) return false; out.time = a; out.dur = (ccMins(b) as number) - (ccMins(a) as number); });
  if (!out.time) take(/\s(?:at\s)?(\d{1,2})[:.](\d{2})\s?(am|pm)?(?=\s)/i, (m) => { const t = tm(m[1], m[2], m[3]); if (!t) return false; out.time = t; });
  if (!out.time) take(/\s(?:at\s)?(\d{1,2})\s?(am|pm)(?=\s)/i, (m) => { const t = tm(m[1], 0, m[2]); if (!t) return false; out.time = t; });
  take(/\sfor\s(\d+(?:[.,]\d+)?)\s?(h|hr|hrs|hours?|m|min|mins|minutes?)(?=\s)/i, (m) => { const n = parseFloat(m[1].replace(",", ".")); out.dur = Math.round(/^h/i.test(m[2]) ? n * 60 : n); });
  const days: number[] = [];
  take(/\severy\s((?:(?:sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*(?:\s?,\s?|\s(?:and\s)?)?)+)(?=\s|$)/i, (m) => {
    m[1].toLowerCase().split(/[\s,]+/).forEach((w) => { if (DAYN[w] != null && days.indexOf(DAYN[w]) < 0) days.push(DAYN[w]); });
    if (!days.length) return false;
    out.recurrence = "FREQ=WEEKLY;BYDAY=" + days.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => CC_DOW[d]).join(",");
  });
  if (!out.recurrence) take(/\severy\s(\d+)\s(day|week|month|year)s?(?=\s)/i, (m) => { out.recurrence = "FREQ=" + ({ day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" } as Record<string, string>)[m[2].toLowerCase()] + ";INTERVAL=" + m[1]; });
  if (!out.recurrence) take(/\s(every\sday|daily|every\sweekday|weekdays|every\sweek|weekly|every\smonth|monthly|every\syear|yearly|annually)(?=\s)/i, (m) => { const w = m[1].toLowerCase(); out.recurrence = /weekday/.test(w) ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" : /da/.test(w) ? "FREQ=DAILY" : /week/.test(w) ? "FREQ=WEEKLY" : /month/.test(w) ? "FREQ=MONTHLY" : "FREQ=YEARLY"; });
  take(/\s(\d{4})-(\d{2})-(\d{2})(?=\s)/, (m) => { out.date = m[1] + "-" + m[2] + "-" + m[3]; });
  if (!out.date) take(/\s(\d{1,2})\.(\d{1,2})\.(\d{4})?(?=\s)/, (m) => { const y = m[3] ? +m[3] : +today.slice(0, 4); let d = y + "-" + pad(+m[2]) + "-" + pad(+m[1]); if (+m[2] > 12 || +m[1] > 31) return false; if (!m[3] && d < today) d = (y + 1) + d.slice(4); out.date = d; });
  if (!out.date) take(/\s(?:on\s)?(\d{1,2})(?:st|nd|rd|th)?\s(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*(?=\s)/i, (m) => { const y = +today.slice(0, 4); let d = y + "-" + pad(MONN[m[2].toLowerCase()]) + "-" + pad(+m[1]); if (d < today) d = (y + 1) + d.slice(4); out.date = d; });
  if (!out.date) take(/\s(today|tonight|tomorrow|next week)(?=\s)/i, (m) => { const w = m[1].toLowerCase(); out.date = w === "tomorrow" ? ccAdd(today, 1) : w === "next week" ? ccAdd(ccMonday(today), 7) : today; });
  if (!out.date) take(/\s(?:on\s|next\s)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|weds?|thu(?:rs?)?|fri|sat)(?=\s)/i, (m) => { out.date = nextDow(DAYN[m[1].toLowerCase()]); });
  if (!out.date) take(/\s(?:on\sthe\s|on\s)?(\d{1,2})(st|nd|rd|th)(?=\s)/i, (m) => { if (+m[1] < 1 || +m[1] > 31) return false; out.date = nextDom(+m[1]); if (/FREQ=MONTHLY/.test(out.recurrence || "")) out.recurrence += ";BYMONTHDAY=" + +m[1]; });
  if (out.recurrence && !out.date) { if (days.length) { for (let i = 0; i < 7; i++) { const d = ccAdd(today, i); if (days.indexOf(ccDow(d)) >= 0) { out.date = d; break; } } } else out.date = today; }
  const low = s.toLowerCase();
  if (take(/\s(deadline|due)(?=\s)/i, () => {})) out.kind = "deadline";
  else if (/\b(gym|workout|deep work|focus time|block)\b/.test(low)) out.kind = "block";
  else if (/\b(meeting|meet|dinner|lunch|breakfast|brunch|coffee|appointment|dentist|doctor|flight|train|birthday|party|concert|wedding|visit)\b/.test(low) && (out.time || out.date)) out.kind = "event";
  out.title = s.replace(/\s+/g, " ").replace(/\s(at|on|by)\s*$/i, "").trim();
  if (out.title) out.title = out.title.charAt(0).toUpperCase() + out.title.slice(1);
  out.understood = used;
  return out;
}
tool("quick_add", {
  description: "Add an item from one line of text, the way the Command Center's quick add reads it: 'call the landlord Wed 10:00', 'gym every Mon Wed Fri 19:00', 'pay rent 1st monthly', 'dinner with Noor tomorrow 19:30-21:30', 'insurance form due 13 Nov p1 #finance'. Pass dry_run: true to see how it was understood without saving. You can override what was parsed with kind/area/priority.",
  inputSchema: z.object({ text: z.string().min(2).max(300), dry_run: z.boolean().optional(), kind: z.enum(ITEM_KINDS).optional(), area: z.enum(AREA_INPUT).optional().describe(AREA_GUIDE), priority: z.enum(PRIORITIES).optional() }),
  handler: async (a: { text: string; dry_run?: boolean; kind?: string; area?: string; priority?: string }) => {
    const p = qaParse(a.text, berlinToday(), CATEGORIES);
    if (!p.title) return fail("nothing left for a title after reading the date and time; add a few words");
    const draft = { kind: a.kind || p.kind, title: p.title, date: p.date, start: p.time, duration_min: p.dur, recurrence: p.recurrence, priority: a.priority || p.priority || undefined, area: a.area || p.area || undefined, source: "claude" };
    if (a.dry_run) return ok({ dryRun: true, understood: p.understood, item: draft });
    // deno-lint-ignore no-explicit-any
    const clean: any = {}; for (const [k, v] of Object.entries(draft)) if (v !== null && v !== undefined) clean[k] = v;
    if (clean.kind === "event") delete clean.priority;
    return itemResult(await itemCreate(clean));
  },
});

// ---- goals and projects ----
async function archiveRow(table: string, id: string, archived: boolean, label: string) {
  const r = await db.from(table).update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id).eq("user_id", OWNER).select().maybeSingle();
  if (r.error) return fail(r.error.message + (/archived_at/.test(r.error.message) ? " (run _Memory/migration_connector_v2.sql)" : ""));
  if (!r.data) return fail("no " + label + " with that id");
  return ok({ ok: true, archived, [label]: r.data });
}
tool("archive_goal", {
  description: "Hide a goal (and leave its projects and tasks as they are). Nothing is deleted; pass archived: false to bring it back.",
  inputSchema: z.object({ id: z.string(), archived: z.boolean().optional() }),
  handler: (a: { id: string; archived?: boolean }) => archiveRow("goals", a.id, a.archived !== false, "goal"),
});
tool("archive_project", {
  description: "Hide a project (its tasks stay). Nothing is deleted; pass archived: false to bring it back.",
  inputSchema: z.object({ id: z.string(), archived: z.boolean().optional() }),
  handler: (a: { id: string; archived?: boolean }) => archiveRow("projects", a.id, a.archived !== false, "project"),
});
tool("link_item", {
  description: "Attach a task, deadline or block to a goal or a project (pass one), or detach it with both null. Shows in the Strategy view's goal trees.",
  inputSchema: z.object({ id: ITEM_ID, goal_id: z.string().nullable().optional(), project_id: z.string().nullable().optional() }),
  handler: async (a: { id: string; goal_id?: string | null; project_id?: string | null }) => {
    if (a.goal_id === undefined && a.project_id === undefined) return fail("pass goal_id or project_id (or both null to detach)");
    return itemResult(await itemEdit(a.id, { goal_id: a.goal_id === undefined ? (a.project_id === null ? null : undefined) : a.goal_id, project_id: a.project_id === undefined ? (a.goal_id === null ? null : undefined) : a.project_id }));
  },
});

// ---- planner settings: work hours, gym days, time zone ----
tool("get_planner_settings", {
  description: "The work block (days and hours, counted as booked in free-time views), the base gym days and the time zone.",
  inputSchema: z.object({}),
  handler: async () => { const s = await plannerSettings(); return ok(s); },
});
tool("set_planner_settings", {
  description: "Change the work block, the base gym days or the time zone. Days are numbers: 1 Monday … 7 Sunday. Only the fields you pass change.",
  inputSchema: z.object({ work_days: z.array(z.number().int().min(1).max(7)).max(7).optional(), work_start: z.string().optional(), work_end: z.string().optional(), gym_days: z.array(z.number().int().min(1).max(7)).max(7).optional(), timezone: z.string().max(60).optional() }),
  // deno-lint-ignore no-explicit-any
  handler: async (a: any) => {
    const p: Record<string, unknown> = { user_id: OWNER, updated_at: new Date().toISOString() };
    for (const k of ["work_start", "work_end"]) if (a[k] !== undefined) { if (!CC_TIME.test(a[k])) return fail(k + " must be HH:MM"); p[k] = a[k]; }
    if (a.work_start && a.work_end && a.work_end <= a.work_start) return fail("work_end must be after work_start");
    if (a.work_days) p.work_days = Array.from(new Set(a.work_days)).sort(); if (a.gym_days) p.gym_days = Array.from(new Set(a.gym_days)).sort();
    if (a.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: a.timezone }); } catch { return fail("unknown time zone; use a name like Europe/Berlin"); } p.timezone = a.timezone; }
    const r = await db.from("planner_settings").upsert(p, { onConflict: "user_id" });
    if (r.error) return fail(r.error.message + " (run _Memory/migration_connector_v2.sql)");
    return ok({ ok: true, ...(await plannerSettings()) });
  },
});

// ============================ KNOWLEDGE: TOPICS ============================
tool("list_topics", {
  description: "Every Knowledge topic with its zone and how many items it holds (only zones Claude may read are counted).",
  inputSchema: z.object({}),
  handler: async () => {
    const allowed = await knAllowed();
    const [t, it] = await Promise.all([db.from("knowledge_topics").select("id,zone,name").eq("user_id", OWNER), knItems("topic_id,zone,provider,privacy").eq("user_id", OWNER).is("archived_at", null)]);
    if (t.error) return fail(t.error.message + KN_HINT);
    const n: Record<string, number> = {}; for (const x of it.data || []) if (x.topic_id && knCan(x, allowed)) n[x.topic_id] = (n[x.topic_id] || 0) + 1;
    return ok({ topics: (t.data || []).filter((x) => allowed.includes(x.zone) || n[x.id]).map((x) => ({ id: x.id, zone: x.zone, name: x.name, items: n[x.id] || 0 })).sort((a, b) => b.items - a.items) });
  },
});
async function topicMove(fromNames: string[], into: string) {
  const allowed = await knAllowed();
  const t = await db.from("knowledge_topics").select("id,zone,name").eq("user_id", OWNER).in("name", fromNames);
  if (t.error) return fail(t.error.message + KN_HINT);
  const rows = (t.data || []).filter((x) => allowed.includes(x.zone)); if (!rows.length) return fail("no topic called " + fromNames.join(" / ") + " in zones Claude may read");
  let moved = 0;
  for (const tp of rows) {
    if (tp.name === into) continue;
    const target = await knTopicId(tp.zone, into);
    const up = await db.from("knowledge_items").update({ topic_id: target, updated_at: new Date().toISOString() }).eq("user_id", OWNER).eq("topic_id", tp.id).select("id");
    if (up.error) return fail(up.error.message); moved += (up.data || []).length;
    for (const it of up.data || []) await knTrace("cluster", it.id, null, into);
  }
  return ok({ ok: true, into, itemsMoved: moved, note: "The old topic names stay as empty labels and do not show on the page." });
}
tool("rename_topic", {
  description: "Rename a Knowledge topic everywhere it is used. If a topic with the new name already exists the two merge.",
  inputSchema: z.object({ name: z.string().min(1).max(60), new_name: z.string().min(2).max(60) }),
  handler: (a: { name: string; new_name: string }) => topicMove([a.name], a.new_name.trim()),
});
tool("merge_topics", {
  description: "Merge several Knowledge topics into one: every item in the listed topics moves to `into` (created if needed).",
  inputSchema: z.object({ topics: z.array(z.string().min(1).max(60)).min(1).max(20), into: z.string().min(2).max(60) }),
  handler: (a: { topics: string[]; into: string }) => topicMove(a.topics, a.into.trim()),
});

// ============================ COMMUNICATION ==================================
// WhatsApp has no way in for a personal account, so Claude on the owner's desktop reads the WhatsApp app
// (computer use) and saves chats here. iCloud Mail is synced by the comm-mail function. Rows live in
// comm_accounts / comm_messages (see _Memory/migration_communication.sql).
const COMM_HINT = " (run _Memory/migration_communication.sql in the Supabase SQL editor first)";
async function commWaAccount(): Promise<{ id?: string; access?: boolean; error?: string }> {
  const f = await db.from("comm_accounts").select("id,claude_access").eq("user_id", OWNER).eq("provider", "whatsapp").is("archived_at", null).maybeSingle();
  if (f.error) return { error: f.error.message + COMM_HINT };
  if (f.data) return { id: f.data.id, access: f.data.claude_access };
  const i = await db.from("comm_accounts").insert({ user_id: OWNER, provider: "whatsapp", address: "WhatsApp", label: "WhatsApp, saved by Claude on your desktop" }).select("id,claude_access").single();
  if (i.error) return { error: i.error.message + COMM_HINT };
  return { id: i.data.id, access: i.data.claude_access };
}
// 'YYYY-MM-DD HH:MM' in Berlin, or an ISO time with an offset
function commWhen(at: string): string | null {
  const t = String(at || "").trim();
  if (/([zZ]|[+-]\d\d:?\d\d)$/.test(t)) { const d = new Date(t); return isNaN(+d) ? null : d.toISOString(); }
  const m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/); if (!m) return null;
  const guess = new Date(m[1] + "T" + m[2].padStart(2, "0") + ":" + m[3] + ":00Z");
  const wall = new Date(guess.toLocaleString("sv-SE", { timeZone: "Europe/Berlin" }).replace(" ", "T") + "Z");
  return new Date(guess.getTime() - (wall.getTime() - guess.getTime())).toISOString();
}
// ---- iCloud Mail, read-only, for Claude on demand: the comm-mail function holds the password and talks IMAP.
// Every call is noted in the activity log ("Searched mail: …"), never with contents.
async function mailCall(route: string, body: Record<string, unknown>, note: string) {
  const r = await fetch(SUPABASE_URL + "/functions/v1/comm-mail" + route, { method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": SERVICE_KEY }, body: JSON.stringify(body) });
  // deno-lint-ignore no-explicit-any
  const j: any = await r.json().catch(() => ({ error: "the mail service answered " + r.status }));
  await db.from("activity_log").insert({ user_id: OWNER, actor: actorStore.getStore() === dbVoice ? "voice" : "claude", table_name: "mail", row_id: crypto.randomUUID(), op: "read", after: { text: note } });
  return j.error ? fail(j.error) : spOk(j);
}
tool("mail_search", {
  description: "Search the owner's iCloud Mail (read-only; Inbox, Sent and Archive unless folder is given). Returns per hit: uid, folder, date, from, to, subject, a 200-character snippet and attachment names. Then mail_get to read one.",
  inputSchema: z.object({
    query: z.string().max(200).optional().describe("words in the subject, sender or body"),
    from: z.string().max(200).optional(), to: z.string().max(200).optional(), folder: z.string().max(200).optional().describe("from mail_folders"),
    since: DAY.optional(), before: DAY.optional(), has_attachment: z.boolean().optional(), limit: z.number().int().min(1).max(25).optional().describe("default 10"),
  }),
  handler: (a: Record<string, unknown>) => mailCall("/search", a, "Searched mail: " + String(a.query || a.from || a.to || "recent").slice(0, 80)),
});
tool("mail_get", {
  description: "Open one email (read-only): headers, the full body as plain text (HTML stripped) and the attachment list with index, name, type and size.",
  inputSchema: z.object({ uid: z.number().int().positive(), folder: z.string().max(200).describe("as returned by mail_search") }),
  handler: (a: { uid: number; folder: string }) => mailCall("/message", a, "Opened an email in " + a.folder),
});
tool("mail_attachment", {
  description: "Read one attachment as text (read-only): PDF text, docx, xlsx, pptx, csv and txt. Images and scanned PDFs return their details and a note. Capped at about 50,000 characters, and says when it was cut.",
  inputSchema: z.object({ uid: z.number().int().positive(), folder: z.string().max(200), index: z.number().int().min(0).describe("from mail_get") }),
  handler: (a: { uid: number; folder: string; index: number }) => mailCall("/attachment", a, "Read a mail attachment"),
});
tool("mail_folders", {
  description: "The owner's iCloud Mail folders with message and unread counts (read-only).",
  inputSchema: z.object({}),
  handler: () => mailCall("/folders", {}, "Listed mail folders"),
});
async function commHash(x: string) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)); return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40); }

tool("get_whatsapp_sync_state", {
  description: "Before saving WhatsApp chats: what is already saved, per chat (name, newest saved message time, count), and when WhatsApp was last saved. Read only the messages newer than these times.",
  inputSchema: z.object({}),
  handler: async () => {
    const a = await commWaAccount(); if (a.error) return fail(a.error);
    const r = await db.from("comm_messages").select("thread_title,sent_at").eq("account_id", a.id!).is("archived_at", null).order("sent_at", { ascending: false }).limit(5000);
    if (r.error) return fail(r.error.message);
    const by: Record<string, { chat: string; newest: string; messages: number }> = {};
    for (const m of r.data || []) { const k = m.thread_title; if (!by[k]) by[k] = { chat: k, newest: m.sent_at, messages: 0 }; by[k].messages++; if (m.sent_at > by[k].newest) by[k].newest = m.sent_at; }
    const acc = await db.from("comm_accounts").select("last_sync_at").eq("id", a.id!).maybeSingle();
    return ok({ lastSaved: acc.data?.last_sync_at || null, chats: Object.values(by).sort((p, q) => q.newest.localeCompare(p.newest)), timezone: "Europe/Berlin" });
  },
});

tool("save_whatsapp_chat", {
  description: "Save messages from one WhatsApp chat that you read in the WhatsApp app on the owner's computer. Send the chat's name and its messages in order, each with who sent it, the text, when (as shown in WhatsApp, 'YYYY-MM-DD HH:MM' Berlin time) and whether the owner sent it. Saving the same message again changes nothing. Never send, reply, delete or open media in WhatsApp while doing this.",
  inputSchema: z.object({
    chat: z.string().min(1).max(120).describe("the chat's name as WhatsApp shows it"),
    isGroup: z.boolean().optional(),
    messages: z.array(z.object({
      from: z.string().max(120).describe("sender's name as shown; for the owner's own messages anything, with outgoing true"),
      text: z.string().max(4000).describe("the message text; for media write e.g. '[photo]' or '[voice message, 0:42]'"),
      at: z.string().describe("'YYYY-MM-DD HH:MM' in Berlin time, or ISO with offset"),
      outgoing: z.boolean().optional(),
    })).min(1).max(300),
  }),
  handler: async (a: { chat: string; isGroup?: boolean; messages: { from: string; text: string; at: string; outgoing?: boolean }[] }) => {
    const acc = await commWaAccount(); if (acc.error) return fail(acc.error);
    const chat = a.chat.trim(), key = "wa:" + chat.toLowerCase(), bad: number[] = [];
    const rows = [];
    for (let i = 0; i < a.messages.length; i++) {
      const m = a.messages[i], when = commWhen(m.at); if (!when) { bad.push(i); continue; }
      const text = String(m.text || "").trim(), from = m.outgoing ? "You" : String(m.from || "").trim() || chat;
      rows.push({ user_id: OWNER, account_id: acc.id, provider: "whatsapp", external_id: await commHash([key, when.slice(0, 16), m.outgoing ? "me" : from.toLowerCase(), text].join("|")),
        thread_key: key, thread_title: chat, folder: a.isGroup ? "group" : "chat", direction: m.outgoing ? "out" : "in", from_name: from, from_addr: "",
        subject: "", preview: text.replace(/\s+/g, " ").slice(0, 280), body: text, sent_at: when, unread: false });
    }
    if (!rows.length) return fail("none of the times could be read; use 'YYYY-MM-DD HH:MM'");
    const up = await db.from("comm_messages").upsert(rows, { onConflict: "user_id,provider,external_id", ignoreDuplicates: true }).select("id");
    if (up.error) return fail(up.error.message + COMM_HINT);
    await db.from("comm_accounts").update({ last_sync_at: new Date().toISOString(), status: "ok" }).eq("id", acc.id!);
    return ok({ ok: true, chat, saved: (up.data || []).length, alreadySaved: rows.length - (up.data || []).length, unreadableTimes: bad.length ? bad : undefined });
  },
});

tool("get_communication_status", {
  description: "Which message sources are connected on the Communication page (iCloud Mail, WhatsApp): status, last sync, any error, how many messages and how many unread, and whether Claude may read them.",
  inputSchema: z.object({}),
  handler: async () => {
    const a = await db.from("comm_accounts").select("id,provider,address,label,status,last_error,last_sync_at,claude_access").eq("user_id", OWNER).is("archived_at", null);
    if (a.error) return fail(a.error.message + COMM_HINT);
    const out = [];
    for (const x of a.data || []) {
      const [n, u] = await Promise.all([
        db.from("comm_messages").select("id", { count: "exact", head: true }).eq("account_id", x.id).is("archived_at", null),
        db.from("comm_messages").select("id", { count: "exact", head: true }).eq("account_id", x.id).is("archived_at", null).eq("unread", true),
      ]);
      out.push({ source: x.provider === "icloud" ? "iCloud Mail" : "WhatsApp", address: x.provider === "icloud" ? x.address : undefined, status: x.status, lastSync: x.last_sync_at, error: x.last_error || undefined, messages: n.count || 0, unread: u.count || 0, claudeMayRead: x.claude_access });
    }
    return ok({ sources: out, note: out.length ? undefined : "Nothing connected yet. iCloud Mail is connected on the Communication page; WhatsApp is saved by Claude on the desktop with save_whatsapp_chat." });
  },
});

// ============================ ACROSS THE CONNECTOR ============================
const RECORD_TYPES = { action: "actions", event: "events", note: "journal", goal: "goals", project: "projects", person: "people", place: "points_of_interest", knowledge_item: "knowledge_items", memory: "agent_memory", person_link: "person_links" } as const;
async function setArchived(type: keyof typeof RECORD_TYPES, id: string, archived: boolean) {
  const table = RECORD_TYPES[type];
  const r = await db.from(table).update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id).eq("user_id", OWNER).select().maybeSingle();
  if (r.error) return fail(r.error.message + (/archived_at/.test(r.error.message) ? " (run _Memory/migration_connector_v2.sql)" : ""));
  if (!r.data) return fail("no " + type + " with that id");
  return ok({ ok: true, type, archived, record: r.data });
}
tool("archive_record", {
  description: "Hide any record by type and id: action, event, note, goal, project, person, place, knowledge_item, memory, person_link. Nothing is ever deleted; restore_record brings it back. (archive_item, archive_goal and set_relationship do the same for their own kinds.)",
  inputSchema: z.object({ type: z.enum(Object.keys(RECORD_TYPES) as [keyof typeof RECORD_TYPES]), id: z.string() }),
  handler: (a: { type: keyof typeof RECORD_TYPES; id: string }) => setArchived(a.type, a.id, true),
});
tool("restore_record", {
  description: "Bring back a record hidden with archive_record (or any archive tool), by type and id.",
  inputSchema: z.object({ type: z.enum(Object.keys(RECORD_TYPES) as [keyof typeof RECORD_TYPES]), id: z.string() }),
  handler: (a: { type: keyof typeof RECORD_TYPES; id: string }) => setArchived(a.type, a.id, false),
});
tool("search_everything", {
  description: "One search across tasks and events, notes, people, goals and projects, Knowledge items (zones Claude may read) and agent memory. Returns type, id, title and a snippet for each hit; then use the type's own get/list tool for detail.",
  inputSchema: z.object({ query: z.string().min(2).max(200), limit: z.number().int().min(1).max(100).optional() }),
  handler: async (a: { query: string; limit?: number }) => {
    const q = a.query.replace(/[%_\\,()]/g, " ").trim(), like = "%" + q + "%", lim = a.limit || 40, allowed = await knAllowed();
    const snip = (t: string) => { const s = String(t || "").replace(/\s+/g, " "), i = s.toLowerCase().indexOf(q.toLowerCase()); const from = Math.max(0, i - 60); return i < 0 ? s.slice(0, 160) : (from ? "…" : "") + s.slice(from, from + 200); };
    const [ac, ev, no, pe, go, pr, kn, me] = await Promise.all([
      owned("actions").is("archived_at", null).or("title.ilike." + like + ",notes_md.ilike." + like).limit(lim),
      owned("events").is("archived_at", null).or("title.ilike." + like + ",notes_md.ilike." + like).limit(lim),
      owned("journal").is("archived_at", null).or("title.ilike." + like + ",text.ilike." + like).limit(lim),
      owned("people").is("archived_at", null).or("name.ilike." + like + ",notes.ilike." + like + ",social_group.ilike." + like).limit(lim),
      owned("goals").or("title.ilike." + like + ",notes_md.ilike." + like).limit(lim),
      owned("projects").or("title.ilike." + like + ",notes_md.ilike." + like).limit(lim),
      owned("knowledge_items").or(KN_VISIBLE).is("archived_at", null).or("title.ilike." + like + ",summary.ilike." + like + ",why.ilike." + like).limit(lim),
      owned("agent_memory").is("archived_at", null).or("title.ilike." + like + ",body_md.ilike." + like).limit(lim),
    ]);
    // deno-lint-ignore no-explicit-any
    const hits: any[] = [];
    for (const r of ac.data || []) hits.push({ type: ccKind(r, "actions"), id: r.id, title: r.title, date: r.date, snippet: snip(r.notes_md || r.title) });
    for (const r of ev.data || []) hits.push({ type: "event", id: r.id, title: r.title, date: r.date, snippet: snip(r.notes_md || r.title) });
    for (const r of no.data || []) hits.push({ type: "note", id: r.id, title: r.title || String(r.text || "").slice(0, 60), date: r.date, snippet: snip(r.text) });
    for (const r of pe.data || []) hits.push({ type: "person", id: r.id, title: r.name, snippet: snip(r.notes || r.social_group || r.name) });
    for (const r of go.data || []) if (!r.archived_at) hits.push({ type: "goal", id: r.id, title: r.title, snippet: snip(r.notes_md || r.title) });
    for (const r of pr.data || []) if (!r.archived_at) hits.push({ type: "project", id: r.id, title: r.title, snippet: snip(r.notes_md || r.title) });
    for (const r of kn.data || []) if (knCan(r, allowed)) hits.push({ type: "knowledge_item", id: r.id, title: r.title, snippet: snip(r.summary || r.why || r.title), zone: r.zone, webUrl: r.web_url || undefined });
    for (const r of me.data || []) hits.push({ type: "memory", id: r.id, title: r.title, snippet: snip(r.body_md) });
    return ok({ query: a.query, total: hits.length, hits: hits.slice(0, lim * 2) });
  },
});
tool("connector_info", {
  description: "Which version of this connector is live: the deployed commit, when it was deployed, when this instance started, and every tool it serves. Use it to check that a new tool is available.",
  inputSchema: z.object({}),
  handler: () => ok({ version: CONNECTOR_VERSION, commit: BUILD_COMMIT.startsWith("__") ? "not stamped (deployed by hand from the dashboard)" : BUILD_COMMIT, deployedAt: BUILD_TIME.startsWith("__") ? null : BUILD_TIME, instanceStartedAt: BOOTED_AT, toolCount: OWNER_TOOLS.length, tools: OWNER_TOOLS.slice().sort(), merged: MERGED_SUMMARY, mergedNote: Object.keys(MERGED_ROUTES).length + " older tools are served through the merged tools above (old name → new tool and kind: docs/CONNECTOR.md)", voice: { endpoint: "/mcp-voice", tools: VOICE_TOOLS }, timezone: "Europe/Berlin" }),
}, "both");
// ==== V2-END ====

// ==== OD-BEGIN ====
// ============================ KNOWLEDGE: ONEDRIVE SOURCES ============================
// These call the knowledge-onedrive function, which holds the OneDrive sign-in. Read-only: nothing here can
// write, move, rename or delete anything in OneDrive. File contents reach the connector only through read_scans,
// and only for files in folders set to "Index" (their text is already Claude's to read).
async function odCall(route: string, body: Record<string, unknown> = {}) {
  const r = await fetch(SUPABASE_URL + "/functions/v1/knowledge-onedrive" + route, { method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": SERVICE_KEY }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: "knowledge-onedrive returned " + r.status }));
  if (r.status === 404 && !j.error) return fail("the knowledge-onedrive function is not deployed yet");
  if (j.error === "reconnect") return fail("OneDrive needs to be reconnected: the owner presses Reconnect OneDrive on the Knowledge page");
  return j.error ? fail(j.error) : ok(j);
}
const OD_PRIVACY = z.enum(["index", "links", "private"]).describe("index: text is read for search and summaries; links: only name, path, dates and link, content never read; private: visible to the owner only, never returned to Claude");
tool("list_knowledge_sources", {
  description: "The OneDrive folders mapped into Knowledge, each with its privacy level, zone, last sync, item and indexed counts, and whether OneDrive is connected.",
  inputSchema: z.object({}),
  handler: () => odCall("/status"),
});
tool("get_sync_status", {
  description: "Same as list_knowledge_sources, focused on sync: which sources are syncing, last synced time, errors, and whether a reconnect is needed.",
  inputSchema: z.object({}),
  handler: () => odCall("/status"),
});
tool("browse_onedrive_folders", {
  description: "List the subfolders of a OneDrive folder (folder names only, never files or contents). Omit folder_id for the top level; use a returned id to go deeper. Code and hidden folders are left out.",
  inputSchema: z.object({ folder_id: z.string().max(200).optional() }),
  handler: (a: { folder_id?: string }) => odCall("/browse", { folderId: a.folder_id }),
});
tool("add_knowledge_source", {
  description: "Map a OneDrive folder into Knowledge (idempotent: the same folder is not added twice). privacy defaults to links. zone: documents, library, web, ideas, thinkers, mine, or one of the owner's own zones. The first sync starts right away.",
  inputSchema: z.object({ folder_id: z.string().max(200).describe("from browse_onedrive_folders"), privacy: OD_PRIVACY.optional(), zone: z.string().regex(/^[a-z][a-z0-9_-]{1,29}$/).optional(), include_subfolders: z.boolean().optional(), file_types: z.array(z.string()).max(40).optional().describe("only these extensions, e.g. pdf, docx; empty = every supported type"), excludes: z.array(z.string()).max(40).optional().describe("name patterns to leave out, * as wildcard"), max_index_mb: z.number().int().min(1).max(500).optional() }),
  handler: (a: Record<string, unknown>) => odCall("/sources/add", { folderId: a.folder_id, privacy: a.privacy, zone: a.zone, includeSubfolders: a.include_subfolders, fileTypes: a.file_types, excludes: a.excludes, maxIndexMb: a.max_index_mb }),
});
tool("set_source_privacy", {
  description: "Change a source's privacy level, its per-subfolder overrides ({ \"Sub/Folder\": \"private\" }), its zone or its filters. Lowering a level removes text that is no longer allowed; the folder is walked again.",
  inputSchema: z.object({ source_id: z.string(), privacy: OD_PRIVACY.optional(), overrides: z.record(z.string(), z.enum(["index", "links", "private"])).optional(), zone: z.string().regex(/^[a-z][a-z0-9_-]{1,29}$/).optional(), include_subfolders: z.boolean().optional(), file_types: z.array(z.string()).max(40).optional(), excludes: z.array(z.string()).max(40).optional(), max_index_mb: z.number().int().min(1).max(500).optional() }),
  handler: (a: Record<string, unknown>) => odCall("/sources/update", { id: a.source_id, privacy: a.privacy, overrides: a.overrides, zone: a.zone, includeSubfolders: a.include_subfolders, fileTypes: a.file_types, excludes: a.excludes, maxIndexMb: a.max_index_mb }),
});
tool("remove_knowledge_source", {
  description: "Stop mapping a OneDrive folder: the source and its items are archived in the planner. Nothing in OneDrive is touched.",
  inputSchema: z.object({ source_id: z.string() }),
  handler: (a: { source_id: string }) => odCall("/sources/remove", { id: a.source_id }),
});
tool("sync_source", {
  description: "Sync a source now. full: true walks the whole folder again instead of only fetching changes.",
  inputSchema: z.object({ source_id: z.string(), full: z.boolean().optional() }),
  handler: (a: { source_id: string; full?: boolean }) => odCall("/sync", { id: a.source_id, full: !!a.full }),
});
// ==== OD-END ====

// ============================ MERGED TOOLS (owner endpoint) ============================
// Tools that share a pattern are served as one tool with a kind / action / mode / view. Each route calls
// the original tool's handler after checking the arguments against that tool's own schema, so what it
// does, who may call it, what stays hidden from Claude and what the activity log records are exactly the
// old tool's. The agent endpoint still serves the old names. Old name → new tool: docs/CONNECTOR.md.
const CONNECTOR_VERSION = "2.0.0";
// deno-lint-ignore no-explicit-any
type MRoute = { when: Record<string, any>; tool: string; rename?: Record<string, string>; consume?: string[] };
export const MERGED_ROUTES: Record<string, { tool: string; when: Record<string, unknown>; rename?: Record<string, string> }> = {};
const MERGED_SUMMARY: Record<string, string> = {};
// deno-lint-ignore no-explicit-any
const zInner = (s: any) => { let x = s; while (x && x._zod && ["optional", "default", "nullable"].includes(x._zod.def.type)) x = x._zod.def.innerType; return x; };
// deno-lint-ignore no-explicit-any
const zSig = (s: any) => { try { const j: any = z.toJSONSchema(zInner(s), { unrepresentable: "any" }); delete j.description; delete j.$schema; return JSON.stringify(j); } catch { return String(zInner(s)?._zod?.def?.type); } };
function merged(name: string, description: string, discs: string[], routes: MRoute[]) {
  // deno-lint-ignore no-explicit-any
  const shape: Record<string, any> = {}, keysOf: string[][] = [], reqOf: string[][] = [];
  const values: Record<string, string[]> = {}; discs.forEach((d) => { values[d] = []; });
  routes.forEach((r, i) => {
    const def = LEGACY[r.tool]; if (!def) throw new Error(name + ": " + r.tool + " is not a folded tool");
    for (const d of discs) if (r.when[d] !== undefined && !values[d].includes(r.when[d])) values[d].push(r.when[d]);
    const back: Record<string, string> = {}; Object.entries(r.rename || {}).forEach(([n, o]) => { back[o] = n; });
    keysOf[i] = []; reqOf[i] = [];
    // deno-lint-ignore no-explicit-any
    for (const [old, zs] of Object.entries<any>(def.inputSchema.shape || {})) {
      const k = back[old] || old;
      if (discs.includes(k)) throw new Error(name + ": field '" + k + "' of " + r.tool + " clashes with the " + k + " switch; rename it");
      keysOf[i].push(k); if (!zs.safeParse(undefined).success) reqOf[i].push(k);
      if (!shape[k]) shape[k] = zs.optional();
      else if (zSig(shape[k]) !== zSig(zs)) shape[k] = z.any().optional().describe(shape[k].description || zs.description || k);
    }
    for (const k of Object.keys(r.when).filter((k) => !discs.includes(k)).concat(r.consume || [])) {
      if (!keysOf[i].includes(k)) keysOf[i].push(k);
      if (!shape[k]) shape[k] = z.boolean().optional();
    }
    MERGED_ROUTES[r.tool] = { tool: name, when: r.when, rename: r.rename };
  });
  const label = (r: MRoute) => Object.entries(r.when).map(([k, v]) => k + "=" + v).join(" ");
  const fields = (i: number) => keysOf[i].filter((k) => !(k in routes[i].when)).map((k) => k + (reqOf[i].includes(k) ? "*" : "")).join(", ") || "nothing else";
  // deno-lint-ignore no-explicit-any
  const discShape: Record<string, any> = {}; for (const d of discs) discShape[d] = z.enum(values[d] as [string, ...string[]]);
  const guide = routes.map((r, i) => label(r) + ": " + fields(i)).join(" · ");
  MERGED_SUMMARY[name] = discs.map((d) => d + ": " + values[d].join("|")).join("; ");
  OWNER_TOOLS.push(name);
  mcp.tool(name, {
    description: description + " Fields (* required) — " + guide,
    inputSchema: z.object({ ...discShape, ...shape }),
    // deno-lint-ignore no-explicit-any
    handler: (a: any, ctx: any) => {
      const i = routes.findIndex((r) => Object.entries(r.when).every(([k, v]) => a[k] === v));
      if (i < 0) return fail(name + ": " + discs.map((d) => d + " must be one of " + values[d].join(", ")).join("; "));
      const r = routes[i], extra = Object.keys(a).filter((k) => !discs.includes(k) && a[k] !== undefined && !keysOf[i].includes(k));
      if (extra.length) return fail(name + " " + label(r) + ": not a field here: " + extra.join(", ") + ". Fields for " + label(r) + ": " + fields(i));
      const skip = new Set([...discs, ...Object.keys(r.when), ...(r.consume || [])]);
      // deno-lint-ignore no-explicit-any
      const fwd: any = {}; for (const k of keysOf[i]) if (!skip.has(k) && a[k] !== undefined) fwd[(r.rename || {})[k] || k] = a[k];
      const p = LEGACY[r.tool].inputSchema.safeParse(fwd);
      if (!p.success) {
        const back: Record<string, string> = {}; Object.entries(r.rename || {}).forEach(([n, o]) => { back[o] = n; });
        // deno-lint-ignore no-explicit-any
        return fail(name + " " + label(r) + ": " + p.error.issues.map((x: any) => { const f = String(x.path[0] ?? ""); return (back[f] || f || "input") + (x.path.length > 1 ? "." + x.path.slice(1).join(".") : "") + ": " + x.message; }).join("; ") + ". Fields for " + label(r) + ": " + fields(i));
      }
      return LEGACY[r.tool].handler(p.data, ctx);
    },
  });
}

merged("archive", "Hide something; nothing is ever deleted. kinds: action, goal, project (archived:false brings it back), item, record (type: event, note, person, place, …). Use restore for items and records.", ["kind"], [
  { when: { kind: "action" }, tool: "archive_action" }, { when: { kind: "goal" }, tool: "archive_goal" }, { when: { kind: "project" }, tool: "archive_project" },
  { when: { kind: "item" }, tool: "archive_item" }, { when: { kind: "record" }, tool: "archive_record" },
]);
merged("restore", "Bring back something archived. kinds: item, record.", ["kind"], [
  { when: { kind: "item" }, tool: "restore_item" }, { when: { kind: "record" }, tool: "restore_record" },
]);
merged("set_done", "Tick something off, or done:false to untick. kinds: action (occurrenceDate for one date of a repeating one), item (a task or deadline; date for a repeating one).", ["kind"], [
  { when: { kind: "action" }, tool: "complete_action" },
  { when: { kind: "item", done: false }, tool: "uncomplete_item" },
  { when: { kind: "item" }, tool: "complete_item", consume: ["done"] },
]);
merged("save_knowledge", "Keep something the owner wants kept. kinds: note, idea (ideaKind: idea|question|…), link, quote, author (Knowledge page), journal (a note on the Notes page).", ["kind"], [
  { when: { kind: "note" }, tool: "save_note" }, { when: { kind: "idea" }, tool: "save_idea", rename: { ideaKind: "kind" } }, { when: { kind: "link" }, tool: "save_link" },
  { when: { kind: "quote" }, tool: "save_quote" }, { when: { kind: "author" }, tool: "save_author" }, { when: { kind: "journal" }, tool: "add_note" },
]);
merged("list", "List records of one kind, with that kind's filters. kinds: actions, events, items (itemKind filters task/event/deadline/block), goals, projects, notes, people, decisions, proposals, agent_reports, pois, located_items, recent_knowledge, tracker.", ["kind"], [
  { when: { kind: "actions" }, tool: "list_actions" }, { when: { kind: "events" }, tool: "list_events" }, { when: { kind: "items" }, tool: "list_items", rename: { itemKind: "kind" } },
  { when: { kind: "goals" }, tool: "list_goals" }, { when: { kind: "projects" }, tool: "list_projects" }, { when: { kind: "notes" }, tool: "list_notes" },
  { when: { kind: "people" }, tool: "list_people" }, { when: { kind: "decisions" }, tool: "list_decisions" }, { when: { kind: "proposals" }, tool: "list_proposals" },
  { when: { kind: "agent_reports" }, tool: "list_agent_reports" }, { when: { kind: "pois" }, tool: "list_pois" }, { when: { kind: "located_items" }, tool: "list_located_items" },
  { when: { kind: "recent_knowledge" }, tool: "list_recent_knowledge" }, { when: { kind: "tracker" }, tool: "get_tracker" },
]);
merged("link", "Connect two things, or undo it. kinds: item (to a goal/project), people (relation: the link kind; remove:true unlinks), people_kind (change an existing people link), scenarios, knowledge, dependency (remove:true drops it).", ["kind"], [
  { when: { kind: "item" }, tool: "link_item" }, { when: { kind: "people" }, tool: "link_people", rename: { relation: "kind" } },
  { when: { kind: "people_kind" }, tool: "set_link_kind", rename: { relation: "kind" } }, { when: { kind: "scenarios" }, tool: "link_scenarios" },
  { when: { kind: "knowledge" }, tool: "link_knowledge" },
  { when: { kind: "dependency", remove: true }, tool: "remove_dependency" }, { when: { kind: "dependency" }, tool: "add_dependency", consume: ["remove"] },
]);
merged("recurrence", "Change how an item repeats. actions: set (rule), end, skip (one date), edit_occurrence (change one date or this-and-following).", ["action"], [
  { when: { action: "set" }, tool: "set_recurrence" }, { when: { action: "end" }, tool: "end_recurrence" },
  { when: { action: "skip" }, tool: "skip_occurrence" }, { when: { action: "edit_occurrence" }, tool: "edit_occurrence" },
]);
merged("reschedule", "Move an item in time. modes: date (an action or event to a day and/or time; occurrenceDate moves one date of a series), snooze (to a later day, default tomorrow, keeping its time), someday (no date, never late).", ["mode"], [
  { when: { mode: "date" }, tool: "reschedule" }, { when: { mode: "snooze" }, tool: "snooze" }, { when: { mode: "someday" }, tool: "make_someday" },
]);
merged("settings", "Read or change settings. action get|set with scope planner (work days and hours, gym days, timezone) or reminders (on/off, quiet hours, digest); set+item sets one item's reminder offsets; get+upcoming lists reminders due soon.", ["action", "scope"], [
  { when: { action: "get", scope: "planner" }, tool: "get_planner_settings" }, { when: { action: "set", scope: "planner" }, tool: "set_planner_settings" },
  { when: { action: "get", scope: "reminders" }, tool: "get_reminder_settings" }, { when: { action: "set", scope: "reminders" }, tool: "set_reminder_settings" },
  { when: { action: "set", scope: "item" }, tool: "set_reminders" }, { when: { action: "get", scope: "upcoming" }, tool: "list_upcoming_reminders" },
]);
merged("set_health", "Change the Health page's state. kinds: condition (a long-term condition with check-ups), flag (a body region: watch/recovering/cleared), status (normal, sick, injured, break).", ["kind"], [
  { when: { kind: "condition" }, tool: "set_health_condition" }, { when: { kind: "flag" }, tool: "set_health_flag" }, { when: { kind: "status" }, tool: "set_health_status" },
]);
merged("log_metric", "Log a number. kinds: tracker (a Tracker variable for a day), body (weight_kg, body_fat_pct, muscle_mass_kg, waist_cm, or blood_pressure with systolic/diastolic).", ["kind"], [
  { when: { kind: "tracker" }, tool: "log_metric" }, { when: { kind: "body" }, tool: "log_body_metric" },
]);
merged("upsert_health", "Save synced health data, idempotent (formerly upsert_health_day, upsert_workout, upsert_activity, upsert_routine). kinds: day (one Garmin day; send every field you can read: hrvAvg and hrvStatus come from Garmin's separate per-day HRV call, not the daily summary; also bodyBatteryHigh/Low, trainingReadiness; re-send today later in the day so steps stay current), workout (one Hevy session; ALWAYS send startedAt and durationMinutes), activity (swim, sauna, walk, run…), routine (the Hevy routines and rotation).", ["kind"], [
  { when: { kind: "day" }, tool: "upsert_health_day" }, { when: { kind: "workout" }, tool: "upsert_workout" },
  { when: { kind: "activity" }, tool: "upsert_activity" }, { when: { kind: "routine" }, tool: "upsert_routine" },
]);
merged("topics", "Knowledge topics. actions: list, rename, merge.", ["action"], [
  { when: { action: "list" }, tool: "list_topics" }, { when: { action: "rename" }, tool: "rename_topic" }, { when: { action: "merge" }, tool: "merge_topics" },
]);
merged("knowledge_source", "Change the OneDrive folders mapped into Knowledge (read-only in OneDrive). actions: add, set_privacy (level, overrides, zone, filters), remove (archives in the planner), sync.", ["action"], [
  { when: { action: "add" }, tool: "add_knowledge_source" }, { when: { action: "set_privacy" }, tool: "set_source_privacy" },
  { when: { action: "remove" }, tool: "remove_knowledge_source" }, { when: { action: "sync" }, tool: "sync_source" },
]);
merged("memory_read", "Read Claude's memory. actions: get (one entry by key or id), search, overview, topics.", ["action"], [
  { when: { action: "get" }, tool: "memory_get" }, { when: { action: "search" }, tool: "memory_search" },
  { when: { action: "overview" }, tool: "memory_overview" }, { when: { action: "topics" }, tool: "memory_topics" },
]);
merged("place", "Places on the Location page. actions: create, edit.", ["action"], [
  { when: { action: "create" }, tool: "create_place" }, { when: { action: "edit" }, tool: "edit_place" },
]);
merged("scenario", "Scenarios for a decision. actions: create (under an action, optionally under another scenario), edit.", ["action"], [
  { when: { action: "create" }, tool: "create_scenario" }, { when: { action: "edit" }, tool: "edit_scenario" },
]);
merged("get_finance", "Money. views: summary (accounts and transactions in a range), snapshot (the latest imported finance snapshot, or as of a date).", ["view"], [
  { when: { view: "summary" }, tool: "get_finance" }, { when: { view: "snapshot" }, tool: "get_finance_snapshot" },
]);
merged("comm_status", "Communication page. views: sources (iCloud Mail and WhatsApp: status, last sync, counts, whether Claude may read), whatsapp (what is saved per chat, before saving more).", ["view"], [
  { when: { view: "sources" }, tool: "get_communication_status" }, { when: { view: "whatsapp" }, tool: "get_whatsapp_sync_state" },
]);
{ const left = [...FOLD].filter((t) => !MERGED_ROUTES[t]); if (left.length) throw new Error("folded but not merged: " + left.join(", ")); }

// ============================ VOICE (/mcp-voice) ============================
// A small, separate connector for Claude voice calls: 12 tools, flat parameters, answers written to be
// spoken (times and titles first, at most five things, no ids, no JSON). Names are matched loosely; if two
// things fit, it asks which and changes nothing. Same database, same rules; its writes are logged as "voice".
const VOICE_TOKEN = Deno.env.get("VOICE_MCP_TOKEN") ?? "";
const mcpVoice = new McpServer({ name: "personal-planner-voice", version: "1.0.0", schemaAdapter });
const VOICE_TOOLS: string[] = [];
const VOICE_INSTRUCTIONS = "Your planner, voice edition. Europe/Berlin time. Call today first for anything about the day. Answers are spoken: be brief, times and titles first, never read ids. Archive, never delete.";
// deno-lint-ignore no-explicit-any
const vOut = (r: any) => { try { return JSON.parse(r.content[0].text); } catch { return { error: "unexpected answer" }; } };
// deno-lint-ignore no-explicit-any
function vtool(name: string, description: string, schema: any, fn: (a: any) => Promise<string>) {
  VOICE_TOOLS.push(name);
  mcpVoice.tool(name, {
    description, inputSchema: schema,
    // deno-lint-ignore no-explicit-any
    handler: async (a: any) => { let text: string; try { text = await actorStore.run(dbVoice, () => fn(a || {})); } catch (e) { text = "Sorry, that didn't work: " + String((e as Error).message || e).slice(0, 120); } return { content: [{ type: "text" as const, text }] }; },
  });
}
const vNorm = (s: string) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ß ]+/g, " ").replace(/\s+/g, " ").trim();
function vScore(q: string, title: string) {
  const a = vNorm(q), b = vNorm(title); if (!a || !b) return 0; if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.55 + 0.4 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const ta = a.split(" "), tb = b.split(" "); let hit = 0;
  for (const t of ta) if (tb.some((x) => x === t || (t.length >= 3 && (x.startsWith(t) || t.startsWith(x))))) hit++;
  return 0.9 * hit / Math.max(ta.length, tb.length);
}
// deno-lint-ignore no-explicit-any
function vPick<T>(q: string, rows: T[], title: (r: T) => string, boost?: (r: T) => number): { one?: T; many?: T[]; none?: boolean } {
  const s = rows.map((r) => ({ r, s: vScore(q, title(r)) + (boost ? boost(r) : 0) })).filter((x) => x.s >= 0.45).sort((x, y) => y.s - x.s);
  if (!s.length) return { none: true };
  if (s.length > 1 && s[1].s >= s[0].s - 0.1 && !(vNorm(title(s[0].r)) === vNorm(q) && vNorm(title(s[1].r)) !== vNorm(q))) return { many: [s[0].r, s[1].r] };
  return { one: s[0].r };
}
const vDays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const vDeDays = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];
function vDay(d: string | null | undefined) {
  if (!d) return ""; const t = berlinToday(); if (d === t) return "today"; if (d === ccAdd(t, 1)) return "tomorrow"; if (d === ccAdd(t, -1)) return "yesterday";
  const dt = new Date(d + "T12:00:00Z"), diff = (dt.getTime() - new Date(t + "T12:00:00Z").getTime()) / 864e5;
  if (diff > 0 && diff < 7) return dt.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return dt.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}
const vAnd = (xs: string[]) => xs.length <= 1 ? (xs[0] || "") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
const vMins = (m: number) => { const h = Math.floor(m / 60), r = m % 60; return h && r ? h + " hours " + r + " minutes" : h ? h + (h === 1 ? " hour" : " hours") : r + " minutes"; };
const vNowMin = () => { const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).split(":"); return +p[0] * 60 + +p[1]; };
const vMin = (t: string | null | undefined) => ccMins(t ? String(t).slice(0, 5) : null) ?? 0;
function vResolveDay(day: string): string | null {
  const t = berlinToday(), x = vNorm(day || "today");
  if (!x || x === "today" || x === "heute") return t;
  if (x === "tomorrow" || x === "morgen") return ccAdd(t, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(day).trim())) return String(day).trim();
  let w = vDays.findIndex((d) => x.startsWith(d.slice(0, 3))); if (w < 0) w = vDeDays.findIndex((d) => x.startsWith(d.slice(0, 2)) && x.length >= 2 && d.startsWith(x));
  if (w >= 0) { for (let i = 0; i < 7; i++) { const d = ccAdd(t, i); if (new Date(d + "T12:00:00Z").getUTCDay() === w) return d; } }
  const p = qaParse("x " + day, t, CATEGORIES); return p && p.date ? p.date : null;
}
// open things the voice tools can act on by name
// deno-lint-ignore no-explicit-any
async function vOpen(includeEvents: boolean): Promise<any[]> {
  const t = berlinToday();
  const [a, e] = await Promise.all([
    db.from("actions").select("*").eq("user_id", OWNER).is("archived_at", null).eq("done", false).limit(1500),
    includeEvents ? db.from("events").select("*").eq("user_id", OWNER).is("archived_at", null).limit(1500) : Promise.resolve({ data: [] }),
  ]);
  // deno-lint-ignore no-explicit-any
  const ev = (e.data || []).filter((r: any) => r.recurrence || !r.date || r.date >= ccAdd(t, -1)).map((r: any) => ({ ...r, _table: "events" }));
  // deno-lint-ignore no-explicit-any
  return (a.data || []).map((r: any) => ({ ...r, _table: "actions" })).concat(ev);
}
// deno-lint-ignore no-explicit-any
const vWhen = (r: any) => { const t = berlinToday(), d = r.recurrence ? (ccDates(r, t, ccAdd(t, 60))[0] || null) : r.date; return [vDay(d), hhmm(r.time_of_day) ? "at " + hhmm(r.time_of_day) : ""].filter(Boolean).join(" "); };
// deno-lint-ignore no-explicit-any
const vBoost = (r: any) => { const t = berlinToday(); return (r.recurrence ? ccDates(r, t, t).length > 0 : r.date && r.date <= t) ? 0.04 : 0; };
// deno-lint-ignore no-explicit-any
const vWhich = (xs: any[]) => "Did you mean " + xs.map((r) => (r.title || r.name) + (vWhen(r) ? ", " + vWhen(r) : "")).join(", or ") + "? Nothing changed.";

vtool("today", "Today at a glance: the main thing, what's next with times, free time from now, and the workout.", z.object({}), async () => {
  const t = berlinToday(), now = vNowMin(), o = vOut(await ALL_DEFS.get_today_overview.handler({}));
  if (o.error) return "I couldn't read today: " + o.error;
  // deno-lint-ignore no-explicit-any
  const sched = (o.schedule || []) as any[], next = sched.filter((x) => { const s = vMin(x.time); return s + (x.minutes || 30) > now; });
  const set = await db.from("planner_settings").select("work_days,work_start,work_end").eq("user_id", OWNER).maybeSingle();
  const wd = new Date(t + "T12:00:00Z").getUTCDay() || 7, ws = set.data || { work_days: [1, 2, 3, 4, 5], work_start: "09:00", work_end: "18:00" };
  const busy: [number, number][] = sched.map((x) => [vMin(x.time), vMin(x.time) + (x.minutes || (x.kind === "task" || x.kind === "deadline" ? 30 : 60))]);
  if ((ws.work_days || []).includes(wd)) busy.push([vMin(String(ws.work_start).slice(0, 5)), vMin(String(ws.work_end).slice(0, 5))]);
  // deno-lint-ignore no-explicit-any
  const free = (globalThis as any).PPFree.compute({ nowMin: now, isToday: true, busy, dayStart: 420, dayEnd: 1380, minGap: 15 }).minutes;
  const parts: string[] = [o.weekday + "."];
  if (o.mainThing) parts.push("Main thing: " + o.mainThing.title + ".");
  parts.push(next.length ? "Next: " + vAnd(next.slice(0, 3).map((x) => x.time + " " + x.title)) + (next.length > 3 ? ", and " + (next.length - 3) + " more" : "") + "." : "Nothing else at a fixed time today.");
  const loose = ((o.tasks || []) as string[]).filter((x) => !o.mainThing || x !== o.mainThing.title);
  if (loose.length) parts.push((o.mainThing ? "Also " : "") + loose.length + (loose.length === 1 ? " task" : " tasks") + " without a time" + (loose.length <= 2 ? ": " + vAnd(loose) : "") + ".");
  if (o.overdue && o.overdue.count) parts.push(o.overdue.count + " overdue.");
  parts.push(free >= 30 ? "About " + vMins(Math.round(free / 15) * 15) + " free from now until 23:00." : "Hardly any free time left today.");
  const g = o.nextGym; if (g) parts.push(g.trainedToday ? "Workout done today." : g.date === t ? "Gym today" + (g.time ? " at " + g.time : "") + (g.routine ? ", " + g.routine : "") + "." : "Next gym " + vDay(g.date) + (g.time ? " at " + g.time : "") + ".");
  return parts.join(" ");
});
vtool("agenda", "A short spoken agenda for one day: today, tomorrow, a weekday or a date.", z.object({ day: z.string().max(40).optional().describe("today, tomorrow, a weekday like Friday, or YYYY-MM-DD") }), async (a) => {
  const d = vResolveDay(a.day || "today"); if (!d) return "Which day? Say today, tomorrow, a weekday or a date.";
  const o = vOut(await ALL_DEFS.get_today_overview.handler({ date: d })); if (o.error) return "I couldn't read that day: " + o.error;
  // deno-lint-ignore no-explicit-any
  const s = (o.schedule || []) as any[], items = s.map((x) => x.time + " " + x.title).concat((o.allDay || []).map((x: string) => x + " (all day)"));
  const head = (vDay(d) === "today" || vDay(d) === "tomorrow" ? vDay(d).charAt(0).toUpperCase() + vDay(d).slice(1) : vDay(d)) + ": ";
  const out = [items.length ? head + vAnd(items.slice(0, 5)) + (items.length > 5 ? ", and " + (items.length - 5) + " more" : "") + "." : head + "nothing at a fixed time."];
  if (o.tasks && o.tasks.length) out.push(o.tasks.length + (o.tasks.length === 1 ? " task" : " tasks") + ": " + vAnd(o.tasks.slice(0, 3)) + (o.tasks.length > 3 ? " and more" : "") + ".");
  return out.join(" ");
});
vtool("add", "Add something from one plain sentence, like 'call the landlord Wednesday 10:00'.", z.object({ text: z.string().min(2).max(300) }), async (a) => {
  const p = qaParse(a.text, berlinToday(), CATEGORIES); if (!p.title) return "I didn't catch what to add.";
  // deno-lint-ignore no-explicit-any
  const draft: any = { kind: p.kind, title: p.title, date: p.date, start: p.time, duration_min: p.dur, recurrence: p.recurrence, priority: p.priority || undefined, area: p.area || undefined, source: "voice" };
  for (const k of Object.keys(draft)) if (draft[k] === null || draft[k] === undefined) delete draft[k];
  if (draft.kind === "event") delete draft.priority;
  const r = await itemCreate(draft); if (r.error) return "I couldn't add that: " + r.error;
  return "Added: " + p.title + (p.recurrence ? ", repeating" : p.date ? ", " + vDay(p.date) : "") + (p.time ? " at " + p.time : "") + ".";
});
vtool("done", "Mark a task done by saying its name.", z.object({ title: z.string().min(2).max(200) }), async (a) => {
  // deno-lint-ignore no-explicit-any
  const rows = (await vOpen(false)).filter((r: any) => ccKind(r, "actions") !== "block");
  const m = vPick(a.title, rows, (r) => r.title, vBoost);
  if (m.none) return "I couldn't find an open task called " + a.title + ".";
  if (m.many) return vWhich(m.many);
  const r = m.one, res = vOut(await itemComplete(r.id, true, r.recurrence ? berlinToday() : undefined));
  return res.error ? "I couldn't mark " + r.title + " done: " + res.error : "Done: " + r.title + ".";
});
vtool("move", "Move a task or event by name to another time: tomorrow, Friday 9:00, or someday.", z.object({ title: z.string().min(2).max(200), when: z.string().min(2).max(60) }), async (a) => {
  const m = vPick(a.title, await vOpen(true), (r) => r.title, vBoost);
  if (m.none) return "I couldn't find anything called " + a.title + ".";
  if (m.many) return vWhich(m.many);
  const r = m.one, t = berlinToday();
  if (/some ?day|later|no date|backlog|irgendwann/i.test(a.when)) {
    if (r._table === "events") return r.title + " is an event, so it needs a day. Say when instead.";
    const res = vOut(itemResult(await itemEdit(r.id, { status: "someday" })));
    return res.error ? "I couldn't park it: " + res.error : "Moved " + r.title + " to someday.";
  }
  const p = qaParse("x " + a.when, t, CATEGORIES), d = p.date || (p.time ? t : null) || vResolveDay(a.when);
  if (!d) return "When should " + r.title + " move to? Say a day or a time.";
  const occ = r.recurrence ? (ccDates(r, t, ccAdd(t, 90))[0] || undefined) : undefined;
  const res = vOut(await itemMove(r.id, d, p.time || undefined, occ));
  return res.error ? "I couldn't move it: " + res.error : "Moved " + r.title + (occ ? " (just this once)" : "") + " to " + vDay(d) + (p.time ? " at " + p.time : "") + ".";
});
vtool("main_thing", "Set today's main thing, by naming a task or saying a new one.", z.object({ text: z.string().min(2).max(200) }), async (a) => {
  // deno-lint-ignore no-explicit-any
  const rows = (await vOpen(false)).filter((r: any) => ccKind(r, "actions") !== "block");
  const m = vPick(a.text, rows, (r) => r.title, vBoost);
  if (m.many) return vWhich(m.many);
  let id = m.one ? m.one.id : null, title = m.one ? m.one.title : a.text.trim(), made = false;
  if (!id) { const c = await itemCreate({ kind: "task", title, date: berlinToday(), priority: "P1", source: "voice" }); if (c.error || !c.item) return "I couldn't add it: " + (c.error || "unknown"); id = c.item.id; made = true; }
  const res = vOut(await ALL_DEFS.set_main_thing.handler({ id, date: berlinToday() }));
  return res.error ? "I couldn't set it: " + res.error : (made ? "Added and set as today's main thing: " : "Today's main thing: ") + title + ".";
});
vtool("next_workout", "When the next workout is and which routine is due.", z.object({}), async () => {
  const n = await hvNextSession(), t = berlinToday();
  const head = n.trainedToday ? "You already trained today. " : "";
  const when = n.date ? (n.date === t && n.trainedToday ? "" : "Next workout: " + vDay(n.date) + (n.time ? " at " + n.time : "") + (n.routine ? ", " + n.routine : "") + ".") : (n.routine ? "No gym day is planned yet. Next routine: " + n.routine + "." : "No gym day is planned yet.");
  const last = n.lastWorkoutDate ? " Last one was " + (n.lastRoutine || "a workout") + ", " + vDay(n.lastWorkoutDate) + "." : "";
  return (head + when + last).trim();
});
vtool("health", "One line on readiness: energy, sleep, last workout and any pains.", z.object({}), async () => {
  const t = berlinToday();
  const [days, wk, flags, st] = await Promise.all([
    db.from("health_daily").select("date,sleep_minutes,sleep_minutes_corrected,sleep_score,body_battery_now,body_battery_high,training_readiness").eq("user_id", OWNER).is("archived_at", null).gte("date", ccAdd(t, -1)).order("date", { ascending: false }).limit(2),
    db.from("workouts").select("date,routine,title").eq("user_id", OWNER).is("archived_at", null).order("date", { ascending: false }).limit(1),
    db.from("health_flags").select("region,state").eq("user_id", OWNER).is("archived_at", null),
    db.from("health_status").select("status,start_date,end_date").eq("user_id", OWNER).is("archived_at", null).order("start_date", { ascending: false }).limit(1),
  ]);
  // deno-lint-ignore no-explicit-any
  const d: any = (days.data || [])[0], out: string[] = [];
  const s = st.data && st.data[0]; if (s && s.status !== "normal" && (!s.end_date || s.end_date >= t)) out.push("Marked as " + s.status + " since " + vDay(s.start_date) + ".");
  if (d) {
    const bb = d.body_battery_now ?? d.body_battery_high; if (bb != null) out.push("Body battery " + bb + (d.body_battery_now == null ? " at its high" : " now") + ".");
    if (d.training_readiness != null) out.push("Training readiness " + d.training_readiness + ".");
    const sm = d.sleep_minutes_corrected ?? d.sleep_minutes; if (sm != null) out.push("Slept " + vMins(sm) + (d.sleep_score != null ? ", score " + d.sleep_score : "") + ".");
  } else out.push("No watch data for today yet.");
  const w = wk.data && wk.data[0]; if (w) out.push("Last workout " + vDay(w.date) + ", " + (w.routine || w.title || "a session") + ".");
  // deno-lint-ignore no-explicit-any
  const p = (flags.data || []).filter((f: any) => f.state !== "cleared"); if (p.length) out.push("Watching: " + vAnd(p.slice(0, 3).map((f: any) => String(f.region).replace(/_/g, " ") + " (" + f.state + ")")) + ".");
  return out.join(" ");
});
vtool("checkin", "Log how you feel today: energy and mood from 1 to 5, and an optional note.", z.object({ energy: z.number().int().min(1).max(5), mood: z.number().int().min(1).max(5), note: z.string().max(300).optional() }), async (a) => {
  const res = vOut(await ALL_DEFS.log_checkin.handler({ energy: a.energy, note: ("Mood " + a.mood + "/5" + (a.note ? ". " + a.note.trim() : "")).slice(0, 400), source: "claude" }));
  return res.error ? "I couldn't log that: " + res.error : "Logged: energy " + a.energy + ", mood " + a.mood + (a.note ? ", with your note" : "") + ".";
});
vtool("note", "Save a quick idea or note to Knowledge.", z.object({ text: z.string().min(2).max(2000) }), async (a) => {
  const title = a.text.trim().split(/\s+/).slice(0, 8).join(" ");
  const res = vOut(await ALL_DEFS.save_note.handler({ text: a.text.trim(), title }));
  return res.error ? "I couldn't save it: " + res.error : "Saved to Knowledge: " + title + (a.text.trim().split(/\s+/).length > 8 ? "…" : ".");
});
vtool("find", "Search everything and say the top three results.", z.object({ query: z.string().min(2).max(200) }), async (a) => {
  const res = vOut(await ALL_DEFS.search_everything.handler({ query: a.query, limit: 15 }));
  if (res.error) return "Search failed: " + res.error;
  const names: Record<string, string> = { task: "task", deadline: "deadline", block: "time block", event: "event", note: "note", person: "person", goal: "goal", project: "project", knowledge_item: "in Knowledge", memory: "memory" };
  // deno-lint-ignore no-explicit-any
  const hits = ((res.hits || []) as any[]).map((h) => ({ h, s: vScore(a.query, h.title || "") })).sort((x, y) => y.s - x.s).slice(0, 3).map((x) => x.h);
  if (!hits.length) return "Nothing found for " + a.query + ".";
  return (res.total > 3 ? "Top three: " : "Found: ") + hits.map((h) => (names[h.type] || h.type) + " " + h.title + (h.date && ["task", "deadline", "event", "block"].includes(h.type) ? ", " + vDay(h.date) : "")).join("; ") + ".";
});
vtool("contact", "Log that you talked to someone, with an optional short note.", z.object({ person: z.string().min(2).max(120), note: z.string().max(400).optional() }), async (a) => {
  const pe = await db.from("people").select("id,name").eq("user_id", OWNER).is("archived_at", null).limit(2000);
  // deno-lint-ignore no-explicit-any
  const m = vPick(a.person, (pe.data || []) as any[], (r) => r.name);
  if (m.none) return "I couldn't find " + a.person + " in People.";
  if (m.many) return "Did you mean " + m.many.map((r) => r.name).join(" or ") + "? Nothing changed.";
  const r = m.one, res = vOut(await ALL_DEFS.log_contact.handler({ person: r.id }));
  if (res.error) return "I couldn't log it: " + res.error;
  if (a.note) { const n = vOut(await ALL_DEFS.set_person_situation.handler({ person: r.id, text: a.note.trim() })); if (n.error) return "Logged that you talked to " + r.name + " today, but the note didn't save."; }
  return "Logged that you talked to " + r.name + " today" + (a.note ? ", and saved your note" : "") + ".";
});

const httpHandler = new StreamableHttpTransport().bind(mcp);
const agentHttpHandler = new StreamableHttpTransport().bind(mcpAgent);
const voiceHttpHandler = new StreamableHttpTransport().bind(mcpVoice);

// ---- Reminders on the phone (Web Push) -----------------------------------------
// Three small routes next to the MCP endpoint:
//   GET  .../push/key   the public key a browser needs to subscribe (not a secret)
//   POST .../push/run   called every few minutes by a database schedule; sends what is due
//   POST .../push/test  sends one test notification; needs the owner's own sign-in token
// Subscriptions, settings and a "sent" log live in push_* tables (see
// _Memory/migration_push.sql). The signing key pair comes from the VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY secrets when they are set; otherwise one is created on first use and kept in
// push_config, a table no browser key can read. Web Push is implemented here with WebCrypto
// (RFC 8291 + RFC 8292), so the function has no extra dependency.
const PUSH_SITE = "https://majdmurad-mm.github.io/personal-planner/";
const b64u = (buf: ArrayBuffer | Uint8Array) => { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (s: string) => { const t = String(s).replace(/-/g, "+").replace(/_/g, "/"), bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const pushCat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const pushUtf8 = (s: string) => new TextEncoder().encode(s);
async function pushHkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
async function pushNewKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)), jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: b64u(pub), privateKey: String(jwk.d) };
}
// The signed token that tells the push service who is sending (RFC 8292).
async function pushVapidHeader(endpoint: string, publicKey: string, privateKey: string, subject: string, nowSec: number) {
  const pub = unb64u(publicKey);
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: privateKey, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(pushUtf8(JSON.stringify({ typ: "JWT", alg: "ES256" }))), body = b64u(pushUtf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, pushUtf8(head + "." + body));
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + publicKey;
}
// Encrypts the message for one browser (RFC 8291, aes128gcm). salt and the one-off key pair can be
// passed in for tests; normally they are random.
// deno-lint-ignore no-explicit-any
async function pushEncrypt(p256dh: string, auth: string, payload: Uint8Array, fixed?: { salt: Uint8Array; keys: any }) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  const keys = fixed ? fixed.keys : await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const as = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, keys.privateKey, 256));
  const ikm = await pushHkdf(secret, shared, pushCat(pushUtf8("WebPush: info\0"), ua, as), 32);
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await pushHkdf(salt, ikm, pushUtf8("Content-Encoding: aes128gcm\0"), 16), nonce = await pushHkdf(salt, ikm, pushUtf8("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, pushCat(payload, new Uint8Array([2]))));
  return pushCat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([as.length]), as, ct);
}
// deno-lint-ignore no-explicit-any
async function pushSend(sub: any, message: unknown, vapid: { publicKey: string; privateKey: string }): Promise<number> {
  try {
    const body = await pushEncrypt(sub.p256dh, sub.auth, pushUtf8(JSON.stringify(message)));
    const res = await fetch(sub.endpoint, { method: "POST", body, headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "normal", Authorization: await pushVapidHeader(sub.endpoint, vapid.publicKey, vapid.privateKey, PUSH_SITE, Math.floor(Date.now() / 1000)) } });
    return res.status;
  } catch (_e) { return 0; }
}
async function pushKeys(): Promise<{ publicKey: string; privateKey: string } | null> {
  const ePub = Deno.env.get("VAPID_PUBLIC_KEY"), ePriv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (ePub && ePriv) return { publicKey: ePub, privateKey: ePriv };
  const cur = await db.from("push_config").select("public_key,private_key").eq("id", 1).maybeSingle();
  if (cur.error) return null;
  if (cur.data) return { publicKey: cur.data.public_key, privateKey: cur.data.private_key };
  const made = await pushNewKeys();
  const ins = await db.from("push_config").insert({ id: 1, public_key: made.publicKey, private_key: made.privateKey });
  if (ins.error) { const again = await db.from("push_config").select("public_key,private_key").eq("id", 1).maybeSingle(); return again.data ? { publicKey: again.data.public_key, privateKey: again.data.private_key } : null; }
  return made;
}
// What is due right now. Pure: takes rows and "now" in Berlin, returns [{ key, title, body }].
// deno-lint-ignore no-explicit-any
function pushDue(actions: any[], events: any[], settings: any, today: string, nowMin: number, windowMin: number) {
  const hm = (t: string | null, d: number) => t ? +String(t).slice(0, 2) * 60 + +String(t).slice(3, 5) : d;
  const qf = hm(settings.quiet_from, 23 * 60), qt = hm(settings.quiet_to, 8 * 60), quiet = qf === qt ? false : qf < qt ? nowMin >= qf && nowMin < qt : nowMin >= qf || nowMin < qt;
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  if (settings.enabled === false || quiet) return out;
  const days = [today, ccAdd(today, 1), ccAdd(today, 2)], clock = (m: number) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  // deno-lint-ignore no-explicit-any
  const each = (rows: any[], table: string) => {
    for (const r of rows) {
      if (r.muted || r.someday || !(r.reminders || []).length) continue;
      const kind = ccKind(r, table);
      for (const d of ccDates(r, today, days[2])) {
        if (table === "actions" && (kind === "task" || kind === "deadline") && (r.recurrence ? (r.recurrence_done || []).includes(d) : r.done)) continue;
        const timed = !!r.time_of_day && !r.all_day, start = days.indexOf(d) * 1440 + (timed ? hm(r.time_of_day, 540) : 540);
        for (const off of r.reminders) {
          const at = start - Number(off);
          if (at <= nowMin && at > nowMin - windowMin) out.push({ key: "r:" + r.id + ":" + d + ":" + off, title: r.title, body: (d === today ? "Today" : d === days[1] ? "Tomorrow" : d) + (timed ? " at " + String(r.time_of_day).slice(0, 5) : "") + (kind === "deadline" ? " · due" : "") });
        }
      }
    }
  };
  each(actions, "actions"); each(events, "events");
  const digestAt = hm(settings.digest_time, 8 * 60);
  if (settings.digest_on !== false && nowMin >= digestAt && nowMin < digestAt + 60) {
    const occ = ccOccurrences(actions, events, today, today), main = actions.find((a) => a.focus_date === today && !a.done), ev = occ.filter((o) => o.kind === "event" || o.kind === "block"), tasks = occ.filter((o) => (o.kind === "task" || o.kind === "deadline") && !o.done);
    const first = ev.filter((o) => o.timeOfDay)[0];
    out.push({ key: "d:" + today, title: main ? "Today: " + main.title : tasks.length ? "Today: " + tasks.length + (tasks.length === 1 ? " thing" : " things") + " on the list" : "Today is open", body: (ev.length ? ev.length + (ev.length === 1 ? " event" : " events") + (first ? ", first " + first.title + " at " + first.timeOfDay : "") : "No events") + (main && tasks.length > 1 ? " · " + (tasks.length - 1) + " other " + (tasks.length - 1 === 1 ? "task" : "tasks") : "") });
  }
  if (settings.deadline_on !== false && nowMin >= 18 * 60 && nowMin < 19 * 60) {
    for (const a of actions) if (ccKind(a, "actions") === "deadline" && !a.done && !a.muted && !a.someday && ccDates(a, days[1], days[1]).length) out.push({ key: "dl:" + a.id + ":" + days[1], title: "Due tomorrow: " + a.title, body: "A heads-up, so tomorrow is calm." });
  }
  void clock;
  return out;
}
function berlinNow(now: Date) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now), g = (t: string) => p.find((x) => x.type === t)?.value || "00";
  return { today: g("year") + "-" + g("month") + "-" + g("day"), nowMin: +g("hour") * 60 + +g("minute") };
}
const PUSH_DEFAULTS = { enabled: true, quiet_from: "23:00", quiet_to: "08:00", digest_on: true, digest_time: "08:00", deadline_on: true };
// deno-lint-ignore no-explicit-any
async function pushDeliver(messages: any[]) {
  const subs = await db.from("push_subscriptions").select("*").eq("user_id", OWNER).is("failed_at", null);
  if (subs.error || !subs.data || !subs.data.length) return { sent: 0, devices: 0 };
  const vapid = await pushKeys(); if (!vapid) return { sent: 0, devices: subs.data.length };
  let sent = 0;
  for (const m of messages) for (const s of subs.data) {
    const status = await pushSend(s, { title: m.title, body: m.body, tag: m.key, url: PUSH_SITE }, vapid);
    if (status === 404 || status === 410) await db.from("push_subscriptions").update({ failed_at: new Date().toISOString() }).eq("id", s.id);
    else if (status >= 200 && status < 300) { sent++; await db.from("push_subscriptions").update({ last_ok_at: new Date().toISOString() }).eq("id", s.id); }
  }
  return { sent, devices: subs.data.length };
}
async function pushRun() {
  if (!OWNER) return { ok: false };
  const set = await db.from("push_settings").select("*").eq("user_id", OWNER).maybeSingle();
  if (set.error) return { ok: false };
  const L = await ccLoad(); if (L.error) return { ok: false };
  const t = berlinNow(new Date()), due = pushDue(L.actions, L.events, { ...PUSH_DEFAULTS, ...(set.data || {}) }, t.today, t.nowMin, 15), fresh = [];
  for (const m of due) { const ins = await db.from("push_log").insert({ user_id: OWNER, key: m.key }); if (!ins.error) fresh.push(m); }   // the unique key stops a second send
  const r = fresh.length ? await pushDeliver(fresh) : { sent: 0, devices: 0 };
  return { ok: true, due: fresh.length, sent: r.sent };
}
const PUSH_CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
async function pushRoute(req: Request, pathname: string): Promise<Response> {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...PUSH_CORS } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: PUSH_CORS });
  if (pathname.endsWith("/push/key")) { const k = await pushKeys(); return k ? json({ publicKey: k.publicKey }) : json({ error: "reminders are not set up yet (run _Memory/migration_push.sql)" }, 503); }
  if (pathname.endsWith("/push/run") && req.method === "POST") return json(await pushRun());
  if (pathname.endsWith("/push/test") && req.method === "POST") {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const who = token ? await db.auth.getUser(token) : null;
    if (!who || who.error || !who.data.user || who.data.user.id !== OWNER) return json({ error: "sign in first" }, 401);
    const r = await pushDeliver([{ key: "test:" + Date.now(), title: "Reminders are working", body: "This is a test from your planner." }]);
    return json({ ok: true, sent: r.sent, devices: r.devices });
  }
  return json({ error: "not found" }, 404);
}

const app = new Hono();

// Token gate. The token may arrive any of three ways, and any of them is accepted:
//   1. Authorization: Bearer <MCP_TOKEN>            — clients that let you set a header.
//   2. ?token=<MCP_TOKEN> in the URL query string   — clients that only take a URL.
//   3. as the path segment right before /mcp:
//        .../functions/v1/planner-mcp/<MCP_TOKEN>/mcp
//      — the most robust option, because some clients (the claude.ai web connector
//      appears to be one) drop the query string when they call the endpoint, but the
//      URL PATH is always preserved. If MCP_TOKEN isn't set, fail closed.
// The same three places carry AGENT_TOKEN, which gets the restricted agent server instead.
// An AGENT_TOKEN identical to MCP_TOKEN is ignored rather than honoured: it would make the
// "restricted" token the owner token, which is exactly the mistake a second token exists to stop.
function tokenRole(req: Request): "owner" | "agent" | "voice" | null {
  const url = new URL(req.url);
  const header = req.headers.get("authorization") || "";
  const pathMatch = url.pathname.match(/\/([^/]+)\/mcp(?:-voice)?$/);
  const presented = [
    header.replace(/^Bearer\s+/i, "").trim(),
    url.searchParams.get("token") || "",
    pathMatch ? pathMatch[1] : "",
  ].filter(Boolean);
  if (MCP_TOKEN && presented.includes(MCP_TOKEN)) return "owner";
  if (AGENT_TOKEN && AGENT_TOKEN !== MCP_TOKEN && presented.includes(AGENT_TOKEN)) return "agent";
  if (VOICE_TOKEN && VOICE_TOKEN !== MCP_TOKEN && VOICE_TOKEN !== AGENT_TOKEN && presented.includes(VOICE_TOKEN)) return "voice";
  return null;
}

// Shown to Claude when it connects, in text chats and in voice mode alike.
const SERVER_INSTRUCTIONS = [
  "The user's personal planner (one person, Europe/Berlin time).",
  "For 'what's my day', a morning check-in or any voice conversation, call get_today_overview first: one small call with times and titles. Use get_agenda, list_* or search tools only when more detail is needed.",
  "In voice mode the answer is spoken: keep it short, lead with times and titles, never read out ids, JSON or long lists, and prefer one tool call over several.",
  "To add something said aloud, quick_add takes plain language (\"call the landlord Wed 10:00\").",
  "Archive, never delete. Health notes and notes about other people are private: summarise them, and only read details aloud when asked.",
].join(" ");
async function withInstructions(res: Response, instructions = SERVER_INSTRUCTIONS): Promise<Response> {
  try {
    const text = await res.clone().text(), sse = /^\s*(event:|data:)/.test(text);
    const json = sse ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : text;
    const msg = JSON.parse(json);
    if (!msg || !msg.result || typeof msg.result !== "object") return res;
    msg.result.instructions = instructions;
    const body = sse ? "event: message\ndata: " + JSON.stringify(msg) + "\n\n" : JSON.stringify(msg);
    const h = new Headers(res.headers); h.delete("content-length");
    return new Response(body, { status: res.status, headers: h });
  } catch { return res; }
}

// Path-agnostic routing. Depending on the Supabase runtime version, the Hono app
// may see the request path WITH the function-name prefix (/planner-mcp/mcp) or
// WITHOUT it (/mcp) — so instead of mounting under a fixed prefix, we match on the
// path suffix. Any path ending in /mcp is the MCP endpoint (bearer-gated);
// everything else is the unauthenticated health check.
app.all("*", async (c) => {
  const pathname = new URL(c.req.url).pathname;
  if (/\/push\/(key|run|test)$/.test(pathname)) return await pushRoute(c.req.raw, pathname);
  if (pathname.endsWith("/goal-scores/refresh")) {
    const k = c.req.header("x-cron-key") || "", row = await db.from("knowledge_cron_key").select("key").eq("id", 1).maybeSingle();
    if (!row.data || !k || k !== row.data.key) return c.json({ error: "unauthorized" }, 401);
    return c.json(await refreshGoalScores());
  }
  // The voice edition: its own token, 12 tools, spoken answers.
  if (pathname.endsWith("/mcp-voice") && !pathname.includes("/.well-known/")) {
    if (tokenRole(c.req.raw) !== "voice") return c.json({ error: "unauthorized" }, 401);
    if (!OWNER) return c.json({ error: "server not configured: OWNER_USER_ID is unset" }, 500);
    let vInit = false;
    if (c.req.method === "POST") { try { const b = await c.req.raw.clone().json(); vInit = !!b && !Array.isArray(b) && b.method === "initialize"; } catch { /* not JSON */ } }
    const vres = await voiceHttpHandler(c.req.raw);
    return vInit ? await withInstructions(vres, VOICE_INSTRUCTIONS) : vres;
  }
  if (pathname.endsWith("/mcp") && !pathname.includes("/.well-known/")) {
    const role = tokenRole(c.req.raw);
    if (!role || role === "voice") return c.json({ error: "unauthorized" }, 401);
    if (!OWNER) return c.json({ error: "server not configured: OWNER_USER_ID is unset" }, 500);
    let isInit = false;
    if (role !== "agent" && c.req.method === "POST") { try { const b = await c.req.raw.clone().json(); isInit = !!b && !Array.isArray(b) && b.method === "initialize"; } catch { /* not JSON */ } }
    const res = await (role === "agent" ? agentHttpHandler : httpHandler)(c.req.raw);
    return isInit ? await withInstructions(res) : res;
  }
  // Health check ONLY at the function root. Everything else — crucially the OAuth
  // discovery probes an MCP client fires on connect (/.well-known/oauth-protected-
  // resource, /.well-known/oauth-authorization-server, /register, /authorize,
  // /token) — must 404. If those return 200, the client thinks this server offers
  // an OAuth sign-in service, tries to register an OAuth client, and fails with
  // "couldn't register with the sign-in service". A 404 tells it there is no OAuth
  // here, so it connects using the ?token= URL instead.
  const isRoot = pathname === "/" || pathname === "" ||
    pathname.endsWith("/planner-mcp") || pathname.endsWith("/planner-mcp/");
  if (isRoot) {
    return c.json({
      service: "personal-planner MCP",
      endpoint: ".../functions/v1/planner-mcp/mcp",
      ownerConfigured: !!OWNER,
      tokenConfigured: !!MCP_TOKEN,
      agentTokenConfigured: !!AGENT_TOKEN && AGENT_TOKEN !== MCP_TOKEN,
    });
  }
  return c.json({ error: "not found" }, 404);
});

export default app;
