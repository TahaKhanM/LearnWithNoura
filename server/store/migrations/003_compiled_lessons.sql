CREATE TABLE IF NOT EXISTS noura.compiled_lessons (
  session_id TEXT PRIMARY KEY REFERENCES noura.sessions(id),
  status TEXT NOT NULL,
  lesson_json JSONB,
  failure_reason TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

INSERT INTO noura.schema_migrations (version, applied_at)
VALUES (2, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
ON CONFLICT (version) DO NOTHING;
