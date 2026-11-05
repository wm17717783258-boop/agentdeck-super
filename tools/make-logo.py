#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成插件图标 assets/logo.png（≤256 KiB，市场要求）

设计意图：三张叠起来的卡（一支队伍/一个任务板）+ 一枚连接节点（协同/串门），
深底亮线，缩到 48px 也能看清轮廓 —— 图标在小尺寸下最怕细节糊成一团。

用法：
  <bundled python> tools/make-logo.py
"""

import math
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "logo.png")
SIZE = 512          # 主图 512，市场会自己缩
SS = 4              # 超采样倍数，边缘才不毛


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def rounded_card(size, radius, color, alpha=255):
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=color + (alpha,))
    return img


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    W = SIZE * SS
    canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))

    # ── 底：圆角方块 + 竖向渐变（墨蓝 → 近黑）─────────────────────────
    bg = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, W))
    top, bottom = (24, 32, 58), (10, 13, 26)
    for y in range(W):
        c = lerp(top, bottom, y / (W - 1))
        grad.putpixel((0, y), c + (255,))
    grad = grad.resize((W, W))
    mask = rounded_card((W, W), int(W * 0.235), (255, 255, 255))  # 只借 mask
    bg.paste(grad, (0, 0), mask.split()[-1])
    canvas = Image.alpha_composite(canvas, bg)


    # ── 三张叠卡：后 → 前，微微旋转，像一叠待办 ─────────────────────
    cw, ch = int(W * 0.395), int(W * 0.245)
    cards = [
        dict(cx=0.393, cy=0.607, ang=-13, col=(96, 132, 255), a=205),   # 蓝
        dict(cx=0.474, cy=0.497, ang=-4, col=(139, 108, 255), a=225),   # 紫
        dict(cx=0.556, cy=0.386, ang=6, col=(64, 224, 208), a=245),     # 青（最前）
    ]
    for spec in cards:
        card = rounded_card((cw, ch), int(ch * 0.26), spec["col"], spec["a"])
        # 卡面上两条"内容线"，暗示这是任务卡
        cd = ImageDraw.Draw(card)
        pad = int(cw * 0.13)
        line_h = max(2, int(ch * 0.085))
        for i, frac in enumerate((0.40, 0.66)):
            y = int(ch * frac)
            cd.rounded_rectangle(
                [pad, y, pad + int((cw - pad * 2) * (0.62 if i == 0 else 0.40)), y + line_h],
                radius=line_h // 2,
                fill=(255, 255, 255, 235 if i == 0 else 150),
            )
        card = card.rotate(spec["ang"], resample=Image.BICUBIC, expand=True)
        canvas.alpha_composite(card, (int(W * spec["cx"] - card.width / 2), int(W * spec["cy"] - card.height / 2)))

    # ── 右上角：连接节点（协同/串门），两点一线 ───────────────────────
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    r_node = int(W * 0.052)
    p1 = (int(W * 0.663), int(W * 0.176))
    p2 = (int(W * 0.795), int(W * 0.281))
    ld.line([p1, p2], fill=(255, 210, 120, 235), width=int(W * 0.026))
    for p in (p1, p2):
        ld.ellipse([p[0] - r_node, p[1] - r_node, p[0] + r_node, p[1] + r_node], fill=(255, 226, 160, 255))
        ld.ellipse(
            [p[0] - r_node * 0.45, p[1] - r_node * 0.45, p[0] + r_node * 0.45, p[1] + r_node * 0.45],
            fill=(255, 255, 255, 255),
        )
    # 光晕
    glow = layer.filter(ImageFilter.GaussianBlur(int(W * 0.020)))
    canvas = Image.alpha_composite(canvas, glow)
    canvas = Image.alpha_composite(canvas, layer)

    # ── 收尾：降采样 + 交回 ───────────────────────────────────────────
    final = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    final.save(OUT, "PNG", optimize=True)
    kb = os.path.getsize(OUT) / 1024
    print(f"已生成 {OUT} · {SIZE}x{SIZE} · {kb:.1f} KiB（上限 256 KiB）")
    if kb > 256:
        raise SystemExit("图标超过 256 KiB，市场会拒收")


if __name__ == "__main__":
    main()
