#!/usr/bin/env python3
"""从 deploy/hero.png 生成门户封面 deploy/origami-cover.jpg (900x506)。

hero.png 是隐藏全部界面元素后的 3D 视图截图（见 make_hero.js），
这里压成门户封面尺寸，在左侧铺一层米色渐变压暗，再叠标题文字。
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'hero.png'
OUT = ROOT / 'origami-cover.jpg'
W, H = 900, 506

base = Image.open(SRC).convert('RGB').resize((W, H), Image.LANCZOS)

# ---- 左侧米色渐变压暗：让标题有干净的纸面
paper = (246, 242, 233)
alpha = np.zeros((H, W), dtype=np.uint8)
for x in range(W):
    t = x / (W * 0.62)
    a = 0 if t >= 1 else int(238 * (1 - t) ** 1.25)
    alpha[:, x] = a
base = Image.composite(Image.new('RGB', (W, H), paper), base, Image.fromarray(alpha, 'L'))

# ---- 底部轻微压暗，避免模型下沿与卡片底边贴太紧
alpha2 = np.zeros((H, W), dtype=np.uint8)
for y in range(H):
    if y > H * 0.72:
        alpha2[y, :] = int(52 * ((y - H * 0.72) / (H * 0.28)) ** 1.5)
base = Image.composite(Image.new('RGB', (W, H), (58, 44, 36)), base, Image.fromarray(alpha2, 'L'))


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


SONGTI = '/System/Library/Fonts/Supplemental/Songti.ttc'
SANS = '/System/Library/Fonts/Hiragino Sans GB.ttc'
f_title = font(SONGTI, 74)
f_sub = font(SONGTI, 30)
f_lead = font(SANS, 14)
f_small = font(SANS, 11)

ink = (38, 34, 30)
accent = (200, 68, 52)
muted = (122, 111, 98)

d = ImageDraw.Draw(base)

# 折角小图标：两个三角 = 一张纸折起来
d.polygon([(58, 96), (92, 60), (92, 96)], fill=(232, 85, 61))
d.polygon([(92, 60), (126, 96), (92, 96)], fill=(184, 64, 44))

d.text((58, 118), '纸 境', font=f_title, fill=ink)
d.text((62, 216), '折 纸 仿 真 平 台', font=f_sub, fill=accent)

d.line((62, 268, 300, 268), fill=(198, 178, 152), width=1)

d.text((62, 284), '画一张折痕图，看它自己折起来。', font=f_lead, fill=(72, 64, 56))
d.text((62, 306), '参数化折痕图案 · 杆-铰链物理仿真 · 分步折纸教程', font=f_lead, fill=(72, 64, 56))

d.text((62, 404), 'SVG / FOLD 导入导出   ·   OBJ / STL 模型   ·   离线单文件', font=f_small, fill=muted)
d.text((62, 424), '打开网页即可使用，无需安装', font=f_small, fill=(150, 138, 122))

d.rectangle((10, 10, W - 11, H - 11), outline=(206, 188, 164), width=1)
base.save(OUT, quality=92, optimize=True)
print(f'wrote {OUT} ({W}x{H})')
