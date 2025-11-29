# 🚀 Blu VAS Complete Integration Guide

## 📋 Executive Summary

This document covers the complete Blu VAS (Value Added Services) integration, expanding beyond airtime and data to include:

1. **✅ Mobile Airtime** - All SA networks
2. **✅ Mobile Data Bundles** - All SA networks
3. **⚡ Prepaid Electricity (STS)** - All municipalities
4. **📺 PayTV (DStv, GOtv)** - Subscription & payments
5. **🎬 OTT Vouchers** - Showmax, BoxOffice, Netflix
6. **🛒 Retail Vouchers** - Pick n Pay, Shoprite, Checkers
7. **🎰 Betting & Gaming** - Hollywoodbets, Betway, etc.
8. **🎫 Generic Vouchers** - 1Voucher, Flash

---

## 📊 VAS Product Catalogue

### 1. Mobile Airtime & Data (IMPLEMENTED ✅)

| Service | Endpoint | Request Fields | Response | Purchase Type |
|---------|----------|----------------|----------|---------------|
| **Airtime** | `POST /mobile/airtime/sales` | `requestId`, `vendorId`, `mobileNumber`, `amount`, `vendMetaData` | `reference`, `amount`, `vendorName` | Instant Vend |
| **Network Check** | `GET /mobile/airtime/mobile-number/check` | `mobileNumber` | `vendorName`, `mobileNumber` | Query |
| **Data Products** | `GET /mobile/data/products` | `vendorId` (optional) | Array of products | Query |
| **Data Purchase** | `POST /mobile/data/sales` | `requestId`, `vendorId`, `productId`, `mobileNumber`, `vendMetaData` | `reference`, `productName`, `vendorName` | Instant Vend |

**Networks**: Vodacom, MTN, Cell C, Telkom

---

### 2. Prepaid Electricity (STS) ⚡

**Endpoint Pattern**: `/electricity/*`

| Endpoint | Method | Purpose | Request Fields |
|----------|--------|---------|----------------|
| `/electricity/meter/validate` | GET | Validate meter & get customer info | `meterNumber` |
| `/electricity/sales` | POST | Purchase electricity token | `requestId`, `meterNumber`, `amount`, `municipalityCode`, `vendMetaData` |

**Response Fields**:
```typescript
{
  reference: string;       // Blu transaction reference
  token: string;           // 20-digit STS token for meter
  tokenType: 'STS_1' | 'STS_2';
  units: number;           // kWh purchased
  unitRate: number;        // Rate per kWh (cents)
  meterNumber: string;
  municipalityName: string;
  customerName: string;
  customerAddress: string;
  arrears: number;         // Outstanding arrears (cents)
  debt: number;            // Debt collected (cents)
  vat: number;             // VAT amount (cents)
  serviceCharge: number;   // Service charge (cents)
}
```

**Meter Number Format**: 11-13 digits (e.g., `1234567890123`)

**Purchase Type**: TOKEN_BASED (returns STS token to enter into meter)

**User Journey Example**:
```
User: "Buy R100 electricity"
Bot: "Please enter your 11-13 digit prepaid meter number."
User: "1234567890123"
Bot: [validates meter, shows customer name]
Bot: "Buy R100 electricity for meter 1234567890123 (John Smith, 123 Main St)?
     Reply YES to confirm."
User: "YES"
Bot: "✅ Electricity purchased!
     Token: 1234 5678 9012 3456 7890
     Units: 45.6 kWh
     Enter this token into your meter."
```

---

### 3. PayTV (DStv, GOtv) 📺

**Endpoint Pattern**: `/paytv/dstv/*`

| Endpoint | Method | Purpose | Request Fields |
|----------|--------|---------|----------------|
| `/paytv/dstv/account` | GET | Lookup smartcard | `smartcard` |
| `/paytv/dstv/products` | GET | Get packages | - |
| `/paytv/dstv/payments` | POST | Pay subscription/balance | `requestId`, `smartcardNumber`, `productId`, `amount`, `paymentType`, `vendMetaData` |

**Smartcard Number Format**: 10 digits starting with 1, 2, 3, or 7

**Payment Types**:
- `SUBSCRIPTION` - Pay for a specific package
- `BALANCE` - Pay outstanding balance
- `RECONNECT` - Reconnect suspended decoder

**Response Fields**:
```typescript
{
  reference: string;
  smartcardNumber: string;
  customerName: string;
  packageName: string;
  expiryDate: string;      // New expiry date
  balance: number;         // Remaining balance (cents)
  dueDate: string;
}
```

**Purchase Type**: INSTANT_VEND (subscription activated immediately)

**User Journey Example**:
```
User: "Pay my DStv"
Bot: "Please enter your 10-digit DStv smartcard number."
User: "1234567890"
Bot: "Account: John Smith - DStv Premium
     Amount due: R869
     Confirm payment? Reply YES."
User: "YES"
Bot: "✅ DStv paid! Active until 25 Dec 2025."
```

---

### 4. OTT Vouchers (Showmax, BoxOffice, Netflix) 🎬

**Endpoint Pattern**: `/voucher/ott/*`

| Endpoint | Method | Purpose | Request Fields |
|----------|--------|---------|----------------|
| `/voucher/ott/products` | GET | Get OTT products | `providerId` (optional) |
| `/voucher/ott/purchase` | POST | Purchase OTT voucher | `requestId`, `providerId`, `productId`, `amount`, `recipientEmail`, `recipientMsisdn`, `vendMetaData` |

**Providers**:
| Provider ID | Display Name | Products |
|-------------|--------------|----------|
| `showmax` | Showmax | 1 Month, 3 Months |
| `boxoffice` | BoxOffice | Fixed amounts |
| `netflix_pin` | Netflix PIN | R100, R200, R500 |
| `disney_plus` | Disney+ | Subscription codes |
| `amazon_prime` | Amazon Prime | Subscription codes |

**Response Fields**:
```typescript
{
  reference: string;
  voucherCode: string;     // Redemption PIN/code
  voucherSerial: string;
  expiryDate: string;
  productName: string;
  instructions: string;    // How to redeem
}
```

**Purchase Type**: PIN_BASED (returns voucher code)

**User Journey Example**:
```
User: "Buy R99 Showmax"
Bot: "Purchase Showmax 1 Month (R99)?
     Reply YES to confirm."
User: "YES"
Bot: "✅ Showmax voucher purchased!
     Code: SHWM-XXXX-XXXX-XXXX
     Redeem at showmax.com/redeem"
```

---

### 5. Retail Vouchers (Pick n Pay, Shoprite, etc.) 🛒

**Endpoint Pattern**: `/voucher/retail/*`

| Endpoint | Method | Purpose | Request Fields |
|----------|--------|---------|----------------|
| `/voucher/retail/products` | GET | Get voucher products | `retailerId` (optional) |
| `/voucher/retail/purchase` | POST | Purchase voucher | `requestId`, `retailerId`, `productId`, `amount`, `recipientMsisdn`, `vendMetaData` |

**Retailers**:
| Retailer ID | Display Name | Amounts |
|-------------|--------------|---------|
| `picknpay` | Pick n Pay | R50, R100, R200, R500, R1000 |
| `shoprite` | Shoprite | R50, R100, R200, R500 |
| `checkers` | Checkers | R50, R100, R200, R500 |
| `woolworths` | Woolworths | R100, R200, R500, R1000 |
| `spar` | Spar | R50, R100, R200 |
| `game` | Game | R100, R200, R500 |

**Response Fields**:
```typescript
{
  reference: string;
  voucherCode: string;
  voucherSerial: string;
  barcode: string;         // For scanning at till
  barcodeFormat: string;   // CODE128, QR
  expiryDate: string;
  retailerName: string;
  productName: string;
  instructions: string;
}
```

**Purchase Type**: PIN_BASED (returns voucher code/barcode)

**User Journey Example**:
```
User: "Buy R100 Pick n Pay voucher"
Bot: "Purchase R100 Pick n Pay gift voucher?
     Reply YES to confirm."
User: "YES"
Bot: "✅ Voucher purchased!
     Code: PNP-XXXX-XXXX
     Barcode: [barcode image]
     Present at any Pick n Pay till."
```

---

### 6. Betting & Gaming (Hollywoodbets, Betway, etc.) 🎰

**Endpoint Pattern**: `/betting/{provider}/*`

| Endpoint | Method | Purpose | Request Fields |
|----------|--------|---------|----------------|
| `/betting/providers` | GET | List betting providers | - |
| `/betting/{provider}/validate` | GET | Validate account | `accountId` |
| `/betting/{provider}/topup` | POST | Top up account | `requestId`, `accountId`, `accountMsisdn`, `amount`, `vendMetaData` |

**Providers**:
| Provider ID | Display Name |
|-------------|--------------|
| `hollywoodbets` | Hollywoodbets |
| `betway` | Betway |
| `sportingbet` | Sportingbet |
| `sunbet` | Sunbet |
| `supabets` | Supabets |
| `playabets` | Playabets |

**Response Fields**:
```typescript
{
  reference: string;
  providerId: string;
  providerName: string;
  accountId: string;
  newBalance: number;      // Updated account balance
  bonusAmount: number;     // Any bonus credited
}
```

**Purchase Type**: INSTANT_VEND (funds credited immediately)

**User Journey Example**:
```
User: "Top up Hollywoodbets R100"
Bot: "Please enter your Hollywoodbets account number or phone number."
User: "0821234567"
Bot: [validates account]
Bot: "Top up R100 to Hollywoodbets (John S)?
     Reply YES to confirm."
User: "YES"
Bot: "✅ Hollywoodbets topped up!
     New balance: R245
     Bonus: R20 (First deposit bonus)"
```

---

### 7. Generic Vouchers (1Voucher, Flash) 🎫

**Endpoint Pattern**: `/voucher/generic/*`

| Endpoint | Method | Purpose | Request Fields |
|----------|--------|---------|----------------|
| `/voucher/generic/purchase` | POST | Purchase voucher | `requestId`, `providerId`, `productId`, `amount`, `vendMetaData` |

**Providers**: `1voucher`, `flash`, `blu_voucher`

**Response Fields**:
```typescript
{
  reference: string;
  voucherPin: string;
  voucherSerial: string;
  expiryDate: string;
  productName: string;
  instructions: string;
}
```

**Purchase Type**: PIN_BASED

---

## 🧠 NLP Integration for Natural Requests

### Supported Utterances

| Category | Example Utterances |
|----------|-------------------|
| **Airtime** | "Buy R50 airtime", "Recharge", "Top up", "Airtime for my wife" |
| **Data** | "Buy 1GB data", "Get me a data bundle", "Monthly data package" |
| **Electricity** | "Buy R50 electricity", "Recharge my meter", "Power token", "Prepaid" |
| **DStv** | "Pay my DStv", "Reconnect DStv", "DStv subscription" |
| **Showmax** | "Get Showmax", "Showmax voucher", "R50 Showmax" |
| **Retail** | "Pick n Pay voucher", "R100 Shoprite gift card", "Checkers voucher" |
| **Betting** | "Top up Hollywoodbets R100", "Fund Betway", "Deposit to Sportingbet" |

### Mem0 Memory Integration

The NLP system stores user preferences in Mem0:

```typescript
interface VasUserPreferences {
  savedMeterNumbers: Array<{ meterNumber: string; nickname?: string }>;
  savedSmartcards: Array<{ smartcardNumber: string; customerName?: string }>;
  bettingAccounts: Array<{ providerId: string; accountId?: string }>;
  preferredNetwork?: string;
  preferredAmounts?: Record<string, number>;
}
```

**Examples**:
- User buys electricity → meter number saved → next time just "Buy electricity"
- User pays DStv → smartcard saved → next time just "Pay DStv"
- User tops up Hollywoodbets → account saved → next time just "Top up Hollywood R50"

---

## 🏗️ Implementation Status

### ✅ Completed
- [x] TypeScript interfaces for all VAS categories (`vas-types.ts`)
- [x] Extended BluVasClient with all methods (`vas-extended.ts`)
- [x] NLP intents for all VAS categories (`vas-intents.ts`)
- [x] Basic airtime/data working

### 🔄 In Progress
- [ ] VAS catalog schema update (Prisma)
- [ ] BFF routes for new VAS products
- [ ] WhatsApp templates for new products

### 📋 Pending
- [ ] Blu API endpoint verification (need Swagger access)
- [ ] Integration testing
- [ ] Production credentials
- [ ] Mem0 integration for saved preferences

---

## 🗃️ Database Schema Updates

### Extended VasProduct Model

```prisma
model VasProduct {
  id                  String   @id @default(cuid())
  category            String   // AIRTIME | DATA | ELECTRICITY | PAYTV | OTT | RETAIL_VOUCHER | BETTING | VOUCHER
  providerId          String   // Network code or provider ID
  providerName        String   // Display name
  skuCode             String   // Product code
  label               String   // Display label
  priceCents          Int      // Price in cents
  purchaseType        String   // INSTANT_VEND | PIN_BASED | TOKEN_BASED | REFERENCE_BASED
  
  // Category-specific fields
  unitType            String?  // CURRENCY | MB | KWH | DAYS
  unitQuantity        Int?     // e.g., 1024 for 1GB, 30 for 30 days
  validityDays        Int?
  
  // Variable amount support
  allowCustomAmount   Boolean  @default(false)
  minCents            Int?
  maxCents            Int?
  stepCents           Int?
  
  // Metadata
  targetType          String   // MSISDN | METER_NUMBER | SMARTCARD | ACCOUNT_ID
  metadata            Json?
  active              Boolean  @default(true)
  
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@unique([category, providerId, skuCode])
  @@index([category, providerId])
  @@index([active, category])
}
```

### User Saved Accounts

```prisma
model UserSavedAccount {
  id              String   @id @default(cuid())
  accountId       String   // WaPay account ID
  category        String   // ELECTRICITY | PAYTV | BETTING
  providerId      String?  // e.g., "hollywoodbets"
  identifier      String   // Meter number, smartcard, betting account
  nickname        String?  // "Home", "Mom's place"
  customerName    String?  // Name from validation
  metadata        Json?
  lastUsed        DateTime @default(now())
  createdAt       DateTime @default(now())

  @@unique([accountId, category, identifier])
  @@index([accountId, category])
}
```

---

## 📡 API Verification Needed

**Action Required**: Access Blu Swagger UI to verify these endpoints exist:

```bash
# QA Environment
Base URL: https://api.qa.bltelecoms.net/v2/api/trade
Swagger: https://api.qa.bltelecoms.net/swagger-ui.html

Username: bld
Password: ornuk3i9vseei125s8qea71kub
API Key: e73d6237-0864-4c87-ba40-e520e951b336
```

**Verify**:
1. `GET /electricity/meter/validate` - Does it exist?
2. `POST /electricity/sales` - Does it exist?
3. `GET /paytv/dstv/account` - Does it exist?
4. `POST /paytv/dstv/payments` - Does it exist?
5. `GET /voucher/ott/products` - Does it exist?
6. `POST /voucher/ott/purchase` - Does it exist?
7. `GET /voucher/retail/products` - Does it exist?
8. `POST /voucher/retail/purchase` - Does it exist?
9. `GET /betting/providers` - Does it exist?
10. `POST /betting/{provider}/topup` - Does it exist?

---

## 🔄 Next Steps

### Phase 1: API Verification (Day 1)
1. Access Blu Swagger UI
2. Document actual endpoint paths and request/response structures
3. Update `vas-extended.ts` with correct endpoints

### Phase 2: BFF Routes (Day 2)
1. Create preview/execute routes for each VAS category
2. Wire NLP → BFF routing

### Phase 3: WhatsApp Templates (Day 3)
1. Create confirmation templates for each VAS type
2. Create receipt templates
3. Submit to Meta for approval

### Phase 4: Integration Testing (Day 4-5)
1. Test each VAS flow end-to-end
2. Test error handling
3. Test idempotency

### Phase 5: Mem0 Integration (Day 6)
1. Implement preference storage
2. Implement preference retrieval
3. Test "remember my meter" flows

---

## 📞 Support

**Blu Support**: Contact Blu for Swagger access and endpoint verification

**WaPay Team**: Use this document as the implementation guide

---

**Document Version**: 1.0  
**Last Updated**: November 25, 2025  
**Status**: Implementation Ready (pending Blu API verification)

