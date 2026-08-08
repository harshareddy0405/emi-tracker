CREATE TABLE IF NOT EXISTS login_rate_limits (
  client_fingerprint char(64) PRIMARY KEY,
  failure_count smallint NOT NULL DEFAULT 1 CHECK (failure_count BETWEEN 1 AND 32767),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  last_failure_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (client_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (last_failure_at >= window_started_at)
);

CREATE INDEX IF NOT EXISTS login_rate_limits_updated_idx
  ON login_rate_limits (updated_at);

COMMENT ON TABLE login_rate_limits IS
  'Per-client login failure windows. Keys are HMAC-SHA256 fingerprints; raw network addresses are never stored.';

-- Account-wide lock state is intentionally retired. The columns remain for
-- compatibility with the offline owner-management script but are no longer
-- consulted by the public login endpoint.
UPDATE users
SET failed_login_attempts = 0,
    locked_until = NULL
WHERE failed_login_attempts <> 0 OR locked_until IS NOT NULL;

COMMENT ON COLUMN users.failed_login_attempts IS
  'Legacy account-wide lock field; public login rate limiting is per-client.';
COMMENT ON COLUMN users.locked_until IS
  'Legacy account-wide lock field; public login rate limiting is per-client.';
