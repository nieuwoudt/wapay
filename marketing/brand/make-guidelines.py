#!/usr/bin/env python3
"""
WaPay Brand Guidelines PDF — for sharing with Canva / external designers.
Embeds the REAL logo files, paints the palette as swatches, and sets the
type samples in actual Inter (registered from the kit's TTFs).
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as rlcanvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader, simpleSplit

KIT = os.path.expanduser('~/Desktop/WaPay-Brand-Kit')
OUT = os.path.join(KIT, 'WaPay-Brand-Guidelines.pdf')
W, H = A4
M = 20 * mm

GREEN = HexColor('#359853')
DEEP = HexColor('#1B7A3D')
WA = HexColor('#25D366')
INK = HexColor('#1D2026')
MUTED = HexColor('#4E5C54')
PAGEBG = HexColor('#F4F7F5')
TEAL = HexColor('#075E54')
GOLD = HexColor('#F0B429')
LINE = HexColor('#E2E8E4')
WHITE = HexColor('#FFFFFF')

pdfmetrics.registerFont(TTFont('Inter', os.path.join(KIT, 'fonts', 'Inter-wght-400.ttf')))
pdfmetrics.registerFont(TTFont('Inter-Semi', os.path.join(KIT, 'fonts', 'Inter-wght-600.ttf')))
pdfmetrics.registerFont(TTFont('Inter-Bold', os.path.join(KIT, 'fonts', 'Inter-wght-700.ttf')))

c = rlcanvas.Canvas(OUT, pagesize=A4)
c.setTitle('WaPay Brand Guidelines')
c.setAuthor('WaPay (Pty) Ltd')
page_no = [0]


def furniture(section=''):
    page_no[0] += 1
    if page_no[0] == 1:
        return
    c.setFont('Inter-Semi', 8.5)
    c.setFillColor(GREEN)
    c.drawString(M, H - 12 * mm, 'WaPay Brand Guidelines')
    c.setFont('Inter', 8.5)
    c.setFillColor(MUTED)
    c.drawRightString(W - M, H - 12 * mm, section)
    c.setStrokeColor(LINE)
    c.setLineWidth(0.6)
    c.line(M, H - 15 * mm, W - M, H - 15 * mm)
    c.setFont('Inter', 8)
    c.setFillColor(MUTED)
    c.drawCentredString(W / 2, 10 * mm, f'{page_no[0]}')


def h1(y, text):
    c.setFont('Inter-Bold', 22)
    c.setFillColor(INK)
    c.drawString(M, y, text)
    return y - 10 * mm


def body(y, text, size=10, leading=14.5, color=INK, font='Inter', width=W - 2 * M):
    c.setFont(font, size)
    c.setFillColor(color)
    for ln in simpleSplit(text, font, size, width):
        c.drawString(M, y, ln)
        y -= leading
    return y


def img_fitted(path, x, y_top, max_w, max_h, center_in=None):
    """Draw image scaled into a box; returns actual bottom y."""
    r = ImageReader(path)
    iw, ih = r.getSize()
    s = min(max_w / iw, max_h / ih)
    w, h = iw * s, ih * s
    if center_in:
        x = x + (center_in - w) / 2
    c.drawImage(r, x, y_top - h, w, h, mask='auto')
    return y_top - h


def label(x, y, text, color=MUTED, size=8.5, font='Inter'):
    c.setFont(font, size)
    c.setFillColor(color)
    c.drawString(x, y, text)


# ------------------------------------------------------------- cover
furniture()
c.setFillColor(PAGEBG)
c.rect(0, 0, W, H, stroke=0, fill=1)
c.setFillColor(WHITE)
c.roundRect(M, H / 2 - 30 * mm, W - 2 * M, 95 * mm, 6 * mm, stroke=0, fill=1)
img_fitted(os.path.join(KIT, 'wapay-logo-1024.png'), M, H / 2 + 58 * mm, W - 2 * M, 70 * mm, center_in=W - 2 * M)
c.setFont('Inter-Bold', 30)
c.setFillColor(INK)
c.drawCentredString(W / 2, H / 2 - 6 * mm, 'Brand Guidelines')
c.setFont('Inter', 12)
c.setFillColor(MUTED)
c.drawCentredString(W / 2, H / 2 - 14 * mm, 'WaPay  ·  Please Pay Me')
c.setFont('Inter', 10)
c.drawCentredString(W / 2, H / 2 - 22 * mm, 'Version 1.0  ·  31 August 2026  ·  for Canva and external designers')
c.setFont('Inter', 9)
c.setFillColor(MUTED)
c.drawCentredString(W / 2, 18 * mm, 'WaPay (Pty) Ltd  ·  wapay.co.za  ·  Please Pay Me is a WaPay service. WaPay is not a bank.')
c.showPage()

# ------------------------------------------------------------- 1. the wapay logo
furniture('1 · The WaPay logo')
y = H - 30 * mm
y = h1(y, 'The WaPay logo')
y = body(y, 'The logo is the W mark — two slanted strokes and a dot — with the WaPay wordmark, '
            'always in the brand green (#359853). It is supplied as finished artwork: never redraw, '
            'retype or recolor it.', color=MUTED)
y -= 4 * mm
box_h = 52 * mm
c.setFillColor(PAGEBG); c.roundRect(M, y - box_h, W - 2 * M, box_h, 4 * mm, stroke=0, fill=1)
img_fitted(os.path.join(KIT, 'wapay-logo-1024.png'), M + 8 * mm, y - 5 * mm, W - 2 * M - 16 * mm, box_h - 12 * mm, center_in=W - 2 * M - 16 * mm)
label(M + 4 * mm, y - box_h + 3 * mm, 'Primary  ·  wapay-logo-1024.png (transparent)')
y -= box_h + 8 * mm

half = (W - 2 * M - 8 * mm) / 2
box_h2 = 42 * mm
c.setFillColor(PAGEBG); c.roundRect(M, y - box_h2, half, box_h2, 4 * mm, stroke=0, fill=1)
img_fitted(os.path.join(KIT, 'wapay-logo-1024-TM.png'), M + 6 * mm, y - 6 * mm, half - 12 * mm, box_h2 - 14 * mm, center_in=half - 12 * mm)
label(M + 4 * mm, y - box_h2 + 3 * mm, 'With TM  ·  wapay-logo-1024-TM.png')
x2 = M + half + 8 * mm
c.setFillColor(PAGEBG); c.roundRect(x2, y - box_h2, half, box_h2, 4 * mm, stroke=0, fill=1)
img_fitted(os.path.join(KIT, 'wapay-favicon-128.png'), x2 + 6 * mm, y - 6 * mm, half - 12 * mm, box_h2 - 14 * mm, center_in=half - 12 * mm)
label(x2 + 4 * mm, y - box_h2 + 3 * mm, 'App icon / favicon  ·  wapay-favicon-128.png')
y -= box_h2 + 10 * mm

y = body(y, 'Rules', size=12, font='Inter-Semi')
for rule in [
    'Clearspace: keep at least the height of the W-mark’s dot clear on every side.',
    'Minimum width 120 px (digital) / 30 mm (print); below that, use the app icon alone.',
    'The TM version and the plain version are both approved — pick per placement, never add your own TM.',
    'Never stretch, outline, shadow, rotate or recolor. Never place on low-contrast or busy backgrounds.',
    'On dark or photographic backgrounds, use the logo on a white rounded card, as on the cover.',
]:
    y = body(y, '•  ' + rule, size=9.5, leading=13.5, color=INK)
c.showPage()

# ------------------------------------------------------------- 2. please pay me
furniture('2 · Please Pay Me')
y = H - 30 * mm
y = h1(y, 'Please Pay Me')
y = body(y, 'Please Pay Me is WaPay’s payment-request service. Its logo is the green wordmark below — '
            'Inter SemiBold in the same brand green — exactly as it appears on the pleasepayme.co.za pay '
            'screen, optionally led by the prayer-hands (please) emoji in product UI.', color=MUTED)
y -= 4 * mm
box_h = 34 * mm
c.setFillColor(PAGEBG); c.roundRect(M, y - box_h, W - 2 * M, box_h, 4 * mm, stroke=0, fill=1)
img_fitted(os.path.join(KIT, 'logo-pleasepayme.png'), M + 10 * mm, y - 8 * mm, W - 2 * M - 20 * mm, box_h - 16 * mm, center_in=W - 2 * M - 20 * mm)
label(M + 4 * mm, y - box_h + 3 * mm, 'Wordmark  ·  logo-pleasepayme.svg / .png')
y -= box_h + 6 * mm
c.setFillColor(PAGEBG); c.roundRect(M, y - box_h, W - 2 * M, box_h, 4 * mm, stroke=0, fill=1)
img_fitted(os.path.join(KIT, 'logo-pleasepayme-TM.png'), M + 10 * mm, y - 8 * mm, W - 2 * M - 20 * mm, box_h - 16 * mm, center_in=W - 2 * M - 20 * mm)
label(M + 4 * mm, y - box_h + 3 * mm, 'With TM  ·  logo-pleasepayme-TM.svg / .png')
y -= box_h + 10 * mm

y = body(y, 'How the two brands relate', size=12, font='Inter-Semi')
for rule in [
    'Please Pay Me always appears with the credit line “with WaPay” or “Powered by WaPay” nearby.',
    'Standing footer wherever both appear: “Please Pay Me is a WaPay service for requesting payments on WhatsApp. WaPay is not a bank.”',
    'Both wordmarks are green #359853 — the shared color IS the family resemblance.',
    'The SVG wordmark type is outlined to paths — no font needed to open or scale it.',
]:
    y = body(y, '•  ' + rule, size=9.5, leading=13.5)
c.showPage()

# ------------------------------------------------------------- 3. color
furniture('3 · Color')
y = H - 30 * mm
y = h1(y, 'Color')
y = body(y, 'One green family carries both brands. #25D366 is reserved for exactly one thing: the WhatsApp '
            'action button — never use it for anything else.', color=MUTED)
y -= 3 * mm

swatches = [
    ('Brand green', '#359853', 'Logos, wordmarks, accents, links', WHITE),
    ('Deep green', '#1B7A3D', 'Solid CTA button fills on pay pages', WHITE),
    ('WhatsApp green', '#25D366', 'RESERVED: the one WhatsApp CTA button per screen', INK),
    ('Ink', '#1D2026', 'Headlines and body text on light', WHITE),
    ('Muted', '#4E5C54', 'Secondary copy, captions', WHITE),
    ('Teal', '#075E54', 'WhatsApp-style chat chrome only', WHITE),
    ('Page background', '#F4F7F5', 'Soft green-tinted page ground', INK),
    ('Surface', '#FFFFFF', 'Cards and content surfaces', INK),
    ('Gold', '#F0B429', 'Sparing highlight (ratings, “new”)', INK),
]
sw_h = 20 * mm
for name, hexv, use, txt in swatches:
    c.setFillColor(HexColor(hexv))
    c.setStrokeColor(LINE); c.setLineWidth(0.7)
    c.roundRect(M, y - sw_h, W - 2 * M, sw_h, 3 * mm, stroke=1, fill=1)
    c.setFillColor(txt)
    c.setFont('Inter-Semi', 11)
    c.drawString(M + 6 * mm, y - 8 * mm, name)
    c.setFont('Inter', 9)
    c.drawString(M + 6 * mm, y - 14 * mm, use)
    c.setFont('Inter-Semi', 11)
    c.drawRightString(W - M - 6 * mm, y - 11 * mm, hexv)
    y -= sw_h + 4 * mm
c.showPage()

# ------------------------------------------------------------- 4. typography
furniture('4 · Typography')
y = H - 30 * mm
y = h1(y, 'Typography')
y = body(y, 'Everything is set in Inter. It ships free in Canva (search “Inter” in the font picker) and on '
            'Google Fonts, and the TTF files travel with this kit.', color=MUTED)
y -= 5 * mm

samples = [
    ('Inter SemiBold  ·  headlines & UI', 'Inter-Semi', 24, 'Get paid on WhatsApp.'),
    ('Inter Bold  ·  emphasis & numbers', 'Inter-Bold', 24, 'R20 — no fees for you.'),
    ('Inter Regular  ·  body copy', 'Inter', 12.5,
     'Warm, plain, South African everyday. Short sentences. “Get paid,” “your link,” “share it.” '
     'Speak like a helpful person, not a bank letter.'),
]
for cap, font, size, sample in samples:
    label(M, y, cap.upper(), size=8, font='Inter-Semi', color=GREEN)
    y -= 9 * mm if size > 20 else 7 * mm
    c.setFont(font, size)
    c.setFillColor(INK)
    for ln in simpleSplit(sample, font, size, W - 2 * M):
        c.drawString(M, y, ln)
        y -= size * 1.35
    y -= 8 * mm

y -= 2 * mm
y = body(y, 'Type rules', size=12, font='Inter-Semi')
for rule in [
    'Headlines: SemiBold 600, tight but never all-caps sentences.',
    'Body: Regular 400 at 14–16 px digital; keep lines under ~70 characters.',
    'Buttons: SemiBold 600, sentence case (“Pay from my WaPay account”).',
    'Wordmark text is artwork — never retype “WaPay” or “Please Pay Me” in layouts as a logo substitute.',
]:
    y = body(y, '•  ' + rule, size=9.5, leading=13.5)
c.showPage()

# ------------------------------------------------------------- 5. usage
furniture('5 · Usage & voice')
y = H - 30 * mm
y = h1(y, 'Usage & voice')
y = body(y, 'Do', size=12, font='Inter-Semi', color=GREEN)
for rule in [
    'Lead with what the customer gets: “Get paid on WhatsApp”, “Buy airtime in chat”.',
    'One bright #25D366 WhatsApp button per screen; every other button uses the deep green.',
    'Keep layouts light: white cards on the soft green page background, rounded corners (12–16 px).',
    'Use real product screenshots from WhatsApp where possible — the chat IS the product.',
]:
    y = body(y, '•  ' + rule, size=9.5, leading=13.5)
y -= 3 * mm
y = body(y, "Don't", size=12, font='Inter-Semi', color=HexColor('#C0392B'))
for rule in [
    'Never call WaPay a bank, or imply deposits are bank accounts. The standing line: “WaPay is not a bank.”',
    'Never promote betting or gambling in WhatsApp creative — web placements only, and only with sign-off.',
    'Never promise fee percentages or savings claims without checking current pricing first.',
    'Never use the old speech-bubble mark or any redrawn W — the supplied files are the only approved logos.',
    'Never show a customer’s number, balance or voucher PIN in creative — use obviously fake sample data.',
]:
    y = body(y, '•  ' + rule, size=9.5, leading=13.5)
y -= 4 * mm
y = body(y, 'Boilerplate', size=12, font='Inter-Semi')
c.setFillColor(PAGEBG)
c.roundRect(M, y - 24 * mm, W - 2 * M, 26 * mm, 3 * mm, stroke=0, fill=1)
y -= 2 * mm
y = body(y - 4 * mm, '“WaPay is a digital voucher and payments service delivered over WhatsApp, operating on '
         'licensed payment rails. WaPay is not a bank or financial institution. Terms, conditions and '
         'product rules apply.”', size=9.5, leading=13.5, color=MUTED, width=W - 2 * M - 12 * mm)
y -= 8 * mm
y = body(y, 'Files in the kit: wapay-logo-1024[-TM].png, wapay-logo-512/256.png, wapay-favicon-128.png, '
            'wapay-logo-1024-white-bg.jpg, logo-pleasepayme[-TM].svg/.png, fonts/Inter-*.ttf, BRAND.md. '
            'Questions: niev@espen.ai.', size=8.5, leading=12, color=MUTED)
c.showPage()

c.save()
print('wrote', OUT)
