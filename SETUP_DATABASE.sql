-- WaPay Database Setup Script
-- Run this in Supabase SQL Editor to create all tables

-- ============================================
-- Migration 000_init: Create base tables
-- ============================================

-- CreateTable
CREATE TABLE IF NOT EXISTS "Account" (
    "id" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "msisdn" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Wallet" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ZAR',
    "availableCents" INTEGER NOT NULL DEFAULT 0,
    "pendingCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "JournalEntry" (
    "id" TEXT NOT NULL,
    "externalRef" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "debitCents" INTEGER,
    "creditCents" INTEGER,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProviderRequest" (
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
CREATE TABLE IF NOT EXISTS "AuthSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lastPinAt" TIMESTAMP(3),
    "deviceBinding" TEXT,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Limit" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "dailyCents" INTEGER NOT NULL DEFAULT 0,
    "monthlyCents" INTEGER NOT NULL DEFAULT 0,
    "usedTodayCents" INTEGER NOT NULL DEFAULT 0,
    "usedMonthCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "VasProduct" (
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
CREATE TABLE IF NOT EXISTS "YoyoInstrument" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "yoyoAccountId" TEXT NOT NULL,
    "cardId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YoyoInstrument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Account_waId_key" ON "Account"("waId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderRequest_idemKey_key" ON "ProviderRequest"("idemKey");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "YoyoInstrument_accountId_key" ON "YoyoInstrument"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "YoyoInstrument_yoyoAccountId_key" ON "YoyoInstrument"("yoyoAccountId");

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

-- ============================================
-- Migration 001: Add WhatsApp Templates
-- ============================================

CREATE TABLE IF NOT EXISTS "WhatsappTemplate" (
    "id" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "category" TEXT,
    "componentsHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WhatsappTemplate_wabaId_name_idx" ON "WhatsappTemplate"("wabaId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappTemplate_wabaId_name_language_key" ON "WhatsappTemplate"("wabaId", "name", "language");

-- ============================================
-- Migration 002: Add Onboarding & Conversation State
-- ============================================

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "onboardingStatus" TEXT DEFAULT 'NEW';
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "conversationState" TEXT;
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "conversationData" JSONB;

-- Update existing accounts to have NEW status
UPDATE "Account" SET "onboardingStatus" = 'NEW' WHERE "onboardingStatus" IS NULL;

-- ============================================
-- Success!
-- ============================================

SELECT 'Database setup complete! ✅' as status;

