# LevelStory — Requirements Audit

**Audit date:** 2026-08-25  
**Compared against:** `LEVELSTORY_SPEC.md`  
**Scope:** Phase 0 documentation only. No new product behavior is implemented by this audit.

## Classification key

- **Functional** — the underlying value or behavior is calculated/validated and exercised by code or tests.
- **Partially functional** — a real slice works, but important required behavior or persistence is absent.
- **Interface placeholder only** — the interface communicates the concept, but the underlying behavior is not implemented.
- **Missing** — no meaningful implementation exists.
- **Incorrect** — an implementation exists but violates the requirement or could produce an unsafe/false result.

## Requirement matrix

| Requirement | Current classification | Supporting code or test | Problem, if any | Recommended implementation phase |
|---|---|---|---|---|
| Shadow Mode only; no broker, order, or execution path | Functional | `artifacts/levelstory/src/components/levelstory-shell.tsx`; no broker/order routes in `artifacts/api-server/src/routes/` | None found in the current path | Phase 0 / retain permanently |
| Deterministic simulated candles | Functional | `artifacts/api-server/src/lib/market-data.ts`; `generateSimulation()` and `makeCandle()` | Simulation is deterministic but narrow and synthetic | Phase 1 |
| Candle open/close times and completion flag | Functional | `artifacts/api-server/src/lib/strategy/types.ts`; `toApiCandle()` | Current generated simulation marks its generated candles complete; forming-candle UI is not modeled | Phase 1 |
| Replay cursor and future-candle exclusion | Functional | `completedCandles()`; `strategy.test.ts` replay and anti-look-ahead tests | Cursor is fixed per session; users cannot control it yet | Phase 3 |
| Same-bar ambiguity policy | Missing | No policy surfaced by `artifacts/api-server/src/lib/strategy/simulation.ts` or UI | Stop/target ordering is not documented or exposed | Phase 2 |
| Premarket high/low from session candles | Functional | `sessionLevels()`; snapshot `levels.premarketHigh/Low` | Timezone is documented as a deterministic UTC simulation assumption rather than a full exchange timezone model | Phase 1 |
| Yesterday high/low | Functional | `sessionLevels()` prior-day map; snapshot fields | Historical data is generated simulation history, not an external market feed | Phase 1 |
| Day-before-yesterday high/low | Functional | `sessionLevels()`; snapshot fields and key-level panel | None for the current simulated scope | Phase 1 |
| First completed 15-minute ORB high/low | Functional | `aggregateCandles()` and `sessionLevels()`; snapshot contract | ORB is calculated for the fixed current replay session, not user-controlled replay time | Phase 1 |
| VWAP | Functional | `indicators.ts`; `sessionLevels()`; API indicator/level fields | No separate VWAP rule beyond its use in trend/confluence evidence | Phase 1 |
| 200 EMA/MA and slope | Partially functional | `indicators.ts`, `sessionLevels()`, dashboard Indicators panel | The slope is a compact recent calculation and the UI has no configuration control for period | Phase 1 |
| RSI | Functional | `indicators.ts`; generated API field and dashboard panel | RSI is informational; no specified decision rule uses it | Phase 1 |
| Support/resistance | Partially functional | Prior-session and mapped levels in `sessionLevels()` and snapshot `critical` levels | No dedicated swing/support-resistance evaluator or manual annotation flow | Phase 1 |
| 15-minute bullish/bearish/neutral trend | Functional | `trendEvidence()` aggregates candles; `strategy.test.ts`; dashboard Trend evidence panel | Trend evidence is deterministic but uses compact structure heuristics rather than a configurable structure engine | Phase 1 |
| Trend evidence: VWAP, EMA relation/slope, HH/HL/LH/LL | Partially functional | `rules.ts` `trendEvidence()`; API `trend` object | Structure labels are inferred from a compact slope comparison, not a full pivot sequence | Phase 1 |
| Unclear trend cannot qualify | Functional | `fullDecision()` trend rule; snapshot decision; lockout/causal tests | No separately rendered neutral “cannot qualify” fixture in the frontend smoke suite | Phase 1 |
| Default NTZ is first completed 15-minute candle | Functional | `config.ts` default `ntzMinutes: 15`; `sessionLevels()`; snapshot `ntz` | Config is not editable/persisted | Phase 1 |
| NTZ high/low/width/status | Functional | `sessionLevels()`; OpenAPI `NtzState`; dashboard Key levels and decision evidence | None for the current snapshot path | Phase 1 |
| NTZ chart shading | Partially functional | `MiniCandleChart()` accepts NTZ and renders a shaded region | Dashboard defaults to premarket, so users must switch to Replay to see a completed NTZ | Phase 1 |
| Completed close outside NTZ gate | Functional | `fullDecision()` `ntz` rule; snapshot regular/premarket tests | No user-controlled cursor to test the exact transition interactively | Phase 1 |
| Configurable NTZ definition | Interface placeholder only | `config.ts` has a centralized default; `settings.tsx` exposes only risk settings | No API/database/UI editing of the NTZ assumption | Phase 3 |
| Completed ORB close in trend direction | Functional | `orbBreakout()` / `fullDecision()`; regular snapshot contract test | No separate API endpoint for evaluating arbitrary cursor points | Phase 1 |
| Mandatory subsequent breakout pullback | Partially functional | `fullDecision()` requires a breakout index before the final candle and calls `pullbackConfluence()` | Pullback sequence is represented by the final candle only; no persisted event or detailed pullback window | Phase 1 |
| Pullback reaches ORB edge plus independent confluence | Partially functional | `pullbackConfluence()` and `fullDecision()` | Confluence evidence is reduced to a boolean; the API does not identify the exact qualifying confluence set | Phase 1 |
| Pullback confluences displayed | Functional | `levelStory` plus dashboard Level Story panel and `critical` level list | No dedicated “qualifying confluence” list tied to the pullback rule | Phase 1 |
| Pullback volume below breakout/recent average | Functional | `volumeCheck()`; snapshot volume evidence; table-driven test | It evaluates the latest candle as the pullback and has no multi-candle pullback selection | Phase 1 |
| High-volume adverse pullback warning | Functional | `volumeCheck()` and snapshot `reversal.warning` | No dedicated visual alert panel separate from the reversal panel | Phase 1 |
| Configurable volume thresholds | Partially functional | `config.ts` named thresholds; dashboard assumptions | Thresholds are not editable/persisted in Settings | Phase 3 |
| Fibonacci 23.6/38.2/50/61.8/78.6 | Functional | `fibonacci()`; generated fields; dashboard Indicators panel; test | Swing source/direction is not exposed in the API | Phase 1 |
| Automatic swing selection | Partially functional | `indicators.ts` `fibonacci()` | Selection is deterministic but not explained to or configurable by the user | Phase 1 |
| Manual swing correction | Missing | No UI, endpoint, or persisted swing selection | Cannot correct an automatic swing | Phase 3 |
| Fibonacci is confluence only | Functional | `fullDecision()` only treats mapped levels as part of pullback/confluence; no standalone Fibonacci signal | The API does not explicitly label Fibonacci’s role as confluence-only | Phase 1 |
| Patience candle and closed-candle requirement | Partially functional | `patienceCandle()`; `fullDecision()`; tests | Current snapshot does not expose a highlighted previous/patience candle pair or a full post-pullback event chain | Phase 1 |
| Patience statuses: waiting/forming/ready/invalid | Functional | `PatienceStatus`, `patienceCandle()`, and signal evidence | Frontend signal status is only confirmed/watching/blocked, so the detailed patience state is not directly shown | Phase 1 |
| Previous and patience candle shown | Missing | `MiniCandleChart()` renders generic candles | No candle pair highlighting | Phase 1 |
| Level Story chronology and classifications | Functional | `levelStory()`; `levelStory` API field; dashboard panel | Events are not persisted and detailed interaction source/price metadata is limited | Phase 2 |
| Full qualification chain | Functional | `fullDecision()`; API `decision`; dashboard no longer uses local qualification toggles | Some rule calculations still use the latest candle as the pullback/patience candidate | Phase 1 |
| Decision states and passed/failed explanations | Functional | `DecisionState`; `StrategyDecision`; dashboard Decision and Rule checklist panels | `SETUP FORMING` and `POSSIBLE REVERSAL` are represented in the contract but are not independently selected by all intended transitions | Phase 1 |
| Catastrophe and thesis/strategy stops | Partially functional | `risk.ts` `positionSize()`; `buildRiskPlan()`; dashboard Position plan | No completed-close stop invalidation, stop outcome, or persisted stop state | Phase 2 |
| Profit buffer, partial profit, runner | Missing | `simulation.ts` contains fill primitives but no snapshot/API/UI integration | No runner/profit-buffer plan or outcome tracking | Phase 2 |
| Reversal alert separated from normal qualification | Partially functional | `candleAlert()`, equivalent-candle detection, reversal panel | No full structure-break plus patience-confirmation reversal path | Phase 1 |
| Doji at key level | Partially functional | `candleAlert()` detects doji; Level Story supplies level context | Doji is not explicitly required to be at a key level by the evaluator | Phase 1 |
| Equivalent red/green candle detection | Functional | `detectEquivalentCandles()`; reversal response | No dedicated unit test for equivalence tolerance boundary | Phase 1 |
| Account size and risk percentage settings | Partially functional | `risk.ts`, `routes/risk.ts`, `settings.tsx`; market route passes persisted risk | Settings are used for sizing, but the broader risk configuration is absent | Phase 2 |
| Daily loss control and emergency lockout | Partially functional | `routes/market.ts` passes persisted risk; `positionSize()`; lockout test | Daily loss is not updated from simulated outcomes and no trade-count history is enforced | Phase 2 |
| Position size formula | Functional | `positionSize()` and lockout/sizing tests; API `riskPlan` | Contract says “shares” even though product scope includes futures contracts | Phase 2 |
| Max trades, position value, spread, liquidity, duplicate, averaging down, stale data, kill switch | Missing | No complete fields/evaluator in `risk.ts` or `routes/risk.ts` | Unsafe or disallowed plan classes are not all server-enforced | Phase 2 |
| Simulated spread, slippage, and fees | Partially functional | `simulation.ts` `simulateFill()` and config assumptions | Fill simulation is not wired into the market snapshot, journal, or outcome UI | Phase 2 |
| MFE/MAE and exit outcomes | Missing | No API or database fields used by current routes | Cannot review simulated trade path quality | Phase 2 |
| Record every accepted and rejected evaluation | Missing | `routes/journal.ts` and `journal.tsx` support manual journal CRUD only | Strategy evaluations are not automatically persisted | Phase 2 |
| Journal evidence and outcome fields | Partially functional | `lib/db/src/schema/levelstory.ts`; journal API/UI | Existing records lack full rule evidence, costs, stops, MFE/MAE, exit reason, and snapshots | Phase 2 |
| Manual journal CRUD | Functional | `routes/journal.ts`; `journal.tsx` | It is not linked to evaluated setup records | Phase 2 |
| OpenAPI-first evaluated snapshot | Functional | `lib/api-spec/openapi.yaml`; generated `lib/api-zod` and `lib/api-client-react`; contract test | No full journal/evaluation contract yet | Phase 2 |
| Desktop-first chart and decision cockpit | Functional | `dashboard.tsx`; `levelstory-ui.tsx`; responsive preview verification | Some full-requirement panels remain absent | Phase 1 |
| Levels, trend, NTZ, Fibonacci, volume, patience, risk, Level Story UI | Partially functional | Dashboard panels and chart overlays | Patience pair, full confluence detail, runner, and editable assumptions are absent | Phase 1 |
| Loading, empty, error states | Functional | `QuerySkeleton`, `QueryError`, empty chart/signals/reviews states | None for existing fetch paths | Phase 1 |
| Stale, disconnected, and true market-closed states | Missing | Snapshot market status is only premarket/open in current generator | Users cannot distinguish a closed or stale feed | Phase 3 |
| Assumptions visible and labeled | Partially functional | Snapshot `assumptions`; dashboard Trend evidence panel; `config.ts` | Assumptions are read-only and not all requirement thresholds are surfaced | Phase 1 / 3 |
| Automated rule and boundary coverage | Partially functional | `artifacts/api-server/src/lib/strategy/strategy.test.ts` | Current suite covers 8 strategy/replay/contract cases, not every required rule or boundary | Phase 4 |
| API validation | Functional | `GetMarketSnapshotResponse.parse()` in `routes/market.ts`; generated contract test | Journal/risk/evaluation contract coverage is incomplete | Phase 4 |
| Journal round-trip and frontend smoke tests | Missing | No dedicated test files/scripts for journal round trips or frontend smoke | Manual verification only | Phase 4 |

## Current implementation summary

The application is no longer relying on local checklist toggles or static signal prose to qualify the current snapshot. The highest-risk snapshot path now has a deterministic strategy core, completed-candle cursor filtering, calculated levels/indicators, rule evidence, server-side basic sizing/lockout, generated API types, and responsive evidence panels.

The audit still classifies the product as incomplete because the broader specification requires persisted evaluated/rejected setups, complete futures risk controls, simulated fill/outcome accounting, editable assumptions and replay controls, and full test coverage. Those are documented as follow-on phases rather than implemented in Phase 0.

## Phased implementation checklist

### Phase 0 — Specification and audit

- [x] Save the authoritative product requirements in `LEVELSTORY_SPEC.md`.
- [x] Audit every requirement in `LEVELSTORY_AUDIT.md`.
- [x] Use the five required classifications consistently.
- [x] Identify supporting code/tests, problems, and recommended phases.
- [x] Keep Shadow Mode boundaries explicit.
- [x] Run existing tests and report results.

### Phase 1 — Causal strategy evaluation

- [x] Deterministic simulated candles and cursor-bounded completed-candle filtering.
- [x] Historical session levels and first completed 15-minute ORB/NTZ.
- [x] VWAP, EMA/RSI, trend evidence, Fibonacci, volume, patience, pullback, and Level Story evaluators.
- [x] Server-returned decision with passed/failed rules.
- [x] Replace client-side qualification with evaluated decision.
- [ ] Expand pullback/patience/reversal sequencing and add full transition coverage.
- [ ] Highlight previous/patience candles and explicit confluence sources.

### Phase 2 — Risk, fills, and journal evidence

- [x] Basic entry-to-catastrophe-stop sizing.
- [x] Basic persisted daily-loss and emergency-lockout gate.
- [ ] Add complete risk guardrails: max trades, position value, spread, liquidity, stale data, duplicates, averaging down, and kill switch.
- [ ] Integrate spread, slippage, fees, partials, runners, profit buffers, MFE/MAE, and exit reasons.
- [ ] Persist every accepted/rejected evaluation and its evidence.
- [ ] Extend journal UI/API/database records for evaluated outcomes.

### Phase 3 — User-controlled assumptions and replay

- [ ] Make strategy assumptions editable, validated, and persisted.
- [ ] Add replay cursor stepping/playback and arbitrary historical cursor evaluation.
- [ ] Add manual Fibonacci swing correction.
- [ ] Add true closed/stale/disconnected states and their server-side gates.
- [ ] Add the complete risk and strategy configuration surface to Settings.

### Phase 4 — Verification and release hardening

- [ ] Add table-driven coverage for every rule and boundary.
- [ ] Add fill, stop, partial/runner, MFE/MAE, and cost accounting tests.
- [ ] Add API contract tests for journal, risk, replay, and evaluated records.
- [ ] Add journal round-trip and frontend smoke tests.
- [ ] Re-verify desktop/mobile previews and browser/workflow logs.
- [ ] Re-audit this document before any future phase is considered complete.
