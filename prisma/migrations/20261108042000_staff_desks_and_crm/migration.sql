-- CreateTable
CREATE TABLE "VendorCustomerNote" (
    "id" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "note" TEXT NOT NULL,
    "followUp" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorCustomerNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorPayout" (
    "id" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "reference" VARCHAR(120),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "VendorPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorVisit" (
    "id" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "userId" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpertArticle" (
    "id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "crop" VARCHAR(40) NOT NULL,
    "coverTone" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PUBLISHED',
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "views" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expertId" UUID NOT NULL,

    CONSTRAINT "ExpertArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleLike" (
    "articleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleLike_pkey" PRIMARY KEY ("articleId","userId")
);

-- CreateTable
CREATE TABLE "ArticleSave" (
    "articleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleSave_pkey" PRIMARY KEY ("articleId","userId")
);

-- CreateTable
CREATE TABLE "ArticleRating" (
    "articleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleRating_pkey" PRIMARY KEY ("articleId","userId")
);

-- CreateTable
CREATE TABLE "ArticleComment" (
    "id" UUID NOT NULL,
    "articleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpertQuestion" (
    "id" UUID NOT NULL,
    "farmerId" UUID NOT NULL,
    "expertId" UUID,
    "crop" VARCHAR(40) NOT NULL,
    "question" TEXT NOT NULL,
    "mode" VARCHAR(20) NOT NULL DEFAULT 'message',
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "reply" TEXT,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpertQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultationPlan" (
    "id" UUID NOT NULL,
    "expertId" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "period" VARCHAR(20) NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "perks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultationBooking" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "farmerId" UUID NOT NULL,
    "topic" VARCHAR(200) NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 30,
    "status" VARCHAR(20) NOT NULL DEFAULT 'UPCOMING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpertPeer" (
    "expertId" UUID NOT NULL,
    "peerId" UUID NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpertPeer_pkey" PRIMARY KEY ("expertId","peerId")
);

-- CreateTable
CREATE TABLE "NewsSourceSuggestion" (
    "id" UUID NOT NULL,
    "expertId" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "url" TEXT NOT NULL,
    "note" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsSourceSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorCustomerNote_vendorId_idx" ON "VendorCustomerNote"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorCustomerNote_vendorId_customerId_key" ON "VendorCustomerNote"("vendorId", "customerId");

-- CreateIndex
CREATE INDEX "VendorPayout_vendorId_createdAt_idx" ON "VendorPayout"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "VendorVisit_vendorId_at_idx" ON "VendorVisit"("vendorId", "at");

-- CreateIndex
CREATE INDEX "ExpertArticle_status_publishedAt_idx" ON "ExpertArticle"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "ExpertArticle_crop_idx" ON "ExpertArticle"("crop");

-- CreateIndex
CREATE INDEX "ExpertArticle_expertId_idx" ON "ExpertArticle"("expertId");

-- CreateIndex
CREATE INDEX "ArticleLike_userId_idx" ON "ArticleLike"("userId");

-- CreateIndex
CREATE INDEX "ArticleSave_userId_idx" ON "ArticleSave"("userId");

-- CreateIndex
CREATE INDEX "ArticleComment_articleId_createdAt_idx" ON "ArticleComment"("articleId", "createdAt");

-- CreateIndex
CREATE INDEX "ExpertQuestion_status_createdAt_idx" ON "ExpertQuestion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ExpertQuestion_expertId_idx" ON "ExpertQuestion"("expertId");

-- CreateIndex
CREATE INDEX "ExpertQuestion_farmerId_idx" ON "ExpertQuestion"("farmerId");

-- CreateIndex
CREATE INDEX "ConsultationPlan_expertId_idx" ON "ConsultationPlan"("expertId");

-- CreateIndex
CREATE INDEX "ConsultationBooking_planId_at_idx" ON "ConsultationBooking"("planId", "at");

-- CreateIndex
CREATE INDEX "ConsultationBooking_farmerId_idx" ON "ConsultationBooking"("farmerId");

-- CreateIndex
CREATE INDEX "ExpertPeer_peerId_idx" ON "ExpertPeer"("peerId");

-- CreateIndex
CREATE INDEX "NewsSourceSuggestion_status_idx" ON "NewsSourceSuggestion"("status");

-- CreateIndex
CREATE INDEX "NewsSourceSuggestion_expertId_idx" ON "NewsSourceSuggestion"("expertId");

-- AddForeignKey
ALTER TABLE "VendorCustomerNote" ADD CONSTRAINT "VendorCustomerNote_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCustomerNote" ADD CONSTRAINT "VendorCustomerNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayout" ADD CONSTRAINT "VendorPayout_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorVisit" ADD CONSTRAINT "VendorVisit_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertArticle" ADD CONSTRAINT "ExpertArticle_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleLike" ADD CONSTRAINT "ArticleLike_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "ExpertArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleLike" ADD CONSTRAINT "ArticleLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleSave" ADD CONSTRAINT "ArticleSave_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "ExpertArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleSave" ADD CONSTRAINT "ArticleSave_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleRating" ADD CONSTRAINT "ArticleRating_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "ExpertArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleRating" ADD CONSTRAINT "ArticleRating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleComment" ADD CONSTRAINT "ArticleComment_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "ExpertArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleComment" ADD CONSTRAINT "ArticleComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertQuestion" ADD CONSTRAINT "ExpertQuestion_farmerId_fkey" FOREIGN KEY ("farmerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertQuestion" ADD CONSTRAINT "ExpertQuestion_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationPlan" ADD CONSTRAINT "ConsultationPlan_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationBooking" ADD CONSTRAINT "ConsultationBooking_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ConsultationPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationBooking" ADD CONSTRAINT "ConsultationBooking_farmerId_fkey" FOREIGN KEY ("farmerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertPeer" ADD CONSTRAINT "ExpertPeer_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertPeer" ADD CONSTRAINT "ExpertPeer_peerId_fkey" FOREIGN KEY ("peerId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsSourceSuggestion" ADD CONSTRAINT "NewsSourceSuggestion_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

