# Personal Planner connector: tool reference

The connector is the Supabase Edge Function `planner-mcp` (`supabase/functions/planner-mcp/index.ts`).
Claude reaches it as an MCP server. All writes run as the service role, so the activity log records them
with author `claude`. Nothing is ever hard-deleted: every entity has an archive and a restore.

- **Dates:** every "today" default is the user's day in Europe/Berlin.
- **Areas:** Health, Finance, Career, Maintenance, Growth, Relationships, Sol. The page names are accepted as aliases:
  Money → Finance, Work → Career, People → Relationships, Home / Admin → Maintenance, Learning / Self → Growth, Life → Sol.
- **Duplicates:** creates match on natural keys (title + date + kind for items, URL for links, name for people)
  and accept an optional `dedupe_key`; a repeat call updates instead of adding a second record.
- **Writes return the full object** after the change.
- **Which version is live:** `connector_info` returns the deployed commit, deploy time and the tool list.

## Deploying

`.github/workflows/deploy-connector.yml` deploys every function under `supabase/functions/` on each push to
`master` that touches them, and stamps the commit and time that `connector_info` reports. It needs the
repository secret `SUPABASE_ACCESS_TOKEN`. Without it the job skips with a notice, and the function has to be
deployed from the Supabase dashboard (then `connector_info` says "not stamped").

## Parity: what the pages can do, and the tool for it

| Page | Action in the UI | Tool |
|---|---|---|
| Today | See the day | `get_agenda`, `plan_day` |
| Today | Set the main thing | `set_main_thing` |
| Today | "What Claude changed" feed | (activity log, written automatically) |
| Command Center | Add a task, event, deadline or block | `create_item`, `quick_add` |
| Command Center | Edit any field | `edit_item` |
| Command Center | Tick off / undo | `complete_item`, `uncomplete_item` |
| Command Center | Archive / bring back | `archive_item`, `restore_item` |
| Command Center | Drag to another day or time | `reschedule`, `snooze` |
| Command Center | Someday / schedule from backlog | `make_someday`, `schedule_from_backlog` |
| Command Center | Repeat, stop repeating, skip or move one date | `set_recurrence`, `end_recurrence`, `skip_occurrence`, `edit_occurrence` |
| Command Center | Reminders per item, mute | `set_reminders`, `mute_item` |
| Command Center | Reminders sheet (quiet hours, digest, heads-up) | `get_reminder_settings`, `set_reminder_settings`, `list_upcoming_reminders` |
| Command Center | Day, week, month, horizon, backlog views | `plan_day`, `plan_week`, `get_month`, `get_horizon`, `get_backlog` |
| Command Center | Weekly review | `weekly_review` |
| Command Center | Search | `search_items`, `list_items` |
| Command Center | Dependencies (blocked) | `add_dependency`, `remove_dependency` |
| Command Center | Accept a proposed plan in one go | `apply_plan` |
| Command Center | Strategy: goals and projects | `create_goal`, `edit_goal`, `archive_goal`, `create_project`, `edit_project`, `archive_project`, `link_item`, `list_goals`, `list_projects` |
| Command Center | Work block, gym days, time zone | `get_planner_settings`, `set_planner_settings` |
| Command Center | Strategy board layout (card positions, hand-drawn links) | missing: layout is visual only |
| Health | Daily numbers, workouts, activities, body metrics | `upsert_health_day`, `upsert_workout`, `upsert_activity`, `log_body_metric` |
| Health | Status, flags, brief | `set_health_status`, `set_health_flag`, `write_health_brief`, `get_health_summary` |
| Health | Trackers | `get_tracker`, `log_metric` |
| People | Add / edit a person | `create_person`, `edit_person` |
| People | Circle, quality, rhythm, birthday, in memory, archive | `set_relationship` |
| People | Log contact, open threads | `log_contact`, `set_person_situation` |
| People | Link two people | `link_people` |
| People | Person detail | `get_person_context`, `list_people` |
| People | Family roles, typed links, family tree | pending approval (People tree brief) |
| Self | Notes: add, edit, archive | `add_note`, `edit_note`, `archive_record` (type note), `list_notes` |
| Money | Accounts and transactions | `get_finance`, `log_transaction` |
| Money | Monthly snapshot (money river) | `import_finance_snapshot`, `get_finance_snapshot` |
| Work | Decisions and scenarios | `list_decisions`, `get_decision`, `create_scenario`, `edit_scenario`, `link_scenarios`, `set_action_decision` |
| Location | Places, item locations, history | `create_place`, `edit_place`, `list_pois`, `set_item_location`, `list_located_items`, `get_location_history`, `geocode_address` |
| Knowledge | Save a link, idea, author, quote, note | `save_link`, `save_idea`, `save_author`, `save_quote`, `save_note` |
| Knowledge | Search, recent, one item | `search_knowledge`, `list_recent_knowledge`, `get_knowledge_item` |
| Knowledge | Change type | `set_item_type` |
| Knowledge | Topics: list, rename, merge | `list_topics`, `rename_topic`, `merge_topics` |
| Knowledge | The spider (map, cluster, link, note) | `map_knowledge`, `cluster_knowledge`, `link_knowledge`, `spider_note` |
| Knowledge | OneDrive folders: list, browse, add, privacy, remove, sync | `list_knowledge_sources`, `browse_onedrive_folders`, `add_knowledge_source`, `set_source_privacy`, `remove_knowledge_source`, `sync_source`, `get_sync_status` |
| Knowledge | Upload files, read OneDrive files, meaning search | missing by design: files are read in the browser |
| Admin | Archive or restore anything | `archive_record`, `restore_record` |
| Admin | Search everything | `search_everything` |
| Agents | Proposals, reports, shared memory | `propose_*`, `post_report`, `list_proposals`, `list_agent_reports`, `memory_*` |

## Command Center items

An item is a task, event, deadline or block. Tasks, deadlines and blocks are rows in `actions`; events are
rows in `events`. The tools find the table from the id. Fields (all optional except `title` on create):

`kind` (task · event · deadline · block), `title`, `notes`, `area`, `secondary_areas`, `goal_id`, `project_id`,
`priority` (P0–P3), `status` (open · done · archived · someday), `date`, `start`, `end` or `duration_min`,
`all_day`, `estimate_min`, `recurrence` (RRULE: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY, BYMONTHDAY,
UNTIL, COUNT), `exceptions`, `reminders` (minutes before), `muted`, `location`, `people` (person ids),
`depends_on` (task ids), `source`, `dedupe_key`.

The returned item adds `blocked` (waits for an open task), `doneDates` (ticked dates of a repeating task),
`isFocus` and `createdAt`.

`edit_occurrence` scopes: `this` (that date only; skipped in the series and copied as a one-off),
`this_and_following` (the series ends the day before; a new series starts with the changes), `all`.

`apply_plan` checks every step first and changes nothing if one is invalid; if a step fails while applying,
the steps before it are undone.

## Tool list

`connector_info` returns the live list. In the code at the time of writing (133; the seven OneDrive tools are listed in the parity table):

add_dependency, add_note, apply_plan, archive_action, archive_goal, archive_item, archive_project, archive_record,
cluster_knowledge, complete_action, complete_item, connector_info, create_action, create_event, create_goal,
create_item, create_person, create_place, create_project, create_scenario, edit_action, edit_event, edit_goal,
edit_item, edit_note, edit_occurrence, edit_person, edit_place, edit_project, edit_scenario, end_recurrence,
geocode_address, get_agenda, get_backlog, get_decision, get_finance, get_finance_snapshot, get_health_summary,
get_horizon, get_item, get_knowledge_item, get_location_history, get_month, get_person_context,
get_planner_settings, get_reminder_settings, get_tracker, import_finance_snapshot, link_item, link_knowledge,
link_people, link_scenarios, list_actions, list_agent_reports, list_decisions, list_events, list_goals,
list_items, list_located_items, list_notes, list_people, list_pois, list_projects, list_proposals,
list_recent_knowledge, list_topics, list_upcoming_reminders, log_body_metric, log_contact, log_metric,
log_transaction, make_someday, map_knowledge, memory_archive, memory_get, memory_overview, memory_save,
memory_search, memory_topics, merge_topics, mute_item, plan_day, plan_week, post_report, propose_action,
propose_event, propose_metric, propose_note, propose_person, propose_scenario, quick_add, remove_dependency,
rename_topic, reschedule, restore_item, restore_record, save_author, save_idea, save_link, save_note, save_quote,
schedule_from_backlog, search_everything, search_items, search_knowledge, set_action_decision, set_health_flag,
set_health_status, set_item_location, set_item_type, set_main_thing, set_person_situation, set_planner_settings,
set_recurrence, set_relationship, set_reminder_settings, set_reminders, skip_occurrence, snooze, spider_note,
uncomplete_item, upsert_activity, upsert_health_day, upsert_workout, weekly_review, write_health_brief

## Knowledge privacy

Items from a Private OneDrive source are never returned by any connector tool (filtered on the server in every
Knowledge read). Links-only items carry name, path, dates and link, never content. File contents are only read in the
owner's browser; the connector cannot fetch them.
