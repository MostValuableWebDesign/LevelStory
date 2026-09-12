export const MAX_HISTORICAL_SESSIONS = 10 as const;

export class HistoricalNoDataError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "HistoricalNoDataError";
  }
}