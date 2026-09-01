# Store redemption test playbook (Wrapped portal)

*Written 2026-09-01, verified live on https://wrappedgifts.co.za. This is how
we test the till-side wiCode experience at our campaign retailers TODAY,
before Yoyo production. Sipho pointed us here (email 30 Jun 2026).*

## What this tests, honestly

These portal vouchers are REAL production vouchers (bought with your card via
Yoyo's own consumer shop), so they redeem at real tills today. This proves the
CUSTOMER-SIDE experience our users will have: the code on the phone, the
cashier interaction, the POS behaviour, partial redemption. It does NOT
exercise our pipeline (our integration issues test-campaign vouchers that do
not redeem; that becomes real only with production campaign IDs).

The money is not lost: you spend the voucher on goods at the store.

## Verified on the portal (2026-09-01)

Every brand on our campaign list is purchasable: **Checkers, Shoprite,
Pick n Pay, KFC, Engen, Shell** (plus Total, Boxer, SPAR, Woolworths
Foodstop @ Engen and ~60 others).

Flow: wrappedgifts.co.za → Send Gifts Now → pick retailer → Gift Value +
recipient name/number + sender email → checkout → voucher arrives on the
recipient's **WhatsApp**.

## The test matrix (~R300 total, redeemed for goods)

One R50 voucher per brand, sent to your own number. At each store, record:

1. Did the cashier recognise a wiCode without explanation? What did they
   press / which POS?
2. Time from "I want to pay with a voucher" to paid.
3. EXACT-AMOUNT test (our target UX): buy goods for MORE than the voucher
   and pay the difference in cash. Clean?
4. PARTIAL test (one store only): spend LESS than the voucher. Does a new
   code arrive? How fast? What does the slip show?
5. Fuel specifics: Engen = forecourt till, tell the attendant BEFORE
   fueling. Shell = try the pump AND the convenience store (should both
   work). Woolworths Foodstop @ Engen is a bonus check.
6. Any cashier confusion to feed into our redemption-guide copy.

## Finding that corrects our own docs

**SPAR is on the live Wrapped portal.** Our July 2025 footprint doc said
Spar was NOT on the wiCode network; the live portal (newer evidence) lists
it. Do not advertise SPAR to customers yet, but ADD it to the Yoyo
questions: is SPAR now redeemable on standard campaigns? If yes, it belongs
in a later campaign phase.
