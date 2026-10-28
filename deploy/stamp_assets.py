#!/usr/bin/env python3
"""给 index.html 中的本地 js/css 打上 ?v=<stamp> 版本号。"""
import re
import sys
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit("usage: stamp_assets.py <stamp> <index.html>")
stamp, target = sys.argv[1], Path(sys.argv[2])
html = target.read_text(encoding="utf-8")
asset = re.compile(r'((?:href|src)=")(?!https?:|data:|#|//)([^"?#]+\.(?:js|css))(?:\?v=[^"]*)?(")')

def repl(m):
    return f'{m.group(1)}{m.group(2)}?v={stamp}{m.group(3)}'

new, n = asset.subn(repl, html)
if n == 0:
    raise SystemExit("no local js/css references found")
target.write_text(new, encoding="utf-8")
print(f"stamped {n} asset references with {stamp}")
