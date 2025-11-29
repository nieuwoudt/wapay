# Blu OpenAPI / Swagger Integration

This document describes how to import the Blu OpenAPI specification and generate TypeScript types for the WaPay codebase.

## Overview

Blu provides a Swagger/OpenAPI specification for their API which includes:
- **Voucher Redemption API** - Cash-in from Blu vouchers
- **VAS API** - Mobile Airtime, Mobile Data, and other Value Added Services

## Specification Location

- **Swagger UI**: https://api.bluvoucher.co.za/swagger-ui/index.html
- **OpenAPI JSON**: https://api.bluvoucher.co.za/v3/api-docs

> Note: The exact URL may differ between QA and Production environments. Check with Blu for the correct URLs.

## Directory Structure

```
packages/providers/blu/
├── openapi/
│   ├── blu-trade-api.json      # Downloaded OpenAPI spec (gitignored)
│   ├── fetch-spec.sh           # Script to download spec
│   └── generate-types.sh       # Script to generate types
└── src/
    ├── generated/              # Generated TypeScript types
    │   ├── index.ts
    │   ├── types.gen.ts
    │   └── client.gen.ts
    ├── client.ts               # BluClient (voucher redemption)
    └── vas.ts                  # BluVasClient (airtime/data)
```

## Setup

### 1. Install Type Generator

```bash
cd packages/providers/blu
pnpm add -D @hey-api/openapi-ts
```

### 2. Fetch OpenAPI Spec

```bash
cd packages/providers/blu/openapi
chmod +x fetch-spec.sh
./fetch-spec.sh
```

For authenticated endpoints or different environments:

```bash
BLU_OPENAPI_URL="https://qa-api.bluvoucher.co.za/v3/api-docs" ./fetch-spec.sh
```

### 3. Generate TypeScript Types

```bash
chmod +x generate-types.sh
./generate-types.sh
```

## Using Generated Types

After generation, import types in your client code:

```typescript
// packages/providers/blu/src/vas.ts
import type {
  AirtimeSaleRequest,
  AirtimeSaleResponse,
  DataProductResponse,
  DataSaleRequest,
  DataSaleResponse,
} from './generated/types.gen.js';
```

## Maintaining Type Stability

When regenerating types:

1. **Preserve public signatures** - The `BluVasClient` and `BluClient` classes should maintain their existing public method signatures
2. **Map generated types internally** - Use generated types internally but transform to WaPay-specific types for consumers
3. **Version control the spec** - Consider versioning the OpenAPI spec file to track API changes

## Example: Type Mapping

```typescript
// Internal: Use generated Blu types
import type { MobileAirtimeSalesRequest } from './generated/types.gen.js';

// Public: Expose WaPay-specific types
export interface AirtimePurchaseParams {
  msisdn: string;           // WaPay format: +27821234567
  amountCents: number;      // Amount in cents
  vendorId: string;         // Network: vodacom, mtn, cellc, telkom
  idemKey: string;          // Idempotency key
  accountId: string;        // WaPay customer ID
  journalEntryId: string;   // WaPay journal entry ID
}

// In the client method, map between the two:
async purchaseAirtime(params: AirtimePurchaseParams) {
  const bluRequest: MobileAirtimeSalesRequest = {
    requestId: params.idemKey,
    vendorId: params.vendorId,
    mobileNumber: this.toBluFormat(params.msisdn),
    amount: params.amountCents,
    vendMetaData: this.buildVendMetaData({ ... }),
  };
  // ...
}
```

## Refreshing Types

When Blu updates their API:

1. Run `./fetch-spec.sh` to get the latest spec
2. Run `./generate-types.sh` to regenerate types
3. Review changes in `src/generated/`
4. Update any affected client code
5. Run tests to verify compatibility

## Environment-Specific Specs

| Environment | Swagger UI | OpenAPI JSON |
|-------------|------------|--------------|
| QA | `https://qa-api.bluvoucher.co.za/swagger-ui/` | `https://qa-api.bluvoucher.co.za/v3/api-docs` |
| Production | `https://api.bluvoucher.co.za/swagger-ui/` | `https://api.bluvoucher.co.za/v3/api-docs` |

## Troubleshooting

### Spec fetch fails
- Check network connectivity
- Verify the URL is correct
- Some endpoints may require authentication

### Type generation errors
- Ensure the spec is valid JSON
- Check for unsupported OpenAPI features
- Review generator output for specific errors

### Type mismatches after update
- Compare old and new spec for breaking changes
- Update client code to handle new/changed fields
- Add migration notes to changelog

## Related Documentation

- [Blu VAS Integration](./blu-vas-integration.md)
- [Blu VAS Catalogue](./blu-vas-catalogue.md)

