CREATE TABLE "UsageEvent" (
 "updateId" INTEGER PRIMARY KEY, "telegramUserId" BIGINT NOT NULL,
 "searches" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "UsageEvent_createdAt_telegramUserId_idx" ON "UsageEvent"("createdAt", "telegramUserId");
CREATE TABLE "StatsState" ("id" TEXT PRIMARY KEY, "messageId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO "StatsState" ("id") VALUES ('usage');
