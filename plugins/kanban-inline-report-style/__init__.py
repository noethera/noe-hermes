"""kanban-inline-report-style: no agent-side hooks needed — this plugin only
ships a desktop half (desktop/plugin.js) that restyles kanban run-report
messages that land inside a chat transcript (CSS attribute + a separate
overlay avatar, never mutating the transcript's own DOM children). This file
exists purely because the plugin loader requires a package __init__.py to
import the directory at all; `register(ctx)` is intentionally omitted since
there are no hooks to register.
"""
from __future__ import annotations
