"""Backend route for the agent-activity desktop pane: GET /api/plugins/agent-activity/state.

Reads the shared journal written by the plugin's hooks (any process) plus running Kanban tasks, and returns one
status per agent. Read-only: never writes anything.

The desktop polls this, so every input is cached against its file signature (mtime + size): an unchanged journal or
Kanban board costs a few stat() calls, not a re-parse or a query. Statuses still depend on the clock (an agent goes
idle WORKING_WINDOW seconds after its last event), so they are derived per request from the cached fold.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from pathlib import Path

try:
    from fastapi import APIRouter
except Exception:  # allows unit tests without FastAPI
    APIRouter = None

WORKING_WINDOW = 20      # seconds after the last event an agent still counts as busy
STUCK_WINDOW = 1800      # a waiting/error status with no newer event for this long reads as idle
TAIL_BYTES = 400_000
TITLES_TTL = 60

_cache: dict[tuple[str, str], tuple[object, object]] = {}


def _root() -> Path:
    try:
        from hermes_constants import get_hermes_home  # type: ignore
        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    return home.parent.parent if home.parent.name == "profiles" else home


def _sig(*paths: Path) -> tuple:
    out = []
    for path in paths:
        try:
            st = path.stat()
            out.append((st.st_mtime_ns, st.st_size))
        except OSError:
            out.append(None)
    return tuple(out)


def _cached(root: Path, name: str, sig: object, compute):
    key = (str(root), name)
    hit = _cache.get(key)
    if hit is not None and hit[0] == sig:
        return hit[1]
    value = compute()
    _cache[key] = (sig, value)
    return value


def _tail_lines(path: Path, max_bytes: int) -> list[str]:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            data = f.read().decode("utf-8", "replace")
    except FileNotFoundError:
        return []
    lines = data.splitlines()
    return lines[1:] if size > max_bytes else lines


def _journal(root: Path) -> Path:
    return root / "agent-activity" / "events.jsonl"


def read_events(root: Path) -> list[dict]:
    journal = _journal(root)
    lines = _tail_lines(journal.with_suffix(".jsonl.1"), TAIL_BYTES // 2) + _tail_lines(journal, TAIL_BYTES)
    events = []
    for line in lines:
        try:
            events.append(json.loads(line))
        except Exception:
            continue
    events.sort(key=lambda e: e.get("ts", 0))
    return events


def profile_titles(root: Path) -> dict[str, str]:
    titles = {"default": "Hermes"}
    for meta in (root / "profiles").glob("*/profile.yaml"):
        m = re.search(r"^\s*title:\s*(.+)$", meta.read_text(errors="replace"), re.M)
        if m:
            titles[meta.parent.name] = m.group(1).strip().strip("\"'")
    return titles


def _agent_key(event: dict) -> str:
    member = str(event.get("member_id") or "")
    if member:
        return member.split("::")[-1].split(":")[-1] or member
    return str(event.get("profile") or "default")


def kanban_tasks(root: Path) -> list[dict]:
    db = root / "kanban.db"
    if not db.exists():
        return []
    con = None
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
        rows = con.execute(
            "select t.id, t.title, t.assignee, t.status, t.started_at, c.author, c.body, c.created_at from tasks t "
            "left join task_comments c on c.id = (select max(id) from task_comments where task_id = t.id) "
            "where t.status in ('ready','running','blocked','review') "
            "order by coalesce(t.started_at, t.created_at) desc limit 12"
        ).fetchall()
    except Exception:
        return []
    finally:
        if con is not None:
            con.close()
    return [{
        "id": task_id, "title": title, "assignee": assignee, "status": status, "started_at": started,
        "last_comment": ({"author": author, "text": " ".join(str(body).split())[:180], "at": at}
                         if author is not None or body is not None else None),
    } for task_id, title, assignee, status, started, author, body, at in rows]


def _session_key(e: dict, agent_key: str) -> str:
    """Identity of the concurrent unit of work an event belongs to: the kanban task when the event
    carries one (two kanban tasks on the SAME profile must not collapse into one), else the session,
    else the room, else the agent key itself (ad-hoc/CLI events with no session id — one shared bucket,
    matching the pre-multi-session behaviour for those)."""
    return str(e.get("kanban_task") or e.get("session_id") or e.get("room_id") or agent_key)


def fold_events(events: list[dict]) -> tuple[dict[tuple[str, str], dict], set[tuple[str, str]]]:
    """Each (agent, session)'s last activity (no status yet), plus the sessions with a tool call still
    open. Keyed per SESSION, not per agent: a profile running two kanban tasks concurrently must keep
    both, so the caller can report a count instead of one activity clobbering the other."""
    sessions: dict[tuple[str, str], dict] = {}
    open_tools: set[tuple[str, str]] = set()
    # A room member's turn runs on a hidden session in the Desktop backend, so its tool calls arrive twice: as room
    # events (tool_id) and as session hooks (same tool_call_id, but the backend's profile). Map such sessions to the
    # member, keep only their start/end markers, and drop the duplicate tool events.
    room_tools = {e["tool_call_id"]: e for e in events if e.get("source") == "room" and e.get("tool_call_id")}
    room_sessions = {e["session_id"]: room_tools[e["tool_call_id"]] for e in events
                     if e.get("source") == "session" and e.get("tool_call_id") in room_tools and e.get("session_id")}
    for e in events:
        if e.get("source") == "kanban" and e.get("kind") in ("task.claimed",):
            continue  # claim happens in the dispatcher before the worker starts; the worker's own events follow
        room = room_sessions.get(e.get("session_id")) if e.get("source") == "session" else None
        if room is not None:
            if e.get("kind") in ("tool.start", "tool.end"):
                continue
            e = {**e, "member_id": room.get("member_id"), "room_id": room.get("room_id")}
        agent_key = _agent_key(e)
        skey = (agent_key, _session_key(e, agent_key))
        a = sessions.setdefault(skey, {"agent": agent_key, "last_ts": 0, "context": None, "current": None})
        a["last_ts"] = e.get("ts", 0)
        kind = e.get("kind")
        if e.get("room_id"):
            a["context"] = {"type": "room", "room_id": e["room_id"]}
        elif e.get("kanban_task"):
            a["context"] = {"type": "kanban", "task_id": e["kanban_task"]}
        if kind == "tool.start":
            open_tools.add(skey)
            a["current"] = {"what": e.get("tool"), "detail": e.get("detail", ""), "since": e.get("ts")}
        elif kind == "tool.end":
            open_tools.discard(skey)
            a["current"] = {"what": "thinking", "detail": "", "since": e.get("ts")}
        elif kind in ("thinking", "turn.start"):
            a["current"] = {"what": "thinking", "detail": "", "since": e.get("ts")}
        elif kind == "reasoning":
            a["current"] = {"what": "thinking", "detail": e.get("detail", ""), "since": (a["current"] or {}).get("since", e.get("ts"))}
        elif kind == "writing":
            a["current"] = {"what": "writing", "detail": "", "since": e.get("ts")}
        elif kind in ("turn.end", "task.completed", "worker.exited"):
            open_tools.discard(skey)
            a["current"] = None
        elif kind in ("approval", "task.blocked"):
            a["current"] = {"what": "waiting", "detail": e.get("detail", ""), "since": e.get("ts")}
        elif kind == "error":
            a["current"] = {"what": "error", "detail": e.get("detail", ""), "since": e.get("ts")}
    return sessions, open_tools


def build_state(root: Path, now: float | None = None) -> dict:
    now = now or time.time()
    titles = _cached(root, "titles", int(now // TITLES_TTL), lambda: profile_titles(root))
    journal = _journal(root)
    folded, open_tools = _cached(root, "fold", _sig(journal, journal.with_suffix(".jsonl.1")),
                                 lambda: fold_events(read_events(root)))
    tasks = _cached(root, "kanban", _sig(root / "kanban.db", root / "kanban.db-wal"), lambda: kanban_tasks(root))
    order = {"working": 0, "thinking": 1, "waiting": 2, "error": 3, "idle": 4}
    by_agent: dict[str, list[dict]] = {}
    for skey, base in folded.items():
        agent_key = skey[0]
        s = {**base}
        current = s["current"]
        idle_for = now - s["last_ts"]
        if current and current["what"] in ("waiting", "error") and idle_for < STUCK_WINDOW:
            status = current["what"]
        elif skey in open_tools:
            status = "working"
        elif current and current["what"] not in ("waiting", "error") and idle_for < WORKING_WINDOW:
            status = "thinking" if current["what"] in ("thinking", "writing") else "working"
        else:
            status = "idle"
            s["current"] = None
        s["status"] = status
        by_agent.setdefault(agent_key, []).append(s)
    agents = []
    for key, sessions in by_agent.items():
        # The row represents whichever session is most urgent (working beats thinking beats
        # waiting...), but `active_count` is how many are ACTUALLY concurrently non-idle — the
        # desktop shows that count instead of a single `current` once it's more than one, so two
        # kanban tasks on the same profile no longer clobber each other into one stale detail.
        active = [s for s in sessions if s["status"] != "idle"]
        pool = sorted(active or sessions, key=lambda s: (order[s["status"]], -s["last_ts"]))
        lead = pool[0]
        agents.append({
            "agent": key,
            "name": titles.get(key, key),
            "status": lead["status"],
            "last_ts": max(s["last_ts"] for s in sessions),
            "context": lead["context"],
            "current": lead["current"],
            "active_count": len(active),
        })
    return {
        "now": now,
        "agents": sorted(agents, key=lambda a: (order[a["status"]], -a["last_ts"])),
        "tasks": tasks,
    }


if APIRouter is not None:
    router = APIRouter()

    # Plain def: FastAPI runs it in its threadpool, so the file reads and SQLite query never block the event loop.
    @router.get("/state")
    def state():
        return build_state(_root())
