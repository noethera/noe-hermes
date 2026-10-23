"""agent-activity: record what Noethera's agents are doing, for the desktop "Aktivitas agent" pane.

Hooks run in whichever process hosts the work (the Desktop backend, the messaging gateway, a Kanban worker), and
plugin events only reach Desktop clients from the Desktop backend. So every hook appends one short JSON line to a
shared journal under the Hermes root; the plugin's backend route (dashboard/plugin_api.py) reads it for the pane.

Hooks never block or raise: each write is one small O_APPEND line, failures are swallowed.
Tool arguments are summarised and redacted; full arguments and results are never written.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

MAX_JOURNAL_BYTES = 2_000_000
REASONING_FLUSH_SECONDS = 1.5
_lock = threading.Lock()
_reasoning: dict[str, dict] = {}   # turn key -> {"text": str, "last": float}
_room_turns_seen: set[str] = set()

_SECRET_PATTERNS = [
    re.compile(r"(?i)\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|APP_PASSWORD|AUTH)[A-Z0-9_]*)\s*[=:]\s*\S+"),
    re.compile(r"(?i)\b(authorization|bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"\b[A-Za-z0-9]{4}(?: [A-Za-z0-9]{4}){5}\b"),          # WordPress application passwords
    re.compile(r"\b(?:sk|pk|rk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{12,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b"),  # JWTs
]


def _root() -> Path:
    """The Hermes root (shared by all profiles), so every process writes to the same journal."""
    try:
        from hermes_constants import get_hermes_home  # type: ignore
        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    return home.parent.parent if home.parent.name == "profiles" else home


def _journal() -> Path:
    return _root() / "agent-activity" / "events.jsonl"


def _profile() -> str:
    try:
        from hermes_cli.profiles import current_profile_name  # type: ignore
        name = current_profile_name()
        if name:
            return str(name)
    except Exception:
        pass
    home = Path(os.environ.get("HERMES_HOME") or "")
    return home.name if home.parent.name == "profiles" else "default"


def _redact(text: str) -> str:
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(lambda m: (m.group(1) + "=***") if m.lastindex else "***", text)
    return text


def _clip(text: str, limit: int = 160) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def summarize_tool(name: str, args) -> str:
    """One short, redacted line describing a tool call."""
    if not isinstance(args, dict):
        return ""
    for key in ("command", "cmd", "query", "url", "path", "file_path", "pattern", "action", "name", "title", "task_id"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            if key in ("path", "file_path"):
                value = "/".join(Path(value).parts[-2:])
            return _clip(_redact(value))
    return ""


def _write(event: dict) -> None:
    try:
        event.setdefault("ts", time.time())
        event.setdefault("profile", _profile())
        task = os.environ.get("HERMES_KANBAN_TASK")
        if task:
            event.setdefault("kanban_task", task)
        line = json.dumps(event, ensure_ascii=False)[:3800] + "\n"
        path = _journal()
        path.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            try:
                if path.stat().st_size > MAX_JOURNAL_BYTES:
                    os.replace(path, path.with_suffix(".jsonl.1"))
            except FileNotFoundError:
                pass
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, line.encode("utf-8"))
            finally:
                os.close(fd)
    except Exception:
        pass


# ---- room member turns -------------------------------------------------------------------------------------------

def on_room_member_activity(room_id="", thread_id="", member_id="", turn_id="", kind="", payload=None, **kwargs):
    payload = payload if isinstance(payload, dict) else {}
    key = f"{room_id}:{member_id}:{turn_id}"
    base = {"source": "room", "room_id": room_id, "member_id": member_id, "turn_id": turn_id}
    if key not in _room_turns_seen:
        _room_turns_seen.add(key)
        if len(_room_turns_seen) > 500:
            _room_turns_seen.clear()
        _write({**base, "kind": "turn.start"})
    if kind == "reasoning.delta":
        state = _reasoning.setdefault(key, {"text": "", "last": 0.0})
        state["text"] = (state["text"] + str(payload.get("text", "")))[-400:]
        now = time.time()
        if now - state["last"] >= REASONING_FLUSH_SECONDS:
            state["last"] = now
            _write({**base, "kind": "reasoning", "detail": _clip(_redact(state["text"][-200:]), 200)})
    elif kind == "tool.started":
        _write({**base, "kind": "tool.start", "tool": payload.get("name", ""),
                "detail": summarize_tool(payload.get("name", ""), payload.get("args")), "tool_call_id": payload.get("tool_id")})
    elif kind == "tool.completed":
        _write({**base, "kind": "tool.end", "tool": payload.get("name", ""), "tool_call_id": payload.get("tool_id")})
    elif kind == "request.opened":
        _write({**base, "kind": "approval", "detail": _clip(_redact(str(payload.get("command", ""))))})
    elif kind == "turn.error":
        _write({**base, "kind": "error", "detail": _clip(_redact(str(payload.get("error") or payload.get("text") or "")))})
    elif kind in ("message.delta", "message.interim"):
        state = _reasoning.setdefault(key + ":msg", {"text": "", "last": 0.0})
        now = time.time()
        if now - state["last"] >= 5:
            state["last"] = now
            _write({**base, "kind": "writing"})


# ---- every session (Bot Chats, rooms, Kanban workers) --------------------------------------------------------------

def pre_tool_call(tool_name="", args=None, session_id="", tool_call_id="", **kwargs):
    _write({"source": "session", "session_id": session_id, "kind": "tool.start", "tool": tool_name,
            "detail": summarize_tool(tool_name, args), "tool_call_id": tool_call_id})
    return None


def post_tool_call(tool_name="", session_id="", tool_call_id="", duration_ms=None, status="", **kwargs):
    _write({"source": "session", "session_id": session_id, "kind": "tool.end", "tool": tool_name,
            "tool_call_id": tool_call_id, "duration_ms": duration_ms, "status": status})


def on_stream_start(session_id="", **kwargs):
    _write({"source": "session", "session_id": session_id, "kind": "thinking"})


def post_llm_call(session_id="", **kwargs):
    _write({"source": "session", "session_id": session_id, "kind": "turn.end"})


# ---- Kanban ------------------------------------------------------------------------------------------------------

def kanban_task_claimed(task_id="", assignee="", **kwargs):
    _write({"source": "kanban", "kind": "task.claimed", "kanban_task": task_id, "profile": assignee or _profile()})


def kanban_task_completed(task_id="", assignee="", summary="", **kwargs):
    _write({"source": "kanban", "kind": "task.completed", "kanban_task": task_id, "profile": assignee or _profile(),
            "detail": _clip(_redact(summary or ""), 200)})


def kanban_task_blocked(task_id="", assignee="", reason="", **kwargs):
    _write({"source": "kanban", "kind": "task.blocked", "kanban_task": task_id, "profile": assignee or _profile(),
            "detail": _clip(_redact(reason or ""), 200)})


def on_kanban_worker_exited(task_id="", assignee="", exit_kind="", **kwargs):
    _write({"source": "kanban", "kind": "worker.exited", "kanban_task": task_id, "profile": assignee or _profile(),
            "detail": str(exit_kind)})


def register(ctx):
    for name, fn in [
        ("on_room_member_activity", on_room_member_activity),
        ("pre_tool_call", pre_tool_call),
        ("post_tool_call", post_tool_call),
        ("on_stream_start", on_stream_start),
        ("post_llm_call", post_llm_call),
        ("kanban_task_claimed", kanban_task_claimed),
        ("kanban_task_completed", kanban_task_completed),
        ("kanban_task_blocked", kanban_task_blocked),
        ("on_kanban_worker_exited", on_kanban_worker_exited),
    ]:
        ctx.register_hook(name, fn)
