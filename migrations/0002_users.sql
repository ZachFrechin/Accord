-- Phase 1 · Lot 1 — users.
-- Accounts. Email is MANDATORY and must be verified before the account is
-- activated (see email_verification_tokens in 0004). username & email are stored
-- lowercased by the app (validation lowercases before insert/lookup), so a plain
-- unique text column gives case-insensitive uniqueness without citext.

CREATE TABLE users (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    username          text        NOT NULL UNIQUE,
    email             text        NOT NULL UNIQUE,
    password_hash     text        NOT NULL,
    email_verified_at timestamptz,
    is_active         boolean     NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- DB guards; the app additionally enforces the [a-z0-9_] charset + lowercasing.
    CONSTRAINT users_username_len CHECK (length(username) BETWEEN 3 AND 32),
    CONSTRAINT users_lowercased   CHECK (username = lower(username) AND email = lower(email))
);
