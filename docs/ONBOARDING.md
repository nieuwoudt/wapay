# WhatsApp sign-up (onboarding), the business question, and the OTP decision

*Written 2026-09-06 from the founder's ask: "build the sign-up flow from the WhatsApp angle end to end; when a business signs up we just ask one question; and should the OTP step stay?" Code: `packages/auth/src/onboarding.ts` (state machine), `pages/api/webhooks/message-processor-v2.js` (`handleOnboardingFlow`, the S4 hook, the `BIZ_SIGNUP_*` states), `lib/business-chat.js` (the business questions).*

## 1. The flow as it runs today (S0 → S5)

| State | What the customer sees | What moves it on |
|---|---|---|
| `S0_INITIAL` | first message → welcome template `onboarding_step_1` (text fallback) | automatic → `S1` |
| `S1_WELCOME_SENT` | any reply → a 6-digit code, template `otp_register_step_2` (text fallback), sent to the **same WhatsApp number** | code sent → `S2` (or straight to `S3` when `WAPAY_ONBOARDING_OTP=off`, §4) |
| `S2_OTP_SENT` | "enter the code" ("resend" allowed, 5-minute rate limit) | correct code → PIN prompt template `onboarding_step_3_pin_creation` → `S3` |
| `S3_OTP_VERIFIED` | "create a 4–6 digit PIN" (not 0000 / 1234) | PIN stored (argon2id) → consent template `consent_terms_` → `S4` |
| `S4_PIN_SET` | "reply I accept" | consents recorded (T&C v1.0, privacy v1.0) → activation template `welcome_new_user_account_activation` → `S5`, audit `ONBOARDING_COMPLETED` |
| `S5_COMPLETED` | **2026-09-06 to 2026-10-19:** "is this WaPay account for you, or for a business? Reply 1 or 2". **Off since 2026-10-19 (CHANGELOG 96):** onboarding ends here; the question is asked only when `WAPAY_ONBOARDING_BUSINESS_QUESTION=ask` | see §2 |

Everything a money flow needs (PIN, consent, limits) exists at `S5`. The account row is keyed by the WhatsApp id (`waId`), the wallet is the account's SPEND wallet.

## 2. The business question (the only difference for a business)

There is **no separate business onboarding**. A business is the same wallet with a `businesses` row (`docs/BUSINESS_PORTAL.md`): same PIN, same limits, same payment rails, and WaPay cannot tell (nor needs to) whether the number runs the WhatsApp Business app or the personal one.

**Off by default since 2026-10-19** (founder, the POC: no business sign-up from onboarding; `WAPAY_ONBOARDING_BUSINESS_QUESTION=ask` restores it; "on" does not, CHANGELOG 98). When on, right after `S5` the bot asks once: *"is this account for you, or for a business? 1 / 2"* (state `BIZ_SIGNUP_TYPE`). While off, the only door is the typed command below, which stays behind the invite gate, so no uninvited account can become a business.

- **1 / personal / cancel / anything unclear twice** → "Personal it is", state cleared, and a one-line hint that *business account* adds a business later. Nobody is ever stuck on the question.
- **2 / business / "it's for my spaza shop"** → the invite gate from the portal applies (`mayRegister`: `WAPAY_BUSINESS_MSISDNS` or `WAPAY_BUSINESS_SIGNUPS=open`). Not invited while the pilot is closed → an honest waitlist answer, `profile.businessInterestAt` recorded, nothing created. Invited → *"what is your business's trading name?"* (state `BIZ_SIGNUP_NAME`).
- **The name** goes through the same `validateBusinessName` as the portal (2–60 chars, no bank / network / WaPay / SARS impersonation), then `createBusiness` (one per account; a race adopts the winner). Category and a password are **never** asked in chat (a password typed into WhatsApp sits in the chat history): both live in the portal's Settings.
- **Done:** "*Name* is now a WaPay business" + the portal URL + *WhatsApp me `business login` for the sign-in code*. That message is sent verbatim (never localised) because it carries a command and a URL.

**Existing wallets** get the same two-step flow from the command **`business account`** (also "register my business", "I'm a business", "wapay for business", "open a business account"). Already registered → the business is named and the portal explained. The help menu lists the command. Mid-flow, a clearly different intent ("buy airtime") escapes the flow like every other flow ("switching over").

Founder's own test (an existing wallet on the invite list): WhatsApp **`business account`** → the trading name → done → **`business login`** → type the code at `business.wapay.co.za`.

Guards: `tests/business-chat.test.mjs` (matcher, both questions, the invite gate, the race, the processor wiring), plus the live scenario in `pnpm qa:chat`.

## 3. Business vs personal accounts: what is stored

| | Personal | Business |
|---|---|---|
| `accounts` row, wallet, PIN, consents | yes | yes (the owner's) |
| `businesses` row (name, category, optional portal password, settings) | no | yes |
| Chat "please pay me R150" links | personal (`businessId` null) | still personal; business links are minted in the portal |
| Portal sign-in | not applicable | `business login` in chat → code → `business.wapay.co.za` |
| Caps | personal request caps | business caps counted separately (250 open / 300 per day) |

## 4. The OTP step: recommendation and the flag

**Recommendation: remove the OTP from the WhatsApp sign-up.** Keep every other step. Reasons:

1. **It verifies nothing the channel has not already verified.** The message arrives from a WhatsApp account that Meta verified by SMS when it was registered, through a webhook whose HMAC signature WaPay checks before reading it. Sending a code to that *same* WhatsApp number and reading it back from that *same* chat only proves the phone can receive what it can already send. An OTP earns its keep when the channel differs: a browser signing in to the business portal or the admin console (the code arrives in chat, the sign-in happens on a computer). Those stay.
2. **It does not protect against the risks people assume it does.** A recycled SIM (the number changes hands and the new holder re-registers WhatsApp) would receive the OTP too. What protects the wallet in that case is the PIN, which stays. A stolen unlocked phone receives the OTP as well.
3. **It is the most fragile step in the funnel.** Authentication templates are approved per WABA and have failed before (BUGLOG #33), the resend logic, the 5-minute rate limit and the "invalid code" loop all sit at the moment a new customer is least invested, and every template send is paid for.
4. **The stored code is plaintext.** `otp_codes.code` holds the customer's code unhashed (the admin and business codes are hashed). Removing the step removes that exposure; if the step is ever kept, hash it.

What the flag does: `WAPAY_ONBOARDING_OTP=off` (also `false`, `0`, `no`, `skip`) makes `S1` send the PIN prompt and move straight to `S3`, with the transition audited as `otpSkipped: true`. Accounts already waiting in `S2` still verify normally. Unset, or any other value (including `true`), keeps today's behaviour, so nothing changes until the founder flips it and redeploys. To see what the live deployment actually reads: `GET https://business.wapay.co.za/api/business/auth` with the `x-internal-api-key` header returns `signups.onboardingOtp` (`on`/`off`) and the raw value.

Two things to settle before flipping: the NPS / e-money legal opinion (does anyone expect "mobile number verification" beyond WhatsApp's own SMS verification? the answer is usually no, but ask), and the PIN-reset flow (`initiatePINReset` also sends an OTP into the same chat, which means whoever holds the phone can reset the PIN; that flow deserves a stronger second factor, such as the ID number once KYC exists, and is a separate piece of work).

## 5. One-step sign-up, the PIN on demand, the payer's reply, and the funnel (2026-10-22)

*Brief: `docs/briefs/ONE_STEP_ONBOARDING_BRIEF.md` (founder, 2026-10-22). Of 739 ad arrivals since 18 October,
177 never answered the welcome, 79 stopped at the PIN step and 32 at the consent step. Three switches, all
OFF by default; with all of them unset the chat behaves and reads exactly as before. The funnel (D) is always on.
Founder's end-to-end test: `docs/testing/one-step-onboarding-2026-10-22.md`.*

### The switches

Each reads `on` (also `true`, `1`, `yes`, `all`) for everyone, or a comma-separated list of numbers for those
numbers only, in any spelling (`27…`, `0…`, `+27 82 …`; matched on `normaliseMsisdn`, the pilot-list lesson
of 2026-09-18). Unset, empty or `off` is nobody. Read at call time; a change in Vercel takes effect with the next deployment (Redeploy).
Code: `lib/onboarding-flags.js`. `GET /api/internal/flags` shows each as `{ everyone, listed }`, never a number.

| Variable | What it does |
|---|---|
| `WAPAY_ONBOARDING_ONE_STEP` (A) | The first message from a number with no finished account opens it: no welcome template, no code, no name step, no PIN, no "I accept". |
| `WAPAY_PIN_ON_DEMAND` (B) | No PIN at sign-up (the classic flow skips its PIN step too); the PIN is chosen the first time money leaves. |
| `WAPAY_PAYER_PREREGISTER` (C) | A card payer's number gets an `S0_INITIAL` account at the receipt; their first message or their tap on **My receipt** opens it with the receipt on top. |
| `WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2` (C) | The approved v2 receipt template's name (`docs/templates/wapay_payment_receipt_v2.md`). Used only for payers C covers; unset, the current `wapay_payment_receipt` goes as before. |

To turn A, B and C on for one number: `WAPAY_ONBOARDING_ONE_STEP=27XXXXXXXXX`, `WAPAY_PIN_ON_DEMAND=27XXXXXXXXX`,
`WAPAY_PAYER_PREREGISTER=27XXXXXXXXX` in Vercel (Production), then redeploy. For everyone: `on`. To go back: unset and redeploy.

### A. One-step sign-up

The first message (any text, a tapped ad question, an invite code, a receipt ask) gets ONE message, built by
`oneStepSignupTurn` in the processor and `composeOneStepMessage` in `lib/one-step-signup.js`:

1. a lead when there is one: who invited them ("Thandi invited you to WaPay 💚"), or the payer's receipt (C);
2. the body: for an ad arrival the answer to what they tapped and the first-link question ("You're all set,
   Thandi. Let's get you paid. Who owes you, and how much? Type the amount and their name.", `adOpenedReply`
   in `lib/ad-flow.js`, then the `AD_FIRST_LINK` step as before); for anyone else the home card, opening
   "🎉 Welcome to WaPay, Thandi! Your account is open.";
3. the terms line, verbatim: "By using WaPay you agree to our Terms & Privacy Policy: https://wapay.co.za/legal/terms".

No template, no buttons, no model call. The name is the WhatsApp profile name (a "Friend" placeholder on a
pre-registered payer is replaced by it). "stop" as a first message opens nothing: the opt-out is recorded and said once.

**Consent by continuing, with evidence.** The message is sent first; only when WhatsApp accepted it does
`completeOneStepOnboarding` (`packages/auth/src/onboarding.ts`) open the account, in one transaction:
`S5_COMPLETED`; two consent rows (`TERMS_AND_CONDITIONS`, `PRIVACY_POLICY`, granted, `v1.0`, with
`userAgent = "IMPLIED_BY_USE wa:<inbound message id>"` because the consents table has no note column, and
`grantedAt`); one audit row `CONSENT_IMPLIED` (the inbound message id in `waMessageId`; method, versions,
URL, the outbound notice's message id, the consent ids and the time in `metadata`); `STATE_TRANSITION` and
`ONBOARDING_COMPLETED` audit rows; the profile stamp below. A notice that did not go out opens nothing (the
next message tries again); a failed consent write rolls everything back; a replay finds S5 and writes nothing.

**Accounts already in S1 to S4** when A covers their number: their next message completes them the same way
(consent implied, PIN deferred; an S4 account keeps the PIN it set).

### B. The PIN on demand

A PIN is needed only to move money out: a pay-out, a send to another person, paying someone's link from the
balance (and, while their switches are on, the purchases), and to log in to the web portal. Getting paid,
making links, the balance and the transactions never ask.

- **Where it is asked** (`lib/pin-setup.js`, `pinSetupGate` in the processor): at the moment the flow would
  say "enter your PIN" (`PAYOUT_PIN` in `deliverPayoutStep`, `VOUCHER_GIFT_PIN` for a send, `PAYREQ_PIN`),
  when the account has none: "🔐 Choose a 4-digit PIN to protect your pay-outs…". Typed twice, and only a
  PIN on its own counts, as at every PIN step: "2580 please" or "send R2000 to 083…" is asked again and never
  routed or sent to a model; a real sentence without a PIN-length number leaves the setup, and when a pay-out or
  send was waiting the answer starts "No problem, switching over. No PIN was set and nothing left your balance."
  The classic sign-up stamps `pinDeferred` the moment it skips the PIN step. Any other
  wallet-PIN step reached without a PIN does the same when a PIN (or "forgot PIN") is typed there.
  "PIN", "set my PIN" or "forgot PIN" from an account without one starts it on its own (the web sends people here).
- **Then the interrupted step carries on in the same turn**: the step waits at its PIN prompt and runs with
  the PIN just typed, so its own `verifyPIN` issues the proof as always (golden thread 2.1). "✅ Your WaPay PIN
  is set." rides on top of that step's reply (`withLeadLine` in `lib/say.js`): one message.
- **Stores**: only `setPIN` (the store `handleS3OtpVerified` writes); only for an account that still has
  none (this flow creates a PIN, it never replaces one; that is the reset's job, with its checks); between
  the two messages only a keyed HMAC sits in the conversation data. The pay-out's own data waits at the top
  level of the setup state, so its account and ID numbers stay sealed (`lib/flow-seal.js`). States
  `PIN_SETUP_NEW` and `PIN_SETUP_CONFIRM`; their digits are hidden in memory and never logged.
- **Asked once**: the gate opens only while the account has no PIN. It applies when B covers the number,
  or when the account finished sign-up without one (`profile.onboarding.pinDeferred`, which the one-step
  sign-up of A and C and the classic sign-up under B stamp), so switching a flag off never strands an
  account at a PIN prompt. A or C alone change nothing for an account they did not open.
- **The classic sign-up under B**: after the welcome and the code (or straight away when
  `WAPAY_ONBOARDING_OTP=off`) comes the consent step, which says "You choose your WaPay PIN later, the first
  time you pay out or send money." An account already waiting at the PIN step keeps a PIN it types, and
  moves on without one otherwise.
- **The web portal** (`lib/app-login.js`): while a switch that opens accounts without a PIN covers the typed
  number, every failed login carries "Set your WaPay PIN in the WhatsApp chat first (say *PIN*), then log in
  here." The same words for an unknown number, a wrong PIN and no PIN, so the form still never tells who is
  on WaPay. A first PIN is never set on the web: the reset-by-ID refuses an account with no PIN (the unknown
  number's answer).
- **What the model is told**: `PIN_ON_DEMAND_RULE` in `packages/ai/src/prompt.ts` and the registry's PIN line
  (`lib/capabilities.js`) say the PIN is set when they first pay out or send, never at sign-up, only while
  the switch covers the customer.

### C. Payer pre-registration and the receipt reply

- When a link is paid by card with the payer's number (`deliverRequestPaidNotifications`), and that number
  has no account: an `S0_INITIAL` record with `profile.origin = { kind: 'PAYER', requestCode, paidAt }`, the
  loop's paylink attribution (requester as referrer) and a zero SPEND wallet (`lib/payer-preregister.js`).
  POPIA: the number was given for the receipt; it is used for nothing else until they write. No message
  beyond the receipt they already get. A pre-registered payer is not a contact on the Growth tab until they write.
- Their first message, on any path, starts the account (`markPayerStarted`): `createdAt` moves to that moment
  and `profile.onboarding.startedAt` is stamped, so the new-account pay-out cap, the funnel and the Growth tab
  count from when they joined, never from the receipt (a number cannot be aged by paying a link and waiting);
  `profile.origin.paidAt` keeps the receipt's time.
- The receipt: free text inside their window as before; outside it, the v2 template when its name is set and
  C covers the payer, else the current template. The **My receipt** tap arrives as a button reply whose
  payload is `WAPAY_RECEIPT:<code>`; the webhook hands that over as the turn's text.
- Their tap, or any first message: the one-step sign-up (A) with the receipt on top ("🧾 You paid R250 to
  Thandi on 22 Oct, reference PF … · PR…."), the home card and the terms line. "You paid" and the PayFast
  reference only to the number that paid; anyone else holding the code reads "Receipt: R250 paid to Thandi…".
  A member who taps gets the receipt alone.

### D. The funnel (always on)

- Every account created from now on carries `profile.onboarding = { path: 'ONE_STEP' | 'CLASSIC', startedAt }`
  (`getOrCreateUser`); older accounts read CLASSIC. One-step completion adds `completedAt`, `completedVia`,
  `consent`, `termsVersion`, `pinDeferred`, `via`.
- `GET /api/internal/funnel?since=YYYY-MM-DD&until=YYYY-MM-DD` (internal key; both days included; default the
  last 14 days): per UTC day and path, accounts opened, finished sign-up, finished within 10 minutes, a first
  link within 24 hours, a first link paid within 72 hours, a pay-out within 72 hours (handed to the rail and
  not failed), the rates over accounts opened, whether the one-step switch was on that day, which windows
  are still filling, and a `summary`. Counts and rates only. Definitions: `lib/signup-funnel.js`.
- Mission Control, Growth tab: the "Sign-up funnel" card (`/api/admin/signup-funnel`, the tab's range).
- The nightly conversation audit's summary carries one line: "Sign-up <yesterday>: one-step X of Y finished (Z%); classic …".

### Not built

- Editing the name in chat ("editable later via settings"): the chat has no settings command yet; the name
  is the WhatsApp profile name, as in the classic flow.
- Holding a pending pay-out across a PIN setup that runs past the 30-minute idle limit: it expires like any
  step and the customer starts the pay-out again (the KYC hold of `lib/kyc-resume.js` is for checks that take hours).
  A send's quote lives 5 minutes (`/api/wallet/send/preview`): a customer who takes longer to choose the PIN gets
  "Your WaPay PIN is set" with "That send did not go through", and sends again with the new PIN.
- Two quick first messages from a new number can each get the welcome (no per-number lock, as in the classic flow).
