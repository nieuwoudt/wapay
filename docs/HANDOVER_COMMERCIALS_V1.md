# WaPay Money Map — the commercials thread, v1

Written 2026-10-04 by the main architecture session for a dedicated side thread named
**"WaPay Money Map"**. The founder's mandate, verbatim: *"determine how everything works in
terms of commercials, payouts, pay-ins, the commission on sales for vouchers, all the
different types of categories that we can make money on … look at the documentation that we
have on file so far and condense that all into one thread … create an artifact dashboard for
me to see what all our commercials are for every single component of money in, money out,
and all the vending of products, and what we're charging customers. We need one dashboard."*

The dashboard is called the **WaPay Money Map**: one page, every rail, what it costs us,
what the customer pays, who pays it, what we keep, and whether the number is signed,
assumed or proposed. Report to the main session (`WaPay Build v1.3 autonomous loop`, find it
with ListAgents, SendMessage after each milestone). Two sibling threads run in parallel:
"WaPay payouts end-to-end" (owns the pay-out rail and is producing
`docs/PAYOUT_COMMERCIALS.md`: consume it, do not duplicate it) and "WaPay BluVas integration
testing" (owns VAS). You own `docs/COMMERCIALS.md`, `docs/commercials/` and the dashboard.
You do not change a fee in code: every fee change is a founder decision; you surface it.

Read in order: `CLAUDE.md`, `WAPAY_STATUS.md` (iCloud root), this file, then the sources in
section 2.

---

## 1. Deliverables

1. **`docs/COMMERCIALS.md`**, the text master: one table per money component (section 3),
   every number with its source (file, section, date) and a status: SIGNED (in a contract),
   LIVE (in code and charged today), ASSUMED (in code or a guide without a contract), PROPOSED
   (a recommendation not yet decided), UNKNOWN (asked of the supplier, no answer). VAT stated
   on every cost line: WaPay is not VAT-registered, so a supplier's ex-VAT price costs us
   ×1.15 and we charge no VAT (memory `payfast-fee-reality`; `WAPAY_VAT_REGISTERED` is the
   switch for registration day).
2. **The WaPay Money Map artifact**: a private claude.ai artifact (favicon 💰), built from
   sources in the repo under `docs/commercials/` the way the architecture map is
   (`docs/architecture/README.md`: template + data JSON + `assemble.js`, publish the
   assembled HTML, republish keeping the URL). Sections: Money in · Money out · Vending ·
   Getting paid · Sending · Business; a reference-amount slider (R50, R200, R500, R1,000,
   R3,000) that recomputes cost, price and margin per row from the data JSON; a status chip
   per number; a "needs the founder's signature" panel; the date and version in the header.
   Record the URL in `WAPAY_STATUS.md`, the memory `wapay-artifacts-index`, and this file.
3. **`tests/commercials-consistency.test.mjs`**: the data JSON must equal what the code
   charges at the reference amounts (`depositFeeCents`, `paymentRequestFeeCents` per rail,
   `cashoutFeeCents` per method, `cashoutRailCostCents`, the VAS/voucher commission config in
   `lib/ledger-core.js FEES`), so the dashboard can never drift from production.
4. **The sign-off list**: every ASSUMED and PROPOSED number as one question each for the
   founder, printed in the session report, no em dashes.

## 2. Sources (read all of them; nothing here is new research)

**Code (the truth about what is charged today):** `lib/ledger-core.js` (`FEES`, `FEE_STYLE`,
`commissionBps` per category and the "0 bps until signed" rule for OTT issuing and Yoyo,
`cashoutFeeCents`, `cashoutRailCostCents`, `cashoutMarginCents`, `netMarginCents`, the
`REVENUE:*` and `CLEARING:*` account codes), `lib/deposits.js` (`depositFeeCents`,
`cardRailFee`, `paymentRequestFeeCents`: PayFast R2.30 + 4.20%, Adumo R1 + 2.5%, free under
R50 with the taper), `lib/fee-facts.js` (`feeSchedule`, what the bot quotes), `lib/payouts.js`
(`PAYOUT_METHODS`, limits), `lib/spend-catalogue.js`, `docs/CONVERSATION_KNOWLEDGE_BASE.md`
(generated: what customers are told).

**Repo docs:** `docs/PAYFAST_FEES.md` (PayFast schedule per method, ex VAT, Mukuru Cash loses
money), `docs/ADUMO.md` §3 (Adumo costs, the R1 + 2.5% floor, blended margin), `docs/PAYOUTS.md`
and `docs/OTT_PAYOUT_API.md` (pay-out methods, fees, the +R2 decision), `docs/HANDOVER_PAYOUTS_V1.md`
§3 and, when it lands, `docs/PAYOUT_COMMERCIALS.md` (the pay-out cost verification: consume
it), `docs/UNIFUEL_INTEGRATION.md` and `docs/WICODE_NETWORK.md` (fuel and retail wiCodes),
`docs/BLU_VAS_CATEGORY_REQUEST.md` (categories asked of Blu), `docs/CAPABILITIES.md` §3 and §7.

**iCloud root strategy docs (`…/Desktop/WaPay /`):** `WAPAY_MONEY_ENGINE_AND_PHASE1.md`,
`WAPAY_V1_AND_FORECAST.md`, `WAPAY_OTT_AGREEMENTS_REVIEW_2026-08-21.md` (Reseller 4% + VAT
commission on face, Merchant redemption 6% + VAT, Payout addendum prices), `WAPAY_B2B_PAYOUTS.md`,
`WAPAY_MARKETING_FEATURE_CATALOGUE.md` (the fee sheet it carries), `WAPAY_WALLET_DESIGN_2026-08-20.md`,
`WAPAY_PLEASE_PAY_ME_RESEARCH_2026-08-22.md`, `WAPAY_RETAIL_LAUNCH_PLAN.md`. Supplier PDFs in
`…/WaPay /OTT Onboarding /` (2026 Addendum to Payout Agreement, Reseller agreement, Merchant
agreement, PayShap deck). The customer-facing guides in `marketing/guides/`
(`WaPay_Pricing_Guide_2026-27.pdf`, built by `build_guides.py` from `wapay_content.py`).

**Memory files (auto-memory directory):** `wapay-fee-model` (locked decisions: flat fees,
spend vs cash balance, KYC on withdrawal only), `payfast-fee-reality`, `no-card-surcharging-sa`
(the payer always pays the displayed amount; the receiver carries the card fee),
`ewallet-real-pricing-2026`, `ott-payout-payshap` (addendum prices: PayShap R2.50, RTC R4.50,
Nedbank Cardless R9.96 + 0.3%, ABSA CashSend R9.96 + 0.3%, VAS 1% + 0.3%, reversals R10),
`ott-collect-decision`, `voucher-as-balance-rejected`, `wicode-retail-economics` (Yoyo 2.5% on
issue, R0.20 per SMS, R15,000 monthly retainer, no grocery rebate, KFC ~5%),
`adumo-shb-card-offer` (credit 2.35%, debit 1.35%, gateway R0.80 + 0.10%, ex VAT),
`wapay-customer-guides` (which guide lines are ASSUMED), `growth-benchmarks-valuation-2026`.

**Existing artifacts to fold in, not rebuild:** the Fee Benchmark calculator
(https://claude.ai/code/artifact/0a816177-c774-4808-b5ac-b00a0899c7da, versions v1.1 and v1.2 with the
Yoyo economics), the Scale Model (https://claude.ai/artifact/2qy3TYNL6149xuT5FBZj8R), the Feature
Catalogue (https://claude.ai/artifact/N5rzSTdVVApZeYrefkMzij, fee sheet).

## 3. The components the map must cover (one row each, nothing missing)

**Money in:** PayFast card (credit/debit), Instant EFT, Capitec Pay, Apple/Google/Samsung Pay,
SnapScan, Zapper, Mukuru Cash (loss-making), with PayFast's fee per method and our deposit fee
(`depositFeeCents`); Adumo card debit/credit, Instant EFT (Ozow), Capitec Pay, with SHB's offer;
OTT voucher load (redemption cost 6% + VAT per the Merchant agreement vs the face we credit);
Blu voucher load (cost per the Blu terms; today the Blu load keeps 6% so R100 credits R94).

**Money out:** PayShap, RTC, ABSA CashSend (bands R18 / R23 / R30), Nedbank cardless, FNB
eWallet (unpriced by OTT), Pay@ (R14), with OTT's cost, our fee, the margin and the
competitor price (Absa R16, FNB R11, Capitec R10, Shoprite R9.99, bank PayShap R0 to R2).

**Vending:** airtime, data, electricity (Blu: commission we earn, in `FEES.commissionBps`;
what the customer pays: face, no WaPay fee); OTT voucher self-purchase and gifts (4% + VAT
commission on face per the Reseller agreement, 0 bps in code until signed in writing; the
R3 gift service fee); fuel and retail wiCodes (Yoyo 2.5% + R0.20 SMS + R15,000 retainer;
the 5% convenience fee discussed; break-even ≈ 1,220 × R500 vouchers a month); the four
categories asked of Blu (lifestyle, bill pay, gaming, remittance) as rows with status UNKNOWN.

**Getting paid (Please Pay Me):** receiver fee per rail (PayFast R2.30 + 4.20%, Adumo R1 +
2.5%), free under R50, the taper, WaPay-to-WaPay payer free; business pay links the same.

**Sending:** WaPay-to-WaPay free; voucher gift R3; the planned P2P fee decisions.

**Business:** the Payouts tab (same methods), any subscription or per-link fee decision.

For every row: counterparty · our cost ex VAT · our cost incl the VAT we cannot recover ·
what the customer pays · who pays (payer, receiver, customer, WaPay) · margin at the five
reference amounts · status · source · decision owner · open question.

## 4. Rules

Every number cites a source; a number without one is ASSUMED and says so. Do not change any
fee in code; where the code and a document disagree, the code is "what is charged today" and
the document is the proposal, and the disagreement becomes a sign-off question. No card
surcharging anywhere in a recommendation (PayFast T&C 5.3, SARB/PASA/schemes). Never promise
dates. No em dashes in anything the founder will send. Stage by path, coordinate with the two
live sibling threads before committing anything they own (`ListAgents`, `SendMessage`), run
`pnpm test` before every push (your consistency test included), `pnpm build` is not needed
for docs-only pushes but never run it while another thread's dev server or harness is up.
Keep `WAPAY_STATUS.md` current (bump its version) and add a dated delta at the top of
`WAPAY_BUILD_TRACKER.md` when you stop.
