# LevelStory — Authoritative Product Specification

**Status:** Product requirements document  
**Phase:** 0 — specification and audit  
**Audit snapshot:** 2026-08-25  
**Operating mode:** Shadow Mode only

## 1. Product purpose

LevelStory is a futures-trading discipline assistant. It helps a trader read a simulated market, build a rule-based plan, rehearse decisions, and journal what happened. It is a decision-support and learning product, not an execution platform and not a profitability product.

The product must make the trader wait for evidence. A chart label, checklist mark, alert, or status string is not evidence unless the underlying value was calculated from valid market data and passed the relevant rule.

## 2. Non-negotiable boundaries

- All market data is deterministic simulated data unless a future phase explicitly changes this specification.
- No broker authentication, brokerage API, order route, live order, paper-broker connection, execution credential, or execution shortcut may be added.
- Every visible evaluation must be reproducible from the candles available at its replay cursor.
- A forming candle or any candle after the cursor cannot confirm a rule.
- No look-ahead bias: changing future candles must not change an earlier decision.
- Every subjective threshold must be a named, validated assumption and visible to the user.
- LevelStory must not claim that the strategy is profitable, optimized, or guaranteed.
- Mutations are limited to Shadow Mode records such as plans, journals, evaluations, and simulated outcomes.

## 3. Market simulation and time model

### 3.1 Candle contract

Every candle has:

- open time and close time;
- open, high, low, close, and volume;
- a completion flag;
- a deterministic ordering;
- the session and timezone context used to create it.

The market feed must expose a replay cursor. The effective candle set is:

```text
isComplete === true AND closeTime <= replayCursor
```

The API must not expose future candles as current evidence. A live-style view may show a forming candle as context, but it cannot use it to pass any rule.

### 3.2 Sessions

The simulation must distinguish at least:

- premarket;
- regular session;
- market closed;
- stale data;
- disconnected/unavailable feed;
- replay mode.

Session boundaries and timezone are explicit assumptions. The same-bar ambiguity policy must be documented for candles that touch multiple levels or both a stop and target.

### 3.3 Determinism and replay

- The same symbol, session, seed/data revision, and cursor produce the same snapshot.
- Replay must be causal and cursor-bounded.
- A previous decision must be testable against a later version of the candle list without future data changing the earlier result.
- Replay controls must eventually allow stepping or moving the cursor through completed candles.

## 4. Required market context and levels

For the selected symbol and session, calculate and show:

1. Premarket high and low.
2. Yesterday’s regular-session high and low.
3. The day-before-yesterday’s high and low.
4. The opening range high and low from the first completed 15-minute regular-session range.
5. Session VWAP.
6. 200-period EMA or MA and its slope.
7. RSI with its named period assumption.
8. Nearby support and resistance derived from the simulated history.
9. Fibonacci levels derived from a selected swing.

Levels must be derived from candles, not from fixed offsets or display-only constants. Each level needs a name, value, source/context, and enough metadata for the chart and Level Story.

## 5. Trend evaluator

The evaluator must aggregate the relevant candles to a 15-minute view and classify the trend as:

- bullish;
- bearish;
- neutral/unclear.

Trend evidence must include:

- price relative to VWAP;
- price relative to the 200 EMA;
- EMA slope;
- market structure: higher highs/higher lows or lower highs/lower lows;
- any conflicting or missing evidence.

An unclear or neutral trend cannot qualify a setup. The UI must show the classification and the evidence that produced it.

## 6. No-Trade Zone (NTZ)

- The default NTZ is the high/low range of the first completed 15-minute regular-session candle.
- The NTZ must expose high, low, width, completion state, and whether the latest completed close is inside or outside it.
- The chart shades the NTZ and shows its boundaries.
- A normal entry is blocked until a completed candle closes outside the NTZ in the candidate direction.
- NTZ duration/definition is configurable only through named, validated assumptions.

## 7. Opening Range Breakout and pullback formula

The normal setup must follow this sequence:

1. A valid 15-minute trend is identified.
2. The opening range is complete.
3. A completed candle closes outside the opening range in the trend direction.
4. A subsequent pullback occurs; the breakout candle itself cannot be treated as its own pullback.
5. The pullback reaches the broken ORB edge and an independent confluence level.
6. Pullback volume passes the volume safety rules.
7. A valid patience candle closes.
8. Risk controls pass.

No single signal, level touch, Fibonacci touch, or checklist can skip a required step.

## 8. Confluence

The evaluator must identify the levels touched or held by the pullback. Eligible confluence sources include:

- broken ORB edge;
- VWAP;
- 200 EMA or configured EMA;
- prior-session levels;
- support/resistance;
- Fibonacci retracement.

Fibonacci and any other level are confluence evidence only. They cannot create a trade without the trend, ORB, pullback, volume, patience, and risk gates. The UI must show which levels formed the confluence and their calculated prices.

## 9. Volume safety

The evaluator must compare:

- breakout-candle volume;
- pullback-candle volume;
- recent average volume;
- the configured expansion and adverse-volume thresholds.

The preferred pullback is quieter than the breakout and does not show unsafe expansion relative to the configured average. A high-volume adverse pullback must produce the exact warning:

> HIGH-VOLUME PULLBACK — POSSIBLE REVERSAL

The warning is an alert/reversal concern, not an entry qualification.

## 10. Fibonacci

The default automatic swing selection must be deterministic and visible. It must calculate:

- 23.6%;
- 38.2%;
- 50%;
- 61.8%;
- 78.6%.

The product must support a future/manual swing-point correction flow. Manual high and low values must be validated, persisted with the evaluation, and clearly distinguished from automatic selection. Fibonacci levels are never standalone entry signals.

## 11. Patience candle

The patience-candle evaluator must use completed candles and expose states such as:

- waiting;
- forming;
- ready/valid;
- invalid.

A valid patience candle must:

- occur after the required pullback/confluence event;
- be checked against the previous candle’s range using the configured containment tolerance;
- show directional rejection/intent consistent with the candidate trend;
- pass the configured body/doji rule;
- be closed before it can pass.

The chart must make the previous and patience candles identifiable.

## 12. Level Story

Level Story is a chronological, candle-derived explanation of the setup. It records level interactions and classifies them, as applicable, as:

- touch;
- hold;
- retest;
- clean break;
- rejection.

Each event includes time, level, price/context, interaction, and explanatory detail. The story must be chronological and must not include interactions derived from candles after the replay cursor.

## 13. Decision states and qualification

The evaluator must return every passed and failed rule, not only a single boolean. The decision surface supports:

- `NO TRADE`;
- `WAITING`;
- `SETUP FORMING`;
- `SETUP QUALIFIED`;
- `POSSIBLE REVERSAL`;
- `RISK LOCKOUT`.

`SETUP QUALIFIED` requires the complete chain:

```text
trend
→ completed ORB break
→ completed close outside NTZ
→ mandatory pullback
→ confluence
→ safe pullback volume
→ valid patience candle
→ risk controls
```

Reversal alerts never qualify a normal entry. The explanation must state why the current state exists and list failed rules in user-readable language.

## 14. Reversal alerts

Reversal logic is a bonus/alert path separated from normal qualification. It may include:

- doji/equivalent indecision at a key level;
- equivalent red/green candle bodies within a configurable percentage;
- adverse high-volume pullback;
- structure break;
- required patience confirmation;
- separate risk validation.

The product must not present a reversal alert as a guaranteed reversal or as permission to enter.

## 15. Risk controls and simulated trade planning

### 15.1 Settings

The risk model must support validated, editable assumptions for:

- account size;
- risk percentage per trade;
- maximum daily loss;
- maximum trades per session/day;
- maximum position value/size;
- spread;
- slippage;
- fees;
- liquidity constraints;
- stale-data timeout;
- duplicate entries;
- averaging down;
- emergency kill switch/lockout;
- runner and profit-buffer behavior.

### 15.2 Position sizing

Quantity is derived from risk, not chosen arbitrarily:

```text
dollar risk = account size × risk percentage
share/contract quantity =
  floor(dollar risk / absolute(entry - catastrophe stop))
```

The evaluator must block zero/negative/undefined stop distance and any plan that violates account, daily loss, trade-count, position-size, liquidity, spread, stale-data, duplicate, averaging-down, or kill-switch rules.

### 15.3 Stops

Every qualified plan must identify:

- strategy/thesis stop;
- catastrophe stop;
- completed-close invalidation behavior;
- stop distance and dollar risk.

The catastrophe stop is the sizing boundary. A thesis stop invalidates the setup thesis. These must not be silently conflated.

### 15.4 Profit buffer, partial, and runner

The simulated plan must support:

- target and configurable profit buffer units;
- partial-profit suggestion/record;
- separate runner quantity;
- runner protection/invalidation;
- costs in the simulated fill;
- realized and unrealized outcome;
- MFE and MAE;
- exit reason.

Same-bar stop/target behavior follows the documented ambiguity policy.

## 16. Journaling and persistence

The journal must record every evaluated setup, including rejected setups. A record may be manually annotated, but the system-generated evaluation must remain intact.

Each evaluation record must be able to preserve:

- symbol/session/replay cursor;
- decision state;
- accepted and rejected rule evidence;
- all relevant levels and indicators;
- NTZ, ORB, trend, pullback, volume, Fibonacci, patience, and reversal evidence;
- entry, thesis stop, catastrophe stop, target, quantity, partial, runner;
- spread, slippage, fees, and simulated fill details;
- MFE, MAE, outcome, and exit reason;
- trader notes and later review.

Persistence is Shadow Mode only and must not expose order placement.

## 17. API and frontend

The API is OpenAPI-first with generated clients and runtime validation. It must expose the evaluated snapshot, replay metadata, levels, indicators, trend evidence, NTZ, decision evidence, risk plan, Level Story, reversal alerts, assumptions, journal records, and settings.

The desktop-first terminal must prioritize:

1. chart and calculated overlays;
2. current decision;
3. required-rule checklist/evidence;
4. risk controls and stops;
5. Level Story and supporting indicators.

The UI must have explicit loading, empty, error, stale, disconnected, market-closed, pending, waiting, qualified, reversal, and risk-lockout states. It must be compact, calm, accessible, responsive on mobile, and clearly branded Shadow Mode.

## 18. Security and safety

- Do not request or store broker credentials.
- Do not add broker integrations or live/paper order APIs.
- Keep all simulated fills and journal mutations visibly separate from execution.
- Validate all API inputs and reject malformed or non-finite numerical values.
- Never describe a simulated result as a real trade or profitability evidence.

## 19. Verification requirements

Automated coverage must include:

- table-driven tests for each rule and boundary;
- completed-candle and cursor tests;
- determinism and anti-look-ahead tests;
- NTZ, ORB, pullback, confluence, volume, Fibonacci, patience, reversal, and decision-state tests;
- position sizing, stops, cost/fill, partial/runner, MFE/MAE, and lockout tests;
- API contract validation;
- journal create/read/update/delete and evaluated-record round trips;
- frontend smoke checks for key states;
- desktop and mobile preview verification.
