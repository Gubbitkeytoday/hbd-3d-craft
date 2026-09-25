"""Paints the night-city view behind the window (used by the Blender bake as
the window's light source AND by the runtime as the backdrop plane), so the
light on the walls matches what you see through the glass.

    python scripts/room/make_city.py   ->  scripts/room/cache/city.png, public/room/city-night.webp
"""
import os, random
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 2048, 1280
rnd = random.Random(7)
img = Image.new('RGB', (W, H))
d = ImageDraw.Draw(img)
# Bangkok night sky: deep blue top, light-polluted violet/sodium haze low.
stops = [(0.0, (8, 14, 40)), (0.35, (22, 30, 72)), (0.62, (70, 52, 96)), (0.78, (150, 92, 86)), (0.9, (120, 70, 60)), (1.0, (30, 20, 26))]
for y in range(H):
    t = y / (H - 1)
    for i in range(len(stops) - 1):
        a, b = stops[i], stops[i + 1]
        if a[0] <= t <= b[0]:
            k = (t - a[0]) / (b[0] - a[0])
            c = tuple(int(a[1][j] + (b[1][j] - a[1][j]) * k) for j in range(3))
            break
    d.line([(0, y), (W, y)], fill=c)

layers = [
    dict(n=34, base=0.82, hmin=0.10, hmax=0.34, col=(44, 40, 70), lit=0.16, win=5, haze=0.55),
    dict(n=20, base=0.9, hmin=0.18, hmax=0.55, col=(26, 25, 44), lit=0.26, win=7, haze=0.25),
    dict(n=9, base=1.02, hmin=0.34, hmax=0.82, col=(13, 13, 22), lit=0.32, win=11, haze=0.0),
]
for L in layers:
    for i in range(L['n']):
        bw = W / L['n'] * (0.5 + rnd.random() * 0.75)
        bx = i / L['n'] * W + (rnd.random() - 0.5) * 60
        bh = H * (L['hmin'] + rnd.random() * (L['hmax'] - L['hmin']))
        by = H * L['base'] - bh
        d.rectangle([bx, by, bx + bw, H], fill=L['col'])
        s = L['win']
        y = by + s * 2
        while y < H * L['base'] - s:
            x = bx + s
            row_on = rnd.random() < 0.85
            while x < bx + bw - s * 1.5:
                if row_on and rnd.random() < L['lit']:
                    warm = rnd.random() < 0.72
                    a = 0.45 + rnd.random() * 0.55
                    c = (255, int(185 + rnd.random() * 45), int(110 + rnd.random() * 60)) if warm else (185, 215, 255)
                    base = L['col']
                    c = tuple(int(base[j] + (c[j] - base[j]) * a) for j in range(3))
                    d.rectangle([x, y, x + s, y + s * 1.15], fill=c)
                x += s * 1.8
            y += s * 2.3
        if rnd.random() < 0.35:
            d.rectangle([bx + bw / 2 - 3, by - 5, bx + bw / 2 + 3, by + 1], fill=(255, 70, 60))
    # Haze over the far layers
    if L['haze']:
        img = Image.blend(img, img.filter(ImageFilter.GaussianBlur(3)), L['haze'] * 0.6)
        d = ImageDraw.Draw(img)

# Street-level glow + bokeh
glow = Image.new('RGB', (W, H), (0, 0, 0))
g = ImageDraw.Draw(glow)
for _ in range(140):
    x = rnd.random() * W
    y = H * (0.86 + rnd.random() * 0.14)
    r = 6 + rnd.random() * 26
    warm = rnd.random() < 0.75
    c = (255, 170, 90) if warm else (230, 240, 255)
    g.ellipse([x - r, y - r, x + r, y + r], fill=tuple(int(v * (0.35 + rnd.random() * 0.4)) for v in c))
glow = glow.filter(ImageFilter.GaussianBlur(9))
from PIL import ImageChops
img = ImageChops.add(img, glow)

os.makedirs(os.path.join(HERE, 'cache'), exist_ok=True)
img.save(os.path.join(HERE, 'cache', 'city.png'))
pub = os.path.join(HERE, '..', '..', 'public', 'room')
os.makedirs(pub, exist_ok=True)
img.resize((1024, 640), Image.LANCZOS).save(os.path.join(pub, 'city-night.webp'), quality=82, method=6)
print('city ok', os.path.getsize(os.path.join(pub, 'city-night.webp')))
