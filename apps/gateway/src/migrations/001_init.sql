-- Users of the gateway. password_hash is NULL until an invite is accepted.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash text,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One-time invite links. Only the SHA-256 of the token is stored.
CREATE TABLE invites (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

-- Dashboard sessions (HttpOnly cookie). Only the SHA-256 of the token is stored.
CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Gateway API keys: token = mgw_<id>_<secret>; only SHA-256(secret) is stored.
CREATE TABLE api_keys (
  id           text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text NOT NULL,
  secret_hash  bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id);

-- Registered upstream MCP servers. credential_enc is AES-256-GCM ciphertext, never returned by the API.
CREATE TABLE upstream_servers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,23}$'),
  name             text NOT NULL,
  url              text NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  auth_type        text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header      text,
  credential_enc   bytea,
  timeout_ms       integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
  admin_only_tools text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'unknown',
  last_error       text,
  last_checked_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Append-only record of every tool call (and rejected attempt). Arguments are not stored (may hold PII).
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  user_email  text,
  api_key_id  text,
  channel     text NOT NULL CHECK (channel IN ('mcp', 'chat')),
  server_slug text,
  tool        text,
  duration_ms integer NOT NULL DEFAULT 0,
  outcome     text NOT NULL,
  error       text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, at DESC);
