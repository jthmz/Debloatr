#!/usr/bin/env python3
"""Draw the app icon: gui/icon.png (1024 x 1024) and app/AppIcon.icns.

    python3 tools/make_icon.py        (needs Pillow)

A charged-lime bolt on a graphite tile, in the proportions of a macOS app
icon: an 824 px body on a 1024 px canvas with rounded corners. Both files are
kept in the repository, so building the app needs no image tools.
"""
import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
SCALE = 4                      # drawn large, then scaled down for clean edges
BODY = 824
RADIUS = 185
GRAPHITE = (22, 23, 26, 255)
EDGE = (43, 45, 51, 255)
LIME = (191, 255, 0, 255)

# The bolt on a 24 unit grid.
BOLT = [(13, 2), (3, 14), (12, 14), (11, 22), (21, 10), (12, 10)]

# What a .icns file holds: the picture at each size macOS asks for, as PNG,
# each under a four-letter code. ic11 to ic14 are the double-density ones.
ICNS = [(b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024),
        (b"ic11", 32), (b"ic12", 64), (b"ic13", 256), (b"ic14", 512)]


def draw_icon():
    n = SIZE * SCALE
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    inset = (SIZE - BODY) // 2 * SCALE
    box = (inset, inset, n - inset, n - inset)
    draw.rounded_rectangle(box, radius=RADIUS * SCALE, fill=EDGE)
    line = 6 * SCALE
    draw.rounded_rectangle(
        (box[0] + line, box[1] + line, box[2] - line, box[3] - line),
        radius=(RADIUS - 6) * SCALE, fill=GRAPHITE)

    # Centre the bolt in the body at a little over half its height.
    unit = BODY * SCALE * 0.56 / 20          # the bolt is 20 units tall
    left = n / 2 - 12 * unit                 # its box is 24 units wide, centred on 12
    top = n / 2 - 12 * unit
    draw.polygon([(left + x * unit, top + y * unit) for x, y in BOLT], fill=LIME)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def png(img, size):
    out = io.BytesIO()
    scaled = img if size == img.width else img.resize((size, size), Image.LANCZOS)
    scaled.save(out, "PNG", optimize=True)
    return out.getvalue()


def icns(img):
    """The .icns container: a header, a table of contents, then the pictures."""
    pictures = [(code, png(img, size)) for code, size in ICNS]
    entry = lambda code, data: code + struct.pack(">I", len(data) + 8) + data
    contents = b"".join(code + struct.pack(">I", len(data) + 8) for code, data in pictures)
    body = entry(b"TOC ", contents) + b"".join(entry(code, data) for code, data in pictures)
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main():
    root = Path(__file__).resolve().parents[1]
    img = draw_icon()
    for path, data in ((root / "gui" / "icon.png", png(img, SIZE)),
                       (root / "app" / "AppIcon.icns", icns(img))):
        path.write_bytes(data)
        print(f"wrote {path} ({len(data) // 1024} KB)")


if __name__ == "__main__":
    main()
