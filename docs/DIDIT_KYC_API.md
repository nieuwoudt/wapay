# Didit KYC — verified API spec & build notes

*Researched 2026-08-28 from the live docs (docs.didit.me) by a 4-agent research pass, then
built against it (`lib/didit-kyc.js`, `/api/webhooks/didit`, `/api/admin/kyc`). **v3 is the
current API — any `/v2/session/` or `docs.didit.me/reference/*` URL you find in search
results is stale and 404s.** Where the docs were silent, §7 records the safe default the code
already implements.*

---

## 1. Create a verification session

```
POST https://verification.didit.me/v3/session/      (trailing slash matters)
Headers: x-api-key: <DIDIT_API_KEY>
         Content-Type: application/json
Body:    { workflow_id, vendor_data, metadata?, language?, callback? }
```

- `workflow_id` (**required**) — the UUID of the KYC workflow created in the console.
- `vendor_data` — **our `Account.id`**. It is also Didit's idempotency key: creating again
  for the same account+workflow returns the existing unfinished session instead of a
  duplicate. Always send it.
- `callback` is a **browser redirect after the flow, NOT a webhook** (create-session has no
  webhook field at all — webhooks are configured separately, §4).

**Response 201:** `session_id` (use for the decision fetch), `session_token` (secret),
**`url`** (the hosted link to hand the customer — use verbatim, never construct it),
`status: "Not Started"`, plus the echoed `vendor_data` / `metadata` / `workflow_id`.

**Rate limits:** 600 creates/min documented on the endpoint page; the pricing page says free
workflows are limited to **10/min**. Conflict → we honour 429 + `Retry-After` and treat the
conservative figure as the ceiling.

## 2. The hosted link

Fully hosted by Didit — no SDK, completes in a phone browser. **Delivery over WhatsApp is a
documented pattern**, which is exactly what `/api/admin/kyc` does (to the account's own
registered waId, never a caller-supplied number). NFC chip reading is native-SDK-only, so on
web it is skipped: plan on document photo + passive liveness + face match.

## 3. Fetch the decision (source of truth)

```
GET https://verification.didit.me/v3/session/{session_id}/decision/
Headers: x-api-key   (key needs the read:sessions privilege)
```

Returns `status`, `vendor_data`, and **per-feature result ARRAYS** — not a flat object:
`id_verifications[]` (with `first_name`, `last_name`, `full_name`, `document_type`,
`document_number`, **`personal_number`** ← the SA ID number lands here, `date_of_birth`, …),
`liveness_checks[]`, `face_matches[]`, `aml_screenings[]`, `database_validations[]`, …

- `node_id` values are workflow-defined — treat as opaque; select by array name + `status`.
- Media URLs are **short-lived presigned links** — never store one as if permanent.
- **Do not poll.** Wait for the webhook, then fetch once.

## 4. Webhooks

Configured as named **destinations** in the console (API & Webhooks) — a public HTTPS URL +
subscribed event types → yields a `secret_shared_key`. There is no per-session webhook URL.

**Headers:** `X-Timestamp` (epoch seconds), `X-Signature`, `X-Signature-V2`,
`X-Signature-Simple`, `User-Agent: DiditWebhook/2.0`.

**Verification (what we implement):** `X-Signature` = HMAC-SHA256 **hex over the exact raw
request-body bytes**, keyed with the webhook secret; compare with `timingSafeEqual`. Read the
raw bytes *before* JSON parsing (our route sets `bodyParser: false`).

**Payload:** `event_id` (idempotency key), `webhook_type`, `session_id`, `status`,
`vendor_data`, `metadata`, `decision` (same array shape as §3).

**Event types (10):** `status.updated`, `data.updated`, `user.status.updated`,
`user.data.updated`, `business.*`, `activity.created`, `transaction.*`,
`travel_rule.status.updated`. **There is no `kyc.completed`** — a finished KYC arrives as
`status.updated` with `Approved`/`Declined`/`In Review`.

**Delivery contract:** any 2xx = delivered; Didit times out at **5s**; on 5xx/404/timeout it
retries **twice** (~1 min, then ~4 min). 3xx and non-404 4xx are **not** retried — so never
return 4xx for a transient failure. Deliveries originate from `18.203.201.92`.

## 5. Status enum (exact, Title Case — compare literally)

Session: `Not Started`, `In Progress`, `Awaiting User`, `In Review`, `Approved`, `Declined`,
`Resubmitted`, `Expired`, `Kyc Expired`, `Abandoned`.
Feature-level: `Not Finished`, `Approved`, `Declined`, `In Review`.

**Our map** (`mapDiditStatus`): Approved→`VERIFIED` · Declined→`DECLINED` · In
Review→`PENDING_REVIEW` · Expired/Kyc Expired/Abandoned→`EXPIRED` · in-flight→`PENDING` ·
**unknown→null (never changes our state)**.

## 6. Founder setup (console clicks)

1. Sign up free at **business.didit.me** (no card).
2. **Workflows → Create New → KYC template** → copy the **workflow UUID** → `DIDIT_WORKFLOW_ID`.
3. **API & Webhooks** → copy the **API key** → `DIDIT_API_KEY`.
4. Same page → add a **webhook destination**: `https://pleasepayme.co.za/api/webhooks/didit`
   (the app domain — see the note below), subscribe **`status.updated`**, copy the **Webhook
   Secret Key** → `DIDIT_WEBHOOK_SECRET`.
5. Do it all in a **sandbox application first** — unbilled, providers mocked, outcomes
   scripted via `sandbox_scenario`, 500 creates/24h. Keep sandbox and live keys separate.
6. **Free tier: 500 full KYC/month forever.** Overage ~$0.33 full bundle / $0.15 ID-only /
   $0.20 AML. Failed verifications are not charged.

> **Domain note:** the webhook must point at the **Next app** domain
> (`pleasepayme.co.za` / `wa-pay.me`), not `wapay.co.za` (the Lovable marketing site) and not
> the admin host. Middleware deliberately never intercepts `/api/*` so the webhook stays
> reachable wherever the console lives.

## 7. Unknowns → the defaults already coded

| Unknown | Our default |
|---|---|
| Session URL expiry | Treat `Expired` as terminal and create a new session; never cache a link as permanent. |
| Free-tier create rate (10 vs 600/min) | Honour 429 + `Retry-After`; surface `DIDIT_RATE_LIMITED`. |
| Exhaustive webhook schema | Parse defensively (every field optional); **fetch the decision endpoint as truth** rather than trusting the webhook's `decision` blob. |
| `node_id` values | Opaque — select by array name + status. |
| Hosted URL path shape | Use the response `url` verbatim. |
| Unrecognised statuses/events | Log + ignore; never move our state; ack unknown `webhook_type`s with 200. |
| SA DHA registry cross-check price ($1.10 vs $2.95 conflict on Didit's own pages) | **Do not enable** the `zaf_africa_national_id` database-validation node until the price is confirmed in the console. |

## 8. What we store (POPIA)

`Account.profile.kyc` = `{ status, provider:'didit', sessionId, url, startedAt, verifiedAt,
fullName, documentType, idNumberMasked, declineReason, notifiedStatus }`.

- **The full document/ID number is never stored** — only `idNumberMasked` (`••••••••083`).
- `declineReason` is redacted (`\d{4,}` → `####`) before persisting — reviewer free text can
  quote an ID number.
- Extracted person data is **never logged**.
- The merge is atomic (`lib/profile-merge.js`, jsonb) so a KYC write and a language write
  can't clobber each other.

## 9. Safety properties the tests lock

Fail-closed without envs · signature verified **before** parse · process-then-ACK (no
fire-and-forget) · 5xx so Didit retries · notification gated on `notifiedStatus` (can't
double-send, can't be permanently lost) · a **VERIFIED account is never regressed** by a
stale/foreign session · the decision's `vendor_data` must match the account or the write is
refused · the verification link only ever goes to the account's registered waId.

See `tests/didit-kyc.test.mjs` (15 tests) and BUGLOG #32 for the review that produced several
of these guards.

## 10. Still to build (when the withdrawal rail goes live)

- **The customer-initiated gate**: `buildCashout` paths must hard-require
  `profile.kyc.status === 'VERIFIED'` before a payout is allowed. Today KYC is admin-initiated
  only — nothing enforces it yet because withdrawals are not live.
- A self-service "verify me" entry point in chat, once counsel clears cash-out.
- Optional: retry/fallback UX for the 40–60% remote-KYC pass-rate reality (see `docs/KYC.md`).
