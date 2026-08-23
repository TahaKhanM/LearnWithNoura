CREATE SCHEMA IF NOT EXISTS noura;
REVOKE ALL ON SCHEMA noura FROM PUBLIC;

CREATE TABLE IF NOT EXISTS noura.schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS noura.children (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  age INTEGER,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_noura_children_parent ON noura.children(parent_id, created_at);

CREATE TABLE IF NOT EXISTS noura.sessions (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES noura.children(id),
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  summary_json JSONB,
  parent_session_id TEXT REFERENCES noura.sessions(id),
  ended_event_id BIGINT,
  summary_version INTEGER,
  summary_through_event_id BIGINT
);
CREATE INDEX IF NOT EXISTS idx_noura_sessions_child ON noura.sessions(child_id, started_at DESC);

CREATE TABLE IF NOT EXISTS noura.events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES noura.sessions(id),
  ts BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  released BOOLEAN NOT NULL DEFAULT TRUE,
  release_requested BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_noura_events_session ON noura.events(session_id, id);

CREATE TABLE IF NOT EXISTS noura.fallback_turns (
  session_id TEXT NOT NULL REFERENCES noura.sessions(id),
  idempotency_key TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  steps_json JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (session_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_noura_fallback_one_active_session
  ON noura.fallback_turns(session_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS noura.evidence (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES noura.sessions(id),
  ts BIGINT NOT NULL,
  concept TEXT NOT NULL,
  observation TEXT NOT NULL,
  verdict TEXT NOT NULL,
  confidence TEXT NOT NULL,
  excerpt TEXT,
  evidence_id TEXT UNIQUE NOT NULL,
  child_id TEXT NOT NULL REFERENCES noura.children(id),
  concept_id TEXT NOT NULL,
  response_taxonomy TEXT NOT NULL,
  confidence_basis TEXT NOT NULL,
  source_event_ids JSONB NOT NULL,
  normalized_excerpt TEXT NOT NULL,
  source_span_json JSONB,
  task_id TEXT NOT NULL,
  independence_level TEXT NOT NULL,
  domain_check_json JSONB,
  turn_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  contradicts_json JSONB NOT NULL,
  supersedes_json JSONB NOT NULL,
  opportunity_kind TEXT NOT NULL DEFAULT 'recall',
  retrieval_of TEXT,
  released BOOLEAN NOT NULL DEFAULT TRUE,
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_noura_evidence_session ON noura.evidence(session_id, id);
CREATE INDEX IF NOT EXISTS idx_noura_evidence_child ON noura.evidence(child_id, id DESC);

INSERT INTO noura.schema_migrations (version, applied_at)
VALUES (1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
ON CONFLICT (version) DO NOTHING;
