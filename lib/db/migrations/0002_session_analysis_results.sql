-- Persistent completed per-session analysis evidence.
-- Incomplete, failed, cancelled, and partial computations are never inserted.
CREATE TABLE IF NOT EXISTS levelstory_session_analysis_results (
  cache_key TEXT PRIMARY KEY,
  cache_key_version TEXT NOT NULL,
  result_schema_version TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  lookback_fingerprint TEXT NOT NULL,
  strategy_identity JSONB NOT NULL,
  formula_version TEXT NOT NULL,
  formula_hash TEXT NOT NULL,
  execution_settings JSONB NOT NULL,
  initial_state JSONB NOT NULL,
  dependency_identity JSONB NOT NULL,
  result_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS levelstory_session_analysis_results_retention_idx
  ON levelstory_session_analysis_results (last_accessed_at, created_at);

CREATE INDEX IF NOT EXISTS levelstory_session_analysis_results_source_idx
  ON levelstory_session_analysis_results (source_fingerprint);