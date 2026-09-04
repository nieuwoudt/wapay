# PayFast fee schedule and what it means for our model

*Captured 2026-09-04 from the founder's PayFast portal (Payment Methods).
Every PayFast rate below is quoted **EXCLUDING VAT**. Our commercial model
must use the VAT-inclusive number, because **WaPay is not VAT-registered**,
so that 15% is an unrecoverable real cost, not a pass-through.*

## Our current deposit fee

`WAPAY_DEPOSIT_FEE_FIXED_CENTS=230` + `WAPAY_DEPOSIT_FEE_BPS=420`
= **R2.30 + 4.20%**, charged on top of the deposit (the customer pays
amount + fee; the wallet is credited the full face value).

## The schedule, with true cost and our margin

Cost = (fixed + percent) x 1.15. Margin = our fee minus that cost.

| Method | PayFast (excl VAT) | True cost incl VAT | Margin @R100 | @R500 | @R3000 | Status |
|---|---|---|---|---|---|---|
| **Instant EFT** | R0.00 + 2.00% | 2.30% | **+R4.20** | +R11.80 | +R59.30 | ✅ on |
| Mobicred | R0.00 + 3.20% | 3.68% | +R2.82 | +R4.90 | +R17.90 | ✅ on |
| Credit Card | R2.00 + 3.20% | R2.30 + 3.68% | +R0.52 | +R2.60 | +R15.60 | ✅ on |
| ApplePay / GooglePay / SamsungPay | R2.00 + 3.20% | R2.30 + 3.68% | +R0.52 | +R2.60 | +R15.60 | ✅ on |
| American Express | R2.00 + 3.20% | R2.30 + 3.68% | +R0.52 | +R2.60 | +R15.60 | ✅ on |
| Store Card (RCS) | R2.00 + 3.20% | R2.30 + 3.68% | +R0.52 | +R2.60 | +R15.60 | ✅ on |
| Zapper | R2.00 + 3.25% | R2.30 + 3.74% | +R0.46 | +R2.31 | +R13.87 | ✅ on |
| Debit Card | R2.00 + 3.50% | R2.30 + 4.02% | **+R0.17** | +R0.87 | +R5.25 | ✅ on |
| SnapScan | R2.00 + 3.50% | R2.30 + 4.02% | +R0.17 | +R0.87 | +R5.25 | ✅ on |
| QR Code Apps | R2.00 + 3.50% | R2.30 + 4.02% | +R0.17 | +R0.87 | +R5.25 | ✅ on |
| **Mukuru Cash** | R6.00 + 3.50% | R6.90 + 4.02% | **−R4.43** | **−R3.73** | +R0.65 | ⚠️ **ON** |
| SCode | R5.00 + 4.50% | R5.75 + 5.17% | −R4.43 | −R8.32 | −R32.70 | off |
| MoreTyme | R2.00 + 5.50% | R2.30 + 6.32% | −R2.12 | −R10.62 | −R63.75 | off |

Limits worth knowing: Mobicred min R1 / max R50k · Mukuru Cash min R200 /
max R20k · MoreTyme min R50 / max R25k · SCode min R10 / max R100k · Store
Card max R50k · everything else R5 to R1m. Our own deposit cap is R10 to
R3,000, so the ceilings never bind; the FLOORS do (Mukuru's R200 minimum).

## 🔴 Finding 1: Mukuru Cash is enabled and loses money

At our R10 to R3,000 deposit caps, Mukuru Cash is **underwater below about
R2,850**. Its R6.00 fixed fee (R6.90 incl VAT) is triple the card rails,
while we charge the same R2.30. Every realistic Mukuru deposit loses money:
a R200 deposit (its own minimum) costs us R14.95 and earns R10.70, a **loss
of R4.25**.

Options, in order of preference:
1. **Disable Mukuru Cash** in the PayFast portal (one toggle, no code).
2. Keep it as a deliberate cash-acquisition subsidy, and say so out loud in
   the model, since it is buying cash-in reach we otherwise lack.
3. Charge a method-specific fee. This needs a code change AND breaks the
   founder's flat-fee promise, so it is the least attractive.

Recommendation: disable it. Cash-in already has a better answer in the Blu
voucher rail, which costs us 6% but is priced as a NET credit, so it can
never go underwater.

## 🟠 Finding 2: the 4.20% is too thin on the 3.50% rails

Debit Card, SnapScan and QR Code Apps leave **17 cents** on a R100 deposit.
Any chargeback, refund or support minute wipes out hundreds of those. Debit
card matters most: it is the mass-market instrument for exactly our target
customer, so this is likely our highest-volume rail.

Raising to 4.50% would give R0.65 at R100 on those rails while still leaving
card cheaper than the R10 to R30 the banks charge for an eWallet send.

## 🟢 Finding 3: Instant EFT is dramatically our best rail

2.30% all-in, no fixed fee, and we earn **R4.20 on a R100 deposit** versus
R0.52 on a credit card. Eight times the margin.

This is a product opportunity, not just a pricing note: nothing in the
WhatsApp flow currently steers anyone toward Instant EFT. Making it the
first-listed or default option on the PayFast checkout is free money, and it
is also cheaper for the customer if we ever pass the difference on.

## Negotiating with PayFast

Worth asking, with the volumes we can now evidence:
- A lower card rate (3.20% is standard SA pricing; 2.8% to 3.0% is
  achievable at volume).
- Removal of the R2.00 per-transaction fixed fee, which hurts small tickets
  disproportionately. On a R20 deposit the fixed fee alone is 11.5%.
- Better Instant EFT pricing, given it is already our cheapest rail and we
  intend to push volume through it.

Alternatives to price against: Yoco, Peach Payments, Paystack SA, Stitch
(pay-by-bank, typically well under 2%), and Ozow for EFT.

## Website

Nothing to change today: the site quotes no fees. When it does, the numbers
must be OUR customer-facing fees (flat, per the locked model), never
PayFast's cost lines. Do not publish a percentage: the founder's locked
position is that flat, explainable numbers earn mass-market trust.

## Actions

| # | Action | Owner |
|---|---|---|
| 1 | Disable Mukuru Cash in the PayFast portal | Founder |
| 2 | Decide on 4.20% to 4.50%, or accept the thin debit margin | Founder |
| 3 | Steer deposits toward Instant EFT in the checkout | Dev |
| 4 | Open a rate negotiation with PayFast | Founder |
| 5 | Keep SCode and MoreTyme disabled: both are loss-making at our caps | Founder |
