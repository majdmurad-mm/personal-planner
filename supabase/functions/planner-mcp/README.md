# Planner MCP connector for Claude Cowork

This Edge Function (`planner-mcp`) is a **remote MCP server** that lets Claude
Cowork (or any MCP client) read and edit your planner's data — the same data the
app stores in Supabase. Once deployed and added as a custom connector, you can
say things in Cowork like *"what's on my plate today?"*, *"add a P1 task to call
the accountant tomorrow"*, or *"log my mood as 4 for today"*, and it acts on your
real planner.

It can **create and edit** goals, projects, habits, actions, events, notes,
people, decisions and their scenarios, places, tracker entries and finance
transactions — but it can **never delete** anything (deletion stays a manual
action in the app), mirroring the app's own in-page agent.

---

## How the security works (read this once)

- The function talks to Postgres with the **service-role key**, which is injected
  automatically by Supabase and **never leaves the server** — Cowork never sees it.
- Every read and write is **hard-scoped to one user id** (`OWNER_USER_ID`), so the
  connector can only ever touch your own rows.
- Access is gated by a **bearer token** (`MCP_TOKEN`) that you generate. Cowork
  sends it in an `Authorization` header. Without the exact token, every request is
  rejected with 401.
- **No secrets live in this repo.** The token and owner id are set as Supabase
  secrets, not committed.

---

## One-time setup

### 0. Prerequisites

- The [Supabase CLI](https://supabase.com/docs/guides/cli) installed
  (`npm i -g supabase` or `scoop install supabase` / `brew install supabase/tap/supabase`).
- Your Supabase **project ref** (Dashboard → Project Settings → General → "Reference ID",
  or it's the `xxxx` in `https://xxxx.supabase.co`).
- A **paid Claude plan** (Cowork custom connectors need Pro/Max/Team/Enterprise).

### 1. Find your owner user id

Dashboard → **Authentication → Users** → click your user → copy the **UID**.

(Or run in the SQL editor: `select id, email from auth.users;` and copy your `id`.)

### 2. Generate a bearer token

Any long random string. For example:

```bash
openssl rand -hex 32
```

Keep it somewhere safe (a password manager) — you'll paste it into Cowork later.

### 3. Link the project and set the secrets

From the repo root:

```bash
supabase link --project-ref <your-project-ref>

supabase secrets set \
  OWNER_USER_ID="<the-uid-from-step-1>" \
  MCP_TOKEN="<the-token-from-step-2>"
```

> Do **not** set `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` — Supabase injects
> those into every function automatically.

### 4. Deploy

```bash
supabase functions deploy planner-mcp
```

`config.toml` already sets `verify_jwt = false` for this function (it does its own
bearer-token auth), so no extra flag is needed. If your CLI version ignores that,
deploy with `supabase functions deploy planner-mcp --no-verify-jwt`.

Your endpoint is now:

```
https://<your-project-ref>.supabase.co/functions/v1/planner-mcp/mcp
```

### 5. (Optional) Smoke-test before wiring up Cowork

```bash
npx @modelcontextprotocol/inspector
```

Connect it to the URL above with a header `Authorization: Bearer <MCP_TOKEN>` and
confirm the tool list loads and `get_agenda` returns data.

---

## Add it to Claude

The claude.ai web "Add custom connector" form only takes a **URL** (plus optional
OAuth) — it has **no request-headers field**, and it **drops the query string** when
it calls the endpoint — so the token goes in the URL **path**, as the segment right
before `/mcp`. (The server also still accepts the token as an `Authorization: Bearer`
header or a `?token=` query param, for clients that support those.)

1. In Claude, go to **Customize → Connectors**.
2. Click **Add → Add custom connector**.
3. **Name:** `Personal Planner`
4. **Remote MCP server URL** — token as a path segment before `/mcp`:
   ```
   https://<your-project-ref>.supabase.co/functions/v1/planner-mcp/<your MCP_TOKEN>/mcp
   ```
   (Leave the OAuth "Advanced settings" empty.)
5. Click **Add**, then **Connect**, then enable the connector in a chat via the
   connectors menu.

> Putting the token in the URL is fine for a personal, single-user connector, but it
> does mean the token can appear in server request logs. Rotate it anytime with
> `supabase secrets set MCP_TOKEN="<new>"` + redeploy, then update the connector URL.
> If a client ever changes the connector's URL, remove and re-add it (there's no edit).

## Make Cowork "keep it in mind"

In **Settings → Cowork → global instructions** (or a folder's instructions), add
something like:

> You have a "Personal Planner" connector wired to my planner app. When I ask
> about my day, tasks, habits, goals, or mood, use it — start with `get_agenda`.
> When I ask you to schedule or capture something, create it with the right tool.
> Never delete anything; if I ask to delete, tell me to do it in the app.

Now every Cowork session starts already grounded in your planner, and you can use
Cowork's **`/schedule`** to run recurring jobs (e.g. a nightly *"summarize what I
did today and lay out tomorrow"*).

---

## Tool reference

**Read:** `get_agenda`, `list_goals`, `list_projects`, `list_habits`,
`list_actions`, `list_events`, `list_notes`, `list_people`, `list_decisions`,
`get_decision`, `list_pois`, `list_located_items`, `get_location_history`,
`geocode_address`, `get_tracker`, `get_finance`

**Write (create/edit only — never delete):** `create_goal`, `edit_goal`,
`create_project`, `edit_project`, `create_habit`, `edit_habit`, `create_action`,
`edit_action`, `complete_action`, `create_event`, `edit_event`,
`set_action_decision`, `create_scenario`, `edit_scenario`, `link_scenarios`,
`add_note`, `edit_note`, `create_person`, `edit_person`, `log_metric`,
`create_place`, `edit_place`, `set_item_location`, `log_transaction`

### The distinctions worth knowing

- **Action vs. event.** An action is something you *complete* — it has a priority
  and a done state. An event is something that *happens* at a time (a meeting, an
  appointment, a trip) and has neither. "Book the dentist" is an action; "dentist,
  Tuesday 9am" is an event. `get_agenda` returns them as separate lists.
- **Decisions.** An action flagged `is_decision` is a fork the user hasn't settled,
  with a canvas of *scenarios* — plausible futures — branching off it.
  `list_decisions` finds them, `get_decision` returns one canvas in full.
- **Scenario weights are importance, not probability.** Each advantage and
  disadvantage carries a weight 1–5 meaning *how much it matters*. Net score is
  summed advantages minus summed disadvantages, and the branches are ranked by it.
  A scenario with nothing weighed comes back `scored: false` and is left out of the
  ranking rather than competing on a zero it never earned. Ties share a rank.
  Out-of-range weights are clamped; a missing one defaults to 3.
- **`edit_scenario` replaces whole lists.** Passing `advantages` overwrites all of
  them — read the current set with `get_decision` first if you mean to add one.
- **Money direction.** `log_transaction` takes a *positive* amount for money in and
  a *negative* one for money out; a €12 lunch is `-12`.
- **Locations are given as addresses, not coordinates.** Every location tool takes an
  `address` and geocodes it server-side through the same OpenStreetMap (Nominatim)
  endpoint the app's own address box uses. Explicit `lat`/`lng` are accepted and win
  when supplied, but they exist for cases where the exact coordinates are already
  known — a model should pass the address and let the server resolve it, never guess
  coordinates. If the geocoder can't find it or is unreachable, the tool says so and
  names the fallback instead of silently dropping a pin in the wrong place.
- **Places vs. item locations.** `create_place` / `edit_place` manage the standalone
  named pins on the Location map. `set_item_location` attaches a location to an
  existing action, habit, event, or person (a person's is their home), or clears one
  with `clear: true`. `create_action` and `create_event` also take a `location`
  directly, so "lunch with Sam at Café Central on Friday" is a single call.
- **`list_located_items`** is the one-call answer to "where is everything" — places,
  located actions/habits/events, and people's homes in a single list.
- **`get_location_history`** returns the user's own recorded positions, evenly
  sampled down (default 300 points) rather than truncated, so a week's data reads as
  a week rather than as one dense afternoon.

## Rotating or revoking access

- **Rotate the token:** `supabase secrets set MCP_TOKEN="<new-token>"`, redeploy,
  then update the header value in the Cowork connector.
- **Revoke entirely:** delete the connector in Cowork, and/or
  `supabase functions delete planner-mcp`.

## Notes / limitations

- Server-side "today" is **UTC**. Near midnight your local date can differ; tools
  that default to today (`get_agenda`, `add_note`, `log_metric`) also accept an
  explicit `date`, and Cowork will usually pass your local date.
- `habitOccursOnDate` here is a mirror of the same function in `index.html`. If you
  change habit-scheduling rules in the app, update it here too so the agenda stays
  in sync. The same goes for the decision-canvas scoring (`scenarioNetScore`,
  `scenarioIsScored`, `scenarioRankMap`, `scenarioLinksTo`) and the canvas layout
  constants (`SC_ORIGIN_X` and friends) — a score reported here that disagrees with
  what's on screen is worse than no score at all.
- **Tools whose tables need a migration first.** `list_events` / `create_event` /
  `edit_event` need `migration_events.sql`; the decision tools need
  `migration_action_scenarios.sql`. Until those are run, those tools return an error
  naming the migration, and `get_agenda` simply omits the events list rather than
  failing outright.
- **The geocoder is an outbound dependency.** Location writes call
  `nominatim.openstreetmap.org` from the Edge Function. It needs no key, but its usage
  policy asks for a descriptive `User-Agent` (sent — see `NOMINATIM_UA`) and roughly
  one request per second, so a model creating many places in a tight loop may get
  throttled. Passing `lat`/`lng` skips the call entirely.
- This connector is intentionally single-user. It is not meant to be shared.
