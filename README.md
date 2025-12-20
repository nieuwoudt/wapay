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
