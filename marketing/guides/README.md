# WaPay customer guides

Two customer-facing booklets, modelled on the FNB eWallet Annual Pricing Guide 2026/27
and built from WaPay's locked fee model (`lib/ledger-core.js` FEES object).

- `WaPay_Pricing_Guide_2026-27.pdf` — 11 pages: fees, two-balance model, WaPay vs FNB eWallet comparison, small print.
- `WaPay_Product_Guide.pdf` — 12 pages: what WaPay is, how it works, AI chat in 5 languages, acceptance network, security, FAQ.

## Rebuild

```bash
python3 -m pip install --user reportlab pypdfium2   # once
python3 build_guides.py                              # writes both PDFs next to the script
```

- `wapay_content.py` — ALL copy and fee numbers live here. Edit this to change prices/wording.
- `wapay_design.py` — brand system (colors from wapay.co.za CSS tokens, logo, icons, chat mockup, tables).
- `build_guides.py` — page layouts for both PDFs.

## Numbers that still need founder sign-off (marked ASSUMED in wapay_content.py)

- R0 customer fee on airtime / data / electricity / bill payments / in-store payments (commission-funded).
- No inactivity fee; free reversal of a mistaken send; free declined transactions.
- EFT / Capitec Pay load = free; Pay@ till deposit shown as "at cost / set by retailer".
- OTT/1Voucher load shown as "R6 per R100" (OTT actually redeems at 6% + VAT).
- Effective date "1 September 2026".

Confirmed from code: P2P R2.50 (free spend->spend), voucher gift R3, cash-out R6 PayShap /
R8 RTC / R12 Pay@ till / R14 CashSend, card load credits full face value, voucher loads NET of 6%.

No WhatsApp number is printed in the guides (couldn't find one published on the site) —
the CTA everywhere is wapay.co.za → "Start banking on WhatsApp". Swap in the real number
in `wapay_content.py`/`build_guides.py` when finalised, and replace the vector chat mockups
with real UI screenshots from the image bank when available.
