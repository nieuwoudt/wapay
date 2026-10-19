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
1. The token is the WaPay Growth token already in `META_ADS_ACCESS_TOKEN` (ads_read +
   whatsapp_business_manage_events). Nobody handles it again: the code uses it unless a
   separate `META_CAPI_ACCESS_TOKEN` is set, and never the bot's messaging token.
2. Create the dataset from the server so the token never leaves Vercel:
   `POST /api/internal/capi-dataset` with the internal key (production only). It reads
   `/{WABA}/dataset` first and creates one only when none is linked; Meta's create is
   idempotent. The response carries the dataset id.
3. Vercel Production: `META_CAPI_DATASET_ID` = that id. Redeploy. The Growth tab's
   Conversions API chip reads "on" with nothing sent yet.
4. Prove the pipe before any spend: `POST /api/internal/capi-test-send` (internal key,
   production only) with `{ "testEventCode": "TEST…" }` from Events Manager → Test events
   in the body (option B, 2026-10-15: no env change, no redeploys; `META_CAPI_TEST_EVENT_CODE`
   still works as a default). It pushes ONE synthetic LeadSubmitted through the real
   sender with that code attached, returns Meta's full response redacted, refuses to run
   without a code, never logs or stores the code, and never touches a customer record.
5. In Ads Manager, set the campaign's conversion location to WhatsApp and its
   optimisation event to **Purchase** (the event the doc says delivery can optimise on
   for WhatsApp; Instagram placements stay measurement-only).

**C. Attribution needs nothing from the founder**: it is live from this deploy for every
click-to-WhatsApp ad. Ads that go through the pleasepayme.co.za landing page first are
NOT attributed (the wa.me hand-off carries no click id); use Click-to-WhatsApp as the
primary ad set, as the campaign brief says.

## 4b. Checking the pipes without touching Meta (2026-10-12)

`GET /api/internal/ads-pipe-check` (internal key, GET only) runs the whole check
server-side with the production environment, so the token never leaves Vercel: env
presence and whitespace, the account id as parsed, `/me` + `/me/permissions` +
`/debug_token` for the token's identity, the ad account (name, currency, timezone,
status), the exact insights and catalogue requests the Refresh button makes (HTTP
status and row count), the WhatsApp account the Conversions API would name (from
`META_WHATSAPP_BUSINESS_ACCOUNT_ID`, plus any `?waba=<id>` you pass) and whether a
dataset is already linked to it (a read, never a create), and both gates on sending.
Every Graph call is a GET; the whole response passes through `redactToken`.

**Two gates on the Conversions API** (`capiConfig().reason`): `CREDENTIALS_MISSING`
until `META_CAPI_DATASET_ID` is set (the token is `META_CAPI_ACCESS_TOKEN`, else the Growth
token in `META_ADS_ACCESS_TOKEN`; the bot's token is never used), and `NOT_PRODUCTION` on any Vercel environment
other than production (the Growth tab shows "held: preview build"). A preview deploy
can therefore never send an event even if someone copies the envs to it;
`META_CAPI_ALLOW_NON_PRODUCTION=true` exists only for a local run against Meta's Test
Events tool.

**First production run, 2026-10-12 12:27 UTC** (`?waba=647978251504290`): token
WaPay Growth, type SYSTEM_USER, app 1344548310511460, never expires, scopes ads_read +
whatsapp_business_management + whatsapp_business_manage_events + public_profile; ad
account act_1090534783572735 "WaPay ZA", ZAR, Africa/Johannesburg, status 1; insights
and catalogue both HTTP 200 with zero rows (no ad has run); WhatsApp account
647978251504290 "WaPay" readable, no dataset linked yet; Conversions API
`CREDENTIALS_MISSING` on production. Two findings fixed the same day (CHANGELOG 78):
production names the WABA `WHATSAPP_BUSINESS_ACCOUNT_ID`, and a zero-row refresh now
records its time. Note `/me` for a System User token returns the app-scoped id
(122107590561498678), not the Business Manager id (61594960366800); the name and
`debug_token` type confirm the identity.

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


## 7. The live valuation matrix (2026-10-19)

`projectionMatrix` (`lib/scale-model.js`) runs the Scale Model five ways and the growth
route returns it as `valuation`: **plan** (the 13 September assessment), **measured inputs
under the plan budget**, **measured inputs under today's spend** (the trailing seven days of
Meta spend, held flat), **great** and **stop**. A measured input replaces its plan value only
once its sample reaches 20 (`measuredToInputs`); the matrix lists which were used and how
many still stand at plan. Each scenario carries accounts, funded, 30-day actives, net
revenue per month, both valuation frames, cumulative cash at M6, M12, M24 and M36, peak
funding and the months at which 1k, 10k, 100k and 1m accounts are reached. Model month 1 is
October 2026. `tests/valuation-matrix.test.mjs` pins the repo model to the artifact's
great case (M6: 81.6k accounts, 36.8k actives, R920k a month, R265m, R1.11m peak funding,
1m at M13), so the matrix and the artifact can never disagree.

### 7b. The plan, where we are, and where today's pace leads (2026-10-19, CHANGELOG 95)

`trajectory` (`lib/scale-model.js`) takes the actual counts the growth route reads (onboarded
accounts, funded accounts, 30-day actives, net revenue over the trailing 30 days, and the
last seven days and the seven before as accounts, funded and net revenue) and returns, with
the valuation on both plan frames at each point: **now** (with the launch day; day 1 =
18 October), **the plan to date** (the plan's month 1 pro rata by launch day), **the plan at
the horizon** (six months ahead, model month 7 = April 2027), **today's pace held flat** (the
seven-day rate × 180 days; actives = funded per month at that pace, never below today's),
**compounding** (only once the prior seven days hold 20 or more accounts, i.e. from
1 November; week-over-week growth clamped to ±50%, compounded weekly; the revenue multiple's
growth uplift applied as in `simulate`), and **the model on the measured inputs** (the same
`simulate` the matrix uses, at month 1 and the horizon). The growth route returns it as
`valuation.trajectory`; `PlanVsNow` renders it on the Dashboard and Growth tabs above the
matrix (one fetch feeds both cards). The valuation tile shows the higher of the two frames
and says when it is the floor. Nothing here is a forecast of behaviour: it is arithmetic on
the last seven days, labelled as such, next to the plan and the model.

## 8. Operator alerts (2026-10-19)

`lib/ops-alerts.js`: `opsMoneyIn` after a non-replayed card credit (PayFast ITN and Adumo
settlement) and `opsPayoutDone` after a pay-out settles. The text is aggregates only:
amount and source class, customer balances and wallets at or above R20, the live OTT
pay-out float (`lib/payout-float.js`, 60-second cache) with cover over balances and days
at the week's pay-out pace, the warn level, open links and today's pay-outs. Recipients
`WAPAY_OPS_ALERT_MSISDNS`; delivery through `notifyCustomer` (text inside the window, the
direct rail or `WAPAY_TEMPLATE_OPS_ALERT` outside it). Once per event via ProcessedMessage.

**The person alert (CHANGELOG 95).** The third-tier withdraw e-mail (`stuckAlert` in
`lib/payout-gate.js`, sent through `ALERT_EMAIL`) now has a WhatsApp twin: `opsPersonAlert`
sends the same content (account id, masked WhatsApp tail, display name, usable balance,
the smallest withdrawal, the situation lines, what to do) to `WAPAY_OPS_ALERT_MSISDNS`,
once per account and day. The chat tells the customer a person was asked when either
channel arrived. A reply to that WhatsApp reaches the bot, not the customer: answer them
from the business inbox.

**Answering a customer by hand (CHANGELOG 96).** When the person alert names an account,
reply inside the customer's own chat with the ops route, which sends through `lib/say.js`
so the chat remembers what was said:

```
curl -X POST -H "x-internal-api-key: $KEY" -H "content-type: application/json" \
  -d '{"accountId":"<account id from the alert>","text":"Hi ..., this is the WaPay team ..."}' \
  https://wapay-api.vercel.app/api/internal/ops-reply
```

Text only, one message of up to 1,500 characters, inside the customer's 24-hour window
(the route answers 409 `WINDOW_CLOSED` otherwise; `?force=1` overrides for a number known
to be reachable). It is not a bulk rail: one account per call, the account id must exist.

## 9. Payment links, the viral loop, the path, the refresh and the reply box (2026-10-19, CHANGELOG 97)

- **Links** (`links` in `/api/admin/metrics`): every `payment_requests` row, bucketed into
  created (all time and in the period), paid (from a balance when `payerRef` starts with
  `WAPAY:`, otherwise by card or EFT), open (PENDING and not expired) and lapsed. Fees at
  today's schedule (`paymentRequestFeeCents`); the margin after the card rail uses PayFast's
  credit-card cost (R2.00 + 3.2% ex VAT); the withdrawal line uses the PayShap fee from
  `cashoutFeeCents` and OTT's R2.88 incl VAT cost. Both are "if every open link" figures,
  labelled so.
- **Viral** (`viral`): accounts with `profile.acquisitionSource = 'paylink'` (stamped at
  creation when a payer's number is captured), their share of all accounts, distinct
  `referrerAccountId` senders, and `capturedPayers` (payers with no account yet).
- **The path** (`PathChart`, both tabs): the cumulative account series is anchored on today's
  total and walked back through the growth route's `daily.onboarded`, so it is exact for any
  window; the projection carries the seven-day pace forward (`trajectory.perDay`), the
  compounding line appears with `weeklyGrowth`, the ring is the plan at the horizon. Log scale.
  **The valuation path** (`ValuationPath`) runs the plan's `simulate` in the browser (the same
  model library the matrix uses) and draws today's pace held flat beside it.
- **Refresh:** `REFRESH_MS` (ten minutes) re-reads metrics and growth on both tabs; the Growth
  read passes `refresh=1`, which the route throttles to one Meta read per ten minutes.
- **Reply box** (`ReplyBox`, customer profile): `POST /api/admin/ops-reply { accountId, text }`
  with the admin session (the internal key also works), one text of up to 1,500 characters
  inside the customer's 24-hour window, sent through `lib/say.js`.
- **Flags** (`GET /api/internal/flags`, internal key): commit, business question, launch hold,
  every switch, fuel, withdrawals, ops-alert recipient count, business invites. Use it to
  verify a Vercel env change after the redeploy.
