
> @wapay/domain@0.0.1 prisma:diff:init /Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01/packages/domain
> prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "msisdn" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ZAR',
    "availableCents" INTEGER NOT NULL DEFAULT 0,
    "pendingCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "externalRef" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "debitCents" INTEGER,
    "creditCents" INTEGER,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderRequest" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "idemKey" TEXT NOT NULL,
    "requestTs" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "providerRef" TEXT,
    "redactedPayload" TEXT,
    "responseJson" TEXT,

    CONSTRAINT "ProviderRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lastPinAt" TIMESTAMP(3),
    "deviceBinding" TEXT,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Limit" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "dailyCents" INTEGER NOT NULL DEFAULT 0,
    "monthlyCents" INTEGER NOT NULL DEFAULT 0,
    "usedTodayCents" INTEGER NOT NULL DEFAULT 0,
    "usedMonthCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VasProduct" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "networkCode" TEXT NOT NULL,
    "skuCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unitType" TEXT NOT NULL,
    "unitQuantityMb" INTEGER,
    "priceCents" INTEGER NOT NULL,
    "validityDays" INTEGER,
    "allowCustomAmount" BOOLEAN NOT NULL DEFAULT false,
    "minCents" INTEGER,
    "maxCents" INTEGER,
    "stepCents" INTEGER,
    "targetType" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "VasProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YoyoInstrument" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "yoyoAccountId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YoyoInstrument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_waId_key" ON "Account"("waId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRequest_idemKey_key" ON "ProviderRequest"("idemKey");

-- CreateIndex
CREATE UNIQUE INDEX "YoyoInstrument_accountId_key" ON "YoyoInstrument"("accountId");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Limit" ADD CONSTRAINT "Limit_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YoyoInstrument" ADD CONSTRAINT "YoyoInstrument_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

