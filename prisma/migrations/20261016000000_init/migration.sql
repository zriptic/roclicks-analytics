-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "AnalyticsGame" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sdkKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastIngestAt" TIMESTAMP(3),
    "devexRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0038,

    CONSTRAINT "AnalyticsGame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsPlayer" (
    "gameId" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "robloxUserId" BIGINT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "playSeconds" INTEGER NOT NULL DEFAULT 0,
    "country" TEXT,

    CONSTRAINT "AnalyticsPlayer_pkey" PRIMARY KEY ("gameId","env","robloxUserId")
);

-- CreateTable
CREATE TABLE "AnalyticsSession" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "robloxUserId" BIGINT NOT NULL,
    "serverId" TEXT NOT NULL,
    "placeId" BIGINT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "country" TEXT,
    "device" TEXT,

    CONSTRAINT "AnalyticsSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" BIGSERIAL NOT NULL,
    "gameId" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "robloxUserId" BIGINT,
    "sessionId" TEXT,
    "value" JSONB,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "z" DOUBLE PRECISION,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsActiveDay" (
    "gameId" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "robloxUserId" BIGINT NOT NULL,
    "day" DATE NOT NULL,

    CONSTRAINT "AnalyticsActiveDay_pkey" PRIMARY KEY ("gameId","env","day","robloxUserId")
);

-- CreateTable
CREATE TABLE "AnalyticsConfig" (
    "gameId" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsConfig_pkey" PRIMARY KEY ("gameId","env")
);

-- CreateTable
CREATE TABLE "AnalyticsUsage" (
    "gameId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "events" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AnalyticsUsage_pkey" PRIMARY KEY ("gameId","month")
);

-- CreateTable
CREATE TABLE "AnalyticsPurchase" (
    "id" BIGSERIAL NOT NULL,
    "gameId" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "robloxUserId" BIGINT NOT NULL,
    "sessionId" TEXT,
    "kind" TEXT NOT NULL,
    "itemId" BIGINT,
    "itemName" TEXT,
    "robux" INTEGER NOT NULL,
    "share" DOUBLE PRECISION NOT NULL,
    "netRobux" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsExperiment" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "variants" JSONB NOT NULL,
    "goal" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "winner" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "AnalyticsExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsExposure" (
    "experimentId" TEXT NOT NULL,
    "robloxUserId" BIGINT NOT NULL,
    "variant" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsExposure_pkey" PRIMARY KEY ("experimentId","robloxUserId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsGame_sdkKey_key" ON "AnalyticsGame"("sdkKey");

-- CreateIndex
CREATE INDEX "AnalyticsGame_ownerId_idx" ON "AnalyticsGame"("ownerId");

-- CreateIndex
CREATE INDEX "AnalyticsPlayer_gameId_env_firstSeenAt_idx" ON "AnalyticsPlayer"("gameId", "env", "firstSeenAt");

-- CreateIndex
CREATE INDEX "AnalyticsSession_gameId_env_startedAt_idx" ON "AnalyticsSession"("gameId", "env", "startedAt");

-- CreateIndex
CREATE INDEX "AnalyticsSession_gameId_env_lastSeenAt_idx" ON "AnalyticsSession"("gameId", "env", "lastSeenAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_gameId_env_at_idx" ON "AnalyticsEvent"("gameId", "env", "at");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_gameId_env_name_at_idx" ON "AnalyticsEvent"("gameId", "env", "name", "at");

-- CreateIndex
CREATE INDEX "AnalyticsPurchase_gameId_env_at_idx" ON "AnalyticsPurchase"("gameId", "env", "at");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsPurchase_gameId_purchaseId_key" ON "AnalyticsPurchase"("gameId", "purchaseId");

-- CreateIndex
CREATE INDEX "AnalyticsExperiment_gameId_env_status_idx" ON "AnalyticsExperiment"("gameId", "env", "status");

-- AddForeignKey
ALTER TABLE "AnalyticsPlayer" ADD CONSTRAINT "AnalyticsPlayer_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "AnalyticsGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsSession" ADD CONSTRAINT "AnalyticsSession_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "AnalyticsGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "AnalyticsGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsActiveDay" ADD CONSTRAINT "AnalyticsActiveDay_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "AnalyticsGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsConfig" ADD CONSTRAINT "AnalyticsConfig_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "AnalyticsGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsUsage" ADD CONSTRAINT "AnalyticsUsage_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "AnalyticsGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsPurchase" ADD CONSTRAINT "AnalyticsPurchase_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "AnalyticsGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsExperiment" ADD CONSTRAINT "AnalyticsExperiment_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "AnalyticsGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsExposure" ADD CONSTRAINT "AnalyticsExposure_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "AnalyticsExperiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

