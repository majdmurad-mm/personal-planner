# Planner connector: tools after the slim-down (v2.0.0)

The owner connector (`/mcp`) used to list 146 tools. Claude voice calls stopped loading it, probably because voice mode
skips large connectors. Tools that share a pattern are now **merged into one tool with a `kind`, `action`, `mode` or `view`**,
and a separate **voice edition** (`/mcp-voice`) serves 12 small tools.

Nothing was dropped. Each merged route checks the arguments against the old tool's own schema and then runs the old tool's code,
so results, permissions, privacy (items kept from Claude stay hidden), archive-never-delete and activity-log entries are unchanged.
A field that belongs to another kind is refused with a message naming the allowed fields for that kind.

| | Tools | tools/list size |
|---|---|---|
| Owner connector before | 146 | 130,939 bytes (≈ 36.4k tokens) |
| Owner connector now | **91** | 108,790 bytes (≈ 30.2k tokens) |
| Voice edition (`/mcp-voice`) | **12** | 3,709 bytes (≈ 1k tokens) |
| Agent connector (agent token, unchanged) | 28 | 25,195 bytes |

The size falls less than the count because every field the old tools took is still there. Most of the remaining weight sits in
the core create/edit tools, which keep their full typed schemas on purpose.

The agent connector still serves its tools under their old names, so the Agent PgM bots are unaffected.

## Old tool → new tool

| Old tool | New tool | Call it with |
|---|---|---|
| `archive_action` | `archive` | `kind: "action"` |
| `archive_goal` | `archive` | `kind: "goal"` |
| `archive_project` | `archive` | `kind: "project"` |
| `archive_item` | `archive` | `kind: "item"` |
| `archive_record` | `archive` | `kind: "record"` |
| `restore_item` | `restore` | `kind: "item"` |
| `restore_record` | `restore` | `kind: "record"` |
| `complete_action` | `set_done` | `kind: "action"` |
| `uncomplete_item` | `set_done` | `kind: "item"`, `done: false` |
| `complete_item` | `set_done` | `kind: "item"` |
| `save_note` | `save_knowledge` | `kind: "note"` |
| `save_idea` | `save_knowledge` | `kind: "idea"` · renamed: `kind` → `ideaKind` |
| `save_link` | `save_knowledge` | `kind: "link"` |
| `save_quote` | `save_knowledge` | `kind: "quote"` |
| `save_author` | `save_knowledge` | `kind: "author"` |
| `add_note` | `save_knowledge` | `kind: "journal"` |
| `list_actions` | `list` | `kind: "actions"` |
| `list_events` | `list` | `kind: "events"` |
| `list_items` | `list` | `kind: "items"` · renamed: `kind` → `itemKind` |
| `list_goals` | `list` | `kind: "goals"` |
| `list_projects` | `list` | `kind: "projects"` |
| `list_notes` | `list` | `kind: "notes"` |
| `list_people` | `list` | `kind: "people"` |
| `list_decisions` | `list` | `kind: "decisions"` |
| `list_proposals` | `list` | `kind: "proposals"` |
| `list_agent_reports` | `list` | `kind: "agent_reports"` |
| `list_pois` | `list` | `kind: "pois"` |
| `list_located_items` | `list` | `kind: "located_items"` |
| `list_recent_knowledge` | `list` | `kind: "recent_knowledge"` |
| `get_tracker` | `list` | `kind: "tracker"` |
| `link_item` | `link` | `kind: "item"` |
| `link_people` | `link` | `kind: "people"` · renamed: `kind` → `relation` |
| `set_link_kind` | `link` | `kind: "people_kind"` · renamed: `kind` → `relation` |
| `link_scenarios` | `link` | `kind: "scenarios"` |
| `link_knowledge` | `link` | `kind: "knowledge"` |
| `remove_dependency` | `link` | `kind: "dependency"`, `remove: true` |
| `add_dependency` | `link` | `kind: "dependency"` |
| `set_recurrence` | `recurrence` | `action: "set"` |
| `end_recurrence` | `recurrence` | `action: "end"` |
| `skip_occurrence` | `recurrence` | `action: "skip"` |
| `edit_occurrence` | `recurrence` | `action: "edit_occurrence"` |
| `reschedule` | `reschedule` | `mode: "date"` |
| `snooze` | `reschedule` | `mode: "snooze"` |
| `make_someday` | `reschedule` | `mode: "someday"` |
| `get_planner_settings` | `settings` | `action: "get"`, `scope: "planner"` |
| `set_planner_settings` | `settings` | `action: "set"`, `scope: "planner"` |
| `get_reminder_settings` | `settings` | `action: "get"`, `scope: "reminders"` |
| `set_reminder_settings` | `settings` | `action: "set"`, `scope: "reminders"` |
| `set_reminders` | `settings` | `action: "set"`, `scope: "item"` |
| `list_upcoming_reminders` | `settings` | `action: "get"`, `scope: "upcoming"` |
| `set_health_condition` | `set_health` | `kind: "condition"` |
| `set_health_flag` | `set_health` | `kind: "flag"` |
| `set_health_status` | `set_health` | `kind: "status"` |
| `log_metric` | `log_metric` | `kind: "tracker"` |
| `log_body_metric` | `log_metric` | `kind: "body"` |
| `upsert_health_day` | `upsert_health` | `kind: "day"` |
| `upsert_workout` | `upsert_health` | `kind: "workout"` |
| `upsert_activity` | `upsert_health` | `kind: "activity"` |
| `upsert_routine` | `upsert_health` | `kind: "routine"` |
| `list_topics` | `topics` | `action: "list"` |
| `rename_topic` | `topics` | `action: "rename"` |
| `merge_topics` | `topics` | `action: "merge"` |
| `add_knowledge_source` | `knowledge_source` | `action: "add"` |
| `set_source_privacy` | `knowledge_source` | `action: "set_privacy"` |
| `remove_knowledge_source` | `knowledge_source` | `action: "remove"` |
| `sync_source` | `knowledge_source` | `action: "sync"` |
| `memory_get` | `memory_read` | `action: "get"` |
| `memory_search` | `memory_read` | `action: "search"` |
| `memory_overview` | `memory_read` | `action: "overview"` |
| `memory_topics` | `memory_read` | `action: "topics"` |
| `create_place` | `place` | `action: "create"` |
| `edit_place` | `place` | `action: "edit"` |
| `create_scenario` | `scenario` | `action: "create"` |
| `edit_scenario` | `scenario` | `action: "edit"` |
| `get_finance` | `get_finance` | `view: "summary"` |
| `get_finance_snapshot` | `get_finance` | `view: "snapshot"` |
| `get_communication_status` | `comm_status` | `view: "sources"` |
| `get_whatsapp_sync_state` | `comm_status` | `view: "whatsapp"` |

## Merged tools (19)

- `archive`: action, goal, project, item, record
- `restore`: item, record
- `set_done`: action, item+false, item
- `save_knowledge`: note, idea, link, quote, author, journal
- `list`: actions, events, items, goals, projects, notes, people, decisions, proposals, agent_reports, pois, located_items, recent_knowledge, tracker
- `link`: item, people, people_kind, scenarios, knowledge, dependency+true, dependency
- `recurrence`: set, end, skip, edit_occurrence
- `reschedule`: date, snooze, someday
- `settings`: get+planner, set+planner, get+reminders, set+reminders, set+item, get+upcoming
- `set_health`: condition, flag, status
- `log_metric`: tracker, body
- `upsert_health`: day, workout, activity, routine
- `topics`: list, rename, merge
- `knowledge_source`: add, set_privacy, remove, sync
- `memory_read`: get, search, overview, topics
- `place`: create, edit
- `scenario`: create, edit
- `get_finance`: summary, snapshot
- `comm_status`: sources, whatsapp

## Tools that stayed as they were (72)

`apply_plan`, `browse_onedrive_folders`, `cluster_knowledge`, `connector_info`, `create_action`, `create_event`, `create_goal`, `create_item`, `create_person`, `create_project`, `edit_action`, `edit_event`, `edit_goal`, `edit_item`, `edit_note`, `edit_person`, `edit_project`, `finish_spider_web`, `geocode_address`, `get_agenda`, `get_backlog`, `get_decision`, `get_exercise_progress`, `get_family_tree`, `get_health_summary`, `get_horizon`, `get_item`, `get_knowledge_item`, `get_location_history`, `get_month`, `get_next_session`, `get_person_context`, `get_spider_web`, `get_sync_status`, `get_today_overview`, `get_workout_history`, `import_finance_snapshot`, `list_knowledge_sources`, `log_checkin`, `log_contact`, `log_transaction`, `mail_attachment`, `mail_folders`, `mail_get`, `mail_search`, `map_knowledge`, `memory_archive`, `memory_save`, `mute_item`, `plan_day`, `plan_week`, `quick_add`, `save_whatsapp_chat`, `schedule_from_backlog`, `search_everything`, `search_items`, `search_knowledge`, `set_action_decision`, `set_item_location`, `set_item_type`, `set_main_thing`, `set_milestone`, `set_person_situation`, `set_relationship`, `set_sleep_correction`, `spider_note`, `spin_thread`, `start_spider_web`, `unweave`, `weave_theme`, `weekly_review`, `write_health_brief`

## Voice edition: `/mcp-voice`

A second connector for Claude voice calls, on the same server and database, with its own token (`VOICE_MCP_TOKEN`).
Answers are plain sentences meant to be spoken: times and titles first, at most five things, no ids, no JSON.
Write tools take a name, not an id, and match it loosely. If nothing fits, they say so. If two things fit, they ask
"Did you mean A or B?" and change nothing. Writes appear in Today's "What Claude changed" feed marked **voice** (with
`_Memory/migration_voice_actor.sql` applied; until then they show as claude).

| Tool | What it does |
|---|---|
| `today` | Today at a glance: the main thing, what's next with times, free time from now, and the workout. |
| `agenda` (day) | A short spoken agenda for one day: today, tomorrow, a weekday or a date. |
| `add` (text) | Add something from one plain sentence, like 'call the landlord Wednesday 10:00'. |
| `done` (title) | Mark a task done by saying its name. |
| `move` (title, when) | Move a task or event by name to another time: tomorrow, Friday 9:00, or someday. |
| `main_thing` (text) | Set today's main thing, by naming a task or saying a new one. |
| `next_workout` | When the next workout is and which routine is due. |
| `health` | One line on readiness: energy, sleep, last workout and any pains. |
| `checkin` (energy, mood, note) | Log how you feel today: energy and mood from 1 to 5, and an optional note. |
| `note` (text) | Save a quick idea or note to Knowledge. |
| `find` (query) | Search everything and say the top three results. |
| `contact` (person, note) | Log that you talked to someone, with an optional short note. |

### Add it in claude.ai as "Planner Voice"

1. Open `_Memory/voice_token.txt` on your computer (it is never committed) and copy the token.
2. In claude.ai: **Settings → Connectors → Add custom connector**. Name: **Planner Voice**.
3. URL: `https://eqguvoaysqspogtdmpun.supabase.co/functions/v1/planner-mcp/<token>/mcp-voice`, with the token pasted in place of `<token>`.
4. Leave the OAuth fields empty and save. In a voice call, turn on **Planner Voice** (you can leave the big connector off there).
5. Check it: ask "what's my day?" It should call `today` and answer in a few sentences.

## One task table

Every task, deadline and time block lives in one table, `actions` (`kind`: task, deadline or block). Where a task hangs is
`parent_type` (none, goal or project) plus `parent_id`. Calendar events are a separate table, `events`. The `*_item` tools
(`list_items`, `create_item`, `edit_item` …) read and write both through one view, so Claude never has to pick the table.

## Goal scores

Each goal has `score` (0–100) and `score_mode`: `manual` (your own rating, shown as x/10), `sleep` (7-day sleep score),
`workout` (workouts done of planned, 28 days), `net_zero` (share of the starting debt cleared) or `tasks` (tasks done, the
default). Auto scores refresh every morning and after a health sync or a finance snapshot; `score_history` keeps one point a
day for the 4-week sparkline. `create_goal` / `edit_goal` take `score`, `score_mode` and `secondary_areas`.

## iCloud Mail (read-only)

`mail_folders`, `mail_search` (from, subject, words, dates, folder, has attachment), `mail_get` (one message: text body and
attachment list) and `mail_attachment` (the text of a PDF, Word, Excel or text attachment). Folders are opened read-only
(IMAP EXAMINE): nothing is moved, flagged, marked read or deleted. The tools work once iCloud Mail is connected on the
Communication page with "Claude can read" on. Each search is written to the activity log as "Searched mail: <query>".
Scanned PDFs without a text layer come back without text (no OCR on the server).
