-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('LIMIT', 'MARKET');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('ACTIVE', 'HALTED', 'DELISTED');

-- CreateEnum
CREATE TYPE "LedgerReason" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRADE', 'FEE', 'LOCK', 'UNLOCK', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WithdrawStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "kycLevel" INTEGER NOT NULL DEFAULT 1,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 8,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "baseAsset" TEXT NOT NULL,
    "quoteAsset" TEXT NOT NULL,
    "tickSize" BIGINT NOT NULL,
    "lotSize" BIGINT NOT NULL,
    "minNotional" BIGINT NOT NULL,
    "makerFeeBps" INTEGER NOT NULL DEFAULT 8,
    "takerFeeBps" INTEGER NOT NULL DEFAULT 10,
    "status" "MarketStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Balance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "available" BIGINT NOT NULL DEFAULT 0,
    "locked" BIGINT NOT NULL DEFAULT 0,
    "lastEngineSeq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "Balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "clientOrderId" TEXT,
    "userId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "price" BIGINT,
    "quantity" BIGINT NOT NULL,
    "quoteQuantity" BIGINT,
    "filledQuantity" BIGINT NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "postOnly" BOOLEAN NOT NULL DEFAULT false,
    "ioc" BOOLEAN NOT NULL DEFAULT false,
    "rejectReason" TEXT,
    "engineSeq" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "engineSeq" BIGINT NOT NULL,
    "market" TEXT NOT NULL,
    "price" BIGINT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "makerOrderId" TEXT NOT NULL,
    "takerOrderId" TEXT NOT NULL,
    "makerUserId" TEXT NOT NULL,
    "takerUserId" TEXT NOT NULL,
    "takerSide" "OrderSide" NOT NULL,
    "makerFee" BIGINT NOT NULL,
    "takerFee" BIGINT NOT NULL,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id","createdAt")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "reason" "LedgerReason" NOT NULL,
    "refId" TEXT,
    "engineSeq" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "WithdrawStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "meta" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_symbol_key" ON "Asset"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "Market_symbol_key" ON "Market"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "Balance_userId_assetId_key" ON "Balance"("userId", "assetId");

-- CreateIndex
CREATE INDEX "Order_userId_market_status_idx" ON "Order"("userId", "market", "status");

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_userId_clientOrderId_key" ON "Order"("userId", "clientOrderId");

-- CreateIndex
CREATE INDEX "Trade_market_createdAt_idx" ON "Trade"("market", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_makerUserId_createdAt_idx" ON "Trade"("makerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_takerUserId_createdAt_idx" ON "Trade"("takerUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_engineSeq_createdAt_key" ON "Trade"("engineSeq", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_engineSeq_userId_asset_reason_key" ON "LedgerEntry"("engineSeq", "userId", "asset", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- AddForeignKey
ALTER TABLE "Balance" ADD CONSTRAINT "Balance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Balance" ADD CONSTRAINT "Balance_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
