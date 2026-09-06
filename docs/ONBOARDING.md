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
| `S5_COMPLETED` | **new 2026-09-06:** "is this WaPay account for you, or for a business? Reply 1 or 2" | see §2 |

Everything a money flow needs (PIN, consent, limits) exists at `S5`. The account row is keyed by the WhatsApp id (`waId`), the wallet is the account's SPEND wallet.

## 2. The business question (the only difference for a business)

There is **no separate business onboarding**. A business is the same wallet with a `businesses` row (`docs/BUSINESS_PORTAL.md`): same PIN, same limits, same payment rails, and WaPay cannot tell (nor needs to) whether the number runs the WhatsApp Business app or the personal one.

Right after `S5` the bot asks once: *"is this account for you, or for a business? 1 / 2"* (state `BIZ_SIGNUP_TYPE`).

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
