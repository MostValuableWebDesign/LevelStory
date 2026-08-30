-- Non-destructive additions for authoritative visual-review evidence.
-- Existing journal and teaching rows are intentionally preserved.
ALTER TABLE levelstory_proposal_validation_runs
  ADD COLUMN IF NOT EXISTS validator_version TEXT;

ALTER TABLE levelstory_teaching_examples
  ADD COLUMN IF NOT EXISTS qualifying_levels JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE levelstory_teaching_examples
  ADD COLUMN IF NOT EXISTS indicator_source_timestamp TEXT;