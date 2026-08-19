"""All copy + fee data for the WaPay guides.
Fee numbers verified against lib/ledger-core.js FEES object (2026-08-19):
  send flat R2.50, free spend->spend; voucher gift R3;
  cashout Pay@ R12 / PayShap R6 / RTC R8 / CashSend R14;
  loads: voucher rails NET of 6% network discount, card credits face value.
Rows marked ASSUMED are product positioning defaults awaiting founder sign-off.
"""

GUIDE_YEAR = "2026/27"
EFFECTIVE = "Effective 1 September 2026 until updated. All fees include VAT."
TAGLINE = "Your Money. On WhatsApp."
SUBLINE = ("No apps to download. No bank cards needed. Just your phone number.")

WALLET_ROWS = [
    ("Monthly wallet fee", "FREE", None),
    ("Opening a WaPay account", "FREE", "Just your WhatsApp number — no forms, no paperwork, no ID to start."),
    ("Balance enquiries & mini statements", "FREE", "Ask any time, right in the chat."),
    ("Payment notifications", "FREE", "Every transaction confirmed instantly on WhatsApp."),
    ("Inactivity fee", "FREE", "Your money never gets nibbled at for standing still."),  # ASSUMED
]

LOAD_ROWS = [
    ("BluVoucher — 150,000+ spaza shops & retailers", "R6 / R100",
     "Buy a BluVoucher with cash, send us the PIN, loaded instantly. Voucher network fee — WaPay adds nothing."),
    ("1Voucher & OTT Voucher", "R6 / R100",
     "Same deal: instant load, network fee only, no WaPay charge on top."),
    ("Pay@ deposit at till — Shoprite, Checkers, Pick n Pay", "At cost",
     "Retailer deposit fee shown in chat before you confirm."),
    ("Card payment", "FREE", "Full value credited to your wallet."),
    ("EFT / Capitec Pay", "FREE", "Typically reflects within minutes."),  # fee ASSUMED
]

SEND_ROWS = [
    ("Send to any WaPay user — spend balance", "FREE",
     "Instant, any amount, as often as you like. This is how money should move."),
    ("Send to any WaPay user — cash balance", "R2.50",
     "One flat fee. Never a percentage."),
    ("Send a voucher to ANY South African cellphone", "R3",
     "They don't need WaPay — they get a voucher to spend or redeem, instantly."),
]

BUY_ROWS = [
    ("Prepaid airtime & data — all networks", "FREE", None),
    ("Prepaid electricity", "FREE", None),
    ("Bill payments — DStv and more", "FREE", None),  # ASSUMED
    ("Gaming, streaming & betting vouchers", "FREE",
     "HollywoodBets, Betway, LottoStar, Netflix, Showmax, Spotify and more."),
    ("Pay in-store at 26,000+ retailers", "FREE",
     "Shoprite, Woolworths, Clicks, Dis-Chem, Spar, Makro and thousands more."),
]

CASHOUT_ROWS = [
    ("PayShap — instant to any bank", "R6", "Straight to any SA bank account, day or night."),
    ("Bank transfer (RTC)", "R8", "Same-day to any SA bank account."),
    ("Cash at till — Pick n Pay & Checkers", "R12", "Get a code in chat, show it at the till, walk out with cash."),
    ("CashSend at ATM", "R14", "Cardless cash at participating ATMs."),
]
CASHOUT_NOTE = ("Cash-outs come from your cash balance, which needs a once-off FICA identity check — "
                "done in the chat in minutes. Loading, spending and sending never require it.")

OTHER_ROWS = [
    ("Declined or failed transaction", "FREE", None),          # ASSUMED
    ("Reversing a mistaken send (recipient balance unspent)", "FREE",
     "Message support in the same chat — no call centre, no forms."),  # ASSUMED
    ("Customer support on WhatsApp", "FREE", "AI assistant plus a human team, in your language."),
]

# ---- comparison vs FNB eWallet (their 2026/27 published guide) ----
COMPARE_SOURCE = ("eWallet fees and features quoted from the FNB eWallet Annual Pricing Guide, "
                  "1 July 2026 – 30 June 2027 (fnb.co.za), retrieved August 2026. FNB and eWallet are "
                  "trademarks of FirstRand Bank Limited, quoted for comparison only. Please verify "
                  "current fees with each provider before deciding.")

COMPARE_ROWS = [
    # (label, wapay, ewallet, wapay_wins: True/False/None=tie)
    ("Monthly wallet fee", "R0", "R0", None),
    ("What you need to open an account", "A WhatsApp number. That's it.",
     "Name, ID number and source of funds", True),
    ("Send to another wallet user", "FREE from your spend balance", "R10 per eWallet send", True),
    ("Send to any SA cellphone number", "R3 voucher send", "R10 eWallet send", True),
    ("Prepaid airtime & data", "FREE", "R0.65 per purchase", True),
    ("Prepaid electricity", "FREE", "R1 per purchase", True),
    ("DStv payment", "FREE", "R7 per payment", True),
    ("Fund a betting account", "Yes — HollywoodBets, Betway, LottoStar & more", "Not offered", True),
    ("Reverse a mistaken send", "FREE via chat support", "R19.50 self-service / R85 contact centre", True),
    ("Inactivity fee", "None, ever", "R7.50 per month after 6 months", True),
    ("Cash out", "R6–R14 flat, whatever the amount", "R2–R12, some charged per R1,000", False),
    ("How you use it", "One AI chat — plain language, 5 SA languages", "Menus on WhatsApp + USSD (*120*321#)", True),
]

LANGS = ["English", "isiZulu", "isiXhosa", "Sesotho", "Afrikaans"]

AI_EXAMPLES = [
    ("Send R50 to Thabo", "English"),
    ("Thumela u-R100 ku-mama", "isiZulu"),
    ("Ndithengele i-airtime ye-R30", "isiXhosa"),
    ("Nthekele motlakase wa R200", "Sesotho"),
    ("Stuur R250 na Pieter", "Afrikaans"),
]

STEPS = [
    ("Open your account", "Message WaPay on WhatsApp. Your number is your account — no forms, no paperwork, no branch."),
    ("Load money", "Buy a BluVoucher at any spaza shop, deposit via Pay@ at major retailers, or use EFT, Capitec Pay or card."),
    ("Do everything", "Send money, buy airtime, data and electricity, pay bills, shop in-store, fund your betting account, or cash out."),
    ("All in one chat", "Just say what you need, in your language. No menus, no apps, no clicks. WaPay understands you."),
]

FEATURES = [
    ("wallet", "Load money anywhere", "BluVoucher at 150,000+ spaza shops, Pay@ deposits at Shoprite, Checkers & Pick n Pay, EFT, Capitec Pay or card."),
    ("send", "Send money free", "WaPay-to-WaPay transfers are free and instant. Send a R3 voucher to any SA cellphone — even without WaPay."),
    ("phone", "Airtime & data", "Every network, best prices, zero fees. Buy for yourself or anyone you love."),
    ("bolt", "Prepaid electricity", "Token delivered straight into the chat, day or night. No queues, no fees."),
    ("bill", "Pay your bills", "DStv and more — settled in seconds from your wallet."),
    ("cart", "Shop in-store", "Pay at 26,000+ retail locations: Shoprite, Woolworths, Clicks, Dis-Chem, Spar, Makro and more."),
    ("ticket", "Vouchers & betting", "HollywoodBets, Betway, LottoStar, Netflix, Showmax, Spotify — bought in one message."),
    ("cash", "Cash out", "PayShap to any bank from R6, or cash at Pick n Pay & Checkers tills. Flat fees, always."),
]

SECURITY = [
    ("lock", "PIN + OTP on every transaction", "Nothing moves without your secret PIN and a one-time password."),
    ("phone", "Device binding", "Your account is locked to your phone. A new SIM or device can't just walk in."),
    ("shield", "Bank-grade encryption", "TLS 1.3 and AES-256 protect every message and every cent."),
    ("chat", "Verified business account", "Look for the WaPay tick on WhatsApp — that's how you know it's really us."),
    ("id", "Tiered accounts", "Start with just your number. Verify your ID once to unlock cash-outs and higher limits."),
    ("bill", "Every fee shown first", "The fee appears in chat before you confirm. No surprises on a statement you never see."),
]

BALANCES = {
    "spend": ("Spend balance", "Yours the second you say hello",
              ["Open with just your WhatsApp number", "Load via voucher, Pay@, EFT or card",
               "Buy airtime, data, electricity & vouchers", "Pay in-store at 26,000+ retailers",
               "Send free to other WaPay users", "No ID document needed"]),
    "cash": ("Cash balance", "Unlock with a once-off ID check",
             ["Everything the spend balance does", "Cash out via PayShap, RTC or at tills",
              "Send to any bank account", "Higher transaction & balance limits",
              "FICA-verified in minutes, in the chat", "Never needed just to spend"]),
}

FAQ = [
    ("Do I need to download an app?", "No — WaPay runs 100% inside WhatsApp. If you can chat, you can WaPay."),
    ("What do I need to open an account?", "Just your phone number. No paperwork, no ID required to start."),
    ("How do I put money in?", "Buy BluVouchers at spaza shops, deposit at Pay@ retailers (Shoprite, Checkers, Pick n Pay), or use EFT, Capitec Pay or card."),
    ("Can I send money to someone without WaPay?", "Yes — send to any South African mobile number. They get a voucher they can redeem or spend."),
    ("Is my money safe?", "Bank-grade encryption, PIN protection, OTPs and device binding guard every transaction — and every fee is shown before you confirm."),
    ("What are the account limits?", "Entry-level accounts have basic limits. Complete a once-off FICA verification in chat to unlock higher limits and cash-outs."),
    ("How long do deposits take?", "BluVoucher and Pay@ deposits are instant. EFT transfers typically reflect within minutes."),
    ("What if I change my SIM or phone?", "Message support in the chat and we'll verify you and restore access securely."),
]

SMALL_PRINT = [
    "All fees in this guide include VAT and are effective from 1 September 2026 until we publish an update at wapay.co.za.",
    "WaPay is not a bank or financial institution. WaPay does not hold bank deposits, earn you interest, or operate bank accounts. WaPay enables you to purchase, store, send and redeem digital value through the WhatsApp platform, delivered on licensed voucher and payment networks.",
    "Every applicable fee is shown to you in the chat before you confirm a transaction. If a partner network changes a fee, the price in your chat is always the one that counts.",
    "Voucher purchases are final once confirmed. Voucher redemptions and retailer acceptance follow each partner network's rules. Expired or used vouchers cannot be reused.",
    "Loading via voucher networks (BluVoucher, 1Voucher, OTT) carries the network's standard fee, deducted from the voucher value before credit. WaPay does not add a loading fee of its own.",
    "Cash-outs and bank transfers are paid from your cash balance, which requires a once-off FICA identity verification as required by South African law. Transaction and balance limits apply per our partners and compliance policy.",
    "You must be 18 years or older with a valid South African mobile number. Accounts are linked to your WhatsApp number and protected by PIN and OTP. Never share your PIN or OTP with anyone — including anyone claiming to be WaPay.",
    "We may change fees or introduce new fees from time to time with reasonable notice, published at wapay.co.za. If this guide and a product's specific terms disagree, the product terms apply.",
    "Fees for comparison shown from other providers' published pricing guides; see the source note on the comparison page. We strive for accuracy and are not responsible for errors or omissions.",
]

GLOSSARY = [
    ("Spend balance", "Your everyday balance — open to everyone with a phone number. Spend, buy and send; cannot be withdrawn as cash."),
    ("Cash balance", "Your withdrawable balance, unlocked by a once-off FICA ID check. Cash out, transfer to banks, higher limits."),
    ("BluVoucher / 1Voucher / OTT", "Cash voucher networks sold at spaza shops and major retailers nationwide — how you turn cash into WaPay balance."),
    ("Pay@", "A payments network at major retailer tills used for deposits and cash pick-ups."),
    ("PayShap", "South Africa's instant payment rail — pay any bank account in seconds using a cellphone number or account."),
    ("FICA", "The Financial Intelligence Centre Act — the once-off ID verification required by law before cash can be withdrawn."),
    ("OTP", "One-time PIN sent for each sensitive action, so only you can approve it."),
]

WHY_SWITCH = [
    ("No ID to start", "FNB's evolved eWallet asks for your name, ID number and source of funds up front. WaPay asks for a hello."),
    ("Free is the default", "Wallet-to-wallet sends, airtime, data, electricity and bills — R0. The everyday things should cost nothing."),
    ("Flat fees you can say out loud", "R6. R8. R12. Never 'R12 per R1,000' arithmetic, never percentages."),
    ("A chat, not a menu", "Type 'send R50 to mama' in any of 5 languages. No USSD codes, no submenus, no app updates."),
    ("Betting & entertainment built in", "Fund HollywoodBets, Betway or LottoStar and buy Netflix, Showmax or Spotify vouchers — no bank will do this in chat."),
    ("Fees shown before you pay", "Every fee appears in the chat before you confirm. Nothing hides on a statement."),
]

CONTACT_LINES = [
    "wapay.co.za",
    "Tap 'Start banking on WhatsApp' on our site",
    "Support: just message us in the chat — AI + humans, in your language",
]
