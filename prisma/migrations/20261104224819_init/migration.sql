-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'zh',
    "ageConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuerySession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stateVersion" INTEGER NOT NULL DEFAULT 1,
    "queryText" VARCHAR(200) NOT NULL,
    "queryKind" TEXT NOT NULL,
    "filtersJson" JSONB NOT NULL DEFAULT '{}',
    "pageToken" TEXT,
    "pageNumber" INTEGER NOT NULL DEFAULT 0,
    "itemsJson" JSONB NOT NULL DEFAULT '[]',
    "view" TEXT NOT NULL DEFAULT 'results',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuerySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCall" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "statusCategory" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "errorType" TEXT,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramUserId_key" ON "User"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "User_chatId_key" ON "User"("chatId");

-- CreateIndex
CREATE INDEX "QuerySession_expiresAt_idx" ON "QuerySession"("expiresAt");

-- CreateIndex
CREATE INDEX "QuerySession_userId_expiresAt_idx" ON "QuerySession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "ProviderCall_createdAt_idx" ON "ProviderCall"("createdAt");

-- AddForeignKey
ALTER TABLE "QuerySession" ADD CONSTRAINT "QuerySession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
