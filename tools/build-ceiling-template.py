"""Build public/email/ceiling-blank.png from the owner's new artwork.

The uploaded artwork has placeholder text ([ANNUAL_GAIN], [CURRENT_INCOME], …)
baked into its value boxes. The runtime renderer draws real numbers into empty
boxes, so the placeholders have to come out here, once, offline.

Erasing is done by interpolating the clean row just above a text band with the
clean row just below it — that keeps both the boxes' horizontal texture (brushed
gold, low-poly navy) and their subtle vertical gradient, which a flat fill would
visibly flatten.
"""
from PIL import Image, ImageDraw, ImageFont

SRC = '/root/.claude/uploads/fe5dca1d-5a86-5d17-815b-a5c80a8b6089/046fedf0-higgsfield0b9cde723a9648ca87a40e0522126c59.png'
OUT = '/home/user/remix-of-proforma-pro/public/email/ceiling-template.jpg'
FONT_BOLD = '/mnt/skills/examples/canvas-design/canvas-fonts/BigShoulders-Bold.ttf'
FONT_REG = '/mnt/skills/examples/canvas-design/canvas-fonts/BigShoulders-Regular.ttf'
TARGET_W = 1200  # renderer draws at most 600 CSS px @2x

im = Image.open(SRC).convert('RGB')
W, H = im.size
px = im.load()

# (x0, x1) interior span to repaint, and the value/caption text bands found by
# scanning for text-coloured pixels inside each box.
ERASE = [
    # gold callout: value + the designer-facing caption
    (1250, 2025, 626, 733),
    (1250, 2025, 743, 817),
    # left column values
    (257, 783, 2820, 2882),
    (257, 783, 3000, 3067),
    (257, 783, 3180, 3244),
    # right column values
    (1262, 1988, 2398, 2487),
    (1262, 1988, 2644, 2735),
    (1262, 1988, 2886, 2980),
    # right income caption ("Current annual income" — wrong on the HTL side)
    (1262, 1988, 2491, 2549),
]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


for x0, x1, ya, yb in ERASE:
    top = [px[x, ya - 5] for x in range(x0, x1 + 1)]
    bot = [px[x, yb + 5] for x in range(x0, x1 + 1)]
    span = max(1, yb - ya)
    for y in range(ya, yb + 1):
        t = (y - ya) / span
        for i, x in enumerate(range(x0, x1 + 1)):
            px[x, y] = lerp(top[i], bot[i], t)

# ── Captions the template got wrong or left blank ────────────────────────
# Sizes/colours sampled from the surviving captions so the additions sit in the
# same visual family as the artwork.
d = ImageDraw.Draw(im)
GOLD_CAPTION = (214, 171, 90)
INK_ON_GOLD = (26, 22, 10)


def centered(text, font, cx, cy, fill):
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    d.text((cx - (r - l) / 2 - l, cy - (b - t) / 2 - t), text, font=font, fill=fill)


f_caption_gold = ImageFont.truetype(FONT_REG, 62)
f_caption_callout = ImageFont.truetype(FONT_REG, 60)

# HTL income box: the template captioned this "Current annual income", the same
# words as the left column, which reads as a contradiction on the HTL side.
centered('Projected annual income', f_caption_gold, (1262 + 1988) // 2, 2520, GOLD_CAPTION)
# The fourth box shipped empty; give it the monthly figure.
centered('More per month', f_caption_gold, (1262 + 1988) // 2, 3248, GOLD_CAPTION)
# "Headline one-year gain" is a note to the designer, not recruit-facing copy.
centered('More per year at Hometown Lending', f_caption_callout, (1250 + 2025) // 2, 780, INK_ON_GOLD)

out = im.resize((TARGET_W, round(H * TARGET_W / W)), Image.LANCZOS)
out.save(OUT, quality=92, optimize=True, progressive=True)
print(f'wrote {OUT} at {out.size}')
