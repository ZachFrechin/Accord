-- Phase 1 · Lot 1 — sessions & refresh tokens.
-- A session represents one authenticated (user, device). Refresh tokens are
-- chained under a session: rotation consumes one and issues its `replaced_by`.
-- Re-presenting an already-consumed token is a reuse signal that revokes the
-- whole session family (RFC 9700), handled in the repository layer.

CREATE TABLE sessions (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_label    text,
    user_agent      text,
    ip              text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_used_at    timestamptz NOT NULL DEFAULT now(),
    absolute_expiry timestamptz NOT NULL,
    revoked_at      timestamptz
);

CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- Opaque token stored as its SHA-256 digest only; the plaintext never lands.
    token_hash  bytea       NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    replaced_by uuid        REFERENCES refresh_tokens(id) ON DELETE SET NULL
);

CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);
