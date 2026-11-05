-- AlterTable
ALTER TABLE "QuerySession" ADD COLUMN     "previousPageToken" TEXT,
ADD COLUMN     "totalCount" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "activeSessionId" TEXT;
