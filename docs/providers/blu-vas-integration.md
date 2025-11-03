# Blu VAS (Value Added Services) Integration Reference

## 📋 Overview

**Blu VAS** provides Mobile Airtime and Mobile Data Bundle purchasing services. This document provides complete integration details for WaPay developers.

**Status**: ✅ Ready for Implementation  
**Last Updated**: November 1, 2025  
**API Version**: v2

---

## 🔐 Authentication

### QA Environment Credentials

**Base URL**: `https://api.qa.bltelecoms.net/v2/api/trade`  
**Swagger UI**: https://api.qa.bltelecoms.net/swagger-ui.html

```bash
USERNAME: bld
PASSWORD: ornuk3i9vseei125s8qea71kub
API_KEY: e73d6237-0864-4c87-ba40-e520e951b336
```

### Auth Method

**HTTP Basic Authentication** + **API Key Header**

```http
Authorization: Basic base64(username:password)
apikey: e73d6237-0864-4c87-ba40-e520e951b336
Content-Type: application/json
```

### Example Auth Header

```typescript
const basic = Buffer.from('bld:ornuk3i9vseei125s8qea71kub').toString('base64');

const headers = {
  'Authorization': `Basic ${basic}`,
  'apikey': 'e73d6237-0864-4c87-ba40-e520e951b336',
  'Content-Type': 'application/json'
};
```

---

## 📱 Mobile Airtime API

### 1. Purchase Airtime

**Endpoint**: `POST /mobile/airtime/sales`

**Purpose**: Purchase prepaid airtime for a mobile number

#### Request

```json
{
  "requestId": "wapay-air-1730476800123",
  "vendorId": "vodacom",
  "mobileNumber": "0821234567",
  "amount": 5000,
  "vendMetaData": {
    "transactionRequestDateTime": "2025-11-01T14:07:41+02:00",
    "transactionReference": "WAPAY-je_abc123",
    "vendorId": "WAPAY-001",
    "deviceId": "WHATSAPP-BOT",
    "consumerAccountNumber": "cust-123",
    "cellphoneNumber": "0821234567"
  }
}
```

#### Request Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `requestId` | string | ✅ YES | **Idempotency key** - Client generated unique identifier |
| `vendorId` | string | ✅ YES | Network identifier (e.g., "vodacom", "mtn", "cellc", "telkom") |
| `mobileNumber` | string | ✅ YES | Phone number (10-14 digits, format: "0821234567") |
| `amount` | integer | ✅ YES | Amount in **cents** including VAT (e.g., 5000 = R50.00) |
| `vendMetaData` | object | ❌ Optional | Transaction metadata for tracking/reconciliation |

#### Response (Success - 200 OK)

```json
{
  "requestId": "wapay-air-1730476800123",
  "reference": "0902834592",
  "amount": 5000,
  "dateTime": "2025-11-01T14:07:41+02:00",
  "mobileNumber": "0821234567",
  "vendorName": "Vodacom",
  "vendorReference": "06876844"
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string | Echoed request identifier |
| `reference` | string | **Blu transaction reference** (store as `providerRef`) |
| `amount` | integer | Amount in cents |
| `dateTime` | string | ISO 8601 timestamp |
| `mobileNumber` | string | Phone number |
| `vendorName` | string | Network display name (e.g., "Vodacom") |
| `vendorReference` | string | Vendor's transaction reference |

---

### 2. Check Mobile Number (Network Detection)

**Endpoint**: `GET /mobile/airtime/mobile-number/check`

**Purpose**: Detect which network a phone number belongs to

#### Request

```http
GET /mobile/airtime/mobile-number/check?mobileNumber=0821234567
```

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mobileNumber` | string | ✅ YES | Phone number to check |

#### Response (Success - 200 OK)

```json
{
  "requestId": "auto-generated",
  "dateTime": "2025-11-01T14:07:41+02:00",
  "mobileNumber": "0821234567",
  "vendorName": "Vodacom",
  "vendorReference": "2025041713034962200"
}
```

**Key Field**: `vendorName` - Use this to auto-detect network!

---

### 3. Get Airtime Vendors

**Endpoint**: `GET /mobile/airtime/products`

**Purpose**: Get list of available mobile network operators

#### Request

```http
GET /mobile/airtime/products
```

#### Response (Success - 200 OK)

```json
[
  {
    "id": "vodacom",
    "name": "Vodacom",
    "category": "airtime"
  },
  {
    "id": "mtn",
    "name": "MTN",
    "category": "airtime"
  },
  {
    "id": "cellc",
    "name": "Cell C",
    "category": "airtime"
  },
  {
    "id": "telkom",
    "name": "Telkom",
    "category": "airtime"
  }
]
```

---

## 📊 Mobile Data API

### 1. Get Data Products (Bundle Catalog)

**Endpoint**: `GET /mobile/data/products`

**Purpose**: Get list of available data bundles for a specific network

#### Request

```http
GET /mobile/data/products?vendorId=vodacom
```

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vendorId` | string | ❌ Optional | Filter by network (omit to get all) |

#### Response (Success - 200 OK)

```json
[
  {
    "id": "042",
    "name": "Vodacom 1GB 30-Day",
    "category": "data",
    "vendorId": "vodacom",
    "amount": 3500
  },
  {
    "id": "043",
    "name": "Vodacom 500MB 7-Day",
    "category": "data",
    "vendorId": "vodacom",
    "amount": 2500
  },
  {
    "id": "044",
    "name": "Cell C R20 Chat (14 days)",
    "category": "data",
    "vendorId": "cellc",
    "amount": 2000
  }
]
```

#### Product Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | **Product identifier** (use as `productId` in purchase) |
| `name` | string | Display name of bundle |
| `category` | string | Type: "data", "sms", etc. |
| `vendorId` | string | Network identifier |
| `amount` | integer | Price in cents including VAT |

---

### 2. Purchase Data Bundle

**Endpoint**: `POST /mobile/data/sales`

**Purpose**: Purchase a data bundle for a mobile number

#### Request

```json
{
  "requestId": "wapay-data-1730476800456",
  "vendorId": "vodacom",
  "productId": "042",
  "mobileNumber": "0821234567",
  "vendMetaData": {
    "transactionRequestDateTime": "2025-11-01T14:07:41+02:00",
    "transactionReference": "WAPAY-je_xyz789",
    "vendorId": "WAPAY-001",
    "deviceId": "WHATSAPP-BOT",
    "consumerAccountNumber": "cust-123",
    "cellphoneNumber": "0821234567"
  }
}
```

#### Request Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `requestId` | string | ✅ YES | **Idempotency key** |
| `vendorId` | string | ✅ YES | Network identifier |
| `productId` | string | ✅ YES | Bundle product ID (from catalog) |
| `mobileNumber` | string | ✅ YES | Phone number (10-14 digits) |
| `vendMetaData` | object | ❌ Optional | Transaction metadata |

#### Response (Success - 200 OK)

```json
{
  "requestId": "wapay-data-1730476800456",
  "reference": "BLU-DATA-123456",
  "amount": 3500,
  "dateTime": "2025-11-01T14:07:41+02:00",
  "mobileNumber": "0821234567",
  "productName": "Vodacom 1GB 30-Day",
  "vendorName": "Vodacom",
  "vendorReference": "06876844"
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string | Echoed request identifier |
| `reference` | string | **Blu transaction reference** |
| `amount` | integer | Price in cents |
| `dateTime` | string | ISO 8601 timestamp |
| `mobileNumber` | string | Phone number |
| `productName` | string | Bundle name |
| `vendorName` | string | Network display name |
| `vendorReference` | string | Vendor's transaction reference |

---

## 🌐 Network Identifiers (vendorId)

### Supported Networks

| Network | `vendorId` | Display Name |
|---------|-----------|--------------|
| Vodacom | `vodacom` | Vodacom |
| MTN | `mtn` | MTN |
| Cell C | `cellc` | Cell C |
| Telkom | `telkom` | Telkom |

**Note**: Values are **lowercase** in requests, but `vendorName` in responses uses proper casing.

---

## 📞 Phone Number Format

### Format Rules

- ✅ **Accepted**: `0821234567` (starts with 0, 10 digits)
- ✅ **Accepted**: `27821234567` (country code without +, 11 digits)
- ❌ **Not Accepted**: `+27821234567` (no + symbol)
- ❌ **Not Accepted**: `082 123 4567` (no spaces)

### WaPay Normalization

```typescript
// Our internal format: +27821234567
// Blu format: 0821234567

function toBluFormat(msisdn: string): string {
  // Remove + and convert +27 to 0
  if (msisdn.startsWith('+27')) {
    return '0' + msisdn.substring(3);
  }
  return msisdn;
}

// Example:
toBluFormat('+27821234567') // Returns: "0821234567"
```

---

## 🔄 VendMetaData (Transaction Metadata)

### Purpose

Optional metadata for:
- ✅ Transaction tracking across systems
- ✅ Reconciliation with Blu
- ✅ Support query resolution
- ✅ Customer analytics
- ✅ Audit trail

### Structure

```typescript
interface VendMetaData {
  transactionRequestDateTime: string;  // ISO 8601
  transactionReference: string;        // WaPay journal entry ID
  vendorId: string;                    // "WAPAY-001" (our system ID)
  deviceId: string;                    // "WHATSAPP-BOT" (channel)
  consumerAccountNumber: string;       // WaPay customer ID
  cellphoneNumber: string;             // Customer phone
  clientId?: string;                   // Optional: WhatsApp ID
  emailAddress?: string;               // Optional: Customer email
}
```

### WaPay Implementation

```typescript
function buildVendMetaData(params: {
  accountId: string;
  journalEntryId: string;
  msisdn: string;
}): VendMetaData {
  return {
    transactionRequestDateTime: new Date().toISOString(),
    transactionReference: `WAPAY-${params.journalEntryId}`,
    vendorId: 'WAPAY-001',
    deviceId: 'WHATSAPP-BOT',
    consumerAccountNumber: params.accountId,
    cellphoneNumber: toBluFormat(params.msisdn),
  };
}
```

---

## 🚨 Error Handling

### Error Response Structure

```json
{
  "timestamp": "2025-11-01T14:07:41+02:00",
  "status": 400,
  "error": "Bad Request",
  "message": "Invalid mobile number format",
  "path": "/mobile/airtime/sales"
}
```

### Error Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string | ISO 8601 date time of error |
| `status` | integer | HTTP status code |
| `error` | string | HTTP status reason phrase |
| `message` | string | **Error detail** (use for logging/user messages) |
| `path` | string | Endpoint that was requested |

### WaPay Error Mapping

| HTTP Status | Blu Error (examples) | WaPay Code | User Message |
|-------------|---------------------|------------|--------------|
| `400` | "Invalid mobile number" | `USER_INPUT` | "Invalid phone number. Please check and try again." |
| `400` | "Invalid vendor" | `USER_INPUT` | "Network not supported." |
| `400` | "Invalid product" | `USER_INPUT` | "Bundle not available." |
| `400` | "Insufficient balance" | `USER_INPUT` | "Insufficient balance for this purchase." |
| `401` | "Unauthorized" | `AUTH` | "Authentication failed. Please contact support." |
| `404` | "Product not found" | `USER_INPUT` | "Bundle not found. Please select another." |
| `409` | "Duplicate transaction" | `USER_INPUT` | "This transaction was already processed." |
| `429` | "Rate limit exceeded" | `RETRYABLE` | "Too many requests. Please try again shortly." |
| `500`, `502`, `503` | Server errors | `RETRYABLE` | "Service temporarily unavailable. Please try again." |

### Error Handling Strategy

```typescript
async function handleBluError(error: any): Promise<never> {
  const status = error.statusCode || 500;
  const message = error.body?.message || 'Unknown error';
  
  if (status === 400 || status === 404 || status === 409) {
    const err = new Error('USER_INPUT');
    (err as any).reason = message;
    throw err;
  }
  
  if (status === 401 || status === 403) {
    const err = new Error('AUTH');
    (err as any).reason = message;
    throw err;
  }
  
  // 429, 500, 502, 503
  throw new Error('RETRYABLE');
}
```

---

## 🔄 Idempotency

### How It Works

- ✅ Same `requestId` = Same result (no duplicate transaction)
- ✅ Blu caches responses for duplicate `requestId`
- ✅ Safe to retry on timeout

### WaPay Implementation

```typescript
// Generate idempotency key
const idemKey = `wapay-air-${Date.now()}-${accountId}`;

// Store in database BEFORE calling Blu
await prisma.providerRequest.create({
  data: {
    idemKey,
    route: 'airtime',
    status: 'PENDING',
    accountId,
  }
});

// Call Blu (safe to retry)
const result = await bluClient.purchaseAirtime({
  requestId: idemKey,
  ...params
});

// Update database
await prisma.providerRequest.update({
  where: { idemKey },
  data: {
    status: 'SUCCESS',
    providerRef: result.reference,
  }
});
```

---

## ⏱️ Timeouts & Retries

### Recommended Settings

```typescript
const config = {
  bodyTimeout: 60000,      // 60 seconds (Blu recommends this)
  headersTimeout: 60000,   // 60 seconds
  maxRetries: 2,           // Retry twice on network errors
  retryDelay: 1000,        // 1 second between retries
};
```

### Retry Strategy

- ✅ **Retry on**: Network errors, timeouts
- ❌ **Don't retry on**: 4xx errors (except 429)
- ✅ **Use exponential backoff**: 1s, 2s, 4s

```typescript
async function callBluWithRetry(fn: () => Promise<any>, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      // Don't retry user errors
      if (error.message === 'USER_INPUT' || error.message === 'AUTH') {
        throw error;
      }
      
      // Last attempt - throw error
      if (attempt === maxAttempts) {
        throw new Error('RETRYABLE');
      }
      
      // Exponential backoff
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}
```

---

## 🧪 Testing

### Test Phone Numbers

**Provided by Blu**: (Check email attachment for test numbers)

### Test Scenarios

1. **Valid Airtime Purchase**
   - Amount: R10 (1000 cents)
   - Expected: Success response with reference

2. **Valid Data Purchase**
   - Product: Smallest bundle
   - Expected: Success response with bundle name

3. **Network Detection**
   - Number: Test number from Blu
   - Expected: Correct vendor name

4. **Invalid Phone Number**
   - Number: "123"
   - Expected: 400 Bad Request

5. **Duplicate Transaction**
   - Same `requestId` twice
   - Expected: Same response (idempotent)

6. **Timeout Simulation**
   - Use very short timeout
   - Expected: Retry logic works

---

## 📊 WaPay Integration Architecture

### Flow Diagram

```
Customer → WhatsApp → NLP → BFF → BluVasClient → Blu API
                                ↓
                            Database
                                ↓
                            Ledger
                                ↓
                          WhatsApp Receipt
```

### Component Responsibilities

1. **NLP**: Extract intent, entities (amount, network, phone)
2. **BFF**: Validate, check balance, enforce limits
3. **BluVasClient**: Call Blu API, handle errors, retry
4. **Database**: Store transaction, metadata, status
5. **Ledger**: Post journal entries (Dr Wallet / Cr Payables)
6. **WhatsApp**: Send receipts to customer

---

## 🔧 Implementation Checklist

### Phase 1: Client Implementation
- [ ] Create `BluVasClient` class
- [ ] Implement `purchaseAirtime()`
- [ ] Implement `purchaseDataBundle()`
- [ ] Implement `checkMobileNumber()`
- [ ] Implement `getDataProducts()`
- [ ] Add timeout & retry logic
- [ ] Add error mapping
- [ ] Add vendMetaData builder
- [ ] Add phone number normalization

### Phase 2: BFF Routes
- [ ] `POST /api/vas/airtime/preview`
- [ ] `POST /api/vas/airtime/execute`
- [ ] `POST /api/vas/data/preview`
- [ ] `POST /api/vas/data/execute`
- [ ] `GET /api/vas/bundles/:network`
- [ ] Add balance checking
- [ ] Add limit enforcement
- [ ] Add PIN verification

### Phase 3: Integration
- [ ] Wire NLP → BFF routes
- [ ] Add ledger postings
- [ ] Add WhatsApp receipts
- [ ] Add to observability (Sentry, logs)
- [ ] Update database schema
- [ ] Add environment variables

### Phase 4: Testing
- [ ] Test airtime purchase (all networks)
- [ ] Test data purchase (all networks)
- [ ] Test network detection
- [ ] Test error scenarios
- [ ] Test idempotency
- [ ] Test retries
- [ ] Test end-to-end flow

---

## 🚀 Deployment

### Environment Variables

```bash
# Blu VAS API
BLU_BASE_URL=https://api.qa.bltelecoms.net/v2/api/trade
BLU_BASIC_USER=bld
BLU_BASIC_PASS=ornuk3i9vseei125s8qea71kub
BLU_API_KEY=e73d6237-0864-4c87-ba40-e520e951b336

# Feature Flags
ENABLE_BLU_VAS=true
```

### Vercel Setup

1. Go to: https://vercel.com/finfy-ai/wapay
2. Settings → Environment Variables
3. Add all variables above
4. Redeploy

---

## 📞 Support

### Blu Support Contact

**Email**: (Check original email for contact)  
**Offer**: Session available early next week to address questions

### WaPay Internal

**Developer**: AI Assistant  
**Documentation**: This file  
**Code**: `packages/providers/blu/src/vas.ts`

---

## 📝 Notes for Developers

### Key Differences: Airtime vs Data

| Aspect | Airtime | Data |
|--------|---------|------|
| Amount | `amount` (cents) | `productId` (from catalog) |
| Flexibility | Any amount | Pre-defined bundles |
| Catalog | Not needed | Required (GET /products) |
| Preview | Optional | Recommended (show bundle details) |

### Phone Number Handling

```typescript
// Always normalize before calling Blu
const bluNumber = toBluFormat(msisdn);

// Always store in our format
const ourNumber = toWaPayFormat(bluNumber); // +27...
```

### Metadata Strategy

```typescript
// ALWAYS include vendMetaData for:
// 1. Reconciliation
// 2. Support queries
// 3. Analytics
// 4. Audit trail

const metadata = buildVendMetaData({
  accountId: 'cust-123',
  journalEntryId: 'je_abc123',
  msisdn: '+27821234567'
});
```

### Error Messages

```typescript
// User-friendly messages (don't expose technical details)
const userMessages = {
  USER_INPUT: 'Please check your details and try again.',
  AUTH: 'Service temporarily unavailable. Please contact support.',
  RETRYABLE: 'Service temporarily unavailable. Please try again in a moment.',
};
```

---

## 🎯 Success Criteria

### MVP Launch Requirements

- ✅ Airtime purchase works (all 4 networks)
- ✅ Data purchase works (all 4 networks)
- ✅ Network auto-detection works
- ✅ Error handling works
- ✅ Idempotency works
- ✅ Receipts sent via WhatsApp
- ✅ Ledger balanced
- ✅ Metadata tracked

### Performance Targets

- ✅ 95% success rate
- ✅ < 5s response time (p95)
- ✅ < 1% timeout rate
- ✅ 100% idempotent replay success

---

## 📚 Additional Resources

- **Swagger UI**: https://api.qa.bltelecoms.net/swagger-ui.html
- **JSON Spec**: (See top left of Swagger UI)
- **Test Numbers**: (Check Blu email attachment)
- **Support**: Contact Blu for session

---

**Document Version**: 1.0  
**Last Updated**: November 1, 2025  
**Status**: ✅ Ready for Implementation


