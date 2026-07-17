# Planner MCP connector for Claude Cowork

This Edge Function (`planner-mcp`) is a **remote MCP server** that lets Claude
Cowork (or any MCP client) read and edit your planner's data — the same data the
app stores in Supabase. Once deployed and added as a custom connector, you can
say things in Cowork like *"what's on my plate today?"*, *"add a P1 task to call
the accountant tomorrow"*, or *"log my mood as 4 for today"*, and it acts on your
real planner.

It can **create and edit** goals, projects, habits, actions, notes, people, and
tracker entries — but it can **never delete** anything (deletion stays a manual
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
OAuth) — it has **no request-headers field** — so the token goes in the URL as a
`?token=` query parameter. The server accepts the token either way (query param or
`Authorization: Bearer` header), so a header-capable client can still use the header.

1. In Claude, go to **Customize → Connectors**.
2. Click **Add → Add custom connector**.
3. **Name:** `Personal Planner`
4. **Remote MCP server URL** — the endpoint with your token appended:
   ```
   https://<your-project-ref>.supabase.co/functions/v1/planner-mcp/mcp?token=<your MCP_TOKEN>
   ```
   (Leave the OAuth "Advanced settings" empty.)
5. Click **Add**, then **Connect**, then enable the connector in a chat via the
   connectors menu.

> Putting the token in the URL is fine for a personal, single-user connector, but it
> does mean the token can appear in server request logs. Rotate it anytime with
> `supabase secrets set MCP_TOKEN="<new>"` + redeploy, then update the connector URL.

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
`list_actions`, `list_notes`, `list_people`, `get_tracker`

**Write (create/edit only — never delete):** `create_goal`, `edit_goal`,
`create_project`, `edit_project`, `create_habit`, `edit_habit`, `create_action`,
`edit_action`, `complete_action`, `add_note`, `create_person`, `edit_person`,
`log_metric`

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
  in sync.
- This connector is intentionally single-user. It is not meant to be shared.
