"""kanban-report-corner: no agent-side hooks needed — this plugin only ships a
desktop half (desktop/plugin.js) that repositions kanban run-report toasts via
CSS + DOM observation on the stock notification stack. This file exists purely
because the plugin loader requires a package __init__.py to import the
directory at all; `register(ctx)` is intentionally omitted since there are no
hooks to register.
"""
from __future__ import annotations
