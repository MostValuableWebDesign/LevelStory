import { boolean, integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const journalEntriesTable = pgTable("levelstory_journal_entries", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  setup: text("setup").notNull(),
  entryPrice: numeric("entry_price", { precision: 12, scale: 4, mode: "number" }).notNull(),
  exitPrice: numeric("exit_price", { precision: 12, scale: 4, mode: "number" }),
  quantity: integer("quantity").notNull(),
  pnl: numeric("pnl", { precision: 12, scale: 2, mode: "number" }),
  notes: text("notes").notNull(),
  checklistPassed: boolean("checklist_passed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const riskSettingsTable = pgTable("levelstory_risk_settings", {
  id: serial("id").primaryKey(),
  accountSize: numeric("account_size", { precision: 14, scale: 2, mode: "number" }).notNull(),
  riskPercent: numeric("risk_percent", { precision: 6, scale: 3, mode: "number" }).notNull(),
  maxDailyLoss: numeric("max_daily_loss", { precision: 14, scale: 2, mode: "number" }).notNull(),
  dailyLossUsed: numeric("daily_loss_used", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  isLocked: boolean("is_locked").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type JournalEntry = typeof journalEntriesTable.$inferSelect;
export type RiskSettings = typeof riskSettingsTable.$inferSelect;