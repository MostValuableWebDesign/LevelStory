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
import { getFuturesContractSpecification } from "../lib/futures/contracts";
import { toApiJournalEntry } from "../lib/phase8-journal";

const router: IRouter = Router();

router.get("/journal", async (req, res): Promise<void> => {
  const parsed = ListJournalEntriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const filters = [
    parsed.data.symbol ? eq(journalEntriesTable.symbol, parsed.data.symbol.toUpperCase()) : undefined,
    parsed.data.setupType ? eq(journalEntriesTable.setupType, parsed.data.setupType) : undefined,
    parsed.data.direction ? eq(journalEntriesTable.side, parsed.data.direction) : undefined,
    parsed.data.outcome ? eq(journalEntriesTable.outcome, parsed.data.outcome) : undefined,
    parsed.data.tradingDate ? eq(journalEntriesTable.tradingDate, parsed.data.tradingDate) : undefined,
  ].filter((filter): filter is NonNullable<typeof filter> => filter !== undefined);
  const entries = await db.select().from(journalEntriesTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(journalEntriesTable.createdAt))
    .limit(parsed.data.limit);
  res.json(ListJournalEntriesResponse.parse(entries.map(toApiJournalEntry)));
});

router.post("/journal", async (req, res): Promise<void> => {
  const parsed = CreateJournalEntryBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid journal entry");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const contract = getFuturesContractSpecification(parsed.data.symbol);
    const [entry] = await db.insert(journalEntriesTable).values({
      ...parsed.data,
      symbol: contract.fullContractSymbol,
      contracts: parsed.data.contracts ?? parsed.data.quantity,
      setupType: parsed.data.setupType ?? parsed.data.setup,
      contractMonth: parsed.data.contractMonth ?? contract.contractMonth,
    }).returning();
    res.status(201).json(CreateJournalEntryResponse.parse(toApiJournalEntry(entry)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Journal entries require a supported futures contract.";
    req.log.warn({ error: message }, "Rejected non-futures journal entry");
    res.status(400).json({ error: message });
  }
});

router.get("/journal/:id", async (req, res): Promise<void> => {
  const parsed = DeleteJournalEntryParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [entry] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, parsed.data.id)).limit(1);
  if (!entry) {
    res.status(404).json({ error: "Journal entry not found" });
    return;
  }
  res.json(CreateJournalEntryResponse.parse(toApiJournalEntry(entry)));
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