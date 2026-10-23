# agent-activity

Shows what each agent is doing right now (group-room turns, Kanban workers, direct chats) in a desktop pane
"Aktivitas agent" and a status-bar chip ("N agent bekerja").

- `__init__.py`: hooks (room member activity, tool calls, turn start/end, Kanban task events) append one short JSON
  line each to `~/.hermes/agent-activity/events.jsonl`, from whichever process runs the work. Rotated at 2 MB.
  Only a tool name and a one-line, redacted summary of its arguments is written; never full arguments or results.
- `dashboard/plugin_api.py`: `GET /api/plugins/agent-activity/state` folds the journal into one status per agent and
  adds active Kanban tasks (read-only from `kanban.db`).
- `desktop/plugin.js`: polls `/state` every 1.5 s and renders the pane and chip.

Install: `plugins/install.sh`, then in the desktop app Capabilities → Plugins → enable "agent-activity" (once), and
open the pane from the layout menu if it is not visible.
