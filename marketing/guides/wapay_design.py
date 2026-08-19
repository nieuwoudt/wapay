"""WaPay booklet design system — shared helpers for the pricing & product guides.

Brand pulled from wapay.co.za CSS tokens:
  --primary: hsl(152 69% 39%)  -> #1FA867 emerald
  --primary-dark: hsl(160 84% 29%) -> #0C885E
  --whatsapp-green: hsl(140 76% 36%) -> #16A244
  chat header teal #075E54, chat bg hsl(36 23% 91%) -> #EDE9E3
  foreground hsl(220 13% 13%) -> #1D2026, accent slate #F1F5F9
"""
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor, Color
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.lib.utils import simpleSplit
import math

PAGE_W, PAGE_H = A4  # 595.27 x 841.89

# ---------------------------------------------------------------- palette
EMERALD      = HexColor("#1FA867")
EMERALD_DARK = HexColor("#0C885E")
TEAL         = HexColor("#075E54")
TEAL_DEEP    = HexColor("#054C44")
GREEN_WA     = HexColor("#16A244")
MINT         = HexColor("#DFF5E9")
MINT_SOFT    = HexColor("#EFF9F3")
CHAT_BG      = HexColor("#EDE9E3")
BUBBLE_ME    = HexColor("#D9FDD3")
INK          = HexColor("#1D2026")
INK_SOFT     = HexColor("#4B5563")
GRAY         = HexColor("#6B7280")
GRAY_LIGHT   = HexColor("#9CA3AF")
LINE         = HexColor("#E5E7EB")
SLATE_BG     = HexColor("#F1F5F9")
CARD_BG      = HexColor("#F8FAF9")
WHITE        = HexColor("#FFFFFF")
CREAM        = HexColor("#FDFBF7")
GOLD         = HexColor("#F0B429")
RED_SOFT     = HexColor("#DC2626")

F      = "Helvetica"
FB     = "Helvetica-Bold"
FO     = "Helvetica-Oblique"
FBO    = "Helvetica-BoldOblique"

MARGIN = 46
FOOTER_LEGAL = ("WaPay is not a bank or financial institution. WaPay is a digital voucher and payments "
                "service delivered over WhatsApp, operating on licensed payment rails. "
                "Terms, conditions and product rules apply.")

# ---------------------------------------------------------------- primitives

def rrect(c, x, y, w, h, r, fill=None, stroke=None, sw=1):
    c.saveState()
    if fill is not None:
        c.setFillColor(fill)
    if stroke is not None:
        c.setStrokeColor(stroke); c.setLineWidth(sw)
    c.roundRect(x, y, w, h, r, stroke=1 if stroke is not None else 0,
                fill=1 if fill is not None else 0)
    c.restoreState()

def text(c, s, x, y, font=F, size=9, color=INK, align="l", charspace=0):
    c.saveState()
    c.setFont(font, size)
    c.setFillColor(color)
    if charspace:
        t = c.beginText()
        t.setTextOrigin(x if align == "l" else x - stringWidth(s, font, size) - charspace*len(s), y)
        t.setCharSpace(charspace)
        t.textOut(s)
        c.drawText(t)
    else:
        if align == "l":   c.drawString(x, y, s)
        elif align == "r": c.drawRightString(x, y, s)
        else:              c.drawCentredString(x, y, s)
    c.restoreState()

def para(c, s, x, y, w, font=F, size=9, color=INK, leading=None, align="l", max_lines=None):
    """Wrapped paragraph, y = top baseline. Returns height used."""
    leading = leading or size * 1.42
    lines = simpleSplit(s, font, size, w)
    if max_lines:
        lines = lines[:max_lines]
    c.saveState()
    c.setFont(font, size); c.setFillColor(color)
    yy = y
    for ln in lines:
        if align == "l":   c.drawString(x, yy, ln)
        elif align == "c": c.drawCentredString(x + w/2, yy, ln)
        else:              c.drawRightString(x + w, yy, ln)
        yy -= leading
    c.restoreState()
    return len(lines) * leading

def pill(c, s, cx, cy, font=FB, size=8, pad_x=10, pad_y=5, fg=WHITE, bg=EMERALD, border=None, center=True):
    w = stringWidth(s, font, size) + 2*pad_x
    h = size + 2*pad_y
    x = cx - w/2 if center else cx
    rrect(c, x, cy - h/2, w, h, h/2, fill=bg, stroke=border)
    text(c, s, x + w/2, cy - size*0.36, font, size, fg, "c")
    return w

def tick(c, x, y, r=5.2, bg=EMERALD, fg=WHITE):
    c.saveState()
    c.setFillColor(bg); c.circle(x, y, r, stroke=0, fill=1)
    c.setStrokeColor(fg); c.setLineWidth(max(1.4, r*0.3)); c.setLineCap(1); c.setLineJoin(1)
    p = c.beginPath()
    p.moveTo(x - r*0.42, y - r*0.02); p.lineTo(x - r*0.10, y - r*0.36); p.lineTo(x + r*0.48, y + r*0.34)
    c.drawPath(p, stroke=1, fill=0)
    c.restoreState()

def cross_dash(c, x, y, r=5.2):
    c.saveState()
    c.setFillColor(LINE); c.circle(x, y, r, stroke=0, fill=1)
    c.setStrokeColor(GRAY); c.setLineWidth(1.6); c.setLineCap(1)
    c.line(x - r*0.45, y, x + r*0.45, y)
    c.restoreState()

# ---------------------------------------------------------------- logo

def logo_mark(c, x, y, s, tile=EMERALD, glyph=WHITE):
    """Rounded tile with W glyph. (x,y)=bottom-left, s=size."""
    rrect(c, x, y, s, s, s*0.28, fill=tile)
    c.saveState()
    c.setStrokeColor(glyph); c.setLineWidth(max(1.2, s*0.085)); c.setLineCap(1); c.setLineJoin(1)
    x0, y0 = x + s*0.20, y + s*0.62
    p = c.beginPath()
    p.moveTo(x0, y0)
    p.lineTo(x + s*0.35, y + s*0.30)
    p.lineTo(x + s*0.50, y + s*0.55)
    p.lineTo(x + s*0.65, y + s*0.30)
    p.lineTo(x + s*0.80, y0)
    c.drawPath(p, stroke=1, fill=0)
    c.restoreState()

def logo(c, x, y, h=16, ink=INK, tile=EMERALD, glyph=WHITE):
    logo_mark(c, x, y, h, tile, glyph)
    text(c, "WaPay", x + h + h*0.38, y + h*0.22, FB, h*0.82, ink)

# ---------------------------------------------------------------- icons (line style)

def _icon_setup(c, color, lw):
    c.setStrokeColor(color); c.setFillColor(color)
    c.setLineWidth(lw); c.setLineCap(1); c.setLineJoin(1)

def icon(c, name, cx, cy, s=11, color=EMERALD_DARK, lw=1.7):
    """Draw a line icon centred at (cx,cy); s = half-size radius-ish."""
    c.saveState()
    _icon_setup(c, color, lw)
    if name == "wallet":
        rrect(c, cx - s, cy - s*0.72, 2*s, 1.44*s, s*0.22, stroke=color, sw=lw)
        c.line(cx - s, cy + s*0.30, cx + s, cy + s*0.30)
        c.circle(cx + s*0.52, cy - s*0.12, s*0.14, stroke=1, fill=0)
    elif name == "send":
        p = c.beginPath()
        p.moveTo(cx - s*0.95, cy + s*0.55); p.lineTo(cx + s*0.95, cy + s*0.10)
        p.lineTo(cx - s*0.35, cy - s*0.75); p.lineTo(cx - s*0.30, cy - s*0.05); p.close()
        c.drawPath(p, stroke=1, fill=0)
        c.line(cx - s*0.30, cy - s*0.05, cx + s*0.95, cy + s*0.10)
    elif name == "phone":
        rrect(c, cx - s*0.55, cy - s, s*1.1, 2*s, s*0.22, stroke=color, sw=lw)
        c.line(cx - s*0.18, cy - s*0.68, cx + s*0.18, cy - s*0.68)
    elif name == "bolt":
        p = c.beginPath()
        p.moveTo(cx + s*0.25, cy + s); p.lineTo(cx - s*0.55, cy - s*0.10)
        p.lineTo(cx - s*0.02, cy - s*0.10); p.lineTo(cx - s*0.25, cy - s)
        p.lineTo(cx + s*0.55, cy + s*0.10); p.lineTo(cx + s*0.02, cy + s*0.10); p.close()
        c.drawPath(p, stroke=1, fill=0)
    elif name == "bill":
        rrect(c, cx - s*0.72, cy - s, s*1.44, 2*s, s*0.16, stroke=color, sw=lw)
        for dy in (0.45, 0.05, -0.35):
            c.line(cx - s*0.40, cy + s*dy, cx + s*0.40, cy + s*dy)
    elif name == "cart":
        c.line(cx - s, cy + s*0.75, cx - s*0.62, cy + s*0.75)
        c.line(cx - s*0.62, cy + s*0.75, cx - s*0.38, cy - s*0.25)
        c.line(cx - s*0.38, cy - s*0.25, cx + s*0.72, cy - s*0.25)
        c.line(cx + s*0.72, cy - s*0.25, cx + s*0.95, cy + s*0.55)
        c.line(cx + s*0.95, cy + s*0.55, cx - s*0.52, cy + s*0.55)
        c.circle(cx - s*0.22, cy - s*0.62, s*0.15, stroke=1, fill=0)
        c.circle(cx + s*0.48, cy - s*0.62, s*0.15, stroke=1, fill=0)
    elif name == "ticket":
        rrect(c, cx - s, cy - s*0.62, 2*s, 1.24*s, s*0.16, stroke=color, sw=lw)
        c.setDash(1.6, 2.2)
        c.line(cx + s*0.25, cy - s*0.62, cx + s*0.25, cy + s*0.62)
        c.setDash()
    elif name == "cash":
        rrect(c, cx - s, cy - s*0.60, 2*s, 1.2*s, s*0.14, stroke=color, sw=lw)
        c.circle(cx, cy, s*0.28, stroke=1, fill=0)
        c.circle(cx - s*0.62, cy, s*0.05, stroke=1, fill=1)
        c.circle(cx + s*0.62, cy, s*0.05, stroke=1, fill=1)
    elif name == "shield":
        p = c.beginPath()
        p.moveTo(cx, cy + s)
        p.curveTo(cx + s*0.55, cy + s*0.78, cx + s*0.9, cy + s*0.7, cx + s*0.9, cy + s*0.55)
        p.lineTo(cx + s*0.9, cy - s*0.15)
        p.curveTo(cx + s*0.9, cy - s*0.7, cx + s*0.35, cy - s*0.92, cx, cy - s)
        p.curveTo(cx - s*0.35, cy - s*0.92, cx - s*0.9, cy - s*0.7, cx - s*0.9, cy - s*0.15)
        p.lineTo(cx - s*0.9, cy + s*0.55)
        p.curveTo(cx - s*0.9, cy + s*0.7, cx - s*0.55, cy + s*0.78, cx, cy + s)
        c.drawPath(p, stroke=1, fill=0)
        c.setLineWidth(lw*1.05)
        c.line(cx - s*0.35, cy + s*0.02, cx - s*0.08, cy - s*0.3)
        c.line(cx - s*0.08, cy - s*0.3, cx + s*0.42, cy + s*0.3)
    elif name == "chat":
        p = c.beginPath()
        p.moveTo(cx - s*0.55, cy - s*0.62)
        p.lineTo(cx - s*0.82, cy - s*0.95)
        p.lineTo(cx - s*0.82, cy - s*0.30)
        c.drawPath(p, stroke=1, fill=0)
        rrect(c, cx - s*0.95, cy - s*0.62, 1.9*s, 1.5*s, s*0.35, stroke=color, sw=lw)
        for dx in (-0.42, 0, 0.42):
            c.circle(cx + dx*s, cy + s*0.12, s*0.07, stroke=0, fill=1)
    elif name == "id":
        rrect(c, cx - s, cy - s*0.68, 2*s, 1.36*s, s*0.14, stroke=color, sw=lw)
        c.circle(cx - s*0.48, cy + s*0.08, s*0.20, stroke=1, fill=0)
        c.line(cx - s*0.72, cy - s*0.38, cx - s*0.24, cy - s*0.38)
        c.line(cx + s*0.05, cy + s*0.22, cx + s*0.70, cy + s*0.22)
        c.line(cx + s*0.05, cy - s*0.10, cx + s*0.70, cy - s*0.10)
    elif name == "globe":
        c.circle(cx, cy, s*0.92, stroke=1, fill=0)
        c.ellipse(cx - s*0.40, cy - s*0.92, cx + s*0.40, cy + s*0.92, stroke=1, fill=0)
        c.line(cx - s*0.92, cy, cx + s*0.92, cy)
    elif name == "lock":
        rrect(c, cx - s*0.72, cy - s*0.85, 1.44*s, s*1.05, s*0.14, stroke=color, sw=lw)
        c.arc(cx - s*0.42, cy + s*0.02, cx + s*0.42, cy + s*0.85, 0, 180)
        c.circle(cx, cy - s*0.32, s*0.10, stroke=0, fill=1)
    elif name == "store":
        c.line(cx - s*0.85, cy - s*0.75, cx - s*0.85, cy + s*0.25)
        c.line(cx + s*0.85, cy - s*0.75, cx + s*0.85, cy + s*0.25)
        c.line(cx - s*0.85, cy - s*0.75, cx + s*0.85, cy - s*0.75)
        p = c.beginPath()
        p.moveTo(cx - s*1.0, cy + s*0.25); p.lineTo(cx - s*0.62, cy + s*0.80)
        p.lineTo(cx + s*0.62, cy + s*0.80); p.lineTo(cx + s*1.0, cy + s*0.25)
        c.drawPath(p, stroke=1, fill=0)
        rrect(c, cx - s*0.25, cy - s*0.75, s*0.5, s*0.62, s*0.08, stroke=color, sw=lw)
    elif name == "sim":
        p = c.beginPath()
        p.moveTo(cx - s*0.7, cy - s*0.9); p.lineTo(cx + s*0.35, cy - s*0.9)
        p.lineTo(cx + s*0.7, cy - s*0.55); p.lineTo(cx + s*0.7, cy + s*0.9)
        p.lineTo(cx - s*0.7, cy + s*0.9); p.close()
        c.drawPath(p, stroke=1, fill=0)
        rrect(c, cx - s*0.34, cy - s*0.30, s*0.68, s*0.60, s*0.10, stroke=color, sw=lw)
    elif name == "arrows":
        c.line(cx - s*0.9, cy + s*0.42, cx + s*0.55, cy + s*0.42)
        p = c.beginPath(); p.moveTo(cx + s*0.30, cy + s*0.68); p.lineTo(cx + s*0.62, cy + s*0.42); p.lineTo(cx + s*0.30, cy + s*0.16)
        c.drawPath(p, stroke=1, fill=0)
        c.line(cx + s*0.9, cy - s*0.42, cx - s*0.55, cy - s*0.42)
        p = c.beginPath(); p.moveTo(cx - s*0.30, cy - s*0.68); p.lineTo(cx - s*0.62, cy - s*0.42); p.lineTo(cx - s*0.30, cy - s*0.16)
        c.drawPath(p, stroke=1, fill=0)
    elif name == "gift":
        rrect(c, cx - s*0.8, cy - s*0.8, 1.6*s, s*1.05, s*0.1, stroke=color, sw=lw)
        rrect(c, cx - s*0.9, cy + s*0.25, 1.8*s, s*0.42, s*0.1, stroke=color, sw=lw)
        c.line(cx, cy - s*0.8, cx, cy + s*0.67)
        c.circle(cx - s*0.28, cy + s*0.80, s*0.20, stroke=1, fill=0)
        c.circle(cx + s*0.28, cy + s*0.80, s*0.20, stroke=1, fill=0)
    elif name == "star":
        pts = []
        for i in range(10):
            ang = math.pi/2 + i * math.pi/5
            rr = s if i % 2 == 0 else s*0.42
            pts.append((cx + rr*math.cos(ang), cy + rr*math.sin(ang)))
        p = c.beginPath(); p.moveTo(*pts[0])
        for pt in pts[1:]: p.lineTo(*pt)
        p.close(); c.drawPath(p, stroke=1, fill=0)
    c.restoreState()

def icon_badge(c, name, cx, cy, r=15, bg=MINT, fg=EMERALD_DARK, s=None, lw=1.7):
    c.saveState()
    c.setFillColor(bg); c.circle(cx, cy, r, stroke=0, fill=1)
    c.restoreState()
    icon(c, name, cx, cy, s or r*0.62, fg, lw)

# ---------------------------------------------------------------- chrome

def page_footer(c, page_num, note=None, dark=False):
    col_line = Color(1, 1, 1, 0.25) if dark else LINE
    col_txt  = Color(1, 1, 1, 0.72) if dark else GRAY_LIGHT
    c.saveState()
    c.setStrokeColor(col_line); c.setLineWidth(0.6)
    c.line(MARGIN, 40, PAGE_W - MARGIN, 40)
    c.restoreState()
    legal = note if note is not None else FOOTER_LEGAL
    para(c, legal, MARGIN, 31, PAGE_W - 2*MARGIN - 40, F, 5.6, col_txt, leading=7.6)
    text(c, str(page_num), PAGE_W - MARGIN, 29, FB, 8, EMERALD if not dark else WHITE, "r")

def page_header(c, kicker, guide_name):
    logo(c, MARGIN, PAGE_H - 52, 13)
    text(c, guide_name, PAGE_W - MARGIN, PAGE_H - 46, FB, 7.5, GRAY, "r", charspace=0.8)
    if kicker:
        text(c, kicker.upper(), PAGE_W - MARGIN, PAGE_H - 57, FB, 6.4, EMERALD, "r", charspace=1.2)

def section_title(c, title, sub=None, y=None):
    y = y or PAGE_H - 108
    text(c, title, MARGIN, y, FB, 23, INK)
    if sub:
        para(c, sub, MARGIN, y - 20, PAGE_W - 2*MARGIN, F, 9.5, INK_SOFT, leading=13.5)
    return y

# ---------------------------------------------------------------- phone / chat mockup

def _bubble(c, x, y, w, h, r, col, left=True):
    rrect(c, x, y, w, h, r, fill=col)
    c.saveState()
    c.setFillColor(col)
    p = c.beginPath()
    if left:
        p.moveTo(x + 1, y + h - 1); p.lineTo(x - 4.2, y + h); p.lineTo(x + 8, y + h - 0.5)
    else:
        p.moveTo(x + w - 1, y + h - 1); p.lineTo(x + w + 4.2, y + h); p.lineTo(x + w - 8, y + h - 0.5)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.restoreState()

def chat_phone(c, x, y, w, h, messages, title="WaPay", subtitle="online", scale=1.0):
    """Vector WhatsApp-style phone. (x,y) bottom-left. messages: list of dicts
    {side:'in'|'out', lines:[...], bold_first:bool, time:'09:41'}"""
    bez = 7*scale
    rrect(c, x - bez, y - bez, w + 2*bez, h + 2*bez, 24*scale, fill=INK)
    rrect(c, x, y, w, h, 18*scale, fill=CHAT_BG)
    # header
    hh = 46*scale
    c.saveState()
    p = c.beginPath()
    p.roundRect(x, y, w, h, 18*scale)
    c.clipPath(p, stroke=0, fill=0)
    c.setFillColor(TEAL)
    c.rect(x, y + h - hh, w, hh, stroke=0, fill=1)
    # avatar + name
    av_r = 11*scale
    c.setFillColor(WHITE); c.circle(x + 24*scale, y + h - hh/2, av_r, stroke=0, fill=1)
    c.restoreState()
    logo_mark(c, x + 24*scale - av_r*0.62, y + h - hh/2 - av_r*0.62, av_r*1.24, tile=WHITE, glyph=EMERALD)
    text(c, title, x + 42*scale, y + h - hh/2 + 2*scale, FB, 10*scale, WHITE)
    # verified tick
    tw = stringWidth(title, FB, 10*scale)
    tick(c, x + 50*scale + tw, y + h - hh/2 + 5*scale, 4.6*scale, bg=HexColor("#53BDEB"), fg=WHITE)
    text(c, subtitle, x + 42*scale, y + h - hh/2 - 9*scale, F, 6.6*scale, HexColor("#B8DBD5"))
    # messages
    pad = 10*scale
    yy = y + h - hh - 14*scale
    fs = 7.2*scale
    lead = fs*1.38
    for m in messages:
        lines = m["lines"]
        wmax = max(stringWidth(ln, FB if (m.get("bold_first") and i == 0) else F, fs)
                   for i, ln in enumerate(lines))
        bw = min(w - 2*pad - 26*scale, wmax + 18*scale)
        bh = len(lines)*lead + 12*scale + (7*scale if m.get("time") else 0)
        bx = x + pad if m["side"] == "in" else x + w - pad - bw
        col = WHITE if m["side"] == "in" else BUBBLE_ME
        _bubble(c, bx, yy - bh, bw, bh, 6*scale, col, left=(m["side"] == "in"))
        ty = yy - 6*scale - fs
        for i, ln in enumerate(lines):
            fnt = FB if (m.get("bold_first") and i == 0) else F
            text(c, ln, bx + 9*scale, ty, fnt, fs, INK)
            ty -= lead
        if m.get("time"):
            text(c, m["time"], bx + bw - 6*scale, yy - bh + 4*scale, F, 5*scale, GRAY_LIGHT, "r")
        yy -= bh + 8*scale
    # input bar
    ib_h = 20*scale
    rrect(c, x + 8*scale, y + 8*scale, w - 42*scale, ib_h, ib_h/2, fill=WHITE)
    text(c, "Type a message", x + 20*scale, y + 8*scale + ib_h/2 - fs*0.36, F, fs, GRAY_LIGHT)
    c.saveState()
    c.setFillColor(EMERALD)
    c.circle(x + w - 20*scale, y + 8*scale + ib_h/2, ib_h/2, stroke=0, fill=1)
    c.restoreState()
    icon(c, "send", x + w - 20*scale, y + 8*scale + ib_h/2, 5.5*scale, WHITE, 1.1*scale)

# ---------------------------------------------------------------- tables

def fee_table(c, x, y_top, w, title, rows, icon_name=None, col_w=118,
              header_bg=TEAL, note=None):
    """rows: list of (label, value, sub) — value 'FREE' gets green pill styling.
    Returns y under the table."""
    head_h = 30
    row_h_base = 24
    # measure
    heights = []
    for label, value, sub in rows:
        lh = row_h_base
        if sub:
            lh += 9.5 * len(simpleSplit(sub, F, 7.4, w - col_w - 46))
        heights.append(lh)
    total_h = head_h + sum(heights) + 8
    rrect(c, x, y_top - total_h, w, total_h, 10, fill=WHITE, stroke=LINE, sw=0.9)
    # header
    c.saveState()
    p = c.beginPath(); p.roundRect(x, y_top - total_h, w, total_h, 10)
    c.clipPath(p, stroke=0, fill=0)
    c.setFillColor(header_bg)
    c.rect(x, y_top - head_h, w, head_h, stroke=0, fill=1)
    c.restoreState()
    tx = x + 16
    if icon_name:
        icon(c, icon_name, x + 22, y_top - head_h/2, 7.5, WHITE, 1.5)
        tx = x + 38
    text(c, title, tx, y_top - head_h/2 - 3.4, FB, 10.5, WHITE)
    text(c, "FEE", x + w - 16, y_top - head_h/2 - 2.8, FB, 6.6, Color(1, 1, 1, 0.75), "r", charspace=1.1)
    # rows
    yy = y_top - head_h
    for i, ((label, value, sub), rh) in enumerate(zip(rows, heights)):
        if i % 2 == 1:
            c.saveState(); c.setFillColor(CARD_BG)
            c.rect(x + 1, yy - rh, w - 2, rh, stroke=0, fill=1); c.restoreState()
        ly = yy - 15.6
        text(c, label, x + 16, ly, FB if value in ("FREE", "R0") else F, 8.6, INK)
        if sub:
            para(c, sub, x + 16, ly - 10.5, w - col_w - 46, F, 7.4, GRAY, leading=9.5)
        # value
        if value in ("FREE", "R0"):
            pill(c, value, x + w - 16 - 24, yy - rh/2, FB, 8, pad_x=9, pad_y=4.2,
                 fg=WHITE, bg=EMERALD, center=True)
        else:
            text(c, value, x + w - 16, yy - rh/2 - 3.2, FB, 9.6, INK, "r")
        if i < len(rows) - 1:
            c.saveState(); c.setStrokeColor(LINE); c.setLineWidth(0.5)
            c.line(x + 12, yy - rh, x + w - 12, yy - rh); c.restoreState()
        yy -= rh
    if note:
        para(c, note, x + 4, y_top - total_h - 11, w - 8, F, 6.6, GRAY, leading=8.8)
        total_h += 11 + 8.8 * (len(simpleSplit(note, F, 6.6, w - 8)) - 1)
    return y_top - total_h - 8

# ---------------------------------------------------------------- misc blocks

def stat_chip(c, x, y, w, h, big, small, bg=MINT_SOFT, fg=EMERALD_DARK, border=None):
    rrect(c, x, y, w, h, 10, fill=bg, stroke=border)
    text(c, big, x + w/2, y + h - 26, FB, 15.5, fg, "c")
    para(c, small, x + 8, y + h - 41, w - 16, F, 7.2, INK_SOFT, leading=9.2, align="c")

def step_circle(c, n, cx, cy, r=11):
    c.saveState()
    c.setFillColor(EMERALD); c.circle(cx, cy, r, stroke=0, fill=1)
    c.restoreState()
    text(c, str(n), cx, cy - r*0.36, FB, r*1.05, WHITE, "c")

def kicker_line(c, s, x, y, color=EMERALD):
    c.saveState()
    c.setFillColor(color)
    c.rect(x, y - 1.5, 18, 3, stroke=0, fill=1)
    c.restoreState()
    text(c, s.upper(), x + 26, y - 3, FB, 8, color, charspace=1.6)
