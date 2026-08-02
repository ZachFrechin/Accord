-- Two-factor auth (TOTP). One row per user; present only while enrolled.
-- `secret_enc` is the AEAD-sealed TOTP shared secret (never plaintext, never a
-- one-way hash — codes must be recomputable). `confirmed_at` is NULL while an
-- enrollment is pending (secret generated but first code not yet proven), and set
-- once the user proves possession — only then does login require a second factor.
CREATE TABLE user_totp (
    user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc   bytea NOT NULL,
    confirmed_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
