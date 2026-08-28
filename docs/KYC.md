# WaPay — KYC / FICA Position & Provider Shortlist

*Written 2026-08-28. The model below is the LOCKED founder decision (2026-08-10, reaffirmed
2026-08-28 in the Keamo reply); the provider ranking is current as of this date — re-verify
pricing and self-serve availability before signing anything.*

---

## 1. The tiered KYC model (what we tell partners, because it is true)

The exact text sent to OTT lives at repo root: `EMAIL_TO_KEAMO_7_KYC.txt`.

| Tier | Trigger | What we verify | Status |
|---|---|---|---|
| **Identify** | Onboarding | Cellphone number, OTP-verified on WhatsApp. One number, one account. | **Live** |
| **Nothing further** | Buying a product (OTT voucher, airtime, data, electricity) | — (same risk class as a till purchase; R3,000 per-transaction caps; wallet is spend-only; no cash-out exists in the live product) | **Live** |
| **Full verification** | Money OUT (any payout / withdrawal) | SA ID number verified against Home Affairs data + liveness selfie match via an accredited provider | **Not live** — payouts launch with this enforced from day one |

**Never claim KYC-at-funding.** Deposits require only the verified number. This is deliberate:
KYC-on-withdrawal-only is both the compliance boundary and the growth wedge (locked decision,
`wapay-fee-model`). The whole design rides the NPS counsel brief before payouts go live.

---

## 2. Provider ranking — easiest to onboard + easiest to integrate

Ranked for OUR shape: WhatsApp-first, low-value mass market, verification collected on a web
page at the withdrawal gate (never inside chat), pay-per-check economics, no enterprise
sales cycle.

| # | Provider | Onboarding ease | Integration ease | Cost signal | Notes |
|---|---|---|---|---|---|
| **1** | **Smile ID** (smile.id) | ★★★★★ self-serve portal, sandbox, pay-as-you-go — start same day | ★★★★★ REST API + hosted web/mobile SDK (SmartSelfie liveness), explicit SA ID + doc coverage, good docs | Pay-as-you-go, startup tier | The pan-African default. First pick for the full check (ID + liveness). 99.8% claimed face-match accuracy across skin tones. |
| **2** | **Didit** (didit.me) | ★★★★★ self-serve, transparent pricing | ★★★★☆ hosted verification link (send a URL — perfect fit for a WhatsApp product) | ~$0.33 per full KYC (their SA page) | Cross-checks Smart ID card / ID book / passport against Home Affairs. Cheapest credible full-KYC quote seen; less African track record than Smile ID — pilot both. |
| **3** | **VerifyNow** (verifynow.co.za) | ★★★★☆ SA-local, buy credits online | ★★★☆☆ lookup-style API + white-label; less an orchestration platform | Home Affairs **photo match ~R29.90** retail (10 credits); cheaper in bulk | Ideal as the cheap **tier-1 data check** (ID number → DHA match, AML/PEP, CIPC) in front of a biometric step. |
| **4** | **Sumsub** | ★★★☆☆ self-serve trial, volume pushes to sales | ★★★★★ best-in-class docs, SDKs, hosted flows | ~$1+/check | Global-grade orchestration; more platform than we need at this stage. |
| **5** | **iiDENTIFii** | ★★☆☆☆ enterprise sales cycle | ★★★★☆ bank-grade liveness (FirstRand et al.) | Enterprise | The upgrade path if volumes/banks demand it — not the starting point. |

**Recommended stack:** VerifyNow (or Didit's data check) as the cheap ID-number-to-Home-Affairs
gate, **Smile ID** for the liveness/selfie match, orchestrated by us on the withdrawal web page.
Pilot Didit head-to-head with Smile ID on price + pass-rate before committing volume.

> **FOUNDER DECISION 2026-08-28: Didit is the v1 provider.** Integration hangs off the
> customer profile: KYC status lives in `Account.profile.kyc` ({status, provider, verifiedAt,
> sessionId}), shown in the admin console's customer view (already wired, reads
> NOT_VERIFIED/PENDING/VERIFIED). Build = Didit hosted-verification link sent to the customer
> at the withdrawal gate + webhook writing the result into profile.kyc. Keep Smile ID as the
> benchmarked fallback if Didit's SA pass-rate disappoints.

**The number that decides the vendor: PASS RATE.** Remote ID checks pass 40–60% in this
market (playbook, stress-tested benchmarks). A failed check at the exact moment someone asks
for their own money is the worst possible support case. Whatever we pick must expose failure
reasons and support a retry/fallback path (e.g. retail assisted verification later).

Sources (checked 2026-08-28): smile.id SA document-verification blog · verifynow.co.za
pricing page · didit.me/solutions/countries/south-africa · korahq.com KYC-providers roundup.

---

## 3. Open items

- OTT's own KYC requirements list — asked in EMAIL_TO_KEAMO_4, re-nudged in #7. Align
  thresholds with theirs before payout launch.
- Counsel: the tiered model + withdrawal gate sit inside the NPS opinion brief.
- Build: verification page lives on the web (pleasepayme.co.za or wapay.co.za), never in
  chat; result stored as an account attribute; `buildCashout` paths must hard-require it.
