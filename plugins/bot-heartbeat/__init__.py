"""bot-heartbeat: no hooks needed — this plugin only ships a read-only dashboard backend
(dashboard/plugin_api.py, reading kanban.db directly) for the desktop plugin.js roster overlay.
This file exists purely because the plugin loader requires a package __init__.py to import the
directory at all; `register(ctx)` is intentionally omitted since there are no hooks to register.
"""
from __future__ import annotations
