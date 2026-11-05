CREATE TABLE "TelegramUpdate" (
  "updateId" INTEGER NOT NULL,
  "payload" JSONB,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TelegramUpdate_pkey" PRIMARY KEY ("updateId")
);
CREATE INDEX "TelegramUpdate_state_updateId_idx" ON "TelegramUpdate"("state", "updateId");
CREATE INDEX "TelegramUpdate_createdAt_idx" ON "TelegramUpdate"("createdAt");
