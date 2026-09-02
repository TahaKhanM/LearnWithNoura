CREATE TABLE IF NOT EXISTS noura.compiled_lessons (
  session_id TEXT PRIMARY KEY REFERENCES noura.sessions(id),
  status TEXT NOT NULL,
  lesson_json JSONB,
  failure_reason TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

REVOKE ALL ON noura.compiled_lessons FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON noura.compiled_lessons TO noura_app;

INSERT INTO noura.schema_migrations (version, applied_at)
VALUES (2, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
ON CONFLICT (version) DO NOTHING;
