#!/usr/bin/env python3
"""Bundle index.html + css + js into a single self-contained HTML file (dist/origami-studio.html)."""
import os, re
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(root, 'index.html'), encoding='utf-8').read()

def css(m):
    return '<style>\n' + open(os.path.join(root, m.group(1)), encoding='utf-8').read() + '\n</style>'

def js(m):
    code = open(os.path.join(root, m.group(1)), encoding='utf-8').read().replace('</script', '<\\/script')
    return '<script>\n/* ---- ' + m.group(1) + ' ---- */\n' + code + '\n</script>'

out = re.sub(r'<link rel="stylesheet" href="([^"]+)">', css, src)
out = re.sub(r'<script src="([^"]+)"></script>', js, out)
os.makedirs(os.path.join(root, 'dist'), exist_ok=True)
dst = os.path.join(root, 'dist', 'origami-studio.html')
open(dst, 'w', encoding='utf-8').write(out)
print(dst, len(out.encode('utf-8')) // 1024, 'KB')
