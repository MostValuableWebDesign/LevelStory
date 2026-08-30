---
name: Patience candidate selection
description: Durable rule for selecting causal patience-candle occurrences when several candidates exist in one session.
---

The patience detector must evaluate candidates chronologically and preserve the first candidate whose immediate next candle confirms; a later candidate must not overwrite an already confirmed P/E sequence. Failed P/E attempts may expire and allow later candidates to re-arm, but later candles can never confirm an earlier P.

**Why:** Selecting the last candidate in a full-session scan caused valid morning ORB pullback/VWAP patience sequences to be replaced by late-session annotations.

**How to apply:** Keep candidate and trigger selection bounded by the evaluation cursor and exact adjacent candle timestamps. Extend occurrence retention separately when the session needs every failed and successful P/E record.