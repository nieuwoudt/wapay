# WaPay

WhatsApp-first payment and services platform for South Africa.

## Features

### Blu Voucher Cash-In
- Redeem Blu vouchers to credit WaPay wallet
- Instant balance updates with WhatsApp receipt

### Blu VAS (Value Added Services)
- **Mobile Airtime**: Purchase prepaid airtime for Vodacom, MTN, Cell C, Telkom
- **Mobile Data**: Purchase data bundles with automatic network detection
- PIN verification for secure transactions
- WhatsApp receipts on successful purchases
- Double-entry ledger for accurate accounting

**Production-ready features:**
- Idempotency protection prevents duplicate charges
- Retry logic with exponential backoff
- Error categorization (USER_INPUT, AUTH, RETRYABLE)
- Sentry integration for error tracking
- Structured metrics logging

### Yoyo / wiGroup Integration
- CVS Issuer (gift issue/topup/balance)
- VSP/Token Manager (wiCode tokens)
- Retailer eligibility checking

## Quick Start

```bash
# Install dependencies
pnpm install

# Set environment variables (see docs/deploy/blu-vas.md)
cp env.template .env.local

# Run database migrations
cd packages/domain && npx prisma migrate deploy

# Build packages
pnpm run build

# Start development server
pnpm run dev
```

## Production Deployment (Git → Vercel auto-deploy)

We deploy to production by pushing to `main`; Vercel Git integration builds and promotes automatically.

Steps:
1) Make and verify changes locally.
2) Stage and commit:
   - `git add -A`
   - `git commit -m "your message"`
3) Push:
   - `git push`
4) Vercel detects the push to `main` and deploys to production for project `wapay-api` (team `finfy-ai`).

Prod base URL:
- `APP_BASE_URL=https://wapay-api-finfy-ai.vercel.app` (set in Vercel env)

Primary prod domains:
- https://wapay-api.vercel.app
- https://wapay-api-finfy-ai.vercel.app

## Testing

## Agentic Commerce & Natural-Language Slot Filling

WaPay supports “agentic commerce”: users can send natural language like:

- `Buy R10 airtime for 0840012300`
- `Ek wil R10 airtime koop vir 0840012300`
- `Send R30 to 0879890808`

### Unified slot parsing (single source of truth)

All commerce routing and state handlers must use the shared parser:

- `lib/slot-parser.js` → `parseSlots(text, context?)`

This returns a single, deterministic slot object (examples):

- Airtime: `amountCents`, `msisdn`
- Data: `dataMb`, `periodType`, `networkCode`, `msisdn`
- Electricity: `amountCents`, `meterNumber`
- Retail Pay: `amountCents`, `retailer`

### Deterministic routing rules (non-negotiable)

- If slots contain **(amountCents + msisdn)** and `productHint=AIRTIME`:
  - Never go to `AIRTIME_MSISDN`
  - Immediately do **preview → confirm → PIN → execute → single receipt**
- Missing slots are the **only** acceptable reason to ask follow-ups.
  - Never ask for the same slot twice if it’s present in the user message.

### Preview-first + vendor correctness

For Airtime (and later Data), confirmation must show the **authoritative vendor/network** from preview.
Prefix guessing is only a fallback when preview is not available.

## Agentic Airtime Vending (QA Verified)

Verified working via WhatsApp (Blu Trade QA), using the agentic flow:
parse → preview → confirm → PIN → execute → single receipt → next actions

- Vodacom: `buy R10 airtime for 0829837088`
- MTN: `buy R10 airtime for 0831118881`
- Telkom: `buy R10 airtime for 0850012345`
- Cell C (Blu-approved): `buy R10 airtime for 0840012300`

Important (Blu QA allowlist/config):

- Some Cell C numbers in QA will return `400 Invalid phone number` (example: `0624404849`).
- When this happens, it is almost always **Blu QA allowlist/config** (not WaPay payload/slot parsing).
- Action: confirm with Blu which Cell C MSISDNs are enabled/approved in the target environment.

## Single Error Message Guarantee (Global Guard)

WaPay guarantees the user receives **at most one WhatsApp error message** per failed attempt:

- All user-facing errors are sent **only** by `pages/api/webhooks/message-processor-v2.js` (the WhatsApp orchestrator).
- Internal VAS API routes (`/api/vas/*/execute`) **never** send WhatsApp messages directly.
- Error delivery is deduped by `(previewId + errorCode)` stored in `account.conversationData.sentErrorKeys`.
- Blu client never retries 400-class request problems like `INVALID_PHONE_NUMBER`, preventing repeated provider calls and repeat errors.

## Why Agentic Airtime Won’t Regress (Guardrails)

If any of these break, we consider it a regression:

- **Slot parsing is universal**: `lib/slot-parser.js` runs before routing and inside state handlers.
- **Deterministic override**: when slots are complete for airtime, the bot must route to preview/confirm and never ask for MSISDN again.
- **Preview-first vendor**: the vendor/network displayed in confirmation comes from preview.
- **Exactly-once errors**: failed executes produce only one WhatsApp error message (no duplicates).

Regression tests that enforce this:

- `tests/routing-regression.test.mjs` (one-shot airtime should not ask for MSISDN)
- `tests/slot-parser.test.mjs` (amount + MSISDN extraction robustness)
- `tests/no-whatsapp-sends-in-api-routes.test.mjs` (API routes must not send WhatsApp messages)
- `packages/providers/blu/__tests__/vas.client.test.ts` (no retries on `INVALID_PHONE_NUMBER`)

## Agentic Electricity Vending (Blu-supported flow)

Blu Support confirmed the correct electricity flow:

- Confirm meter / quote: `GET /electricity/info?amount={cents}&free-basic-electricity=false&meter-number={meter}`
- Vend token: `POST /electricity/sales` using the `reference` returned by the info call

WaPay implementation:

- Preview: `POST /api/vas/electricity/preview`
  - validates wallet balance
  - calls Blu `GET /electricity/info` and stores `reference` in the preview metadata
- Execute: `POST /api/vas/electricity/execute`
  - uses stable idempotency key `wapay-elec-exec-${previewId}`
  - calls Blu `POST /electricity/sales` with `{ requestId, reference, vendMetaData }`

Safety:

- You can restrict electricity to specific WhatsApp IDs by setting:
  - `VAS_ALLOWLIST_ELECTRICITY=27787051175,27760000000`

## Agentic Data Bundles (improved)

Data agentic flow supports natural language like:

- `buy 2GB data for 0787051175`

Behavior:

- If size + MSISDN are present, WaPay will infer the network from the MSISDN prefix (fallback) and select the best matching bundle in `VasProduct` by popularity/price.
- If the network cannot be inferred, the bot asks **only** for the missing network.

## Agentic VAS Test Data (QA)

This section is the **single source of truth** for known-good QA test inputs used to validate WaPay’s agentic VAS vending end-to-end.

### Airtime (Blu Trade QA)

Use these in WhatsApp messages like:

- `buy R10 airtime for 0829837088`

Known-good test MSISDNs:

- **Vodacom**: `0829837088`
- **MTN**: `0831118881`
- **Telkom**: `0850012345`
- **Cell C (Blu-approved)**: `0840012300`

Known-bad / expected failure (provider/config):

- **Cell C (not approved in QA)**: `0624404849` → often returns `400 Invalid phone number`

### Data Bundles (Blu Trade QA)

Use WhatsApp messages like:

- `buy 2GB data for 0787051175`

Notes:

- Vending uses `POST /mobile/bundle/sales` and requires `productId` (not `id`).
- WaPay resolves `productId` from `VasProduct.externalCode` after matching size/network/period (and may infer network from MSISDN as a fallback).

### Electricity (Blu Trade QA)

Electricity uses the Blu-supported flow:

- Confirm meter/quote: `GET /electricity/info?amount={cents}&free-basic-electricity=false&meter-number={meter}`
- Vend token: `POST /electricity/sales` using the `reference` returned by `/electricity/info`

Recommended WhatsApp format:

- `buy R200 electricity for meter 000001020001`

#### Electricity test meters (Compliance 2025 list)

All amounts below are ZAR. When calling Blu `/electricity/info`, amounts are sent as **cents** (e.g., R200.00 → `20000`).

| Test case | Scenario | Meter number | Utility/Transaction type | Amount |
|---:|---|---|---|---|
| 1 | Generic Vend - 1 Credit Token | `000001020001` | None | R200.00 |
| 2 | Generic Vend - Credit Token with Second FBE Token | `00001100000` | None | R200.00 |
| 3 | FBE Basic Electricity ONLY request - No amount | `00001000000` | None | R0.00 |
| 4 | Prepaid Water Meter Test | `000000000100` | Ontec | R200.00 |
| 5 | Smart Meter Topup where NO Token is present | `00000100000` | None | R200.00 |
| 6 | Minimum Vend in Meter Confirmation Response | `00000100100` | None | R5.00 |
| 7 | Maximum Vend in Meter Confirmation Response | `00000110000` | None | R12,000.00 |
| 8 | Partial Block Scenario | `00000100110` | None | Any Amount |
| 9 | Full Block Scenario | `00000110100` | None | R100.00 |
| 10 | Credit Token with two additional Key Change Tokens - 3 Tokens | `00200100000` | None | R200.00 |
| 11 | Credit Token with FBE Token with additional Key Change Tokens - 4 Tokens | `0020110000` | None | R200.00 |
| 12 | Credit Token + FBE with additional Key Change Tokens - 3 Tokens | `00201100000` | None | R200.00 |
| 13 | Tariff Details contained in Vend Responses - 1 Tariff | `00000210011` | None | R200.00 |
| 14 | Tariff Details contained in Vend Responses - Step Tar | `00000130000` | None | R200.00 |
| 15 | Credit + FBE unit amount combined in 1 Token | `00001100000` | None | R200.00 |

Source: `Copy of Electricity Test Meters -2025 Compliance001.csv` / `.pdf`

## Known Pitfall: SMART_PRODUCT_QUERY Slot Bypass (Regression Guard)

### Symptom

User says: `Buy R10 airtime for 0840012300`\nBot asks again: “Which phone number should I send the airtime to?”

### Log signature (prod)

- `nlp_intent.intent = SMART_PRODUCT_QUERY`\n- `entities = {}`\n- then state becomes `AIRTIME_MSISDN`

### Root cause

The SMART_PRODUCT_QUERY handler performed state transitions **without running slot parsing**, so the system believed slots were missing even when present.

### Fix (guard)

- `parseSlots()` is called **before routing** and also inside state handlers.\n- `message-processor-v2` deterministically overrides routing when slots are complete.\n- Regression tests (`tests/routing-regression.test.mjs`) fail if we ever regress.

## Slot coverage checklist (QA baseline)

### Airtime
- Required: `amountCents`, `msisdn`\n- Flow: parse → preview → confirm → PIN → execute → single receipt → CTA/Home

### Data
- Required: `dataMb` (or bundle SKU), `msisdn`\n- Flow: parse → match catalogue → preview → confirm → PIN → execute → receipt

### Electricity
- Required: `meterNumber`, `amountCents`\n- Flow: parse → preview/lookup → confirm → PIN → execute → token receipt

### Vouchers (Blu catalogue)
- Required: product selection + denomination\n- Flow: list → select → preview → confirm → PIN → vend → code receipt

### Send Money
- Required: `amountCents`, recipient `msisdn`\n- Flow: parse → confirm → PIN → transfer → receipt

### Retail Pay (wiCode / wiGroup)
- Required: `amountCents`, `retailer` (MVP: Boxer, Checkers, Shoprite, Usave, Pick n Pay, Engen)\n- Flow: parse → confirm → PIN → generate token → receipt

### Unit Tests

```bash
# Run Blu VAS client tests
cd packages/providers/blu
pnpm test
```

### Integration Tests (QA Environment)

```bash
# Run against Blu QA environment
BLU_TEST_MSISDN=0821234567 node test-blu-vas-suite.js
```

### Manual E2E Testing

See [docs/testing/blu-vas-e2e.md](docs/testing/blu-vas-e2e.md) for step-by-step testing guide.

## API Endpoints

### VAS Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/vas/airtime/preview` | Preview airtime purchase |
| POST | `/api/vas/airtime/execute` | Execute airtime purchase (requires PIN) |
| POST | `/api/vas/data/preview` | Preview data bundle purchase |
| POST | `/api/vas/data/execute` | Execute data bundle purchase (requires PIN) |
| GET | `/api/vas/bundles/:network` | Get data bundles for network |

### Yoyo Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/yoyo/eligible?retailer=X` | Check retailer eligibility |
| POST | `/yoyo/token/issue` | Issue wiCode token |

## Documentation

| Document | Description |
|----------|-------------|
| [Blu VAS Catalogue](docs/providers/blu-vas-catalogue.md) | All VAS products we can sell |
| [Blu OpenAPI Setup](docs/providers/blu/openapi.md) | Type generation from Swagger |
| [Blu VAS E2E Testing](docs/testing/blu-vas-e2e.md) | Manual test procedures |
| [Blu VAS Deployment](docs/deploy/blu-vas.md) | Environment setup and deployment |
| [Blu VAS Runbook](docs/runbooks/blu-vas.md) | Operational procedures |

## Environment Variables

### Required for Blu (Voucher + VAS)

```bash
BLU_BASE_URL=https://api.bluvoucher.co.za
BLU_BASIC_USER=<username>
BLU_BASIC_PASS=<password>
BLU_TRADE_API_KEY=<api-key>  # Shared key for Voucher + VAS
```

> Note: Blu Voucher redemption and Blu VAS (airtime/data) share the same API key.

### Required for WhatsApp

```bash
META_WHATSAPP_TOKEN=<token>
META_WHATSAPP_PHONE_NUMBER_ID=<phone-id>
```

### Database

```bash
DATABASE_URL=postgresql://...
```

### Optional

```bash
SENTRY_DSN=<sentry-dsn>         # Error tracking
PIN_PEPPER=<pepper>              # PIN hashing pepper
PIN_TOKEN_SECRET=<secret>        # JWT signing key
```

## Architecture

```
packages/
├── auth/           # PIN, OTP, consent management
├── domain/         # Prisma schema and database
├── nlp/            # Intent classification
├── providers/
│   ├── blu/        # Blu Voucher & VAS client
│   └── yoyo/       # Yoyo/wiGroup integration
├── utils/          # Shared utilities
└── whatsapp/       # WhatsApp API client

pages/api/
├── vas/
│   ├── airtime/    # Airtime preview/execute
│   ├── data/       # Data preview/execute
│   └── bundles/    # Bundle catalogue
└── webhooks/       # WhatsApp message handler
```

## User Stories

1. **Deposit via Blu Voucher**: Redeem voucher → credit wallet → send receipt
2. **Check balances**: Reply with wallet + gift balances
3. **Buy airtime/data**: Preview → confirm → PIN → receipt
4. **Pay at retailer**: "Pay R79.88 at Checkers" → issue wiCode token

## License

Proprietary - All rights reserved.
