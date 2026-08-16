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
// goals, projects, habits, actions, events, notes, people, decisions) plus read
// tools for pulling the current state. Like the in-app agent, it can create and
// edit but NEVER delete — deletion stays a manual action in the app. That
// includes scenarios and the links between them: link_scenarios can remove an
// arrow (a link is an edit to a row, not a row), but nothing here drops a row.
// ============================================================================

import { Hono } from "hono";
import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

// ---- Secrets / environment -------------------------------------------------
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically into
// every Edge Function; OWNER_USER_ID and MCP_TOKEN you set yourself via
// `supabase secrets set` (see the README).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OWNER = Deno.env.get("OWNER_USER_ID") ?? "";
const MCP_TOKEN = Deno.env.get("MCP_TOKEN") ?? "";

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---- Vocabulary (kept in lockstep with index.html's own constants) ---------
const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
const CATEGORIES = ["Health", "Finance", "Career", "Maintenance", "Growth", "Relationships", "Sol"] as const;
const ACTION_TYPES = ["Call", "Email", "Meeting", "Research", "Write", "Review", "Task", "Follow-up"] as const;
const RELATIONSHIPS = ["Family", "Friend", "Colleague", "Mentor", "Partner", "Other"] as const;
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
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// Mirror of index.html's habitOccursOnDate — MUST stay in step with it so the
// agenda's "habits due today" matches what the app itself shows.
function habitOccursOnDate(h: any, dateStr: string): boolean {
  const skip: string[] = h.skip_dates || [];
  const extra: string[] = h.extra_dates || [];
  if (skip.indexOf(dateStr) !== -1) return false;
  if (extra.indexOf(dateStr) !== -1) return true;
  const createdAt = h.created_at ? String(h.created_at).slice(0, 10) : null;
  if (createdAt && dateStr < createdAt) return false;
  if (h.frequency === "weekly") {
    return (h.weekdays || []).indexOf(WEEKDAY_ABBR[new Date(dateStr + "T00:00:00").getDay()]) !== -1;
  }
  if (h.frequency === "monthly") {
    const d = new Date(dateStr + "T00:00:00");
    const lastDayOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const targetDay = Math.min(h.month_day || 1, lastDayOfMonth);
    return d.getDate() === targetDay;
  }
  if (h.frequency === "custom" && createdAt) {
    const interval = h.custom_interval_days || 1;
    const daysSince = Math.round(
      (new Date(dateStr + "T00:00:00").getTime() - new Date(createdAt + "T00:00:00").getTime()) / 86400000,
    );
    return daysSince % interval === 0;
  }
  return true;
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
// stay in step with them, for the same reason habitOccursOnDate above does: a number
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

// ---- MCP server ------------------------------------------------------------
const mcp = new McpServer({
  name: "personal-planner",
  version: "1.0.0",
  schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType),
});

// ============================ READ TOOLS ====================================

mcp.tool("get_agenda", {
  description:
    "The user's plan for one day (defaults to today, server UTC). Returns actions due that day, overdue open actions, undated open actions (backlog), the habits scheduled for that day (with whether each is already done), the events happening that day, and any notes written that day. Start here to understand what's on the user's plate.",
  inputSchema: z.object({
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today (server UTC). Pass the user's local date if it might differ."),
  }),
  handler: async (args: { date?: string }) => {
    const date = args.date || todayUTC();
    const [actionsR, habitsR, notesR, eventsR] = await Promise.all([
      owned("actions"),
      owned("habits"),
      owned("journal").eq("date", date).order("created_at"),
      owned("events").eq("date", date),
    ]);
    if (actionsR.error) return fail(actionsR.error.message);
    if (habitsR.error) return fail(habitsR.error.message);
    if (notesR.error) return fail(notesR.error.message);
    // Events are tolerated as missing rather than fatal: the table only exists once
    // migration_events.sql has been run, and an agenda without events is still useful.
    const events = eventsR.error ? [] : (eventsR.data || []);

    const actions = actionsR.data || [];
    const habits = (habitsR.data || []).filter((h) => habitOccursOnDate(h, date));

    // Habit completion lives in tracker_entries keyed by the habit's linked
    // tracker_variable_id — pull that day's entries to mark each habit done/undone.
    const varIds = habits.map((h) => h.tracker_variable_id).filter(Boolean);
    const doneVarIds = new Set<string>();
    if (varIds.length) {
      const entR = await owned("tracker_entries").eq("date", date).in("variable_id", varIds);
      for (const e of entR.data || []) {
        // The app stores boolean habit completion as the string "true"/"1"; treat any non-empty, non-"false"/"0" as done.
        const v = String(e.value).toLowerCase();
        if (v && v !== "false" && v !== "0") doneVarIds.add(e.variable_id);
      }
    }

    const slimAction = (a: any) => ({
      id: a.id, title: a.title, type: a.type, priority: a.priority,
      date: a.date, timeOfDay: a.time_of_day, area: a.category,
      parentType: a.parent_type, parentId: a.parent_id, done: a.done,
      isMilestone: !!a.is_milestone, isDecision: !!a.is_decision,
    });

    return ok({
      date,
      actions: {
        dueToday: actions.filter((a) => a.date === date && !a.done).map(slimAction),
        overdue: actions.filter((a) => a.date && a.date < date && !a.done).map(slimAction),
        backlog: actions.filter((a) => !a.date && !a.done).map(slimAction),
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
      habitsDue: habits.map((h) => ({
        id: h.id, title: h.title, priority: h.priority, frequency: h.frequency,
        timeOfDay: h.time_of_day, done: h.tracker_variable_id ? doneVarIds.has(h.tracker_variable_id) : false,
      })),
      notes: (notesR.data || []).map((n) => ({
        id: n.id, title: n.title, text: n.text, areas: n.categories || [],
        priority: n.priority, timeOfDay: n.time_of_day, sentiment: n.sentiment || [],
      })),
    });
  },
});

mcp.tool("list_goals", {
  description: "List the user's goals. Optionally filter by area (category).",
  inputSchema: z.object({
    area: z.enum(CATEGORIES).optional().describe("only goals in this area"),
  }),
  handler: async (args: { area?: string }) => {
    let q = owned("goals").order("position");
    if (args.area) q = q.eq("category", args.area);
    const { data, error } = await q;
    if (error) return fail(error.message);
    return ok((data || []).map((g) => ({
      id: g.id, title: g.title, priority: g.priority, area: g.category,
      due: g.due, ongoing: g.ongoing, secondaryAreas: g.secondary_categories || [],
      milestones: g.milestones || [],
    })));
  },
});

mcp.tool("list_projects", {
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

mcp.tool("list_habits", {
  description: "List the user's recurring habits and their schedules.",
  inputSchema: z.object({}),
  handler: async () => {
    const { data, error } = await owned("habits").order("position");
    if (error) return fail(error.message);
    return ok((data || []).map((h) => ({
      id: h.id, title: h.title, goalId: h.goal_id, priority: h.priority,
      frequency: h.frequency, weekdays: h.weekdays || [], monthDay: h.month_day,
      customIntervalDays: h.custom_interval_days, timeOfDay: h.time_of_day,
      durationMinutes: h.duration_minutes,
    })));
  },
});

mcp.tool("list_actions", {
  description: "List the user's actions (tasks), most recent first. Filter by done state and/or date range.",
  inputSchema: z.object({
    done: z.boolean().optional().describe("filter by completion state; omit for both"),
    from: z.string().optional().describe("YYYY-MM-DD inclusive lower bound on the action's date"),
    to: z.string().optional().describe("YYYY-MM-DD inclusive upper bound on the action's date"),
    area: z.enum(CATEGORIES).optional(),
    limit: z.number().optional().describe("max rows (default 100)"),
  }),
  handler: async (args: { done?: boolean; from?: string; to?: string; area?: string; limit?: number }) => {
    let q = owned("actions").order("date", { ascending: false, nullsFirst: false });
    if (args.done !== undefined) q = q.eq("done", args.done);
    if (args.from) q = q.gte("date", args.from);
    if (args.to) q = q.lte("date", args.to);
    if (args.area) q = q.eq("category", args.area);
    q = q.limit(args.limit && args.limit > 0 ? args.limit : 100);
    const { data, error } = await q;
    if (error) return fail(error.message);
    return ok((data || []).map((a) => ({
      id: a.id, title: a.title, type: a.type, priority: a.priority, date: a.date,
      timeOfDay: a.time_of_day, durationMinutes: a.duration_minutes, area: a.category,
      secondaryAreas: a.secondary_categories || [],
      parentType: a.parent_type, parentId: a.parent_id, done: a.done,
      isMilestone: !!a.is_milestone,
      // An action flagged as a decision is a fork the user hasn't settled, not a task
      // they're about to do — call get_decision on it to see the scenarios and scores.
      isDecision: !!a.is_decision,
      // [{id, requiresDone}] — a hard prerequisite (requiresDone) blocks this action
      // until the other one is done; a plain link is only an ordering hint.
      dependencies: a.dependencies || [],
      notes: a.notes_md || "",
      locationAddress: a.location_address || null, lat: a.location_lat, lng: a.location_lng,
    })));
  },
});

mcp.tool("list_notes", {
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
    })));
  },
});

mcp.tool("list_people", {
  description: "List people in the user's network, with their full profile fields. Optionally filter by relationship or a name search.",
  inputSchema: z.object({
    relationship: z.enum(RELATIONSHIPS).optional(),
    query: z.string().optional().describe("case-insensitive substring match on the person's name"),
    limit: z.number().optional().describe("max rows (default 100)"),
  }),
  handler: async (args: { relationship?: string; query?: string; limit?: number }) => {
    let q = owned("people").order("position");
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
    })));
  },
});

mcp.tool("get_tracker", {
  description: "The user's self-tracking variables (mood, metrics, habits) and their logged entries over a date range (defaults to the last 14 days).",
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

mcp.tool("list_events", {
  description:
    "List the user's events. An event is something that HAPPENS at a time — a meeting, an appointment, a trip — not a task to complete: it has no done state and no priority. Use this (not list_actions) when the user asks what's on their calendar.",
  inputSchema: z.object({
    from: z.string().optional().describe("YYYY-MM-DD inclusive lower bound on the event's date"),
    to: z.string().optional().describe("YYYY-MM-DD inclusive upper bound on the event's date"),
    area: z.enum(CATEGORIES).optional(),
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
    })));
  },
});

mcp.tool("list_decisions", {
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

mcp.tool("get_decision", {
  description:
    "One decision's full scenario canvas: every scenario with its weighted advantages and disadvantages, its computed net score and rank, and the branching links between them. Weights are 1-5 for HOW MUCH SOMETHING MATTERS, not how likely it is; net score = summed advantages minus summed disadvantages. Scenarios with nothing weighed are reported scored:false and left out of the ranking.",
  inputSchema: z.object({
    actionId: z.string().describe("id of the action flagged as a decision (from list_decisions)"),
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

mcp.tool("list_pois", {
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

mcp.tool("list_located_items", {
  description:
    "Everything in the planner that carries a location, in one place: saved places, the actions/habits/events that have an address, and the people with a home location. Use this to answer 'what do I have near X' or 'where is everything'.",
  inputSchema: z.object({
    kinds: z.array(z.enum(["place", "action", "habit", "event", "person"])).optional()
      .describe("restrict to these kinds; omit for all"),
  }),
  handler: async (args: { kinds?: string[] }) => {
    const want = (k: string) => !args.kinds || !args.kinds.length || args.kinds.indexOf(k) !== -1;
    const [poisR, actionsR, habitsR, eventsR, peopleR] = await Promise.all([
      want("place") ? owned("points_of_interest") : Promise.resolve({ data: [], error: null } as any),
      want("action") ? owned("actions") : Promise.resolve({ data: [], error: null } as any),
      want("habit") ? owned("habits") : Promise.resolve({ data: [], error: null } as any),
      want("event") ? owned("events") : Promise.resolve({ data: [], error: null } as any),
      want("person") ? owned("people") : Promise.resolve({ data: [], error: null } as any),
    ]);
    // Any one of these tables may predate its migration; a partial map beats a hard failure.
    const rows = (r: any) => (r && !r.error && r.data) ? r.data : [];
    const located: any[] = [];
    rows(poisR).forEach((p: any) => located.push({
      kind: "place", id: p.id, title: p.name, lat: p.lat, lng: p.lng, address: null, notes: p.notes || "",
    }));
    [["action", actionsR], ["habit", habitsR], ["event", eventsR]].forEach(([kind, r]: any) => {
      rows(r).forEach((x: any) => {
        if (x.location_lat == null && x.location_lng == null && !x.location_address) return;
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

mcp.tool("get_location_history", {
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

mcp.tool("geocode_address", {
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

mcp.tool("get_finance", {
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

// ============================ WRITE TOOLS ===================================
// These mirror the app's in-page Agent tools (executeAgentTool in index.html).
// Every insert sets user_id explicitly because the service-role client has no
// auth.uid() to fall back on for the column default.

mcp.tool("create_goal", {
  description: "Create a new goal.",
  inputSchema: z.object({
    title: z.string(),
    priority: z.enum(PRIORITIES),
    area: z.enum(CATEGORIES).describe("the goal's primary area (category)"),
    due: z.string().optional().describe("YYYY-MM-DD; omit if ongoing or no due date"),
    ongoing: z.boolean().optional(),
  }),
  handler: async (args: { title: string; priority: string; area: string; due?: string; ongoing?: boolean }) => {
    const ongoing = !!args.ongoing;
    const { data, error } = await safeWrite((p) => db.from("goals").insert(p).select().single(), {
      user_id: OWNER, title: args.title, priority: args.priority, category: args.area,
      due: ongoing ? null : (args.due || null), ongoing,
    });
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id });
  },
});

mcp.tool("edit_goal", {
  description: "Edit an existing goal by id. Only the fields you pass are changed.",
  inputSchema: z.object({
    id: z.string(),
    title: z.string().optional(),
    priority: z.enum(PRIORITIES).optional(),
    area: z.enum(CATEGORIES).optional(),
    due: z.string().optional(),
    ongoing: z.boolean().optional(),
  }),
  handler: async (args: any) => {
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.area !== undefined) patch.category = args.area;
    if (args.due !== undefined) patch.due = args.due || null;
    if (args.ongoing !== undefined) patch.ongoing = args.ongoing;
    if (args.ongoing === true) patch.due = null;
    const { error } = await safeWrite((p) => db.from("goals").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

mcp.tool("create_project", {
  description: "Create a new project, optionally attached to a goal.",
  inputSchema: z.object({
    title: z.string(),
    priority: z.enum(PRIORITIES),
    goalId: z.string().optional().describe("id of the parent goal; omit for no parent"),
    due: z.string().optional(),
    hours: z.number().optional(),
    areas: z.array(z.enum(CATEGORIES)).optional().describe("the project's own area(s); omit to inherit the parent goal's area"),
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

mcp.tool("edit_project", {
  description: "Edit an existing project by id. Only the fields you pass are changed.",
  inputSchema: z.object({
    id: z.string(),
    title: z.string().optional(),
    goalId: z.string().optional(),
    priority: z.enum(PRIORITIES).optional(),
    due: z.string().optional(),
    hours: z.number().optional(),
    done: z.boolean().optional(),
    areas: z.array(z.enum(CATEGORIES)).optional(),
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

mcp.tool("create_habit", {
  description: "Create a new recurring habit, optionally attached to a goal. Also creates the linked tracker variable the app uses to record completions.",
  inputSchema: z.object({
    title: z.string(),
    priority: z.enum(PRIORITIES),
    frequency: z.enum(["daily", "weekly", "monthly", "custom"]),
    goalId: z.string().optional(),
    weekdays: z.array(z.enum(WEEKDAY_ABBR as unknown as [string, ...string[]])).optional()
      .describe('for weekly: which days, e.g. ["Mon","Wed","Fri"]'),
    monthDay: z.number().optional().describe("for monthly: day of month 1-31 (clamped to the last day in shorter months)"),
    customIntervalDays: z.number().optional().describe("for custom: repeat every N days from creation"),
    timeOfDay: z.string().optional().describe("HH:MM 24h, optional"),
    durationMinutes: z.number().optional(),
  }),
  handler: async (args: any) => {
    // Mirror the app: each habit gets its own boolean tracker variable so day-by-day
    // completion can live in tracker_entries.
    let trackerVariableId: string | null = null;
    const vr = await safeWrite((p) => db.from("tracker_variables").insert(p).select().single(), { user_id: OWNER, name: args.title, type: "boolean" });
    if (!vr.error && vr.data) trackerVariableId = vr.data.id;

    const { data, error } = await safeWrite((p) => db.from("habits").insert(p).select().single(), {
      user_id: OWNER, goal_id: args.goalId || null, title: args.title, priority: args.priority,
      frequency: args.frequency, days: {}, weekdays: args.frequency === "weekly" ? (args.weekdays || []) : null,
      month_day: args.frequency === "monthly" ? Math.max(1, Math.min(31, Math.round(args.monthDay) || 1)) : null,
      custom_interval_days: args.frequency === "custom" ? Math.max(1, Math.round(args.customIntervalDays) || 1) : null,
      time_of_day: args.timeOfDay || null, duration_minutes: args.durationMinutes || null,
      tracker_variable_id: trackerVariableId,
    });
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id });
  },
});

mcp.tool("edit_habit", {
  description: "Edit an existing habit by id. Only the fields you pass are changed.",
  inputSchema: z.object({
    id: z.string(),
    title: z.string().optional(),
    goalId: z.string().optional(),
    priority: z.enum(PRIORITIES).optional(),
    frequency: z.enum(["daily", "weekly", "monthly", "custom"]).optional(),
    weekdays: z.array(z.enum(WEEKDAY_ABBR as unknown as [string, ...string[]])).optional(),
    monthDay: z.number().optional(),
    customIntervalDays: z.number().optional(),
    timeOfDay: z.string().optional(),
    durationMinutes: z.number().optional(),
  }),
  handler: async (args: any) => {
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.goalId !== undefined) patch.goal_id = args.goalId || null;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.frequency !== undefined) patch.frequency = args.frequency;
    if (args.weekdays !== undefined) patch.weekdays = args.weekdays;
    if (args.monthDay !== undefined) patch.month_day = Math.max(1, Math.min(31, Math.round(args.monthDay) || 1));
    if (args.customIntervalDays !== undefined) patch.custom_interval_days = args.customIntervalDays;
    if (args.timeOfDay !== undefined) patch.time_of_day = args.timeOfDay || null;
    if (args.durationMinutes !== undefined) patch.duration_minutes = args.durationMinutes;
    const { error } = await safeWrite((p) => db.from("habits").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    // Keep the linked tracker variable's name in step with a renamed habit.
    if (args.title !== undefined) {
      const h = await owned("habits").eq("id", args.id).maybeSingle();
      if (!h.error && h.data && h.data.tracker_variable_id) {
        await safeWrite((p) => db.from("tracker_variables").update(p).eq("id", h.data.tracker_variable_id).eq("user_id", OWNER), { name: args.title });
      }
    }
    return ok({ ok: true });
  },
});

mcp.tool("create_action", {
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
    area: z.enum(CATEGORIES).optional().describe("the action's own area; otherwise inferred from its parent"),
    secondaryAreas: z.array(z.enum(CATEGORIES)).optional().describe("other areas this action also touches"),
    isMilestone: z.boolean().optional().describe("mark it a milestone — a dated checkpoint rather than ordinary work"),
    isDecision: z.boolean().optional().describe("mark it a decision — a fork with a scenario canvas rather than a task. Add scenarios with create_scenario."),
    notes: z.string().optional().describe("longer free-form notes for the action's own page (Markdown)"),
    location: z.string().optional().describe("where it happens — an address or place name, geocoded for you and pinned on the Location map"),
  }),
  handler: async (args: any) => {
    const pt = args.parentType || "none";
    const place = await resolvePlace({ address: args.location });
    if (place.error) return fail(place.error);
    const { data, error } = await safeWrite((p) => db.from("actions").insert(p).select().single(), {
      user_id: OWNER, title: args.title, type: args.type, priority: args.priority,
      parent_type: pt, parent_id: pt === "none" ? null : (args.parentId || null),
      date: args.date || null, done: false, time_of_day: args.timeOfDay || null,
      duration_minutes: args.durationMinutes || null, category: args.area || null,
      secondary_categories: args.secondaryAreas || [],
      is_milestone: !!args.isMilestone, is_decision: !!args.isDecision,
      notes_md: args.notes || "",
      location_address: place.address, location_lat: place.lat, location_lng: place.lng,
    });
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id, lat: place.lat, lng: place.lng });
  },
});

mcp.tool("edit_action", {
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
    area: z.enum(CATEGORIES).optional(),
    secondaryAreas: z.array(z.enum(CATEGORIES)).optional().describe("replaces the existing set"),
    isMilestone: z.boolean().optional(),
    notes: z.string().optional().describe("free-form notes for the action's own page (Markdown); replaces what's there"),
    done: z.boolean().optional(),
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
    if (Object.keys(patch).length === 0) return fail("nothing to update — pass at least one field");
    const { error } = await safeWrite((p) => db.from("actions").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

mcp.tool("complete_action", {
  description: "Mark an action done (or not done). Convenience wrapper over edit_action.",
  inputSchema: z.object({
    id: z.string(),
    done: z.boolean().optional().describe("defaults to true"),
  }),
  handler: async (args: { id: string; done?: boolean }) => {
    const { error } = await safeWrite((p) => db.from("actions").update(p).eq("id", args.id).eq("user_id", OWNER), { done: args.done === undefined ? true : args.done });
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

// ---- Events ----------------------------------------------------------------

mcp.tool("create_event", {
  description:
    "Create an event — something that HAPPENS at a time (a meeting, an appointment, a trip). Use this rather than create_action when there is nothing to complete: an event has no done state and no priority. If the user needs to DO something, that's an action.",
  inputSchema: z.object({
    title: z.string(),
    date: z.string().optional().describe("YYYY-MM-DD when it happens"),
    timeOfDay: z.string().optional().describe("HH:MM 24h, optional"),
    durationMinutes: z.number().optional(),
    area: z.enum(CATEGORIES).optional().describe("the event's primary area"),
    secondaryAreas: z.array(z.enum(CATEGORIES)).optional(),
    location: z.string().optional().describe("where it happens — an address or place name, geocoded for you and pinned on the Location map"),
    linkedPeopleIds: z.array(z.string()).optional().describe("ids from list_people — who it's with"),
    notes: z.string().optional(),
  }),
  handler: async (args: any) => {
    const place = await resolvePlace({ address: args.location });
    if (place.error) return fail(place.error);
    const { data, error } = await safeWrite((p) => db.from("events").insert(p).select().single(), {
      user_id: OWNER, title: args.title, date: args.date || null,
      time_of_day: args.timeOfDay || null, duration_minutes: args.durationMinutes || null,
      category: args.area || null, secondary_categories: args.secondaryAreas || [],
      location_address: place.address, location_lat: place.lat, location_lng: place.lng,
      linked_people_ids: args.linkedPeopleIds || [], notes_md: args.notes || "",
    });
    if (error) return fail(error.message + " (has migration_events.sql been run?)");
    return ok({ ok: true, id: data.id, lat: place.lat, lng: place.lng });
  },
});

mcp.tool("edit_event", {
  description: "Edit an existing event by id (reschedule, rename, move). Only the fields you pass are changed.",
  inputSchema: z.object({
    id: z.string(),
    title: z.string().optional(),
    date: z.string().optional().describe("YYYY-MM-DD; pass an empty string to clear it"),
    timeOfDay: z.string().optional().describe("HH:MM 24h; pass an empty string to clear it"),
    durationMinutes: z.number().optional(),
    area: z.enum(CATEGORIES).optional(),
    secondaryAreas: z.array(z.enum(CATEGORIES)).optional().describe("replaces the existing set"),
    location: z.string().optional().describe("new address or place name, geocoded for you; pass an empty string to remove the location"),
    linkedPeopleIds: z.array(z.string()).optional().describe("replaces the existing set"),
    notes: z.string().optional(),
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
    if (Object.keys(patch).length === 0) return fail("nothing to update — pass at least one field");
    const { error } = await safeWrite((p) => db.from("events").update(p).eq("id", args.id).eq("user_id", OWNER), patch);
    if (error) return fail(error.message);
    return ok({ ok: true });
  },
});

// ---- Decisions and their scenarios -----------------------------------------

mcp.tool("set_action_decision", {
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

mcp.tool("create_scenario", {
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

mcp.tool("edit_scenario", {
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

mcp.tool("link_scenarios", {
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

mcp.tool("add_note", {
  description: "Add a new note (journal entry). Defaults the date to today.",
  inputSchema: z.object({
    text: z.string(),
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today (server UTC)"),
    title: z.string().optional().describe("optional short heading"),
    priority: z.enum(PRIORITIES).optional(),
    areas: z.array(z.enum(CATEGORIES)).optional().describe("optional area(s); a note can span more than one"),
    noteType: z.enum(NOTE_TYPES).optional()
      .describe("what kind of note this is (default reflection). Only 'reflection' gets sentiment analysis in the app — a reference or a decision record isn't a mood."),
    timeOfDay: z.string().optional().describe("HH:MM 24h, optional"),
  }),
  handler: async (args: any) => {
    const { data, error } = await safeWrite((p) => db.from("journal").insert(p).select().single(), {
      user_id: OWNER, date: args.date || todayUTC(), text: args.text,
      title: args.title || null, priority: args.priority || null,
      categories: args.areas || [], note_type: args.noteType || "reflection",
      time_of_day: args.timeOfDay || null,
    });
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id });
  },
});

mcp.tool("edit_note", {
  description: "Edit an existing note (journal entry) by id. Only the fields you pass are changed. (Sentiment tags and note-tag links are managed by the app and left untouched.)",
  inputSchema: z.object({
    id: z.string(),
    text: z.string().optional(),
    title: z.string().optional().describe("short heading; pass an empty string to clear it"),
    priority: z.enum(PRIORITIES).optional(),
    areas: z.array(z.enum(CATEGORIES)).optional().describe("the note's area(s); replaces the existing set"),
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

mcp.tool("create_person", {
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

mcp.tool("edit_person", {
  description: "Edit an existing person by id. Only the fields you pass are changed.",
  inputSchema: z.object({
    id: z.string(),
    name: z.string().optional(),
    relationship: z.enum(RELATIONSHIPS).optional(),
    contact: z.string().optional(),
    notes: z.string().optional(),
    socialGroup: z.string().optional(),
  }),
  handler: async (args: any) => {
    const patch: Record<string, unknown> = {};
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

mcp.tool("log_metric", {
  description: "Record a self-tracking value for a date (mood, weight, a habit's completion, etc.). The variable must already exist — call get_tracker to see available variables and their ids. Upserts, so re-logging the same day overwrites.",
  inputSchema: z.object({
    variableId: z.string().describe("id of an existing tracker variable (from get_tracker)"),
    value: z.string().describe('the value as text — e.g. "4", "true", "72.5", or a category label'),
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today (server UTC)"),
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

mcp.tool("create_place", {
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

mcp.tool("edit_place", {
  description:
    "Edit a saved place by id — rename it, move it, or change its notes. Only the fields you pass are changed. Passing `address` re-geocodes and moves the pin; passing `lat`/`lng` moves it to exactly those coordinates.",
  inputSchema: z.object({
    id: z.string().describe("the place's id (from list_pois)"),
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

mcp.tool("set_item_location", {
  description:
    "Attach a location to an action, habit, event, or person (a person's is their home). Give an `address` and it's geocoded; pass `lat`/`lng` only if you already know them. Pass `clear: true` to remove the location instead.",
  inputSchema: z.object({
    kind: z.enum(["action", "habit", "event", "person"]),
    id: z.string(),
    address: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    clear: z.boolean().optional().describe("remove the location from this item"),
  }),
  handler: async (args: any) => {
    const TABLES: Record<string, string> = { action: "actions", habit: "habits", event: "events", person: "people" };
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

mcp.tool("log_transaction", {
  description:
    "Record a finance transaction against an existing account. Amount is POSITIVE for money in and NEGATIVE for money out — a €12 lunch is -12. Call get_finance first for account ids.",
  inputSchema: z.object({
    accountId: z.string().describe("id of an existing account (from get_finance)"),
    amount: z.number().describe("positive = money in, negative = money out"),
    description: z.string(),
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today (server UTC)"),
    area: z.enum(CATEGORIES).optional().describe("which life area this spend belongs to"),
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

// ---- HTTP wiring -----------------------------------------------------------
const transport = new StreamableHttpTransport();
const httpHandler = transport.bind(mcp);

const app = new Hono();

// Token gate. The token may arrive any of three ways, and any of them is accepted:
//   1. Authorization: Bearer <MCP_TOKEN>            — clients that let you set a header.
//   2. ?token=<MCP_TOKEN> in the URL query string   — clients that only take a URL.
//   3. as the path segment right before /mcp:
//        .../functions/v1/planner-mcp/<MCP_TOKEN>/mcp
//      — the most robust option, because some clients (the claude.ai web connector
//      appears to be one) drop the query string when they call the endpoint, but the
//      URL PATH is always preserved. If MCP_TOKEN isn't set, fail closed.
function authorized(req: Request): boolean {
  if (!MCP_TOKEN) return false;
  const url = new URL(req.url);
  const header = req.headers.get("authorization") || "";
  const headerToken = header.replace(/^Bearer\s+/i, "").trim();
  if (headerToken && headerToken === MCP_TOKEN) return true;
  const queryToken = url.searchParams.get("token");
  if (queryToken && queryToken === MCP_TOKEN) return true;
  const pathMatch = url.pathname.match(/\/([^/]+)\/mcp$/);
  if (pathMatch && pathMatch[1] === MCP_TOKEN) return true;
  return false;
}

// Path-agnostic routing. Depending on the Supabase runtime version, the Hono app
// may see the request path WITH the function-name prefix (/planner-mcp/mcp) or
// WITHOUT it (/mcp) — so instead of mounting under a fixed prefix, we match on the
// path suffix. Any path ending in /mcp is the MCP endpoint (bearer-gated);
// everything else is the unauthenticated health check.
app.all("*", async (c) => {
  const pathname = new URL(c.req.url).pathname;
  if (pathname.endsWith("/mcp")) {
    if (!authorized(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
    if (!OWNER) return c.json({ error: "server not configured: OWNER_USER_ID is unset" }, 500);
    return await httpHandler(c.req.raw);
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
    });
  }
  return c.json({ error: "not found" }, 404);
});

export default app;
