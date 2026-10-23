"""session-tab-bot-icon: no agent-side hooks needed — this plugin only ships a
desktop half (desktop/plugin.js) that polls the gateway's own profiles.list /
session.list / profiles.get_asset RPCs and decorates session tabs via DOM.
This file exists purely because the plugin loader requires a package
__init__.py to import the directory at all; `register(ctx)` is intentionally
omitted since there are no hooks to register.
"""
from __future__ import annotations
