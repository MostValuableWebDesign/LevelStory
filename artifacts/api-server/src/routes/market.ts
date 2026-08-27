import { Router, type IRouter } from "express";
import { GetDashboardOverviewQueryParams, GetDashboardOverviewResponse, GetMarketSnapshotQueryParams, GetMarketSnapshotResponse, ListFuturesContractSpecificationsResponse } from "@workspace/api-zod";
import { db, journalEntriesTable, marketDataCandlesTable, riskSettingsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { createMarketSnapshot } from "../lib/market-data";
import { recordSnapshotEvaluations, toApiJournalEntry } from "../lib/phase8-journal";
import { summarizeDashboardEntries } from "../lib/dashboard-metrics";
import { getFuturesContractSpecification, listFuturesContractSpecifications, type FuturesContractSpecification } from "../lib/futures/contracts";
import { isTradingDate, previousTradingDate, sessionCalendarForContract, tradingDateForTimestamp } from "../lib/futures/session-calendar";
import {
  createMarketDataProvider,
  providerKindFromEnvironment,
  providerRequestWindow,
  normalizedToSimulatedCandle,
  selectFrontMonthContract,
  validateCandleSeries,
  type MarketDataProviderKind,
} from "../lib/futures/market-data-provider";
import { GetMarketDataStatusQueryParams, GetMarketDataStatusResponse } from "@workspace/api-zod";

const router: IRouter = Router();

function parseOptionalQueryBoolean(value: unknown, fallback?: boolean): boolean | undefined {
  if (value === undefined) return fallback;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === true || raw === false) return raw;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`Boolean query value must be true or false, received "${String(raw)}".`);
}

router.get("/market/snapshot", async (req, res): Promise<void> => {
  const parsed = GetMarketSnapshotQueryParams.safeParse(req.query);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid market snapshot query");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const [risk] = await db.select().from(riskSettingsTable).limit(1);
    const hasManualHigh = parsed.data.fibHigh !== undefined;
    const hasManualLow = parsed.data.fibLow !== undefined;
    if (hasManualHigh !== hasManualLow) {
      res.status(400).json({ error: "Manual Fibonacci correction requires both fibHigh and fibLow." });
      return;
    }
    const manualFibAnchors = hasManualHigh && hasManualLow
      ? { high: parsed.data.fibHigh!, low: parsed.data.fibLow! }
      : undefined;
     const premarketAvailable = parseOptionalQueryBoolean(
       req.query.premarketAvailable,
       parsed.data.premarketAvailable,
     );
      const providerKind = (parsed.data.provider ?? providerKindFromEnvironment()) as MarketDataProviderKind;
      let providerReplayOptions: Parameters<typeof createMarketSnapshot>[5] = {
        tradingDate: parsed.data.tradingDate,
        cursor: parsed.data.cursor,
        premarketAvailable,
      };
      if (providerKind !== "simulated") {
        const sourceSpecification = getFuturesContractSpecification(parsed.data.symbol);
        const sourceCalendar = sessionCalendarForContract(sourceSpecification);
        const sourceTradingDate = parsed.data.tradingDate ?? tradingDateForTimestamp(Date.now(), sourceCalendar);
        const selectedSpecification = selectFrontMonthContract(sourceSpecification, sourceTradingDate);
        const provider = createMarketDataProvider(providerKind, selectedSpecification);
        try {
          const sourceCandles = await provider.getHistoricalCandles({
            specification: selectedSpecification,
            ...providerRequestWindow(sourceTradingDate, sessionCalendarForContract(selectedSpecification)),
            intervalMinutes: 5,
          });
          const strategyCandles = sourceCandles
            .map(normalizedToSimulatedCandle)
            .filter((candle): candle is NonNullable<typeof candle> => candle !== null && candle.isComplete);
          if (!strategyCandles.length) {
            throw new Error(`${provider.metadata.displayName} returned no quote-complete completed candles; Shadow analysis is gated rather than simulated.`);
          }
          providerReplayOptions = {
            tradingDate: sourceTradingDate,
            cursor: parsed.data.cursor,
            allCandles: strategyCandles,
            historicalFeed: strategyCandles,
            premarketAvailable,
          };
        } finally {
          await provider.disconnect();
        }
      }
     const snapshot = createMarketSnapshot(
       parsed.data.symbol,
       parsed.data.session,
       risk,
       manualFibAnchors,
       { targetDollars: parsed.data.targetDollars, slippageMode: parsed.data.slippageMode },
        providerReplayOptions,
      );
      await recordSnapshotEvaluations(snapshot);
      res.json(GetMarketSnapshotResponse.parse(snapshot));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid futures contract.";
    req.log.warn({ error: message }, "Rejected market snapshot request");
    res.status(400).json({ error: message });
  }
});

router.get("/market/data-status", async (req, res): Promise<void> => {
  const parsed = GetMarketDataStatusQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const providerKind = (parsed.data.provider ?? providerKindFromEnvironment()) as MarketDataProviderKind;
  let specification: FuturesContractSpecification;
  try {
    specification = getFuturesContractSpecification(parsed.data.symbol ?? "MES");
    const initialCalendar = sessionCalendarForContract(specification);
    let tradingDate = parsed.data.tradingDate ?? tradingDateForTimestamp(Date.now(), initialCalendar);
    if (!isTradingDate(tradingDate, initialCalendar)) tradingDate = previousTradingDate(tradingDate, initialCalendar);
    specification = selectFrontMonthContract(specification, tradingDate);
    const calendar = sessionCalendarForContract(specification);
    const provider = createMarketDataProvider(providerKind, specification);
    let health = await provider.health();
    {
      const window = providerRequestWindow(tradingDate, calendar);
      try {
        const candles = await provider.getHistoricalCandles({
          specification,
          ...window,
          intervalMinutes: 5,
        });
        const providerHealthAfterRequest = await provider.health();
        const quality = { ...validateCandleSeries(candles, specification), delayed: providerHealthAfterRequest.delayed };
        health = {
          ...providerHealthAfterRequest,
          connected: true,
          state: providerHealthAfterRequest.delayed ? "delayed_shadow" : providerHealthAfterRequest.state,
          quality,
          lastEventAt: candles.at(-1)?.closeTime ?? providerHealthAfterRequest.lastEventAt,
          message: candles.length
            ? providerHealthAfterRequest.message
            : `${providerHealthAfterRequest.message} No normalized candles were returned for the requested window.`,
        };
        const completed = candles.filter((candle) => candle.isComplete);
        if (completed.length) {
          await db.insert(marketDataCandlesTable).values(completed.map((candle) => ({
            provider: providerKind,
            dataset: provider.metadata.dataset,
            rootSymbol: specification.rootSymbol,
            contractSymbol: candle.contractSymbol,
            intervalMinutes: candle.intervalMinutes,
            openTime: new Date(candle.openTime),
            closeTime: new Date(candle.closeTime),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            bid: candle.bid,
            ask: candle.ask,
            bidSize: candle.bidSize,
            askSize: candle.askSize,
            isComplete: candle.isComplete,
            quality: candle.quality,
          }))).onConflictDoNothing();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Provider request failed.";
        health = {
          ...health,
          connected: false,
          state: "disconnected",
          message: message.replace(/DATABENTO_API_KEY[^.]*\.?/gi, "Databento credentials are unavailable."),
        };
      }
    }
    await provider.disconnect();
    res.json(GetMarketDataStatusResponse.parse({
      provider: health.provider,
      state: health.state,
      connected: health.connected,
      authenticated: health.authenticated,
      delayed: health.delayed,
      lastEventAt: health.lastEventAt === null ? null : new Date(health.lastEventAt).toISOString(),
      checkedAt: new Date(health.checkedAt).toISOString(),
      message: health.message,
      dataOnly: true,
      executionEnabled: false,
      metadata: {
        displayName: provider.metadata.displayName,
        dataset: provider.metadata.dataset,
        contractSymbol: provider.metadata.contractSymbol,
        contractMonth: provider.metadata.contractMonth,
        rolloverDate: provider.metadata.rolloverDate,
      },
      quality: health.quality,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid market-data query.";
    res.status(400).json({ error: message });
  }
});

router.get("/futures/contracts", (_req, res): void => {
  res.json(ListFuturesContractSpecificationsResponse.parse(listFuturesContractSpecifications()));
});

router.get("/dashboard/overview", async (req, res): Promise<void> => {
  try {
    const parsed = GetDashboardOverviewQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const calendar = sessionCalendarForContract(getFuturesContractSpecification("MES"));
    let tradingDate = parsed.data.tradingDate ?? tradingDateForTimestamp(Date.now(), calendar);
    if (!isTradingDate(tradingDate, calendar)) {
      if (parsed.data.tradingDate) {
        res.status(400).json({ error: `${tradingDate} is not a trading date.` });
        return;
      }
      tradingDate = previousTradingDate(tradingDate, calendar);
    }
    const [risk] = await db.select().from(riskSettingsTable).limit(1);
    const allEntries = await db.select().from(journalEntriesTable).orderBy(desc(journalEntriesTable.createdAt));
    const summary = summarizeDashboardEntries(allEntries, tradingDate);
    const data = {
      sessionPnl: summary.sessionPnl,
      sessionPnlPercent: risk && risk.accountSize > 0 ? Number(((summary.sessionPnl / risk.accountSize) * 100).toFixed(2)) : 0,
      maxDailyLoss: risk?.maxDailyLoss ?? 500,
      dailyLossUsed: risk?.dailyLossUsed ?? 0,
      tradeCount: summary.triggeredTradeCount,
      reviewCount: summary.reviewCount,
      triggeredTradeCount: summary.triggeredTradeCount,
      openTradeCount: summary.openTradeCount,
      closedTradeCount: summary.closedTradeCount,
      winCount: summary.winCount,
      lossCount: summary.lossCount,
      breakevenCount: summary.breakevenCount,
      winRate: summary.winRate,
      setupPerformance: summary.setupPerformance,
      checklistCompleted: 4,
      checklistTotal: 5,
      recentEntries: summary.recentEntries.map(toApiJournalEntry),
    };
    res.json(GetDashboardOverviewResponse.parse(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load dashboard overview.";
    req.log.warn({ error: message }, "Rejected dashboard overview request");
    res.status(400).json({ error: message });
  }
});

export default router;