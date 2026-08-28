ALTER TABLE noura.board_assets ADD COLUMN IF NOT EXISTS parent_id TEXT;
ALTER TABLE noura.board_assets ADD COLUMN IF NOT EXISTS session_id TEXT;

INSERT INTO noura.schema_migrations (version, applied_at)
VALUES (4, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
ON CONFLICT (version) DO NOTHING;
