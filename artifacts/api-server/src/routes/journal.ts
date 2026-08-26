import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, journalEntriesTable } from "@workspace/db";
import {
  CreateJournalEntryBody,
  CreateJournalEntryResponse,
  DeleteJournalEntryParams,
  ListJournalEntriesQueryParams,
  ListJournalEntriesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function toApiJournalEntry(entry: typeof journalEntriesTable.$inferSelect) {
  return { ...entry, createdAt: entry.createdAt.toISOString() };
}

router.get("/journal", async (req, res): Promise<void> => {
  const parsed = ListJournalEntriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const entries = await db.select().from(journalEntriesTable).orderBy(desc(journalEntriesTable.createdAt)).limit(parsed.data.limit);
  res.json(ListJournalEntriesResponse.parse(entries.map(toApiJournalEntry)));
});

router.post("/journal", async (req, res): Promise<void> => {
  const parsed = CreateJournalEntryBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid journal entry");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [entry] = await db.insert(journalEntriesTable).values(parsed.data).returning();
  res.status(201).json(CreateJournalEntryResponse.parse(toApiJournalEntry(entry)));
});

router.delete("/journal/:id", async (req, res): Promise<void> => {
  const parsed = DeleteJournalEntryParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const deleted = await db.delete(journalEntriesTable).where(eq(journalEntriesTable.id, parsed.data.id)).returning({ id: journalEntriesTable.id });
  if (!deleted.length) {
    res.status(404).json({ error: "Journal entry not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;