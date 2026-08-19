"""Build the WaPay Pricing Guide + Product Guide PDFs."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.colors import Color, HexColor
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase.pdfmetrics import stringWidth
from wapay_design import *
import wapay_content as CT

OUT = os.path.dirname(os.path.abspath(__file__))

# ================================================================ shared pages

def info_band(c, y, h, bg, icon_name, title, body, dark=True, icon_bg=None, icon_fg=None,
              title_col=None, body_col=None, border=None):
    w = PAGE_W - 2*MARGIN
    rrect(c, MARGIN, y, w, h, 14, fill=bg, stroke=border)
    icon_badge(c, icon_name, MARGIN + 38, y + h/2, 17,
               bg=icon_bg or (Color(1, 1, 1, 0.12) if dark else WHITE),
               fg=icon_fg or (WHITE if dark else EMERALD_DARK))
    tc = title_col or (WHITE if dark else INK)
    bc = body_col or (HexColor("#B8DBD5") if dark else INK_SOFT)
    text(c, title, MARGIN + 66, y + h - 26, FB, 10.5, tc)
    para(c, body, MARGIN + 66, y + h - 40, w - 104, F, 8.6, bc, leading=11)

def cover_backdrop_bubbles(c, base_alpha=0.05):
    """Faint decorative chat bubbles on dark covers."""
    for (bx, by, bw, left) in [(452, 630, 130, False),
                               (90, 200, 140, True), (350, 140, 160, False)]:
        col = Color(1, 1, 1, base_alpha)
        c.saveState(); c.setFillColor(col)
        c.roundRect(bx, by, bw, 34, 10, stroke=0, fill=1)
        c.restoreState()

def draw_cover(c, guide_title, guide_sub, page_note):
    # full-bleed deep teal
    c.setFillColor(TEAL_DEEP); c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    c.setFillColor(TEAL); c.rect(0, PAGE_H - 340, PAGE_W, 340, stroke=0, fill=1)
    # soft emerald glow band
    c.saveState(); c.setFillColor(Color(0.12, 0.66, 0.40, 0.16))
    c.circle(PAGE_W - 80, PAGE_H - 60, 200, stroke=0, fill=1)
    c.circle(60, 180, 170, stroke=0, fill=1)
    c.restoreState()
    cover_backdrop_bubbles(c)
    # logo
    logo(c, MARGIN, PAGE_H - 78, 24, ink=WHITE)
    pill(c, "LIKE A BANK. ON WHATSAPP.", MARGIN + 2, PAGE_H - 106, FB, 7,
         pad_x=10, pad_y=5, fg=HexColor("#A7F3CE"), bg=Color(1, 1, 1, 0.10), center=False)
    # title block
    ty = PAGE_H - 210
    text(c, guide_title.split("|")[0], MARGIN, ty, FB, 40, WHITE)
    text(c, guide_title.split("|")[1], MARGIN, ty - 46, FB, 40, HexColor("#7BE3AE"))
    para(c, guide_sub, MARGIN, ty - 84, PAGE_W - 2*MARGIN - 150, F, 11, HexColor("#CBEADF"), leading=16)
    # phone mockup
    msgs = [
        {"side": "in", "lines": ["Welcome to WaPay", "What would you like to do?"], "bold_first": True},
        {"side": "out", "lines": ["Send R50 to Thabo"], "time": "09:41"},
        {"side": "in", "lines": ["Done! R50 sent to Thabo.", "Fee: FREE · Balance: R245.50"], "bold_first": True, "time": "09:41"},
        {"side": "out", "lines": ["Buy R30 airtime for me"], "time": "09:42"},
        {"side": "in", "lines": ["R30 Vodacom airtime loaded.", "Fee: FREE · Balance: R215.50"], "time": "09:42"},
    ]
    pw, ph = 236, 380
    chat_phone(c, (PAGE_W - pw)/2 + 60, 128, pw, ph, msgs, scale=1.0)
    # left fact chips
    chips = [("R0", "monthly fees"), ("26,000+", "places to shop"), ("5", "SA languages")]
    cy = 420
    for big, small in chips:
        rrect(c, MARGIN, cy - 52, 148, 62, 12, fill=Color(1, 1, 1, 0.07))
        text(c, big, MARGIN + 14, cy - 24, FB, 17, HexColor("#7BE3AE"))
        text(c, small, MARGIN + 14, cy - 40, F, 8.5, HexColor("#CBEADF"))
        cy -= 76
    # bottom band
    text(c, page_note, MARGIN, 78, FB, 9.5, WHITE)
    text(c, CT.EFFECTIVE, MARGIN, 64, F, 7.5, HexColor("#9CC9BE"))
    para(c, FOOTER_LEGAL + " wapay.co.za", MARGIN, 44, PAGE_W - 2*MARGIN, F, 5.8,
         Color(1, 1, 1, 0.55), leading=8)
    c.showPage()

def draw_back_cover(c):
    c.setFillColor(TEAL_DEEP); c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    c.saveState(); c.setFillColor(Color(0.12, 0.66, 0.40, 0.14))
    c.circle(PAGE_W/2, PAGE_H/2 + 60, 230, stroke=0, fill=1)
    c.restoreState()
    cover_backdrop_bubbles(c, 0.04)
    logo_mark(c, PAGE_W/2 - 26, PAGE_H - 300, 52)
    text(c, "Ready when you are.", PAGE_W/2, PAGE_H - 360, FB, 27, WHITE, "c")
    para(c, "Open your account in the time it takes to say hello. Your money, your language, your chat.",
         PAGE_W/2 - 180, PAGE_H - 388, 360, F, 10.5, HexColor("#CBEADF"), leading=15, align="c")
    # contact card
    cw, chh = 350, 128
    cx = (PAGE_W - cw)/2
    rrect(c, cx, PAGE_H - 570, cw, chh, 14, fill=Color(1, 1, 1, 0.07))
    yy = PAGE_H - 570 + chh - 34
    labels = ["Visit", "Start", "Help"]
    for i, line in enumerate(CT.CONTACT_LINES):
        text(c, labels[i].upper(), cx + 24, yy, FB, 7, HexColor("#7BE3AE"), charspace=1.4)
        para(c, line, cx + 70, yy, cw - 92, FB if i == 0 else F, 9.5 if i == 0 else 8.5, WHITE, leading=11)
        yy -= 38
    pill(c, "wapay.co.za", PAGE_W/2, 180, FB, 11, pad_x=22, pad_y=10, fg=TEAL_DEEP, bg=HexColor("#7BE3AE"))
    para(c, FOOTER_LEGAL, MARGIN, 70, PAGE_W - 2*MARGIN, F, 5.8, Color(1, 1, 1, 0.5), leading=8, align="c")
    c.showPage()

def draw_divider(c, kicker, big1, big2, sub, chips, page_num, guide_name):
    c.setFillColor(MINT_SOFT); c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    c.saveState(); c.setFillColor(Color(0.12, 0.66, 0.40, 0.08))
    c.circle(PAGE_W - 60, PAGE_H - 120, 190, stroke=0, fill=1)
    c.circle(40, 140, 150, stroke=0, fill=1)
    c.restoreState()
    page_header(c, None, guide_name)
    kicker_line(c, kicker, MARGIN, PAGE_H - 150)
    text(c, big1, MARGIN, PAGE_H - 208, FB, 44, INK)
    text(c, big2, MARGIN, PAGE_H - 258, FB, 44, EMERALD_DARK)
    para(c, sub, MARGIN, PAGE_H - 296, PAGE_W - 2*MARGIN - 60, F, 11, INK_SOFT, leading=16.5)
    # big stat chips row
    cw = (PAGE_W - 2*MARGIN - 2*14) / 3
    cy = PAGE_H - 470
    for i, (big, small) in enumerate(chips):
        x = MARGIN + i*(cw + 14)
        rrect(c, x, cy, cw, 92, 14, fill=WHITE, stroke=LINE, sw=0.8)
        text(c, big, x + 16, cy + 52, FB, 21, EMERALD_DARK)
        para(c, small, x + 16, cy + 32, cw - 32, F, 8.2, INK_SOFT, leading=10.5)
    # promise strip
    rrect(c, MARGIN, 120, PAGE_W - 2*MARGIN, 74, 14, fill=TEAL)
    icon_badge(c, "shield", MARGIN + 38, 157, 17, bg=Color(1, 1, 1, 0.12), fg=WHITE)
    text(c, "Our promise: every fee is shown in the chat before you confirm.",
         MARGIN + 66, 162, FB, 11, WHITE)
    text(c, "If you don't see it and say yes, you don't pay it.", MARGIN + 66, 146, F, 9, HexColor("#B8DBD5"))
    page_footer(c, page_num)
    c.showPage()

def compare_col_headers(c, x_label_w, col_w, y, h=34):
    x1 = MARGIN + x_label_w
    x2 = x1 + col_w
    rrect(c, x1, y - h, col_w - 8, h, 9, fill=EMERALD_DARK)
    logo_mark(c, x1 + 12, y - h + 9, 15, tile=WHITE, glyph=EMERALD_DARK)
    text(c, "WaPay", x1 + 33, y - h + 12, FB, 11, WHITE)
    rrect(c, x2, y - h, col_w - 8, h, 9, fill=SLATE_BG, stroke=LINE)
    text(c, "FNB eWallet", x2 + 12, y - h + 12, FB, 11, INK_SOFT)

def draw_compare_page(c, page_num, guide_name, kicker="Compare us"):
    page_header(c, kicker, guide_name)
    kicker_line(c, "Side by side", MARGIN, PAGE_H - 92)
    text(c, "WaPay vs the evolved eWallet", MARGIN, PAGE_H - 122, FB, 21, INK)
    para(c, "Same WhatsApp. Very different philosophy. Here is how we stack up against FNB's "
            "eWallet, using their published 2026/27 pricing guide.",
         MARGIN, PAGE_H - 140, PAGE_W - 2*MARGIN, F, 9, INK_SOFT, leading=12.5)
    label_w = 168
    col_w = (PAGE_W - 2*MARGIN - label_w) / 2
    top = PAGE_H - 168
    compare_col_headers(c, label_w, col_w, top)
    yy = top - 34
    fs = 7.8
    for label, wp, ew, wins in CT.COMPARE_ROWS:
        l_lines = simpleSplit(label, FB, fs, label_w - 14)
        w_lines = simpleSplit(wp, FB, fs, col_w - 40)
        e_lines = simpleSplit(ew, F, fs, col_w - 26)
        n = max(len(l_lines), len(w_lines), len(e_lines))
        rh = max(26, n * (fs + 3.2) + 11)
        x1 = MARGIN + label_w
        x2 = x1 + col_w
        # wapay column tint runs the height
        c.saveState()
        c.setFillColor(MINT_SOFT); c.rect(x1, yy - rh, col_w - 8, rh, stroke=0, fill=1)
        c.restoreState()
        ty = yy - 16
        for ln in l_lines: text(c, ln, MARGIN, ty, FB, fs, INK); ty -= fs + 3.2
        ty = yy - 16
        mark_x = x1 + 12
        if wins is True: tick(c, mark_x, yy - rh/2, 5.4)
        elif wins is None: tick(c, mark_x, yy - rh/2, 5.4, bg=GRAY_LIGHT)
        else: cross_dash(c, mark_x, yy - rh/2)
        for ln in w_lines: text(c, ln, x1 + 24, ty, FB, fs, EMERALD_DARK if wins else INK); ty -= fs + 3.2
        ty = yy - 16
        for ln in e_lines: text(c, ln, x2 + 12, ty, F, fs, INK_SOFT); ty -= fs + 3.2
        c.saveState(); c.setStrokeColor(LINE); c.setLineWidth(0.5)
        c.line(MARGIN, yy - rh, PAGE_W - MARGIN, yy - rh)
        c.restoreState()
        yy -= rh
    para(c, CT.COMPARE_SOURCE, MARGIN, yy - 14, PAGE_W - 2*MARGIN, F, 6.2, GRAY, leading=8.4)
    info_band(c, 108, 74, TEAL, "star", "The short version",
              "Everyday money is free on WaPay, you start with zero paperwork, and every fee is one "
              "flat number you approve in the chat. That's the whole pitch.", dark=True)
    page_footer(c, page_num)
    c.showPage()

def draw_balances_page(c, page_num, guide_name):
    page_header(c, "Two balances", guide_name)
    kicker_line(c, "How your wallet is built", MARGIN, PAGE_H - 92)
    text(c, "One wallet. Two balances.", MARGIN, PAGE_H - 122, FB, 21, INK)
    para(c, "Most services make you hand over your ID before you can do anything. WaPay flips it: "
            "start instantly with a spend balance, and only verify — once — when you want to take cash out.",
         MARGIN, PAGE_H - 140, PAGE_W - 2*MARGIN, F, 9, INK_SOFT, leading=12.5)
    cw = (PAGE_W - 2*MARGIN - 18) / 2
    ch = 330
    top = PAGE_H - 185
    for i, key in enumerate(["spend", "cash"]):
        name, tag, feats = CT.BALANCES[key]
        x = MARGIN + i * (cw + 18)
        dark = (key == "cash")
        rrect(c, x, top - ch, cw, ch, 16, fill=TEAL if dark else WHITE,
              stroke=None if dark else LINE, sw=1)
        icon_badge(c, "wallet" if key == "spend" else "cash", x + 34, top - 36, 19,
                   bg=MINT if not dark else Color(1, 1, 1, 0.12),
                   fg=EMERALD_DARK if not dark else WHITE)
        text(c, name, x + 62, top - 32, FB, 14.5, INK if not dark else WHITE)
        text(c, tag, x + 62, top - 46, F, 8, INK_SOFT if not dark else HexColor("#B8DBD5"))
        yy = top - 88
        for ftext in feats:
            tick(c, x + 30, yy + 3, 5.6, bg=EMERALD if not dark else HexColor("#7BE3AE"),
                 fg=WHITE if not dark else TEAL_DEEP)
            used = para(c, ftext, x + 44, yy, cw - 66, F, 8.6,
                        INK if not dark else WHITE, leading=11)
            yy -= max(31, used + 19)
        badge = "NO ID NEEDED" if key == "spend" else "ONE-TIME FICA CHECK"
        pill(c, badge, x + cw/2, top - ch + 26, FB, 7.5, pad_x=12, pad_y=5.5,
             fg=EMERALD_DARK if not dark else TEAL_DEEP,
             bg=MINT if not dark else HexColor("#7BE3AE"))
    # arrow strip below
    rrect(c, MARGIN, 118, PAGE_W - 2*MARGIN, 66, 12, fill=MINT_SOFT)
    icon_badge(c, "id", MARGIN + 34, 151, 16, bg=WHITE, fg=EMERALD_DARK)
    para(c, "Upgrading takes minutes and happens right in the chat: send your ID details once, "
            "and your cash balance — with cash-outs and higher limits — switches on.",
         MARGIN + 60, 162, PAGE_W - 2*MARGIN - 84, F, 8.8, INK, leading=11.5)
    page_footer(c, page_num)
    c.showPage()

# ================================================================ PRICING GUIDE

def pricing_welcome(c, page_num, guide_name):
    page_header(c, "Welcome", guide_name)
    kicker_line(c, "Hello, money", MARGIN, PAGE_H - 92)
    text(c, "Pricing that fits in one message.", MARGIN, PAGE_H - 124, FB, 21.5, INK)
    para(c, "Banks publish 40-page fee brochures with asterisks on their asterisks. Ours fits on a "
            "few friendly pages, because the model is simple: the everyday things are free, the rest "
            "is one flat fee you can say out loud. No percentages. No 'per R1,000'. No monthly "
            "anything. And every fee is shown in the chat before you confirm.",
         MARGIN, PAGE_H - 146, PAGE_W - 2*MARGIN - 40, F, 9.6, INK_SOFT, leading=14)
    # three principles
    cw = (PAGE_W - 2*MARGIN - 2*14) / 3
    principles = [
        ("star", "Free by default", "Sending to WaPay users, airtime, data, electricity, bills and shopping: R0."),
        ("cash", "Flat fees only", "A fee is a number, not a formula. R6 means R6 — on R100 or R5,000."),
        ("chat", "See it before you pay it", "The fee shows in chat before you say yes. No statements, no surprises."),
    ]
    cy = PAGE_H - 268
    for i, (ic, t, d) in enumerate(principles):
        x = MARGIN + i*(cw + 14)
        rrect(c, x, cy - 96, cw, 108, 14, fill=WHITE, stroke=LINE, sw=0.9)
        icon_badge(c, ic, x + 26, cy - 12, 15)
        text(c, t, x + 14, cy - 40, FB, 10, INK)
        para(c, d, x + 14, cy - 54, cw - 28, F, 7.6, INK_SOFT, leading=10)
    # how to get started band
    rrect(c, MARGIN, PAGE_H - 560, PAGE_W - 2*MARGIN, 150, 16, fill=TEAL)
    text(c, "Get started in 30 seconds", MARGIN + 24, PAGE_H - 442, FB, 13, WHITE)
    steps = [("1", "Go to wapay.co.za and tap 'Start banking on WhatsApp'"),
             ("2", "Say 'Hi' — your number becomes your account"),
             ("3", "Load money with a BluVoucher, Pay@, EFT or card")]
    yy = PAGE_H - 470
    for n, s in steps:
        step_circle(c, n, MARGIN + 36, yy, 10)
        text(c, s, MARGIN + 56, yy - 3.4, F, 9.5, WHITE)
        yy -= 30
    # contents
    kicker_line(c, "Inside this guide", MARGIN, PAGE_H - 600)
    toc = [("03", "What you can do with WaPay"), ("04", "Our fees, our promise"),
           ("05", "Wallet basics & loading money"), ("06", "Sending, buying & paying"),
           ("07", "Cashing out & the extras"), ("08", "One wallet, two balances"),
           ("09", "WaPay vs FNB eWallet"), ("10", "The small print & glossary")]
    yy = PAGE_H - 630
    colw = (PAGE_W - 2*MARGIN) / 2
    for i, (pg, item) in enumerate(toc):
        x = MARGIN + (i % 2) * colw
        text(c, pg, x, yy, FB, 10, EMERALD)
        text(c, item, x + 26, yy, F, 9.5, INK)
        if i % 2 == 1: yy -= 24
    page_footer(c, page_num)
    c.showPage()

def pricing_cando(c, page_num, guide_name):
    page_header(c, "What you can do", guide_name)
    kicker_line(c, "One chat, whole wallet", MARGIN, PAGE_H - 92)
    text(c, "Everything WaPay does", MARGIN, PAGE_H - 122, FB, 21, INK)
    cw = (PAGE_W - 2*MARGIN - 14) / 2
    ch = 114
    top = PAGE_H - 152
    for i, (ic, t, d) in enumerate(CT.FEATURES):
        x = MARGIN + (i % 2) * (cw + 14)
        y = top - (i // 2) * (ch + 11) - ch
        rrect(c, x, y, cw, ch, 14, fill=WHITE, stroke=LINE, sw=0.9)
        icon_badge(c, ic, x + 28, y + ch - 28, 16)
        text(c, f"{i+1:02d}", x + cw - 16, y + ch - 24, FB, 9, HexColor("#BBE3CE"), "r")
        text(c, t, x + 16, y + ch - 54, FB, 10.5, INK)
        para(c, d, x + 16, y + ch - 68, cw - 32, F, 7.7, INK_SOFT, leading=10.2)
    info_band(c, 108, 70, TEAL, "chat",
              "All of it, one message away.",
              "No app store, no forms, no queue. Everything on this page happens in the WhatsApp "
              "chat you already have open.", dark=True)
    page_footer(c, page_num)
    c.showPage()

def pricing_fees_1(c, page_num, guide_name):
    page_header(c, "Fees · money in & sends", guide_name)
    kicker_line(c, "Money in", MARGIN, PAGE_H - 88)
    text(c, "Load & send", MARGIN, PAGE_H - 116, FB, 21, INK)
    w = PAGE_W - 2*MARGIN
    y = fee_table(c, MARGIN, PAGE_H - 140, w, "Wallet basics", CT.WALLET_ROWS, icon_name="wallet")
    y = fee_table(c, MARGIN, y - 12, w, "Loading money", CT.LOAD_ROWS, icon_name="cash",
                  note="Voucher network fees are charged by the voucher issuer and deducted from the "
                       "voucher value before credit — WaPay adds no loading fee of its own.")
    info_band(c, 108, 72, MINT_SOFT, "cash", "Why flat fees?",
              "Because 'R6' is a price and '1.2% min R5 per R1,000 or part thereof' is a maths exam. "
              "You should never need a calculator to know what your own money costs to move.",
              dark=False)
    page_footer(c, page_num)
    c.showPage()

def pricing_fees_2(c, page_num, guide_name):
    page_header(c, "Fees · sends, spends & cash-outs", guide_name)
    kicker_line(c, "Money moving", MARGIN, PAGE_H - 88)
    text(c, "Send, spend & cash out", MARGIN, PAGE_H - 116, FB, 21, INK)
    w = PAGE_W - 2*MARGIN
    y = fee_table(c, MARGIN, PAGE_H - 140, w, "Sending money", CT.SEND_ROWS, icon_name="send")
    y = fee_table(c, MARGIN, y - 12, w, "Buying & paying", CT.BUY_ROWS, icon_name="cart")
    # what a send looks like — mini receipt strip
    bw_ = PAGE_W - 2*MARGIN
    rrect(c, MARGIN, 108, bw_, 118, 14, fill=CHAT_BG)
    text(c, "WHAT A SEND LOOKS LIKE", MARGIN + 18, 204, FB, 6.8, TEAL, charspace=1.4)
    rrect(c, MARGIN + bw_ - 232, 168, 214, 26, 8, fill=BUBBLE_ME)
    text(c, "Send R500 to mama", MARGIN + bw_ - 222, 177, F, 8.6, INK)
    rrect(c, MARGIN + 18, 124, 268, 38, 8, fill=WHITE)
    text(c, "Done! R500 sent to Mama Dlamini.", MARGIN + 28, 148, FB, 8.6, INK)
    text(c, "Fee: FREE · spend balance · 12:03", MARGIN + 28, 134, F, 8, GRAY)
    tick(c, MARGIN + 300, 143, 7)
    page_footer(c, page_num)
    c.showPage()

def pricing_fees_3(c, page_num, guide_name):
    page_header(c, "Fees · cash out & extras", guide_name)
    kicker_line(c, "Money out", MARGIN, PAGE_H - 88)
    text(c, "Cashing out & the extras", MARGIN, PAGE_H - 116, FB, 21, INK)
    w = PAGE_W - 2*MARGIN
    y = fee_table(c, MARGIN, PAGE_H - 140, w, "Cashing out", CT.CASHOUT_ROWS, icon_name="cash",
                  note=CT.CASHOUT_NOTE)
    y = fee_table(c, MARGIN, y - 26, w, "The extras (this list is short on purpose)",
                  CT.OTHER_ROWS, icon_name="star")
    # cash out in three steps
    rrect(c, MARGIN, 118, w, 108, 14, fill=TEAL)
    text(c, "CASH OUT IN THREE STEPS", MARGIN + 18, 204, FB, 6.8, HexColor("#7BE3AE"), charspace=1.4)
    steps = [("1", "Verify once", "A quick FICA ID check, done in the chat."),
             ("2", "Pick your exit", "PayShap, bank transfer, till or ATM."),
             ("3", "Get your cash", "Flat fee shown first. Money out in seconds.")]
    colw = (w - 36) / 3
    for i, (n, t, d) in enumerate(steps):
        x = MARGIN + 18 + i * colw
        step_circle(c, n, x + 10, 172, 10)
        text(c, t, x + 28, 168, FB, 9.5, WHITE)
        para(c, d, x + 28, 154, colw - 40, F, 7.6, HexColor("#B8DBD5"), leading=9.8)
    page_footer(c, page_num)
    c.showPage()

def pricing_smallprint(c, page_num, guide_name):
    page_header(c, "Important information", guide_name)
    kicker_line(c, "The small print", MARGIN, PAGE_H - 92)
    text(c, "Clear, even down here.", MARGIN, PAGE_H - 120, FB, 21, INK)
    colw = (PAGE_W - 2*MARGIN - 24) / 2
    yy = PAGE_H - 150
    x = MARGIN
    col = 0
    half = (len(CT.SMALL_PRINT) + 1) // 2
    for idx, s in enumerate(CT.SMALL_PRINT):
        lines = simpleSplit(s, F, 7.6, colw - 18)
        h = len(lines) * 10 + 14
        if idx == half and col == 0:
            col = 1; x = MARGIN + colw + 24; yy = PAGE_H - 150
        c.saveState(); c.setFillColor(EMERALD)
        c.circle(x + 3, yy - 3, 2, stroke=0, fill=1)
        c.restoreState()
        para(c, s, x + 14, yy - 6, colw - 18, F, 7.6, INK_SOFT, leading=10)
        yy -= h
    # glossary
    kicker_line(c, "Say it like WaPay — glossary", MARGIN, 288)
    gy = 262
    colw2 = (PAGE_W - 2*MARGIN - 24) / 2
    for i, (term, desc) in enumerate(CT.GLOSSARY):
        gx = MARGIN + (i % 2) * (colw2 + 24)
        if i % 2 == 0 and i > 0: pass
        text(c, term, gx, gy, FB, 8.4, EMERALD_DARK)
        used = para(c, desc, gx, gy - 11, colw2 - 10, F, 7.3, INK_SOFT, leading=9.4)
        if i % 2 == 1:
            gy -= max(30, used + 22)
    page_footer(c, page_num)
    c.showPage()

def build_pricing():
    path = os.path.join(OUT, "WaPay_Pricing_Guide_2026-27.pdf")
    c = Canvas(path, pagesize=A4)
    c.setTitle("WaPay Pricing Guide 2026/27")
    c.setAuthor("WaPay")
    gname = f"Pricing Guide {CT.GUIDE_YEAR}"
    draw_cover(c, "Pricing|Guide 2026/27",
               "Every fee we charge, on a few friendly pages. Flat fees you can say out loud — and the everyday things are free.",
               "The all-in-one wallet on WhatsApp")
    pricing_welcome(c, 2, gname)
    pricing_cando(c, 3, gname)
    draw_divider(c, "Our fees", "R0 monthly.", "Flat forever.",
                 "No monthly wallet fee. No inactivity fee. No percentages. Sending to other WaPay "
                 "users, airtime, data, electricity, bills and in-store shopping are free — "
                 "you only ever pay small flat fees to move cash in certain ways.",
                 [("R0", "monthly wallet fee — and no inactivity fees, ever"),
                  ("FREE", "sends to WaPay users, airtime, data & electricity"),
                  ("R6+", "flat cash-out fees — never a percentage")],
                 4, gname)
    pricing_fees_1(c, 5, gname)
    pricing_fees_2(c, 6, gname)
    pricing_fees_3(c, 7, gname)
    draw_balances_page(c, 8, gname)
    draw_compare_page(c, 9, gname)
    pricing_smallprint(c, 10, gname)
    draw_back_cover(c)
    c.save()
    return path

# ================================================================ PRODUCT GUIDE

def product_meet(c, page_num, guide_name):
    page_header(c, "Meet WaPay", guide_name)
    kicker_line(c, "Like a bank. On WhatsApp.", MARGIN, PAGE_H - 92)
    text(c, "The wallet that lives where", MARGIN, PAGE_H - 126, FB, 22, INK)
    text(c, "you already are.", MARGIN, PAGE_H - 152, FB, 22, EMERALD_DARK)
    para(c, "28 million South Africans open WhatsApp every day. WaPay puts your money in the same "
            "place: load cash, send money, buy airtime and electricity, pay bills, shop at over "
            "26,000 stores and cash out — all by chatting, in your language. No app to download, "
            "no bank card, no branch, no paperwork. Just your phone number.",
         MARGIN, PAGE_H - 176, 290, F, 9.8, INK_SOFT, leading=14.5)
    # stat chips, single column beside the phone
    chips = [("26,000+", "retail stores accept WaPay payments"),
             ("150,000+", "spaza shops & tills sell BluVouchers to load"),
             ("5", "South African languages, one natural chat"),
             ("R0", "monthly fees — free everyday transactions")]
    cw = 260; chh = 62
    top = PAGE_H - 330
    for i, (big, small) in enumerate(chips):
        x = MARGIN
        y = top - i * (chh + 12)
        rrect(c, x, y - chh, cw, chh, 12, fill=MINT_SOFT)
        text(c, big, x + 16, y - 27, FB, 15, EMERALD_DARK)
        para(c, small, x + 110, y - 24, cw - 124, F, 7.6, INK_SOFT, leading=9.8)
    # phone on right
    msgs = [
        {"side": "in", "lines": ["Welcome to WaPay", "Your account is ready."], "bold_first": True},
        {"side": "out", "lines": ["Load my BluVoucher", "0231 4456 8890 1123"], "time": "08:15"},
        {"side": "in", "lines": ["R94.00 loaded!", "Balance: R94.00"], "bold_first": True, "time": "08:15"},
        {"side": "out", "lines": ["Buy R20 electricity"], "time": "08:16"},
        {"side": "in", "lines": ["Token: 5839 2211 0392 8841", "Sent to your meter details."], "time": "08:16"},
    ]
    chat_phone(c, PAGE_W - MARGIN - 200, PAGE_H - 600, 200, 345, msgs, scale=0.86)
    # positioning strip
    rrect(c, MARGIN, 130, PAGE_W - 2*MARGIN, 84, 14, fill=TEAL)
    text(c, "Not a bank. On purpose.", MARGIN + 24, 184, FB, 11.5, WHITE)
    para(c, "WaPay is a digital voucher & payments service running on licensed payment networks. "
            "That's why there are no branches to fund, no forms to fill and no monthly fees to pay — "
            "and why you can start with nothing but a hello.",
         MARGIN + 24, 168, PAGE_W - 2*MARGIN - 48, F, 8.8, HexColor("#CBEADF"), leading=11.5)
    page_footer(c, page_num)
    c.showPage()

def product_how(c, page_num, guide_name):
    page_header(c, "How it works", guide_name)
    kicker_line(c, "From hello to money in minutes", MARGIN, PAGE_H - 92)
    text(c, "How WaPay works", MARGIN, PAGE_H - 122, FB, 21, INK)
    # 4 steps on left, phone on right
    left_w = PAGE_W - 2*MARGIN - 236
    yy = PAGE_H - 170
    for i, (t, d) in enumerate(CT.STEPS):
        step_circle(c, i + 1, MARGIN + 14, yy - 6, 12)
        text(c, t, MARGIN + 38, yy - 2, FB, 12, INK)
        used = para(c, d, MARGIN + 38, yy - 18, left_w - 50, F, 8.8, INK_SOFT, leading=12)
        if i < 3:
            c.saveState(); c.setStrokeColor(HexColor("#BBE3CE")); c.setLineWidth(1.6)
            c.setDash(1, 3.5); c.setLineCap(1)
            c.line(MARGIN + 14, yy - 20, MARGIN + 14, yy - used - 40)
            c.restoreState()
        yy -= used + 56
    msgs = [
        {"side": "in", "lines": ["Hi! I'm WaPay", "Say hello to your new wallet."], "bold_first": True},
        {"side": "out", "lines": ["Hi"], "time": "07:58"},
        {"side": "in", "lines": ["Account created for", "071 ··· 2210. Load money to", "get going — voucher, Pay@,", "EFT or card."], "bold_first": False},
        {"side": "out", "lines": ["Send R100 to my sister"], "time": "08:02"},
        {"side": "in", "lines": ["Done! R100 to Ayanda.", "Fee: FREE · 08:02"], "bold_first": True},
        {"side": "out", "lines": ["And R30 airtime for me"], "time": "08:03"},
        {"side": "in", "lines": ["R30 Vodacom airtime loaded.", "Anything else?"], "bold_first": True},
    ]
    chat_phone(c, PAGE_W - MARGIN - 216, PAGE_H - 610, 216, 400, msgs, scale=0.94)
    # ribbon
    rrect(c, MARGIN, 130, PAGE_W - 2*MARGIN, 66, 12, fill=MINT_SOFT)
    icon_badge(c, "bolt", MARGIN + 34, 163, 16, bg=WHITE)
    para(c, "Voucher and Pay@ loads land instantly; EFT reflects within minutes. From first hello "
            "to first payment is typically under five minutes.",
         MARGIN + 60, 172, PAGE_W - 2*MARGIN - 90, F, 8.8, INK, leading=11.5)
    page_footer(c, page_num)
    c.showPage()

def product_ai(c, page_num, guide_name):
    page_header(c, "AI banking", guide_name)
    kicker_line(c, "Chat like you talk", MARGIN, PAGE_H - 92)
    text(c, "No menus. No codes.", MARGIN, PAGE_H - 124, FB, 22, INK)
    text(c, "Just say it.", MARGIN, PAGE_H - 150, FB, 22, EMERALD_DARK)
    para(c, "Other services give you menus, submenus and USSD strings to memorise. WaPay reads "
            "plain human language — five of South Africa's languages, slang and typos included — "
            "and does the thing you asked. It's the difference between operating software and "
            "sending a text.",
         MARGIN, PAGE_H - 174, PAGE_W - 2*MARGIN - 190, F, 9.6, INK_SOFT, leading=14)
    # language pills
    xx = MARGIN
    for lang in CT.LANGS:
        w = pill(c, lang, xx, PAGE_H - 246, FB, 8.5, pad_x=12, pad_y=6, fg=EMERALD_DARK,
                 bg=MINT, center=False)
        xx += w + 8
    # example commands list
    yy = PAGE_H - 300
    text(c, "Things you can just type:", MARGIN, yy + 8, FB, 10.5, INK)
    for cmd, lang in CT.AI_EXAMPLES:
        yy -= 34
        rrect(c, MARGIN, yy, 300, 26, 13, fill=WHITE, stroke=LINE, sw=0.9)
        icon(c, "chat", MARGIN + 17, yy + 13, 6, EMERALD_DARK, 1.3)
        text(c, f'"{cmd}"', MARGIN + 32, yy + 8.6, FB, 9, INK)
        text(c, lang, MARGIN + 310, yy + 8.6, F, 7.5, GRAY)
    # phone right
    msgs = [
        {"side": "out", "lines": ["kanjani ibhalansi yami?"], "time": "17:20"},
        {"side": "in", "lines": ["Ibhalansi yakho: R312.40", "Spend: R212.40 · Cash: R100"], "bold_first": True},
        {"side": "out", "lines": ["stuur R60 vir ouma asb"], "time": "17:21"},
        {"side": "in", "lines": ["Klaar! R60 aan Ouma gestuur.", "Fooi: GRATIS"], "bold_first": True},
    ]
    chat_phone(c, PAGE_W - MARGIN - 190, PAGE_H - 560, 190, 300, msgs, scale=0.82)
    # bottom band: support
    rrect(c, MARGIN, 130, PAGE_W - 2*MARGIN, 74, 14, fill=TEAL)
    icon_badge(c, "chat", MARGIN + 38, 167, 17, bg=Color(1, 1, 1, 0.12), fg=WHITE)
    text(c, "Help never leaves the chat.", MARGIN + 66, 174, FB, 11, WHITE)
    para(c, "Our AI assistant answers instantly, any hour. Real humans step in when it matters — in "
            "your language, in the same conversation. No call centre queues, no ticket numbers.",
         MARGIN + 66, 158, PAGE_W - 2*MARGIN - 110, F, 8.6, HexColor("#B8DBD5"), leading=11)
    page_footer(c, page_num)
    c.showPage()

def product_network(c, page_num, guide_name):
    page_header(c, "Where it works", guide_name)
    kicker_line(c, "The network", MARGIN, PAGE_H - 92)
    text(c, "WaPay works where you already shop", MARGIN, PAGE_H - 122, FB, 20, INK)
    para(c, "From the spaza on your corner to the biggest chains in the country — load, spend and "
            "cash out across one of South Africa's widest acceptance networks.",
         MARGIN, PAGE_H - 142, PAGE_W - 2*MARGIN, F, 9.4, INK_SOFT, leading=13)
    sections = [
        ("wallet", "Load money here", "BluVoucher & 1Voucher at 150,000+ points · Pay@ deposits",
         ["Spaza shops", "Shoprite", "Checkers", "Pick n Pay", "Boxer", "Usave", "Garages", "EFT · Capitec Pay · Card"]),
        ("cart", "Shop & pay here", "26,000+ retail locations nationwide",
         ["Shoprite", "Woolworths", "Clicks", "Dis-Chem", "Spar", "OK Foods", "Ackermans", "Edgars", "Jet", "Game", "Makro", "+ thousands of independents"]),
        ("ticket", "Top up & play here", "Vouchers & account funding in one message",
         ["HollywoodBets", "Betway", "LottoStar", "Netflix", "Showmax", "Spotify", "DStv", "All networks' airtime & data", "Prepaid electricity"]),
        ("cash", "Cash out here", "Flat fees, no percentages",
         ["Pick n Pay tills", "Checkers tills", "PayShap to any bank", "RTC bank transfer", "CashSend ATMs"]),
    ]
    top = PAGE_H - 172
    cw = (PAGE_W - 2*MARGIN - 14) / 2
    ch2 = 196
    for i, (ic, t, sub, chips) in enumerate(sections):
        x = MARGIN + (i % 2) * (cw + 14)
        y = top - (i // 2) * (ch2 + 14) - ch2
        rrect(c, x, y, cw, ch2, 14, fill=WHITE, stroke=LINE, sw=0.9)
        icon_badge(c, ic, x + 28, y + ch2 - 28, 15)
        text(c, t, x + 50, y + ch2 - 25, FB, 11.5, INK)
        text(c, sub, x + 50, y + ch2 - 38, F, 7, GRAY)
        # chips flow
        cx0, cy0 = x + 14, y + ch2 - 66
        xx, yy2 = cx0, cy0
        for chip in chips:
            wch = stringWidth(chip, FB, 7.4) + 16
            if xx + wch > x + cw - 14:
                xx = cx0; yy2 -= 24
            rrect(c, xx, yy2 - 8, wch, 19, 9.5, fill=MINT_SOFT)
            text(c, chip, xx + 8, yy2 - 2.4, FB, 7.4, EMERALD_DARK)
            xx += wch + 7
    para(c, "Retailer and partner names indicate acceptance networks where WaPay-issued vouchers and payment codes are redeemable; "
            "availability may vary by store. All trademarks belong to their owners.",
         MARGIN, top - 2*ch2 - 42, PAGE_W - 2*MARGIN, F, 6.2, GRAY, leading=8.4)
    info_band(c, 118, 74, MINT_SOFT, "store", "One wallet for the whole high street",
              "Load at the spaza before work, buy electricity on the taxi, pay at the till at lunch, "
              "send money home tonight — without opening a single app.", dark=False)
    page_footer(c, page_num)
    c.showPage()

def product_security(c, page_num, guide_name):
    page_header(c, "Security", guide_name)
    kicker_line(c, "Safe by design", MARGIN, PAGE_H - 92)
    text(c, "Serious about the boring stuff", MARGIN, PAGE_H - 122, FB, 21, INK)
    para(c, "A wallet you chat with still has to be a vault underneath. Six layers stand between "
            "your money and anyone who isn't you:",
         MARGIN, PAGE_H - 142, PAGE_W - 2*MARGIN, F, 9.4, INK_SOFT, leading=13)
    cw = (PAGE_W - 2*MARGIN - 2*14) / 3
    ch2 = 150
    top = PAGE_H - 172
    for i, (ic, t, d) in enumerate(CT.SECURITY):
        x = MARGIN + (i % 3) * (cw + 14)
        y = top - (i // 3) * (ch2 + 14) - ch2
        rrect(c, x, y, cw, ch2, 14, fill=WHITE, stroke=LINE, sw=0.9)
        icon_badge(c, ic, x + 27, y + ch2 - 30, 16)
        para(c, t, x + 14, y + ch2 - 62, cw - 28, FB, 9.2, INK, leading=11.5)
        para(c, d, x + 14, y + ch2 - 90, cw - 28, F, 7.5, INK_SOFT, leading=10)
    # golden rule band
    gy = 262
    rrect(c, MARGIN, gy, PAGE_W - 2*MARGIN, 92, 14, fill=CREAM, stroke=HexColor("#F0D9A8"), sw=1)
    icon_badge(c, "shield", MARGIN + 38, gy + 46, 18, bg=HexColor("#FDF0D5"), fg=HexColor("#B7791F"))
    text(c, "The golden rule", MARGIN + 66, gy + 58, FB, 10.5, HexColor("#92400E"))
    para(c, "WaPay will never ask for your PIN or OTP — not in chat, not on a call, not by SMS. "
            "Anyone who does is a scammer, no matter how official they sound. Look for the verified "
            "tick next to our name, and keep your PIN yours.",
         MARGIN + 66, gy + 44, PAGE_W - 2*MARGIN - 104, F, 8.6, HexColor("#78350F"), leading=11.2)
    info_band(c, 118, 74, TEAL, "lock", "Your money moves only when you say so",
              "Every send, purchase and cash-out needs your PIN, your OTP and your phone. "
              "Lose the phone? Message us from a new one and we'll lock and restore your account securely.",
              dark=True)
    page_footer(c, page_num)
    c.showPage()

def product_why(c, page_num, guide_name):
    page_header(c, "Why WaPay", guide_name)
    kicker_line(c, "Why people switch", MARGIN, PAGE_H - 92)
    text(c, "Six honest reasons", MARGIN, PAGE_H - 122, FB, 21, INK)
    cw = (PAGE_W - 2*MARGIN - 14) / 2
    ch2 = 118
    top = PAGE_H - 150
    for i, (t, d) in enumerate(CT.WHY_SWITCH):
        x = MARGIN + (i % 2) * (cw + 14)
        y = top - (i // 2) * (ch2 + 12) - ch2
        rrect(c, x, y, cw, ch2, 14, fill=MINT_SOFT if i % 2 == 0 else WHITE,
              stroke=None if i % 2 == 0 else LINE, sw=0.9)
        text(c, f"{i+1:02d}", x + 16, y + ch2 - 32, FB, 15, EMERALD)
        text(c, t, x + 44, y + ch2 - 30, FB, 10.5, INK)
        para(c, d, x + 16, y + ch2 - 54, cw - 32, F, 8, INK_SOFT, leading=10.8)
    info_band(c, 150, 80, TEAL, "send", "The seventh reason: it takes 30 seconds to see for yourself",
              "Go to wapay.co.za, tap 'Start banking on WhatsApp', and say hi. If it doesn't feel "
              "like the future, you've lost half a minute.", dark=True)
    page_footer(c, page_num)
    c.showPage()

def product_faq(c, page_num, guide_name):
    page_header(c, "FAQ", guide_name)
    kicker_line(c, "Questions, answered", MARGIN, PAGE_H - 92)
    text(c, "You asked. We answered.", MARGIN, PAGE_H - 122, FB, 21, INK)
    colw = (PAGE_W - 2*MARGIN - 24) / 2
    tops = [PAGE_H - 158, PAGE_H - 158]
    for i, (q, a) in enumerate(CT.FAQ):
        col = i % 2
        x = MARGIN + col * (colw + 24)
        yy = tops[col]
        qh = para(c, q, x + 22, yy, colw - 30, FB, 9.4, INK, leading=12)
        c.saveState(); c.setFillColor(EMERALD)
        c.circle(x + 6, yy + 3, 3, stroke=0, fill=1)
        c.restoreState()
        ah = para(c, a, x + 22, yy - qh - 2, colw - 30, F, 8.2, INK_SOFT, leading=11)
        tops[col] = yy - qh - ah - 26
    band_y = max(120, min(tops) - 96)
    info_band(c, band_y, 74, MINT_SOFT, "chat", "Still curious?",
              "The fastest FAQ is a conversation. Message WaPay on WhatsApp and ask anything — "
              "our AI answers instantly, and real humans are one 'agent' away.", dark=False)
    page_footer(c, page_num)
    c.showPage()

def build_product():
    path = os.path.join(OUT, "WaPay_Product_Guide.pdf")
    c = Canvas(path, pagesize=A4)
    c.setTitle("WaPay Product Guide")
    c.setAuthor("WaPay")
    gname = "Product Guide"
    draw_cover(c, "Product|Guide",
               "Everything WaPay does, and why it feels like the future: your money, in your language, in the chat you already use every day.",
               "Your money. On WhatsApp.")
    product_meet(c, 2, gname)
    product_how(c, 3, gname)
    pricing_cando(c, 4, gname)
    product_ai(c, 5, gname)
    product_network(c, 6, gname)
    draw_balances_page(c, 7, gname)
    product_security(c, 8, gname)
    product_why(c, 9, gname)
    draw_compare_page(c, 10, gname)
    product_faq(c, 11, gname)
    draw_back_cover(c)
    c.save()
    return path

if __name__ == "__main__":
    p1 = build_pricing()
    p2 = build_product()
    print(p1); print(p2)
