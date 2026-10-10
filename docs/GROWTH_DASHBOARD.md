# Growth: the Scale Model, measured

*Brief and build record, 2026-10-10. The founder's ask: "set up the Facebook campaign to
plug in and give a live feed of account openings and click-throughs, link it to the
project's system, and make the Scale Model dashboards live." This document is the
brief, what was built, how the numbers are defined, and what the founder has to switch
on. Companion: the Scale Model artifact (planning model, great / plan / stop bounds)
at https://claude.ai/artifact/2qy3TYNL6149xuT5FBZj8R, whose model now also lives in
`lib/scale-model.js`.*

## 1. What it is

Mission Control gained a third tab, **Growth**. It answers, from live data, the
questions the planning model only assumed: what a started conversation costs, how many
conversations become accounts, how many accounts create a link and get paid, how many
stay active, what each active person earns and costs in messages, and how big the loop
is. Every one of the Scale Model's inputs is shown with its measured value, its sample
size and a chip saying whether it sits at the great, plan or stop bound. One link opens
the Scale Model artifact with the measured values in place of the assumed ones.

Three pipes feed it:

| Pipe | Direction | What it carries | On when |
|---|---|---|---|
| **Attribution** | Meta → WaPay | The click-to-WhatsApp `referral` on the first message after an ad click (ad id, click id, headline), stamped on the account at creation | Always, since this build |
| **Marketing API** | Meta → WaPay | Spend, impressions, clicks, "messaging conversations started" per ad per day, plus the ad catalogue | `META_ADS_ACCESS_TOKEN` + `META_AD_ACCOUNT_ID` |
| **Conversions API** | WaPay → Meta | `LeadSubmitted` (onboarding complete), `QualifiedLead` (first link), `Purchase` (first money in, with value), so delivery optimises for funded accounts | `META_CAPI_DATASET_ID` (+ a token with the events permission) |

Without the two Meta envs the tab still works on WaPay's own data: the funnel per
source, accounts per ad (from the click id), the loop, cohorts and messages.

## 2. Definitions (build-binding)

- **Contact**: a number that ever messaged. The `Account` row is created at first
  contact, so it is NOT an account.
- **Account**: onboarding complete (`onboardingState = S5_COMPLETED`: OTP, PIN, consent).
  The Dashboard tab's "Accounts" tile and funnel now use this too (BUGLOG #99).
  Onboarding time = the first consent row (every completion passes `recordConsent`).
- **Activated**: created a first payment link (`payment_requests.accountId`).
- **Funded**: first credit posting into the person's wallet (same rule as the Dashboard).
- **Active**: a money event (any journal line on their wallet) in the last 30 days.
- **Source**: `organic` | `paylink` (number captured as a card payer before onboarding,
  with the requester remembered as `referrerAccountId`) | `ad` (ad referral) | `partner`
  (reserved). Ad wins over pay-link.
- **Conversations started**: Meta's `onsite_conversion.messaging_conversation_started_7d`.
- **Cost per conversation / account / funded**: spend ÷ that count, same window.
- **Funnel hops** (onboarded → first link, first link → paid, self-load) are judged on a
  MATURE cohort: accounts opened 14 to 44 days ago, so everyone had two weeks to act.
- **The loop**: K = links per active per month × paid payers per link × payer-to-account.
  Trees: ad-acquired accounts, the accounts whose first paid link was theirs (level 1),
  and theirs (level 2); tree factor = downstream per ad-acquired.
- **Replies**: `conversation_turns` with role `assistant` (what `say()` records). Template
  sends (OTP, receipts outside the window) are not in this count.
- **A measured value is used** (chip and Scale Model link) once its sample reaches 20.

## 3. What was built

| Piece | File | Notes |
|---|---|---|
| Referral capture | `pages/api/webhooks/whatsapp.js` → `message-processor-v2.js` → `user-manager.js` | `referral` passed through the turn; `newAccountProfile` computes `acquisitionSource` + `attribution` BEFORE the upsert and writes it in the same create. A late click on an unfinished account is stamped by `attachReferralIfMissing`. |
| Attribution module | `lib/growth-attribution.js` | pure builders, pay-link referrer lookup, milestones, Conversions API sync (once per event, marks in `profile.attribution.capi`, nested atomic merge), the two processor hooks, the daily sweep |
| Conversions API client | `lib/meta-capi.js` | `action_source: business_messaging`, `messaging_channel: whatsapp`, WABA id + `ctwa_clid`; ZAR value on Purchase; test-event code; 2.5 s timeout; off without a dataset id |
| Marketing API client | `lib/meta-ads.js` | `act_<id>/insights` level=ad, daily, with `actions`; `act_<id>/ads` for names and headlines; `snapshotAdInsights` upserts |
| Tables | `ad_insights_daily`, `ad_catalog` (migration `20261010_ad_insights`, applied to production before deploy) | one row per ad per day; catalogue keyed by ad id |
| Route | `pages/api/admin/growth.js` | admin-gated; aggregates only; `?range=7|30|90|all`; `?refresh=1` pulls the last 3 days from Meta at most every 10 minutes |
| Tab | `pages/admin/index.js` (`Growth`) | status chips, KPIs, two daily charts, funnel by source, per-ad table, measured inputs table, the loop, messages, cohorts |
| Cron | `pages/api/cron/daily-vas-sync.js` | best-effort `snapshotAdInsights` (3 days) + `capiSweep` (50 accounts, 15 s) |
| Model in repo | `lib/scale-model.js` | the artifact's model + `encodeScenario` (the artifact's `#s=` format) + `boundStatus` |
| Tests | `tests/growth.test.mjs`, `tests/growth-route.test.mjs` | attribution, event shape, once-only sends, parsers, encoder round-trip, 401 before query, wiring locks, betting-word ban |

Money safety: nothing here touches the ledger. Every growth write is best-effort and
bounded (the Conversions API call races a 3 s timeout inside the turn); a Meta outage
cannot slow or fail a customer's message.

## 4. Founder actions to switch the two Meta pipes on

**A. Marketing API (reads spend and conversations)**
1. Meta Business Suite → Business settings → Users → **System users** → add a system
   user (name it `wapay-growth`, role Employee).
2. Add assets to it: the **ad account** (Manage campaigns is more than needed; View
   performance is enough) and the **WhatsApp account**.
3. Generate a token for the app WaPay already uses for WhatsApp, with
   `ads_read` (and `business_management` if the dataset step below is hidden). Set
   expiry to never. Copy it once.
4. Vercel → Environment variables: `META_ADS_ACCESS_TOKEN` = that token,
   `META_AD_ACCOUNT_ID` = the ad account id (digits; `act_` optional). Redeploy.
5. Open Mission Control → Growth → **Refresh ad numbers**. Spend per ad appears within a
   minute; history accrues nightly from then on.

**B. Conversions API (sends funded accounts back to Meta)**
1. Events Manager → the dataset linked to the WhatsApp Business Account (Meta creates one
   per WABA; if none shows, the Marketing API doc's `POST /{WABA_ID}/dataset` creates it).
   Copy the **dataset id**.
2. The token needs `whatsapp_business_management` and
   `whatsapp_business_manage_events`. The existing `META_WHATSAPP_TOKEN` usually has the
   first; the second is granted on the same system user in step A3. If so, no new env is
   needed for the token.
3. Vercel: `META_CAPI_DATASET_ID` = the dataset id; optionally `META_CAPI_ACCESS_TOKEN` if
   a separate token was minted; while testing, `META_CAPI_TEST_EVENT_CODE` from Events
   Manager → Test events (remove it after). Redeploy.
4. In Ads Manager, set the campaign's conversion location to WhatsApp and its
   optimisation event to **Purchase** (the event the doc says delivery can optimise on
   for WhatsApp; Instagram placements stay measurement-only).

**C. Attribution needs nothing from the founder**: it is live from this deploy for every
click-to-WhatsApp ad. Ads that go through the pleasepayme.co.za landing page first are
NOT attributed (the wa.me hand-off carries no click id); use Click-to-WhatsApp as the
primary ad set, as the campaign brief says.

## 5. How to read it in the first weeks

- Until an ad has run, every ad KPI shows a dash and the chips read "too early". The
  funnel by source and the loop read from day one.
- The first number to watch is **cost per conversation** (Meta) against **conversation
  to account** (ours). Their product is the cost per account, the plan bound is R40.
- Funnel hops fill in two weeks after the first accounts (mature-cohort rule).
- Cohort retention needs a month per column: +1 after one full month, +3 after three.
- The **Open the Scale Model with measured inputs** link rebuilds the whole 36-month
  path on what has actually happened; everything still unmeasured stays at plan.

## 6. Not in this build

- Instagram-placement attribution beyond what Meta's `referral` carries.
- Landing-page (pleasepayme.co.za) attribution: would need a code in the wa.me prefill.
- Ad spend import into the ledger (spend is reported, not booked).
- A scheduled Claude routine that reads the tab and writes a weekly note: once the
  founder wants it, the route's JSON is the input and this document is the brief.
