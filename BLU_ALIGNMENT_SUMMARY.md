# Blu Voucher Client Alignment Summary

## Changes Made

### 1. Updated `BluClient.checkStatus()` 
**File**: `packages/providers/blu/src/client.ts`

- Changed from `POST /voucher/status` to `GET /voucher/variable/vouchers?token={pin}` (per Swagger spec)
- Added `BluVoucherStatus` type export
- Improved status mapping: `ACTIVE`/`VALID` → `ACTIVE`, `USED`/`REDEEMED` → `USED`, `EXPIRED` → `EXPIRED`
- Amount is now correctly parsed as cents (no conversion needed - Blu returns cents)
- Enhanced error logging with full response body for debugging

### 2. Updated `BluClient.redeem()`
**File**: `packages/providers/blu/src/client.ts`

- **Breaking change**: `amountCents` parameter is now REQUIRED
- Signature: `async redeem(pin: string, idemKey: string, amountCents: number)`
- Validates `amountCents` is a positive number, throws error if not
- Request body now uses exact Swagger fields:
  - `requestId`: idempotency key
  - `token`: voucher PIN
  - `amount`: amount in cents (no conversion - Blu expects cents)
- Improved logging to include `amountCents` in request logs
- Response parsing uses correct field names from Swagger

### 3. Added `issueVoucher()` Placeholder
**File**: `packages/providers/blu/src/client.ts`

```typescript
async issueVoucher(params: { amount_cents: number; idemKey: string }): Promise<{ providerRef: string; amount_cents: number }> {
  throw new Error('Blu voucher issuance not implemented yet');
}
```

### 4. Updated All Call Sites

#### `pages/api/webhooks/message-processor-v2.js`
- Now calls `checkStatus()` before `redeem()` to get amount
- Blocks redemption if voucher is USED or EXPIRED
- Returns clear error if amount cannot be determined
- Passes `amount_cents` from status check to `redeem()`

#### `pages/api/webhooks/message-processor.js` (legacy)
- Same changes as v2 for consistency

#### `apps/api/src/routes/deposit.ts`
- Added status pre-check before redemption
- Returns 400 with specific error messages for USED/EXPIRED/UNKNOWN vouchers
- Passes `amount_cents` from status check to `redeem()`

## Key Improvements

1. **Swagger Compliance**: All API calls now match Blu's documented Swagger spec exactly
2. **Better Error Handling**: Pre-checking status prevents unnecessary redemption attempts
3. **Clearer User Feedback**: Users get specific messages for USED/EXPIRED/UNKNOWN vouchers
4. **Type Safety**: Required `amountCents` parameter prevents runtime errors
5. **Better Logging**: Full request/response logging for easier debugging

## Testing Checklist

- [x] TypeScript compilation passes
- [x] All call sites updated
- [x] Code committed and pushed
- [ ] Test with QA voucher PIN (requires Vercel deployment)
- [ ] Verify status check returns correct amount
- [ ] Verify redemption succeeds with correct amount
- [ ] Test USED voucher error handling
- [ ] Test EXPIRED voucher error handling

## Next Steps

1. Wait for Vercel deployment to complete
2. Test with a QA voucher PIN from Blu
3. Monitor logs for any Swagger spec mismatches
4. Document any Blu-specific quirks discovered during testing

## Deployment

Commit: `6ce1db5`  
Branch: `main`  
Status: Pushed to GitHub (Vercel deploying)

