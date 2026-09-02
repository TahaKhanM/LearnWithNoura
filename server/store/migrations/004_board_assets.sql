CREATE TABLE IF NOT EXISTS noura.board_assets (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  bytes TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_noura_board_assets_cache ON noura.board_assets(cache_key);

REVOKE ALL ON noura.board_assets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON noura.board_assets TO noura_app;

INSERT INTO noura.schema_migrations (version, applied_at)
VALUES (3, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
ON CONFLICT (version) DO NOTHING;
