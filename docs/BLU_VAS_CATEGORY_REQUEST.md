# WaPay — request to Blue Label: additional VAS categories & product documentation

**Status:** requested 18 Aug 2026 (email to Phuti Maphoto / Mpho Ramethape), re-sent with test
evidence 28 Aug 2026. **Awaiting response.**
**Owner:** WaPay engineering · **Counterparty:** Blue Label Telecoms (Blu Telecoms Trade API)

---

## 1. Why this document exists

We asked Blue Label to enable four additional VAS categories on our trade account. Before
building against them we audited exactly what we hold, and the finding is important enough to
state plainly at the top:

> **We do not have Blue Label product documentation for any of the four requested categories.**
> We hold no OpenAPI/Swagger specification at all — `packages/providers/blu/openapi/` contains
> only a placeholder pointing at Blu's Swagger UI. Our prose docs cover airtime, data,
> electricity and voucher redemption only, and were written by browsing that Swagger UI.

Everything our codebase contains for lifestyle, bill payments, gaming and remittance is
therefore **our own assumption, not Blue Label's specification**. That is the gap this request
is meant to close, and we should not build further until it is closed.

---

## 2. What is genuinely confirmed today

Endpoints verified against Blu (browsed in Swagger and/or exercised in QA):

| Endpoint | Purpose |
|---|---|
| `GET /voucher/variable/vouchers` | Voucher status/balance check |
| `POST /voucher/variable/redemptions` | Voucher redemption (live, 8 production transactions) |
| `POST /mobile/airtime/sales` | Airtime vend (live, 6 production transactions) |
| `GET /mobile/airtime/mobile-number/check` | Network detection |
| `GET /mobile/airtime/products` | Operator list |
| `GET /mobile/bundle/products` | Data bundle catalogue (replaced `/mobile/data/products`, which Blu deprecated) |
| `POST /mobile/data/sales` | Data bundle vend |
| `GET /electricity/info` | Meter confirm + quote (Blu support confirmed `POST /electricity/confirmCustomer` is deprecated — do not use) |
| `POST /electricity/sales` | Electricity token vend |

`GET /mobile/bundle/products` is the **only** product-discovery endpoint we know of, and it
covers mobile bundles only. We know of no cross-category catalogue endpoint.

---

## 3. The four requested categories — what we actually know

### (a) Lifestyle / entertainment vouchers
*Requested for: Netflix, Uber, PlayStation, Google Play.*

- **Blu endpoint: unknown.** Our client calls `/voucher/ott/products` and
  `/voucher/ott/purchase`; a second internal doc says `/vouchers/ott/sales`. Both are guesses
  and they contradict each other. Neither was ever confirmed.
- **Product codes: ours, invented.** `UBER_50`, `PSN_100`, `GPLAY_50`, `NETFLIX_100` are seed
  rows we wrote. Uber, PlayStation and Google Play appear in **no** Blue Label document we
  hold — only in our own seed data and a chatbot keyword list.
- **Denominations: ours**, not sourced from Blu.

### (b) Bill payments (DStv)

- **Closest to plausible, still unverified.** Client calls `/paytv/dstv/account`,
  `/paytv/dstv/payments`, `/paytv/dstv/products`; an internal doc instead says `/paytv/sales`.
  Marked "estimated" in our own catalogue.
- **Package codes: ours** (`DSTV_PREMIUM`, `DSTV_ACCESS`…), derived from retail pricing we
  looked up, not from a Blue Label SKU list.

### (c) Gaming / betting top-ups

- **Endpoints guessed:** `/betting/providers`, `/betting/{providerId}/validate`,
  `/betting/{providerId}/topup`. All three sit on our own internal "does this endpoint exist?"
  verification list, which was never closed out with Blu.
- **Operator IDs and denominations: ours** (`HWBETS_50`, `BETWAY_50`…).
- ⚠️ Internal note: betting must remain **web-only**. Meta cannot grant SA gambling permission,
  so betting must never appear in WhatsApp-facing copy (see `meta-gambling-policy` memory).
  This does not change what we ask Blue Label for, but it constrains where we surface it.

### (d) Remittance (Mukuru, Hello Paisa, Mama Money, EcoCash)

- **Nothing exists.** No endpoint, no client method, no type, no documentation section. The
  provider-side category union in our types does not even include remittance. **EcoCash does
  not appear anywhere in our codebase.**
- The only artefacts are WaPay seed rows we wrote (`MUKURU_SEND`, `HELLOPAISA_SEND`,
  `MAMA_SEND`).
- ⚠️ Internal note: remittance is **regulatory-sensitive** and must not be enabled without
  counsel sign-off. Our entire current posture is that we sell goods vouchers and never
  perform money transfer. Enabling remittance would change that posture materially, so treat
  this as a strategic decision, not just an integration.

---

## 4. What we are asking Blue Label for

1. **The API specification.** The current OpenAPI/Swagger JSON URL for **both** QA and
   production. We are presently building from prose notes, which is how the contradictions
   above arose.
2. **The production base URL.** Our own docs disagree (`api.qa.bltelecoms.net/v2/api/trade`
   vs `api.bluvoucher.co.za` vs `api.bluvoucher.com/v1`) and no production `bltelecoms.net`
   host is documented anywhere. We need this confirmed in writing.
3. **A product/SKU catalogue per category**, plus the endpoint that enumerates it — product
   codes, categories, denominations and whether codes are stable. (For data bundles we
   currently hash vendorId+name+amount when Blu returns no stable product id; stable SKUs
   would remove that workaround.)
4. **Written confirmation of our account entitlements** — specifically which of the four
   categories our trade account is or can be enabled for, and any separate agreements,
   commercials or approval steps attached to each.
5. **Operational answers still outstanding:** rate limits, whether webhooks/async
   confirmations exist, and whether a reconciliation/settlement file is provided.
6. **IP whitelisting:** whether production requires it, and if so whether a shared static
   egress IP is acceptable or a dedicated IP is required.
7. **Production UAT:** whether a production test allowance exists (we currently see only the
   QA MSISDN whitelist: 0840012300 Cell C, 0720012345 Vodacom, 0830012300 MTN, 0850012345
   Telkom).

---

## 5. Engineering position until this is answered

- All four categories stay **gated off** in `lib/vas-config.js` (they already are, by default),
  and the WhatsApp surface continues to say "listed, but purchasing is not enabled yet".
- **Do not build against the guessed endpoints.** They are unverified, mutually contradictory
  in our own docs, and no production code calls them today.
- **Do not treat our seed product codes as real.** They were invented for UI scaffolding. When
  Blue Label supplies a real catalogue, the seed rows must be replaced, not extended.
- Remittance additionally waits on counsel, independent of Blue Label.

---

## 6. Related

- Test evidence supplied to Blue Label: `docs/testing/BLU_UAT_EVIDENCE.md`
- Emails: `EMAIL_TO_PHUTI_1_TESTLOGS.txt` (28 Aug 2026), original request 18 Aug 2026
- ⚠️ Security: live-looking Blu QA credentials are committed in plaintext in several repo
  docs. This is already tracked under the deferred key-rotation work and must be resolved
  before public launch.
