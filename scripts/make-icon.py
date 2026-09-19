#!/usr/bin/env python3
"""Turn the square source artwork into a macOS-shaped app icon set.

macOS icons are not plain squares: the artwork sits on a superelliptic
("squircle") plate inset inside a 1024pt canvas. Shipping a raw PNG makes the
icon look oversized and sharp-cornered next to every other app in the Dock, so
we mask the art ourselves and emit both the .icns (bundle/Dock) and a flat PNG
(Linux/Windows fallback, README).

Usage: python3 scripts/make-icon.py [source.png]
Writes build/icon.icns and build/icon.png.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = REPO_ROOT / "icon" / "icon.png"
OUT_DIR = REPO_ROOT / "build"

CANVAS = 1024
#: Apple's macOS Big Sur+ grid: the plate is 824pt wide inside a 1024pt canvas.
PLATE = 824
#: Superellipse exponent approximating Apple's continuous-corner squircle.
SQUIRCLE_N = 5.0
#: Trim the source's own painted border so our mask does not clip it unevenly.
SOURCE_TRIM = 0.02
#: Supersampling factor for a clean, non-aliased mask edge.
SS = 4
#: .icns needs every size Finder/Dock/Get Info can ask for.
ICNS_SIZES = ((16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2))


def squircle_mask(size: int, exponent: float = SQUIRCLE_N) -> Image.Image:
    """Antialiased alpha mask of |x|^n + |y|^n = 1 scaled to `size`."""
    big = size * SS
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    radius = big / 2.0
    for row in range(big):
        # Normalised vertical distance from the centre of the plate.
        y = (row + 0.5 - radius) / radius
        remaining = 1.0 - min(abs(y), 1.0) ** exponent
        if remaining <= 0:
            continue
        half_width = remaining ** (1.0 / exponent) * radius
        draw.line([(radius - half_width, row), (radius + half_width - 1, row)], fill=255)
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def center_square(image: Image.Image, trim: float = SOURCE_TRIM) -> Image.Image:
    """Largest centred square of the source, minus a small border trim."""
    side = min(image.size)
    left = (image.width - side) // 2
    top = (image.height - side) // 2
    inset = int(side * trim)
    return image.crop((left + inset, top + inset, left + side - inset, top + side - inset))


def build_plate(source: Path) -> Image.Image:
    art = center_square(Image.open(source).convert("RGBA")).resize((PLATE, PLATE), Image.Resampling.LANCZOS)
    art.putalpha(squircle_mask(PLATE))

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    # A soft contact shadow is what makes a macOS icon read as "a real app".
    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 90), ((CANVAS - PLATE) // 2, (CANVAS - PLATE) // 2 + 10), art.getchannel("A"))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(10)))
    canvas.alpha_composite(art, ((CANVAS - PLATE) // 2, (CANVAS - PLATE) // 2))
    return canvas


def main(argv: list[str]) -> int:
    source = Path(argv[1]).resolve() if len(argv) > 1 else DEFAULT_SOURCE
    if not source.exists():
        print(f"source artwork not found: {source}", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    plate = build_plate(source)
    png_path = OUT_DIR / "icon.png"
    plate.save(png_path)

    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for point, scale in ICNS_SIZES:
            pixels = point * scale
            suffix = "" if scale == 1 else "@2x"
            plate.resize((pixels, pixels), Image.Resampling.LANCZOS).save(iconset / f"icon_{point}x{point}{suffix}.png")
        icns_path = OUT_DIR / "icon.icns"
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns_path)], check=True)

    print(f"wrote {icns_path} and {png_path} from {source}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
