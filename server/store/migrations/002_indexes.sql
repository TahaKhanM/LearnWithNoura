CREATE INDEX IF NOT EXISTS idx_noura_sessions_parent
  ON noura.sessions(parent_session_id);
