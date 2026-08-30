# Where Yoyo wiCode vouchers work — the transparent picture

*Compiled 2026-08-30 from the primary documents on file (Yoyo Retail Footprint,
July 2025 + the Agreed Gift Card Rebates sheet, both in the iCloud `WaPay /WiGroup /`
folder) and Yoyo's own emails on fuel (July 2026, in the UniFuel repo
`docs/yoyo-production-status.md`). This file is the honest reference for what we
may claim, what earns money, and what still needs Yoyo's confirmation. The LIVE
issuable catalogue at any moment is data, not this document:
`GET /api/partner/wapay/catalog` on UniFuel returns what can actually be issued
today, and `lib/spend-catalogue.js` is what the bot is allowed to say.*

## Fuel (what v1.3 built end-to-end)

| Partner | POS | Redeem where | Status |
|---|---|---|---|
| Shell | Figment | Pump AND convenience store | ~85% of stations — say "participating stations", never "any Shell" |
| Engen | Winbranch | Forecourt till only (fuel) | Onboarded |
| TotalEnergies | Payment24 | — | **NOT onboarded** (POS transition) — never advertised |

Current pipeline status: issuance proven end-to-end on the Yoyo TEST environment
(campaign 54211). **Test wiCodes do not redeem at real pumps.** Production needs
Yoyo's QA sign-off + Dean's verification + per-brand production campaign IDs
(~R15k/month once live).

## Retail (the wider Yoyo outlet network — provisioned, not yet issuable)

Per the July 2025 footprint, the wiCode-accepting network includes roughly:

- **Grocery (~3,700 stores):** Pick n Pay (768 + Express 206 + Clothing 332 +
  Liquor 13), Shoprite (553 + Usave 476 + Liquor), Checkers (249 + Hyper 40 +
  Liquor 212), Boxer (315). **Spar is NOT on the network** — never name it.
- **Fast food (where the ~5% rebates live):** KFC 1,184, Debonairs 730,
  Steers 723, Wimpy 469, Mugg & Bean 289, Fishaways 260, Vida e Caffè 260,
  Milky Lane 112. Lower tiers: Burger King/Hungry Lion/Dis-Chem ~3%,
  Spur/Panarottis 2.5%, Krispy Kreme 2%, Nando's/iStore 1.5%.
- **Other:** Cape Union Mart group, Toys R Us, Netflorist, Loot, Cellucity,
  petro-convenience (Engen 696, Total Convenience 472), Takealot/Showmax
  (API-only). ~30 POS systems integrated (GAAP, Micros, Yoco, Winbranch, …).

**Money reality:** the rebate sheet has NO agreed rebate for any grocery
retailer — grocery is the marketing story, fast food is the margin. Negotiate
grocery rebates before pushing grocery volume.

**Claim discipline (standing rule):** none of the retail list above may be
advertised to customers until the redeemable catalogue is confirmed with Yoyo
for OUR campaigns — the footprint doc describes the network, not our
entitlement. That is why `lib/spend-catalogue.js` ships with `retail:[]`
advertised; entries get added (env-JSON or code) only as Yoyo enables each
brand campaign. UniFuel's issue endpoint refuses `productType: RETAIL` with
`NO_PRODUCT` until retail campaign products exist in its catalogue.

## What "buying into the ecosystem" activates, mechanically

Per outlet-brand, going live = Yoyo enables a **campaign** for that brand →
UniFuel adds a product row (partner, campaign id, bounds) → it appears in
`/api/partner/wapay/catalog` → WaPay's brain and menus pick it up as data.
No WaPay build is needed per merchant; fuel is simply the first campaign wired.

## Known unknowns to close with Yoyo (next email)

1. Confirmation of OUR redeemable brand list + per-brand campaign IDs.
2. Shell coverage discrepancy: the July 2025 footprint lists no Shell while
   Yoyo's 2026 fuel emails say ~85% via Figment — get the current number.
3. Grocery rebate negotiation (nothing agreed today).
4. Callback authentication for redemption webhooks (currently unsigned).
5. Partial-redemption UX per brand (a partial kills the code; regeneration is
   automated in our pipeline, but per-till behaviour differs by POS).
