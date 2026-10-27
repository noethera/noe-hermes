#!/usr/bin/env python3
"""Embed desktop plugins into install.sh as heredoc payloads (idempotent).

usage: python3 tools/embed_desktop_plugins.py <id>=<path/to/plugin.js> [...]
Replaces an existing '# ---------- payload: desktop-plugins/<id>/plugin.js' block,
or inserts a new one at the end of the payload section (before the skin check).
"""
import re
import sys
from pathlib import Path

INSTALL = Path(__file__).resolve().parent.parent / "install.sh"
EOF = "__NOETHERA_PLUGIN_EOF__"
ANCHOR = '[ -f "$PAYLOAD/themes/$SKIN.yaml" ]'  # first line after the payload section


def block(pid: str, js: str) -> str:
    if EOF in js:
        sys.exit(f"{pid}: plugin source contains the heredoc terminator {EOF}")
    return (
        f"# ---------- payload: desktop-plugins/{pid}/plugin.js ----------\n"
        f'mkdir -p "$PAYLOAD/desktop-plugins/{pid}"\n'
        f"cat > \"$PAYLOAD/desktop-plugins/{pid}/plugin.js\" <<'{EOF}'\n"
        f"{js.rstrip(chr(10))}\n{EOF}\n\n"
    )


def main(args: list[str]) -> None:
    text = INSTALL.read_text()
    for arg in args:
        pid, path = arg.split("=", 1)
        new = block(pid, Path(path).read_text())
        pat = re.compile(
            rf"# ---------- payload: desktop-plugins/{re.escape(pid)}/plugin\.js ----------\n.*?\n{EOF}\n\n", re.S
        )
        if pat.search(text):
            text = pat.sub(lambda _m: new, text, count=1)
            print("updated", pid)
        else:
            i = text.index(ANCHOR)
            text = text[:i] + new + text[i:]
            print("inserted", pid)
    INSTALL.write_text(text)


if __name__ == "__main__":
    main(sys.argv[1:])
