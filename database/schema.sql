-- Astra conversation storage. CREATE IF NOT EXISTS keeps existing Prisma-created
-- tables and their data intact when the Python API starts.
CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Conversation" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL DEFAULT 'New chat',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "ownerId" TEXT REFERENCES "User"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "Conversation_ownerId_updatedAt_idx" ON "Conversation"("ownerId", "updatedAt");

-- Existing Prisma-created tables may have no database default for @updatedAt.
ALTER TABLE "Conversation" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS "Message" (
  "id" TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Attachment" (
  "id" TEXT PRIMARY KEY,
  "messageId" TEXT NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE,
  "groupId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "frameIndex" INTEGER,
  "frameTime" DOUBLE PRECISION,
  "data" BYTEA,
  "extractedText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "Conversation_updatedAt_idx" ON "Conversation"("updatedAt");
CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "Attachment_messageId_idx" ON "Attachment"("messageId");
CREATE INDEX IF NOT EXISTS "Attachment_groupId_idx" ON "Attachment"("groupId");
