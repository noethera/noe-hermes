"""Backend route for the bot-heartbeat Bots-roster line: GET /api/plugins/bot-heartbeat/counts.

Returns how many Kanban tasks are currently `running`, grouped by assignee — {"qa-dev": 2, ...}. The
desktop plugin.js uses this to show "N tugas berjalan" instead of one task's title when a profile holds
more than one concurrently (profiles.list's `worker_session` is a single field; it can't tell two
concurrent kanban workers on the same profile apart, so this plugin reads kanban.db directly instead).

Cached against the DB file's (mtime, size) signature: an unchanged board costs a stat() call, not a query.
Read-only: never writes anything.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

try:
    from fastapi import APIRouter
except Exception:  # allows unit tests without FastAPI
    APIRouter = None

_cache: dict[str, tuple[object, dict[str, int]]] = {}


def _root() -> Path:
    try:
        from hermes_constants import get_hermes_home  # type: ignore
        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    return home.parent.parent if home.parent.name == "profiles" else home


def _sig(path: Path) -> tuple | None:
    try:
        st = path.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def running_counts(root: Path) -> dict[str, int]:
    db = root / "kanban.db"
    sig = _sig(db)
    key = str(root)
    hit = _cache.get(key)
    if hit is not None and hit[0] == sig:
        return hit[1]

    counts: dict[str, int] = {}
    if db.exists():
        con = None
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
            rows = con.execute(
                "select assignee, count(*) from tasks where status = 'running' and assignee is not null "
                "group by assignee"
            ).fetchall()
            counts = {str(assignee): int(n) for assignee, n in rows if assignee}
        except Exception:
            counts = {}
        finally:
            if con is not None:
                con.close()

    _cache[key] = (sig, counts)
    return counts


if APIRouter is not None:
    router = APIRouter()

    # Plain def: FastAPI runs it in its threadpool, so the SQLite query never blocks the event loop.
    @router.get("/counts")
    def counts():
        return running_counts(_root())
