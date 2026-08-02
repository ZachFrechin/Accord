-- Phase 1 · Lot 1 — email verification, password reset, recovery codes, outbox.
-- All external-facing tokens are stored HASHED, single-use and time-bounded.
-- The outbox decouples "an email is needed" from "an email was sent": a worker
-- drains it with retries so a slow/unavailable provider never blocks a request.

CREATE TABLE email_verification_tokens (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash bytea       NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
);
CREATE INDEX email_verification_user_idx ON email_verification_tokens (user_id);

CREATE TABLE password_reset_tokens (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash bytea       NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
);
CREATE INDEX password_reset_user_idx ON password_reset_tokens (user_id);

-- A set of 8-10 single-use recovery codes, Argon2id-hashed. Offline fallback to
-- the email reset flow; the plaintext is shown to the user exactly once.
CREATE TABLE recovery_codes (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    used_at    timestamptz
);
CREATE INDEX recovery_codes_user_unused_idx ON recovery_codes (user_id) WHERE used_at IS NULL;

-- Transactional email queue, drained by a background worker with backoff.
CREATE TABLE email_outbox (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient       text        NOT NULL,
    template        text        NOT NULL,
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    status          text        NOT NULL DEFAULT 'pending', -- pending | sent | failed
    attempts        integer     NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz
);
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';
