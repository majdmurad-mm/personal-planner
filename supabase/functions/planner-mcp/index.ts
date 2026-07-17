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
// goals, projects, habits, actions, notes, people) plus read tools for pulling
// the current state. Like the in-app agent, it can create and edit but NEVER
// delete — deletion stays a manual action in the app.
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
const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

// ---- MCP server ------------------------------------------------------------
const mcp = new McpServer({
  name: "personal-planner",
  version: "1.0.0",
  schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType),
});

// ============================ READ TOOLS ====================================

mcp.tool("get_agenda", {
  description:
    "The user's plan for one day (defaults to today, server UTC). Returns actions due that day, overdue open actions, undated open actions (backlog), the habits scheduled for that day (with whether each is already done), and any notes written that day. Start here to understand what's on the user's plate.",
  inputSchema: z.object({
    date: z.string().optional().describe("YYYY-MM-DD; defaults to today (server UTC). Pass the user's local date if it might differ."),
  }),
  handler: async (args: { date?: string }) => {
    const date = args.date || todayUTC();
    const [actionsR, habitsR, notesR] = await Promise.all([
      owned("actions"),
      owned("habits"),
      owned("journal").eq("date", date).order("created_at"),
    ]);
    if (actionsR.error) return fail(actionsR.error.message);
    if (habitsR.error) return fail(habitsR.error.message);
    if (notesR.error) return fail(notesR.error.message);

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
    });

    return ok({
      date,
      actions: {
        dueToday: actions.filter((a) => a.date === date && !a.done).map(slimAction),
        overdue: actions.filter((a) => a.date && a.date < date && !a.done).map(slimAction),
        backlog: actions.filter((a) => !a.date && !a.done).map(slimAction),
      },
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
      timeOfDay: a.time_of_day, area: a.category, parentType: a.parent_type,
      parentId: a.parent_id, done: a.done,
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
      priority: n.priority, timeOfDay: n.time_of_day, sentiment: n.sentiment || [],
    })));
  },
});

mcp.tool("list_people", {
  description: "List people in the user's network. Optionally filter by relationship or a name/notes text search.",
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
      id: p.id, name: p.name, relationship: p.relationship, contact: p.contact,
      notes: p.notes, socialGroup: p.social_group, location: p.location,
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
    const { data, error } = await db.from("goals").insert({
      user_id: OWNER, title: args.title, priority: args.priority, category: args.area,
      due: ongoing ? null : (args.due || null), ongoing,
    }).select().single();
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
    const { error } = await db.from("goals").update(patch).eq("id", args.id).eq("user_id", OWNER);
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
    const { data, error } = await db.from("projects").insert({
      user_id: OWNER, goal_id: args.goalId || null, title: args.title, priority: args.priority,
      due: args.due || null, hours: args.hours || 0, done: false, categories: args.areas || [],
    }).select().single();
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
    const { error } = await db.from("projects").update(patch).eq("id", args.id).eq("user_id", OWNER);
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
    const vr = await db.from("tracker_variables").insert({ user_id: OWNER, name: args.title, type: "boolean" }).select().single();
    if (!vr.error && vr.data) trackerVariableId = vr.data.id;

    const { data, error } = await db.from("habits").insert({
      user_id: OWNER, goal_id: args.goalId || null, title: args.title, priority: args.priority,
      frequency: args.frequency, days: {}, weekdays: args.frequency === "weekly" ? (args.weekdays || []) : null,
      month_day: args.frequency === "monthly" ? Math.max(1, Math.min(31, Math.round(args.monthDay) || 1)) : null,
      custom_interval_days: args.frequency === "custom" ? Math.max(1, Math.round(args.customIntervalDays) || 1) : null,
      time_of_day: args.timeOfDay || null, duration_minutes: args.durationMinutes || null,
      tracker_variable_id: trackerVariableId,
    }).select().single();
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
    const { error } = await db.from("habits").update(patch).eq("id", args.id).eq("user_id", OWNER);
    if (error) return fail(error.message);
    // Keep the linked tracker variable's name in step with a renamed habit.
    if (args.title !== undefined) {
      const h = await owned("habits").eq("id", args.id).maybeSingle();
      if (!h.error && h.data && h.data.tracker_variable_id) {
        await db.from("tracker_variables").update({ name: args.title }).eq("id", h.data.tracker_variable_id).eq("user_id", OWNER);
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
  }),
  handler: async (args: any) => {
    const pt = args.parentType || "none";
    const { data, error } = await db.from("actions").insert({
      user_id: OWNER, title: args.title, type: args.type, priority: args.priority,
      parent_type: pt, parent_id: pt === "none" ? null : (args.parentId || null),
      date: args.date || null, done: false, time_of_day: args.timeOfDay || null,
      duration_minutes: args.durationMinutes || null, category: args.area || null,
    }).select().single();
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id });
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
    if (args.done !== undefined) patch.done = args.done;
    const { error } = await db.from("actions").update(patch).eq("id", args.id).eq("user_id", OWNER);
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
    const { error } = await db.from("actions")
      .update({ done: args.done === undefined ? true : args.done })
      .eq("id", args.id).eq("user_id", OWNER);
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
    timeOfDay: z.string().optional().describe("HH:MM 24h, optional"),
  }),
  handler: async (args: any) => {
    const { data, error } = await db.from("journal").insert({
      user_id: OWNER, date: args.date || todayUTC(), text: args.text,
      title: args.title || null, priority: args.priority || null,
      categories: args.areas || [], time_of_day: args.timeOfDay || null,
    }).select().single();
    if (error) return fail(error.message);
    return ok({ ok: true, id: data.id });
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
    const { data, error } = await db.from("people").insert({
      user_id: OWNER, name: args.name, relationship: args.relationship,
      contact: args.contact || "", notes: args.notes || "", social_group: args.socialGroup || null,
    }).select().single();
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
    const { error } = await db.from("people").update(patch).eq("id", args.id).eq("user_id", OWNER);
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

// ---- HTTP wiring -----------------------------------------------------------
const transport = new StreamableHttpTransport();
const httpHandler = transport.bind(mcp);

const app = new Hono();

// Bearer-token gate. Cowork sends "Authorization: Bearer <MCP_TOKEN>" (configured
// in the connector's Request headers). Anything else is rejected before it can
// reach a tool. If MCP_TOKEN somehow isn't set, fail closed rather than open.
function authorized(req: Request): boolean {
  if (!MCP_TOKEN) return false;
  const header = req.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token === MCP_TOKEN;
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
  return c.json({
    service: "personal-planner MCP",
    endpoint: ".../functions/v1/planner-mcp/mcp",
    ownerConfigured: !!OWNER,
    tokenConfigured: !!MCP_TOKEN,
  });
});

export default app;
