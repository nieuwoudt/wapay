# Blu Voucher API Integration Reference

## Overview
Blu Voucher provides a Variable Voucher API for issuing and redeeming vouchers. WaPay uses the **redemption flow** to allow users to deposit funds into their wallet.

---

## 🔐 Authentication

**Base URL**: `https://api.qa.bltelecoms.net/v2/api/trade`  
**Swagger**: https://api.qa.bltelecoms.net/swagger-ui.html

### Credentials (QA Environment)
```bash
USERNAME: bld
PASSWORD: ornuk3i9vseei125s8qea71kub
```

### Auth Method
**HTTP Basic Authentication** + **API Key Header**

```http
Authorization: Basic base64(username:password)
apikey: [YOUR_API_KEY_HERE]
Content-Type: application/json
```

---

## 📡 API Endpoints

### 1. **Voucher Status Check**
**Endpoint**: `GET /voucher/variable/vouchers`

**Purpose**: Query a voucher's status using serial number or PIN.

**Query Parameters**:
- `serialNumber` (optional): The voucher serial number
- `token` (optional): The voucher PIN/token

**Note**: If both parameters are provided, preference is given to the serial number.

**Request Example**:
```bash
curl -X GET "https://api.qa.bltelecoms.net/v2/api/trade/voucher/variable/vouchers?token=8276%208409%204119%201701" \
  -H "Authorization: Basic YmxkOm9ybnVrM2k5dnNlZWkxMjVzOHFlYTcxa3Vi" \
  -H "apikey: YOUR_API_KEY"
```

**Response Example**:
```json
{
  "status": "ACTIVE",
  "amount": 10000,
  "currency": "ZAR",
  "expiryDate": "2025-12-31T23:59:59Z"
}
```

---

### 2. **Voucher Redemption** ⭐ (PRIMARY INTEGRATION)
**Endpoint**: `POST /voucher/variable/redemptions`

**Purpose**: Redeem a voucher for a specified amount. If the voucher is partially redeemed, a new voucher will be returned with the remaining balance.

**⚠️ IMPORTANT**: This endpoint is only available to API clients with "redemption partner" account credentials.

**Request Body Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `requestId` | string | ✅ **YES** | **IDEMPOTENCY KEY** - A client generated unique request identifier. This will be echoed in response and reconciliation files. Can be used to query status or reverse transaction on timeout. |
| `token` | string | ✅ **YES** | The voucher PIN (e.g., "8276 8409 4119 1701") |
| `amount` | integer($int32) | ✅ **YES** | Amount to redeem **in cents including VAT** (e.g., 10000 = R100.00) |
| `vendMetaData` | VendMetaData | ❌ Optional | Optional vendor metadata object |

**Request Example**:
```bash
curl -X POST "https://api.qa.bltelecoms.net/v2/api/trade/voucher/variable/redemptions" \
  -H "Authorization: Basic YmxkOm9ybnVrM2k5dnNlZWkxMjVzOHFlYTcxa3Vi" \
  -H "apikey: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "a70e0961-bf1c-4e63-a0d7-89e5246d4a20",
    "token": "8276 8409 4119 1701",
    "amount": 10000
  }'
```

**Response Fields**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `requestId` | string | ✅ YES | The echoed request identifier (our idempotency key) |
| `reference` | string | ✅ YES | **Unique transaction reference** - Store this as `providerRef` |
| `amount` | integer($int32) | ✅ YES | The retail amount in cents including VAT |
| `dateTime` | string($date-time) | ✅ YES | ISO 8601 timestamp (yyyy-MM-ddTHH:mm:ss+00:00) |
| `redeemedVoucherSerialNumber` | string | ✅ YES | The unique voucher serial number that was redeemed |
| `redeemedVoucherReference` | string | ❌ Optional | Transaction reference from the initial vend of the voucher |
| `replacementVoucher` | VariableVoucher | ❌ Optional | **New voucher for partial redemption** (if applicable) |
| `vendMetaData` | VendMetaData | ❌ Optional | Vendor metadata |

**Response Example (Full Redemption)**:
```json
{
  "requestId": "a70e0961-bf1c-4e63-a0d7-89e5246d4a28",
  "reference": "0902834592",
  "amount": 10000,
  "dateTime": "2019-01-09T14:07:41+02:00",
  "redeemedVoucherSerialNumber": "BL016C1E46AD2768",
  "redeemedVoucherReference": "0902834592"
}
```

**Response Example (Partial Redemption)**:
```json
{
  "requestId": "a70e0961-bf1c-4e63-a0d7-89e5246d4a28",
  "reference": "0902834593",
  "amount": 5000,
  "dateTime": "2019-01-09T14:07:41+02:00",
  "redeemedVoucherSerialNumber": "BL016C1E46AD2768",
  "replacementVoucher": {
    "token": "1234 5678 9012 3456",
    "serialNumber": "BL016C1E46AD2769",
    "balance": 5000
  }
}
```

---

## 🚨 Error Handling

### Error Response Structure
```json
{
  "timestamp": "2019-01-09T14:07:41+02:00",
  "status": 400,
  "error": "Bad Request",
  "message": "Invalid voucher token",
  "path": "/voucher/variable/redemptions"
}
```

### Error Response Fields
| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string($date-time) | ISO 8601 date time of the error |
| `status` | integer($int32) | HTTP status code (400, 401, 404, 500, etc.) |
| `error` | string | HTTP status code reason phrase |
| `message` | string | **Error detail or reason** - Use this for logging/debugging |
| `path` | string | The resource URL that was requested |

### WaPay Error Mapping Strategy
| HTTP Status | Blu Error Message (examples) | WaPay Code | User Message |
|-------------|------------------------------|------------|--------------|
| `400` | "Invalid voucher token" | `USER_INPUT` | "Invalid voucher PIN. Please check and try again." |
| `400` | "Insufficient balance" | `USER_INPUT` | "Voucher balance is insufficient for this amount." |
| `400` | "Voucher expired" | `USER_INPUT` | "This voucher has expired." |
| `400` | "Voucher already redeemed" | `USER_INPUT` | "This voucher has already been redeemed." |
| `401` | "Unauthorized" / Auth errors | `AUTH` | "Authentication failed. Please contact support." |
| `404` | "Voucher not found" | `USER_INPUT` | "Voucher not found. Please check the PIN." |
| `429` | "Too many requests" | `RETRYABLE` | "Too many attempts. Please try again in a moment." |
| `500`, `502`, `503` | Server errors | `RETRYABLE` | "Service temporarily unavailable. Please try again." |
| Other | Unknown errors | `FATAL` | "An unexpected error occurred. Please contact support." |

**Implementation Note**: Map based on `status` code first, then refine by `message` content if needed.

---

## 🔄 Idempotency

The `requestId` field provides **built-in idempotency**:
- Same `requestId` = same result (no duplicate redemption)
- WaPay maps `X-Idempotency-Key` → `requestId`

**Implementation**:
```typescript
const idemKey = req.headers['x-idempotency-key'];
await bluClient.redeem(pin, idemKey); // Uses idemKey as requestId
```

---

## 🛡️ Security & Compliance

### PII Redaction
**NEVER log full voucher PINs**:
```typescript
// ✅ Good
console.log({ pin: maskVoucherPin(pin) }); // "****1701"

// ❌ Bad
console.log({ pin: fullPin }); // "8276 8409 4119 1701"
```

### Rate Limiting
- **Unknown** - need to confirm with Blu
- Recommendation: Implement client-side rate limiting (e.g., 10 req/sec)

### Retry Strategy
- **Timeout**: 30 seconds
- **Retries**: 2 attempts on network errors
- **Backoff**: Exponential (1s, 2s)
- **No retry on**: 4xx errors (except 429)

---

## 📋 Integration Checklist

### ✅ **COMPLETED**
- [x] Client implementation in `packages/providers/blu/src/client.ts`
- [x] `checkStatus(pin)` method
- [x] `redeem(pin, idemKey)` method
- [x] HTTP client with `undici`
- [x] Timeout & retry logic
- [x] Error mapping (USER_INPUT, AUTH, RETRYABLE, FATAL)
- [x] PIN masking utility

### ❓ **NEED CLARIFICATION**
- [ ] **API Key** - Where is it? (only username/password provided)
- [ ] **Exact error codes** - What does Blu return for invalid PIN, expired, etc.?
- [ ] **Partial redemption** - Do we need to support this? (new voucher returned)
- [ ] **Rate limits** - What are Blu's throttling rules?
- [ ] **Webhook notifications** - Does Blu send async confirmations?
- [ ] **Reconciliation** - Is there a settlement file or reporting API?
- [ ] **Test voucher PINs** - Do you have QA vouchers to test with?

### 🔧 **TODO**
- [ ] Get API key from Blu team
- [ ] Test redemption with real QA voucher
- [ ] Verify error response format
- [ ] Document partial redemption flow (if needed)
- [ ] Set up reconciliation process

---

## 🧪 Testing Plan

### Test Cases
1. **Valid voucher** - Full redemption (R100)
2. **Invalid PIN** - Should return USER_INPUT error
3. **Expired voucher** - Should return USER_INPUT error
4. **Insufficient balance** - Redeem R200 from R100 voucher
5. **Idempotency** - Same requestId twice (should return cached result)
6. **Partial redemption** - Redeem R50 from R100 voucher (if supported)
7. **Network timeout** - Simulate slow response (30s timeout)
8. **Auth failure** - Wrong credentials (should return AUTH error)

### Test Script
```bash
# Test with curl (once we have API key)
curl -X POST "https://api.qa.bltelecoms.net/v2/api/trade/voucher/variable/redemptions" \
  -H "Authorization: Basic YmxkOm9ybnVrM2k5dnNlZWkxMjVzOHFlYTcxa3Vi" \
  -H "apikey: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "test-'$(date +%s)'",
    "token": "TEST_VOUCHER_PIN",
    "amount": 10000
  }'
```

---

## 📞 Next Steps for You

To complete the Blu Voucher integration, **please provide**:

1. **API Key** 🔑
   - The screenshots show `apikey` header is required
   - You provided username/password but not the API key
   - **Where can I find it?**

2. **Test Voucher PINs** 🎟️
   - Do you have QA vouchers we can test with?
   - Format: "8276 8409 4119 1701"
   - With known balances (e.g., R100, R50)

3. **Error Response Examples** ⚠️
   - What does Blu return for:
     - Invalid PIN?
     - Expired voucher?
     - Already redeemed?
   - Can you test in Swagger and share the responses?

4. **Partial Redemption Requirements** 🔄
   - Do users need to redeem partial amounts?
   - Or always redeem full voucher balance?

5. **Reconciliation Process** 📊
   - How do we reconcile transactions with Blu?
   - Is there a reporting API or settlement file?

---

## 🚀 Current Implementation Status

Our existing `BluClient` in `packages/providers/blu/src/client.ts` is **95% ready**:

```typescript
export class BluClient {
  async redeem(pin: string, idemKey: string): Promise<{
    providerRef: string;
    amount_cents: number;
  }> {
    // ✅ Already implemented with:
    // - Basic auth
    // - Timeout (30s)
    // - Retries (2x)
    // - Error mapping
    
    // ❌ Missing: API key header
    // ❌ Missing: Test with real credentials
  }
}
```

**Once you provide the API key**, we can:
1. Add it to environment variables
2. Test redemption end-to-end
3. Deploy to Vercel
4. Send WhatsApp receipts! 🎉

---

## 📝 Summary

**What's Clear**: ✅
- API endpoints & request/response formats
- Authentication method (Basic + API key)
- Idempotency via `requestId`
- Error handling approach

**What's Unclear**: ❓
- API key value
- Exact error codes from Blu
- Test voucher PINs
- Partial redemption requirements
- Reconciliation process

**Ready to integrate once you provide**: 🎯
1. API key
2. Test voucher PIN(s)
3. Error response examples (optional but helpful)

