import { boolean, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const uploadedChartAnalysesTable = pgTable("levelstory_uploaded_chart_analyses", {
  id: varchar("id", { length: 64 }).primaryKey(),
  attachmentId: varchar("attachment_id", { length: 64 }).notNull().unique(),
  ownerId: varchar("owner_id", { length: 255 }).notNull(),
  objectPath: text("object_path").notNull(),
  originalFilename: text("original_filename").notNull(),
  mimeType: varchar("mime_type", { length: 64 }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
  tradingDate: varchar("trading_date", { length: 10 }).notNull(),
  symbol: varchar("symbol", { length: 32 }).notNull(),
  timeframe: varchar("timeframe", { length: 32 }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  session: varchar("session", { length: 32 }).notNull(),
  visibleStart: varchar("visible_start", { length: 32 }),
  visibleEnd: varchar("visible_end", { length: 32 }),
  chartNote: text("chart_note"),
  status: varchar("status", { length: 64 }).notNull(),
  machineExtraction: jsonb("machine_extraction").notNull(),
  reviewerCorrections: jsonb("reviewer_corrections"),
  candidate: jsonb("candidate"),
  reviewerStatus: varchar("reviewer_status", { length: 32 }).notNull().default("unreviewed"),
  reviewerNote: text("reviewer_note"),
  includeInCombinedReplay: boolean("include_in_combined_replay").notNull().default(false),
  duplicateWarning: jsonb("duplicate_warning"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UploadedChartAnalysis = typeof uploadedChartAnalysesTable.$inferSelect;