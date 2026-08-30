-- Non-destructive additions for authoritative visual-review evidence.
-- Existing journal and teaching rows are intentionally preserved.
ALTER TABLE levelstory_proposal_validation_runs
  ADD COLUMN IF NOT EXISTS validator_version TEXT;

ALTER TABLE levelstory_teaching_examples
  ADD COLUMN IF NOT EXISTS qualifying_levels JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE levelstory_teaching_examples
  ADD COLUMN IF NOT EXISTS indicator_source_timestamp TEXT;

ALTER TABLE levelstory_teaching_examples
  ADD COLUMN IF NOT EXISTS level_candle_timestamp TEXT,
  ADD COLUMN IF NOT EXISTS qualifying_level_id TEXT,
  ADD COLUMN IF NOT EXISTS qualifying_level_value TEXT,
  ADD COLUMN IF NOT EXISTS qualifying_level_range_low TEXT,
  ADD COLUMN IF NOT EXISTS qualifying_level_range_high TEXT,
  ADD COLUMN IF NOT EXISTS qualifying_level_distance_ticks INTEGER,
  ADD COLUMN IF NOT EXISTS consolidation_metadata JSONB,
  ADD COLUMN IF NOT EXISTS calendar_fingerprint TEXT;