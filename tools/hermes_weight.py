#!/usr/bin/env python3
"""hermes_weight: how much CPU and RAM each Hermes surface uses on this Mac.

  python3 tools/hermes_weight.py measure --label baseline --delay 60 --duration 120
  python3 tools/hermes_weight.py compare A.json B.json
  python3 tools/hermes_weight.py startup --label term-cli -- hermes -p noe --cli

CPU% = (cumulative CPU seconds at the end - at the start) / wall seconds * 100, read from `ps`,
so it is exact for the window. 100% = one full core. Stdlib only (macOS /usr/bin/python3 3.9).
Results are saved as JSON in ~/.hermes/profiles/noe/data/perf/.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import select
import signal
import subprocess
import time
from datetime import datetime
from pathlib import Path

HERMES_ROOT = Path.home() / ".hermes"
OUT_DIR = HERMES_ROOT / "profiles" / "noe" / "data" / "perf"
GROUPS = (
    "desktop_ui",        # Hermes.app main + Helper processes (Electron GPU, renderer, network...)
    "desktop_backend",   # what the app spawns that is not Electron: `hermes serve`, embedded shells
    "gateway",           # `hermes gateway run`: Telegram, cron, Kanban dispatch for every profile
    "kanban_workers",    # `chat -q work kanban task ...` workers + their tool subprocesses
    "terminal_clients",  # `hermes --cli` / `--tui` clients (and the TUI's node child)
    "terminal_apps",     # Terminal.app / Warp / Ghostty / iTerm
    "windowserver",      # macOS compositor: pays for glass and for every animation frame
)
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\r")
RUNTIME = re.compile(r"\sgateway run\b|\sserve --host\b")


def parse_cputime(text: str) -> float:
    """ps TIME -> seconds. Accepts 'SS.ss', 'M:SS.ss', 'H:MM:SS.ss', 'D-HH:MM:SS'."""
    days = 0
    if "-" in text:
        head, text = text.split("-", 1)
        days = int(head)
    total = 0.0
    for part in text.split(":"):
        total = total * 60 + float(part)
    return days * 86400 + total


def parse_ps(output: str) -> dict:
    procs = {}
    for line in output.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid, ppid, rss, cpu, cmd = parts
        procs[int(pid)] = {"ppid": int(ppid), "rss_kb": int(rss), "cpu_s": parse_cputime(cpu), "cmd": cmd}
    return procs


def snapshot() -> dict:
    out = subprocess.run(
        ["ps", "-axww", "-o", "pid=,ppid=,rss=,time=,command="], capture_output=True, text=True, check=True
    ).stdout
    return parse_ps(out)


def descendants(procs: dict, root: int) -> set:
    kids = {}
    for pid, p in procs.items():
        kids.setdefault(p["ppid"], []).append(pid)
    out, stack = set(), [root]
    while stack:
        for child in kids.get(stack.pop(), []):
            if child not in out:
                out.add(child)
                stack.append(child)
    return out


def gateway_pid(root: Path = HERMES_ROOT):
    try:
        return int(json.loads((root / "gateway.pid").read_text())["pid"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def classify(procs: dict, gw_pid=None) -> dict:
    groups = {g: set() for g in GROUPS}
    claimed = set()

    def take(group, pids):
        fresh = set(pids) - claimed
        groups[group] |= fresh
        claimed.update(fresh)

    for pid, p in procs.items():
        if "work kanban task" in p["cmd"]:
            take("kanban_workers", {pid} | descendants(procs, pid))
    for pid, p in procs.items():
        if re.search(r"/Hermes\.app/Contents/MacOS/Hermes(\s|$)", p["cmd"]):
            tree = descendants(procs, pid)
            take("desktop_ui", {pid} | {c for c in tree if "Hermes.app/" in procs[c]["cmd"]})
            take("desktop_backend", tree)
    if gw_pid is not None and gw_pid in procs:
        take("gateway", {gw_pid} | descendants(procs, gw_pid))
    for pid, p in procs.items():
        if re.search(r"\s--(cli|tui)\b|ui-tui/dist/entry\.js", p["cmd"]):
            take("terminal_clients", {pid} | descendants(procs, pid))
    for pid, p in procs.items():
        if re.search(r"/(Terminal|Warp|Ghostty|iTerm)\.app/Contents/MacOS/", p["cmd"]):
            take("terminal_apps", {pid})
        elif re.search(r"/WindowServer(\s|$)", p["cmd"]):
            take("windowserver", {pid})
    return groups


def group_cpu_percent(s0: dict, s1: dict, groups: dict, wall: float) -> dict:
    out = {}
    for group, pids in groups.items():
        used = 0.0
        for pid in pids:
            before = s0.get(pid)
            start = before["cpu_s"] if before and before["cmd"] == s1[pid]["cmd"] else 0.0
            used += max(0.0, s1[pid]["cpu_s"] - start)
        out[group] = round(used / wall * 100, 1) if wall > 0 else 0.0
    return out


def measure(label: str, delay: float, duration: float, interval: float = 5.0) -> dict:
    if delay:
        time.sleep(delay)
    gw = gateway_pid()
    t0, s0 = time.time(), snapshot()
    rss = {g: [] for g in GROUPS}
    while True:
        left = duration - (time.time() - t0)
        if left <= 0:
            break
        time.sleep(min(interval, left))
        snap = snapshot()
        for group, pids in classify(snap, gw).items():
            rss[group].append(sum(snap[p]["rss_kb"] for p in pids) / 1024)
    t1, s1 = time.time(), snapshot()
    groups = classify(s1, gw)
    cpu = group_cpu_percent(s0, s1, groups, t1 - t0)
    result = {
        "label": label,
        "started_at": datetime.fromtimestamp(t0).isoformat(timespec="seconds"),
        "duration_s": round(t1 - t0, 1),
        "kanban_workers_running": sum(1 for p in s1.values() if "work kanban task" in p["cmd"]),
        "groups": {
            g: {
                "cpu_pct": cpu[g],
                "rss_mb_avg": round(sum(rss[g]) / len(rss[g])) if rss[g] else 0,
                "rss_mb_max": round(max(rss[g])) if rss[g] else 0,
                "procs": len(groups[g]),
            }
            for g in GROUPS
        },
    }
    ui, be = result["groups"]["desktop_ui"], result["groups"]["desktop_backend"]
    result["desktop_total"] = {
        "cpu_pct": round(ui["cpu_pct"] + be["cpu_pct"], 1),
        "rss_mb_avg": ui["rss_mb_avg"] + be["rss_mb_avg"],
    }
    return result


def _read_some(fd: int, wait: float) -> bytes:
    ready, _, _ = select.select([fd], [], [], wait)
    if not ready:
        return b""
    try:
        return os.read(fd, 65536)
    except OSError:
        return b""


def _stop(pid: int, fd: int) -> None:
    try:
        os.write(fd, b"/exit\r")
    except OSError:
        pass
    for sig in (None, signal.SIGTERM, signal.SIGKILL):
        if sig is not None:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        deadline = time.time() + 3
        while time.time() < deadline:
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return
            if done:
                return
            _read_some(fd, 0.1)


def startup(label: str, cmd: list, ready: str, timeout: float = 20.0, hold: float = 20.0) -> dict:
    """Start a terminal client in a pty, time it until `ready` shows, then measure it at idle for `hold` s."""
    import fcntl
    import pty
    import struct
    import termios

    before = snapshot()
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(cmd[0], cmd)
        finally:
            os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    pattern = re.compile(ready.encode())
    t0, buf, ready_s = time.time(), b"", None
    while time.time() - t0 < timeout:
        buf += _read_some(fd, 0.2)
        if pattern.search(ANSI.sub(b"", buf)):
            ready_s = round(time.time() - t0, 2)
            break
    s0, h0 = snapshot(), time.time()
    while time.time() - h0 < hold:
        buf += _read_some(fd, 0.2)
    s1, wall = snapshot(), time.time() - h0
    tree = {p for p in ({pid} | descendants(s1, pid)) if p in s1}
    cpu = group_cpu_percent(s0, s1, {"client": tree}, wall)["client"]
    new_runtimes = [s1[p]["cmd"][-120:] for p in sorted(s1) if p not in before and RUNTIME.search(s1[p]["cmd"])]
    rss_mb = round(sum(s1[p]["rss_kb"] for p in tree) / 1024)
    _stop(pid, fd)
    os.close(fd)
    return {
        "label": label,
        "cmd": cmd,
        "started_at": datetime.fromtimestamp(t0).isoformat(timespec="seconds"),
        "ready_s": ready_s,
        "hold_s": hold,
        "client_cpu_pct": cpu,
        "client_rss_mb": rss_mb,
        "client_procs": len(tree),
        "new_runtimes": new_runtimes,
        "screen_tail": ANSI.sub(b"", buf).decode("utf-8", "replace")[-1500:],
    }


def save(result: dict, out_dir: Path = OUT_DIR) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{result['label']}-{datetime.now():%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps(result, indent=2))
    return path


def table(result: dict) -> str:
    lines = [
        f"{result['label']}: {result['duration_s']} s, {result['kanban_workers_running']} kanban workers running",
        f"{'group':<18}{'CPU%':>7}{'RSS avg MB':>12}{'RSS max MB':>12}{'procs':>7}",
    ]
    for g in GROUPS:
        r = result["groups"][g]
        lines.append(f"{g:<18}{r['cpu_pct']:>7.1f}{r['rss_mb_avg']:>12}{r['rss_mb_max']:>12}{r['procs']:>7}")
    d = result["desktop_total"]
    lines.append(f"{'DESKTOP TOTAL':<18}{d['cpu_pct']:>7.1f}{d['rss_mb_avg']:>12}")
    return "\n".join(lines)


def compare(a: dict, b: dict) -> str:
    lines = [
        f"{a['label']} ({a['kanban_workers_running']} workers) -> {b['label']} ({b['kanban_workers_running']} workers)",
        f"{'group':<18}{'CPU% a':>8}{'CPU% b':>8}{'RSS a':>8}{'RSS b':>8}",
    ]
    for g in GROUPS:
        ra, rb = a["groups"][g], b["groups"][g]
        lines.append(f"{g:<18}{ra['cpu_pct']:>8.1f}{rb['cpu_pct']:>8.1f}{ra['rss_mb_avg']:>8}{rb['rss_mb_avg']:>8}")
    da, db = a["desktop_total"], b["desktop_total"]
    lines.append(f"{'DESKTOP TOTAL':<18}{da['cpu_pct']:>8.1f}{db['cpu_pct']:>8.1f}{da['rss_mb_avg']:>8}{db['rss_mb_avg']:>8}")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("measure")
    m.add_argument("--label", required=True)
    m.add_argument("--delay", type=float, default=0, help="seconds to wait first (let the app go idle)")
    m.add_argument("--duration", type=float, default=120)
    c = sub.add_parser("compare")
    c.add_argument("a")
    c.add_argument("b")
    s = sub.add_parser("startup")
    s.add_argument("--label", required=True)
    s.add_argument("--ready", default=r"Session:|\bready\b", help="regex that means the client is ready")
    s.add_argument("--timeout", type=float, default=20)
    s.add_argument("--hold", type=float, default=20)
    s.add_argument("command", nargs=argparse.REMAINDER)
    args = ap.parse_args(argv)

    if args.cmd == "measure":
        result = measure(args.label, args.delay, args.duration)
        path = save(result)
        print(table(result))
        print(f"saved: {path}")
    elif args.cmd == "compare":
        a, b = (json.loads(Path(p).read_text()) for p in (args.a, args.b))
        print(compare(a, b))
    else:
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command:
            ap.error("startup needs a command after --")
        result = startup(args.label, command, args.ready, args.timeout, args.hold)
        path = save(result)
        print(json.dumps({k: v for k, v in result.items() if k != "screen_tail"}, indent=2))
        print("--- screen tail ---")
        print(result["screen_tail"][-600:])
        print(f"saved: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
