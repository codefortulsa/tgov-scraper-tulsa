-- CreateTable
CREATE TABLE "Committee" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Committee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingRecord" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "endedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "committeeId" TEXT NOT NULL,
    "videoViewUrl" TEXT,
    "agendaViewUrl" TEXT,
    "rawJson" JSONB NOT NULL,
    "videoId" TEXT,
    "audioId" TEXT,
    "agendaId" TEXT,

    CONSTRAINT "MeetingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Committee_name_key" ON "Committee"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingRecord_name_key" ON "MeetingRecord"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingRecord_committeeId_startedAt_key" ON "MeetingRecord"("committeeId", "startedAt");

-- AddForeignKey
ALTER TABLE "MeetingRecord" ADD CONSTRAINT "MeetingRecord_committeeId_fkey" FOREIGN KEY ("committeeId") REFERENCES "Committee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
