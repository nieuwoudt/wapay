# OTT Payout API — Integration Guide (WaPay)

*OTT's money-OUT rail: bank withdrawals via PayShap / RTC / CashSend, and OTT-Voucher payout.
Spec received from OTT 2026-08-26; client implemented in `lib/ott-payout.js`; tests in
`tests/ott-payout.test.mjs`. This is the WaPay-specific integration record — the ordering, the
money-safety mapping, the open questions, and the launch gates — not a re-paste of OTT's PDF.*

> **This is a SEPARATE product from OTT voucher ISSUING** (`@wapay/providers-ott`). Different base
> URL, different credentials, different auth. Do not mix the two credential sets.

---

## 1. Status & what's blocking go-live

| Piece | State |
|---|---|
| API client (`lib/ott-payout.js`) | ✅ built, unit-tested against OTT's two published golden vectors |
| Crypto (Basic auth + SHA-256 hash + webhook verify) | ✅ provably byte-identical to the spec |
| Money-safe status→settlement mapping | ✅ `classifyPayoutStatus` |
| Test API credentials | ⛔ **not yet generated** — do this in the test portal (§3) |
| IP allowlisting (if any) | ⛔ confirm with OTT + register our egress IP |
| Ledger wiring (reserveHold → payout → settle/hold/release) + KYC capture | ⛔ next build, once credentials let us sandbox-test |
| Customer-facing "Withdraw" flow | ⛔ **counsel gate** — cash-out ends WaPay's no-cash-out posture; legal opinion required before it goes live |

**Nothing customer-facing ships until counsel clears cash-out.** Building and sandbox-testing the
rail in parallel is fine and expected.

---

## 2. Base URLs & environments

| Env | Base URL |
|---|---|
| Test | `https://test-payoutapi.ott-mobile.com` |
| Production | `https://payoutapi.ott-mobile.com` |

Test and production are fully separate — test creds work only in test. Request production access +
credentials from OTT after sandbox testing passes.

**Env vars** (local `.env` and Vercel):

```
OTT_PAYOUT_BASE_URL=https://test-payoutapi.ott-mobile.com
OTT_PAYOUT_USERNAME=<API username>
OTT_PAYOUT_PASSWORD=<API password>
OTT_PAYOUT_API_KEY=<API key generated in the portal — shown ONCE>
# OTT_PAYOUT_BODY_ENCODING=form   # only if sandbox proves the API wants form-urlencoded (see §6)
```

---

## 3. Credentials & the portal

- Test portal: `https://test-payout-portal.ott-mobile.com`
- Login username = the email registered with OTT; set the password via the portal's reset flow
  before first login.
- The **API key is displayed only once** at generation. Store it immediately in `.env` (never in the
  repo). If lost or suspected leaked, regenerate and rotate.
- The portal is also where the **webhook URL** is configured (Administration → API Settings → Webhook).

**Auth model (three credentials):**
- HTTP **Basic auth** header = `Base64(API_USERNAME:API_PASSWORD)`.
- **SHA-256 request hash** = the API key, appended to an ordered list of parameter values (§4).

⚠️ Portal caution mirrors the issuing side: treat any "reset/regenerate key" control as destructive —
it rotates the live key. Only regenerate deliberately, then rotate the new value into every env at once.

---

## 4. Request signing (the part that must be exact)

Every call is `POST` over HTTPS (TLS 1.2+), with:
1. `Authorization: Basic <base64(username:password)>`
2. a `hashcheck` body field = `SHA-256( value1 + value2 + … + apiKey )` — **values only, no names,
   no separators, in the endpoint's documented order, API key last.**

Two golden vectors from the spec are pinned as tests, so our implementation is proven correct:
- `Base64("Aladdin:OpenSesame")` = `QWxhZGRpbjpPcGVuU2VzYW1l`
- `SHA-256("11" + "123456789012" + "ace4e782-e953-45d5-9f2a-aa1498c830ed")` =
  `9576e5e8ad6a28cd78a192aa875fa84063038481dc97a7fc87ccf7167708e2ee`

**Hash orders (from the spec), one per endpoint:**

| Endpoint | Hash value order (then `apiKey`) |
|---|---|
| GetBalance / GetActiveProviders / GetActiveProvidersLimits / GetPaymentStatus / ResendSMS / GetBranchCodes / GetCountryCodes | `requestdate`, `yourUniqueReference` |
| VerifyWH | `requestdate`, `yourUniqueReference`, `whSecret` |
| **PerformPayout** | `account_name`, `account_number`, `amount`, `bank_id`, `branch_name`, `branch_code`, `country_of_issue`, `date_of_birth`, `email`, `firstname`, `id_number`, `id_type`, `middle_name`, `mobile`, `nationality`, `providerCode`, `providerName`, `surname`, `swift_code`, `title`, `yourUniqueReference` |
| **Webhook** (inbound) | `merchantUniqueReference`, `message`, `status`, `transactionId`, `utctimestamp` |

`optionalData.*` is NOT part of the PerformPayout hash. Absent optionals are hashed as `""`.

---

## 5. Endpoints (all `POST`, path appended to the base URL)

| # | Path | Purpose |
|---|---|---|
| 1 | `/api/purchase/v1/PerformPayout` | Initiate a withdrawal to a recipient via a provider |
| 2 | `/api/purchase/v1/GetBalance` | Our payout float balance |
| 3 | `/api/purchase/v1/VerifyWH` | Server-side webhook verification helper |
| 4 | `/api/purchase/v1/GetActiveProviders` | List active payout providers + codes |
| 5 | `/api/purchase/v1/GetPaymentStatus` | Final status of a prior payout (poll fallback) |
| 6 | `/api/purchase/v1/ResendSMS` | Resend a transaction SMS (rate-limited: 1/30min, max total) |
| 7 | `/api/purchase/v1/GetBranchCodes` | Universal branch codes (required for PayShap/RTC) |
| 8 | `/api/purchase/v1/GetCountryCodes` | Country codes (passport-type payouts, e.g. FNB) |
| 9 | `/api/purchase/v1/GetActiveProvidersLimits` | Per-provider min/max + **required recipient fields** |

**Always call #9 (GetActiveProvidersLimits) first for a provider** — it returns exactly which
recipient fields that provider needs (they differ: PayShap/RTC need `branch_code`+`branch_name` from
#7; FNB may need `id_number`+`mobile`; passport payouts need `country_of_issue` from #8). Build the
PerformPayout body from that, don't hardcode.

### PerformPayout response / status codes → our action

| status | meaning | HTTP | our settlement |
|---|---|---|---|
| `100` | Payment successful | 200 | **SETTLE** the hold |
| `99` | Loaded, pending finalisation | 200 | **PENDING** — keep hold, reconcile on webhook |
| `98` | Pending transaction | 200 | **PENDING** — keep hold |
| `0` | Provider inactive / insufficient float / limit breach | 400 | RELEASE (nothing paid) |
| `-1`,`1` | Auth / logon error | 401 | RELEASE (our bug) |
| `2` | Invalid hash | 401 | RELEASE (our bug) |
| `3` | Reference not unique / add-client error | 400 | **PENDING + reconcile** (see below) |
| `4` | Invalid mobile | 400 | RELEASE (fix input) |
| `9`,`10`,`11` | Data / SA-ID validation | 400 | RELEASE (fix input) |
| `12` | Max payout / birthdate | 400 | RELEASE / contact OTT |
| `97` | Failed at provider | 400 | RELEASE |
| _other_ | unknown | — | **PENDING** (safe default — we may have paid) |
| _transport failure / timeout_ | request may be in flight | — | **PENDING + reconcile** |

`classifyPayoutStatus(status)` returns `{ outcome, settlement, retriable, reconcileRequired? }`
implementing exactly this.

### The two "looks like a failure but isn't" cases (review 2026-08-26)

Both would double-spend if treated as failures, so both are PENDING:

1. **Transport failure / timeout.** `performPayout` does **not** throw on a network error — it
   RETURNS `{ outcome: 'TRANSPORT_INDETERMINATE', settlement: 'PENDING', reconcileRequired: true }`.
   A timeout does not mean the payout didn't happen; the request may have reached OTT.
2. **Status `3` (duplicate reference).** Our `yourUniqueReference` is deterministic, so "not unique"
   means an **earlier attempt already reached OTT** and may have succeeded.

**After any `reconcileRequired` outcome: call `getPaymentStatus(reference)` — never re-issue
`performPayout`.** Only that answer (or the webhook) may settle or release the hold.

**Money-safety rule: never RELEASE a hold on PENDING.** A `98`/`99` means the payout may still
complete; only the webhook (or GetPaymentStatus) gives the final answer. Releasing early would let the
customer spend money we then also pay out.

---

## 6. Two open questions to resolve in sandbox

The spec is internally inconsistent on two points we cannot settle without live credentials. The
client handles both defensively; confirm both on the first sandbox calls.

1. **Body encoding.** "Request Requirements" says `application/x-www-form-urlencoded`, but every
   sample body is nested JSON (`recipient.*`, `provider.*`) and the webhook is JSON. We **default to
   JSON**. If sandbox returns a parse/format error, set `OTT_PAYOUT_BODY_ENCODING=form` (the client
   flattens nested objects to dotted keys). The hash is unaffected either way.
2. **Amount + empty-optional formatting inside the hash.** We send and hash the *same* 2dp string
   (`"50.00"`) — never a JS number, which would drop trailing zeros and break the hash — and hash
   absent optionals as `""`. A mismatch surfaces as **status 2 (Invalid Hash)** with a valid
   request otherwise — so if the first PerformPayout returns `2` while the auth header is accepted,
   this formatting is the first thing to vary (try no-decimal, or a different empty-field convention).

---

## 7. Webhook

Providers that settle asynchronously (PayShap/RTC included) POST a JSON status update to our
configured endpoint whenever a transaction's status changes.

- **Verify every webhook** with `verifyPayoutWebhook(payload, apiKey)` before acting — it recomputes
  the SHA-256 over `merchantUniqueReference + message + status + transactionId + utctimestamp + apiKey`
  and constant-time-compares to `payload.hashcheck`. Reject on mismatch.
- Drive the outcome off the **`status`** field, not `message`: `100`=success, `98`/`99`=pending,
  `≤97`=failed.
- Be **idempotent** — duplicates occur. Reconcile against our own transaction record keyed by
  `merchantUniqueReference` (= our `yourUniqueReference`); a repeat status is a no-op.
- Respond `200 OK` fast; do the ledger work, then ack. (Same await-before-ack discipline as the
  WhatsApp webhook — never fire-and-forget on Vercel.)
- The `secret` field is reserved/all-zeros — ignore it.

The webhook route will live at `pages/api/webhooks/ott-payout.js` (to build) and reuse the durable,
idempotent settlement pattern from the PayFast ITN + `lib/request-notify.js`.

---

## 8. How it maps to WaPay's ledger (next build)

The customer-facing withdraw flow will follow the reference hold pattern, exactly like VAS vends:

```
ensureWallet
 → reserveHold(CASH, amount + customer fee)         // funds locked
 → OttPayoutClient.performPayout(... deterministic yourUniqueReference from the hold idemKey ...)
 → classifyPayoutStatus(result.status):
     SETTLE  → settleHold(buildCashout(method, amount)) + book buildCashoutRailCost  // rail cost incl VAT
     PENDING → leave the hold ACTIVE; mark the intent PENDING; the webhook/GetPaymentStatus finalises
     RELEASE → releaseHold(reason)                    // nothing paid; customer made whole
```

- `yourUniqueReference` is **deterministic and epoch-free** (derived from the hold idemKey), so a
  retry replays the same reference — OTT rejects a duplicate reference (status `3`), which is the
  exactly-once guard on their side too.
- Fees + VAT are already in `lib/ledger-core.js` (`buildCashout`, `cashoutFeeCents`,
  `cashoutRailCostCents`, banded CashSend, PayShap flat R3.12) — see the payout-commercials work.
- **KYC:** withdrawals are the KYC-gated path. The recipient fields PerformPayout needs (name, SA ID,
  mobile, bank/branch) are captured at withdrawal time; that capture + verification is part of the
  withdraw flow build, and a failed check must fail *before* any hold settles.

Provider codes are **not hardcoded** — resolve them at runtime from GetActiveProviders /
GetActiveProvidersLimits (the sample shows codes like FNB=1, "OTT VOUCHER"=3; PayShap/RTC codes come
from the live list).

---

## 9. Security checklist

- Credentials in env only, never committed; API key shown once, rotate on suspicion.
- The PerformPayout success response for the OTT-VOUCHER provider carries a **bearer PIN**
  (`voucherdata.pin`) — treat as a secret: never logged (the client masks/omits it), delivered to the
  recipient over WhatsApp only, same discipline as issued vouchers.
- Recipient PII (account number, SA ID, mobile) is never logged in full — masked to last-3.
- Webhook payloads are verified (hash) before any money action; unverified → reject.
- IP allowlisting: Vercel egress is dynamic; if OTT allowlists, we need a static egress IP (the
  Fly.io Johannesburg option from the static-IP research) — confirm the requirement with OTT.
```
