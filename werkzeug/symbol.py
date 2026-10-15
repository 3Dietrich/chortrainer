#!/usr/bin/env python3
"""Symbol der öffentlichen Fassung (pankd.de/noten/): zwei rote Achtel auf dem
Trainer-Dunkel. Erzeugt icon-192.png, icon-512.png, apple-touch-icon.png und
favicon-32.png im Repo-Ordner. Der Chor-Trainer im Verein hat sein eigenes Logo."""
from pathlib import Path
from PIL import Image, ImageDraw

DUNKEL, ROT = (31, 31, 30), (248, 84, 84)
ZIEL = Path(__file__).resolve().parents[1]


def zeichnen(n=1024):
    bild = Image.new('RGB', (n, n), DUNKEL)
    d = ImageDraw.Draw(bild)
    s = n / 100
    # Inhalt reicht von x=20 bis 88: um 4 nach links, damit er mittig sitzt
    # Zwei Notenköpfe (schräg liegende Ellipsen), Hälse, ein Balken
    for x, y in ((18, 70), (56, 62)):
        kopf = Image.new('L', (int(26 * s), int(18 * s)), 0)
        ImageDraw.Draw(kopf).ellipse([0, 0, kopf.width - 1, kopf.height - 1], fill=255)
        kopf = kopf.rotate(22, expand=True, resample=Image.BICUBIC)
        bild.paste(ROT, (int((x - 2) * s), int((y - 9) * s)), kopf)
    d.rectangle([40 * s, 24 * s, 46 * s, 72 * s], fill=ROT)
    d.rectangle([78 * s, 16 * s, 84 * s, 64 * s], fill=ROT)
    d.polygon([(40 * s, 24 * s), (84 * s, 16 * s), (84 * s, 28 * s), (40 * s, 36 * s)], fill=ROT)
    return bild


gross = zeichnen()
for name, groesse in (('icon-512.png', 512), ('icon-192.png', 192),
                      ('apple-touch-icon.png', 180), ('favicon-32.png', 32)):
    gross.resize((groesse, groesse), Image.LANCZOS).save(ZIEL / name, optimize=True)
    print(name)
