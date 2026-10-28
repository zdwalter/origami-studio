#!/usr/bin/env python3
"""幂等更新门户首页：插入/替换「纸境」卡片，首次上线时在架数量 +1。"""
import re
import sys
from pathlib import Path

if len(sys.argv) < 4:
    raise SystemExit("usage: patch_portal.py <portal.html> <card.html> <output.html>")

portal_path, card_path, out_path = map(Path, sys.argv[1:4])
portal = portal_path.read_text(encoding="utf-8")
card = card_path.read_text(encoding="utf-8").strip()
start, end = "<!-- origami:start -->", "<!-- origami:end -->"

if start in portal and end in portal:
    portal = re.sub(re.escape(start) + r".*?" + re.escape(end), card, portal, flags=re.S)
    print("portal card updated")
else:
    marker = "</section>"
    if marker not in portal:
        raise SystemExit("portal section marker not found")
    portal = portal.replace(marker, card + "\n\n" + marker, 1)

    def bump(m):
        return m.group(1) + str(int(m.group(2)) + 1) + m.group(3)

    portal, n = re.subn(r'(id="gameCount">)(\d+)(<)', bump, portal, count=1)
    print("portal card inserted" + (", count incremented" if n else ""))

out_path.write_text(portal, encoding="utf-8")
