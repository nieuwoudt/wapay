# Blu VAS Product Catalogue

This document catalogues all VAS (Value Added Services) products available through the Blu API that WaPay can sell.

## Quick Reference

| Category | Status | Endpoint | Target Type |
|----------|--------|----------|-------------|
| Mobile Airtime | ✅ Implemented | `/mobile/airtime/sales` | MSISDN |
| Mobile Data | ✅ Implemented | `/mobile/data/sales` | MSISDN |
| Electricity | 📋 Planned | `/electricity/sales` | METER_NUMBER |
| PayTV (DStv) | 📋 Planned | `/paytv/sales` | SMARTCARD |
| OTT Vouchers | 📋 Planned | `/vouchers/ott/sales` | EMAIL/CODE |
| Retail Vouchers | 📋 Planned | `/vouchers/retail/sales` | CODE |
| Betting Top-ups | 📋 Planned | `/betting/topup` | ACCOUNT_ID |

---

## 1. Mobile Airtime (IMPLEMENTED)

### Overview
Purchase prepaid airtime for South African mobile networks.

### API Details
- **Endpoint**: `POST /mobile/airtime/sales`
- **Network Check**: `GET /mobile/airtime/mobile-number/check?mobileNumber={number}`

### Supported Networks
| Vendor ID | Display Name | Min Amount | Max Amount |
|-----------|--------------|------------|------------|
| `vodacom` | Vodacom | R5 | R1000 |
| `mtn` | MTN | R5 | R1000 |
| `cellc` | Cell C | R5 | R1000 |
| `telkom` | Telkom | R5 | R1000 |

### Request Fields
```json
{
  "requestId": "string (idempotency key)",
  "vendorId": "string (vodacom|mtn|cellc|telkom)",
  "mobileNumber": "string (0821234567)",
  "amount": "number (cents)",
  "vendMetaData": {
    "transactionRequestDateTime": "ISO8601",
    "transactionReference": "string",
    "vendorId": "WAPAY-001",
    "deviceId": "WHATSAPP-BOT",
    "consumerAccountNumber": "string",
    "cellphoneNumber": "string"
  }
}
```

### Response Structure
```json
{
  "requestId": "string",
  "reference": "string (Blu reference)",
  "amount": "number (cents)",
  "dateTime": "ISO8601",
  "mobileNumber": "string",
  "vendorName": "string (Vodacom|MTN|etc)"
}
```

### Purchase Type
- **Instant Vend** - Airtime is delivered immediately

---

## 2. Mobile Data Bundles (IMPLEMENTED)

### Overview
Purchase data bundles for South African mobile networks.

### API Details
- **Endpoint**: `POST /mobile/data/sales`
- **Catalogue**: `GET /mobile/data/products?vendorId={network}`

### Bundle Categories
Each network offers bundles in these categories:
- **Daily** - 24-hour validity
- **Weekly** - 7-day validity
- **Monthly** - 30-day validity
- **Night** - Off-peak hours only (usually 00:00-05:00)

### Request Fields
```json
{
  "requestId": "string (idempotency key)",
  "vendorId": "string (vodacom|mtn|cellc|telkom)",
  "productId": "string (from catalogue)",
  "mobileNumber": "string (0821234567)",
  "vendMetaData": { ... }
}
```

### Response Structure
```json
{
  "requestId": "string",
  "reference": "string (Blu reference)",
  "amount": "number (cents)",
  "dateTime": "ISO8601",
  "mobileNumber": "string",
  "productName": "string (e.g., '500MB Daily')",
  "vendorName": "string"
}
```

### Purchase Type
- **Instant Vend** - Data bundle is activated immediately

---

## 3. Prepaid Electricity (PLANNED)

### Overview
Purchase STS prepaid electricity tokens for meters.

### API Details (Estimated)
- **Endpoint**: `POST /electricity/sales`
- **Meter Lookup**: `GET /electricity/meter/validate?meterNumber={number}`

### Supported Providers
| Provider ID | Display Name | Notes |
|-------------|--------------|-------|
| `eskom` | Eskom | Eskom direct meters |
| `city_power` | City Power | Johannesburg |
| `city_cape_town` | City of Cape Town | Cape Town |
| `ethekwini` | eThekwini | Durban |
| `tshwane` | City of Tshwane | Pretoria |

### Request Fields (Estimated)
```json
{
  "requestId": "string",
  "meterNumber": "string (13-20 digits)",
  "amount": "number (cents, R50-R5000)",
  "vendMetaData": { ... }
}
```

### Response Structure (Estimated)
```json
{
  "reference": "string",
  "amount": "number",
  "token": "string (STS token - 20 digits)",
  "units": "number (kWh)",
  "meterNumber": "string",
  "customerName": "string"
}
```

### Purchase Type
- **Token-Based** - Returns STS token for meter input

---

## 4. PayTV / DStv (PLANNED)

### Overview
Pay DStv subscriptions or purchase DStv vouchers.

### API Details (Estimated)
- **Endpoint**: `POST /paytv/sales`
- **Account Lookup**: `GET /paytv/account/validate?smartcard={number}`
- **Packages**: `GET /paytv/packages?provider={dstv}`

### DStv Packages
| Package Code | Name | Price |
|--------------|------|-------|
| `PREMIUM` | DStv Premium | R879 |
| `COMPACT_PLUS` | DStv Compact Plus | R599 |
| `COMPACT` | DStv Compact | R429 |
| `FAMILY` | DStv Family | R319 |
| `ACCESS` | DStv Access | R129 |

### Request Fields (Estimated)
```json
{
  "requestId": "string",
  "provider": "dstv",
  "smartcardNumber": "string (10 digits)",
  "packageCode": "string (optional)",
  "amount": "number (cents)",
  "vendMetaData": { ... }
}
```

### Purchase Type
- **Reference-Based** - Payment applied to account

---

## 5. OTT Vouchers (PLANNED)

### Overview
Purchase streaming service vouchers.

### Supported Services
| Provider ID | Display Name | Denominations |
|-------------|--------------|---------------|
| `showmax` | Showmax | R49, R99 |
| `netflix` | Netflix | R99, R199, R299 |
| `boxoffice` | DStv BoxOffice | R40, R80 |
| `spotify` | Spotify | R59, R119 |

### Request Fields (Estimated)
```json
{
  "requestId": "string",
  "provider": "string",
  "productId": "string (from catalogue)",
  "deliveryEmail": "string (optional)",
  "vendMetaData": { ... }
}
```

### Response Structure (Estimated)
```json
{
  "reference": "string",
  "amount": "number",
  "voucherCode": "string (redemption PIN)",
  "expiryDate": "string",
  "productName": "string"
}
```

### Purchase Type
- **PIN-Based** - Returns voucher code for redemption

---

## 6. Retail Vouchers (PLANNED)

### Overview
Purchase gift vouchers for retail stores.

### Supported Retailers
| Provider ID | Display Name | Denominations |
|-------------|--------------|---------------|
| `picknpay` | Pick n Pay | R50, R100, R200, R500 |
| `shoprite` | Shoprite/Checkers | R50, R100, R200, R500 |
| `woolworths` | Woolworths | R100, R250, R500 |
| `spar` | SPAR | R50, R100, R200 |

### Purchase Type
- **PIN-Based** - Returns voucher code for in-store redemption

---

## 7. Betting Top-ups (PLANNED)

### Overview
Top up sports betting accounts.

### Supported Operators
| Operator ID | Display Name | Min | Max |
|-------------|--------------|-----|-----|
| `hollywoodbets` | Hollywoodbets | R10 | R10,000 |
| `betway` | Betway | R10 | R10,000 |
| `sportingbet` | Sportingbet | R10 | R10,000 |
| `supabets` | Supabets | R10 | R10,000 |

### Request Fields (Estimated)
```json
{
  "requestId": "string",
  "operatorId": "string",
  "accountNumber": "string (betting account ID)",
  "amount": "number (cents)",
  "vendMetaData": { ... }
}
```

### Purchase Type
- **Instant Vend** - Balance credited to betting account

---

## Configuration

### VasProduct Database Schema

All products are stored in the `VasProduct` table:

```prisma
model VasProduct {
  id               String   @id @default(cuid())
  category         String   // AIRTIME | DATA | ELECTRICITY | PAYTV | OTT | RETAIL_VOUCHER | BETTING
  providerId       String   // vodacom, mtn, dstv, showmax, etc.
  providerName     String   // Display name
  networkCode      String   // Legacy: same as providerId for mobile
  skuCode          String   // Product SKU
  label            String   // Display label
  unitType         String   // CURRENCY | MB | KWH | DAYS
  unitQuantityMb   Int?     // For data bundles
  priceCents       Int      // Fixed price or 0 for custom amount
  validityDays     Int?     // Bundle validity
  purchaseType     String   // INSTANT_VEND | PIN_BASED | TOKEN_BASED | REFERENCE_BASED
  allowCustomAmount Boolean // True for airtime, electricity
  minCents         Int?     // Min custom amount
  maxCents         Int?     // Max custom amount
  stepCents        Int?     // Amount step (usually 100 = R1)
  targetType       String   // MSISDN | METER_NUMBER | SMARTCARD | ACCOUNT_ID
  metadata         Json?    // Extra provider-specific data
  active           Boolean  // Enable/disable without code changes
}
```

### Enabling/Disabling Products

Products can be toggled without code changes:

```sql
-- Disable all betting products
UPDATE "VasProduct" SET active = false WHERE category = 'BETTING';

-- Enable a specific product
UPDATE "VasProduct" SET active = true WHERE id = 'xyz123';
```

### Adding New Products

New products can be added via seed script or admin panel:

```typescript
await prisma.vasProduct.create({
  data: {
    category: 'ELECTRICITY',
    providerId: 'eskom',
    providerName: 'Eskom',
    networkCode: 'eskom',
    skuCode: 'ESKOM_PREPAID',
    label: 'Eskom Prepaid Electricity',
    unitType: 'KWH',
    priceCents: 0, // Custom amount
    purchaseType: 'TOKEN_BASED',
    allowCustomAmount: true,
    minCents: 5000,  // R50
    maxCents: 500000, // R5000
    stepCents: 100,
    targetType: 'METER_NUMBER',
    active: true,
  },
});
```

---

## Implementation Roadmap

### Phase 1 (Current) - Mobile Services
- ✅ Mobile Airtime
- ✅ Mobile Data Bundles
- ✅ Network Detection

### Phase 2 - Utilities
- 📋 Prepaid Electricity
- 📋 PayTV (DStv)

### Phase 3 - Digital Goods
- 📋 OTT Vouchers
- 📋 Retail Vouchers

### Phase 4 - Entertainment
- 📋 Betting Top-ups

---

## Related Documentation

- [Blu OpenAPI Integration](./blu/openapi.md)
- [Blu VAS Integration Details](./blu-vas-integration.md)
- [VAS Testing Guide](../testing/blu-vas-e2e.md)

