-- Phase 2 · Lot 3 — conversations, membership, and end-to-end encrypted messages.
-- A conversation is a DM (exactly 2 members) or a group (Lot 4). Membership is a
-- join table. Messages carry only CIPHERTEXT — the server never holds the keys
-- and cannot read a body. Each message's single-use key is wrapped once per
-- recipient device (message_keys), so every device can decrypt independently.
-- Ids are UUIDv7 (app-generated): time-sortable, so keyset pagination on
-- (created_at, id) is index-only.

CREATE TABLE conversations (
    id         uuid        PRIMARY KEY,             -- UUIDv7 (app-generated)
    kind       text        NOT NULL,                -- 'dm' | 'group'
    -- For DMs, the canonical pair 'lo:hi' enforces a single DM per pair; NULL for groups.
    dm_key     text        UNIQUE,
    created_by uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT conversations_kind   CHECK (kind IN ('dm', 'group')),
    CONSTRAINT conversations_dm_key CHECK ((kind = 'dm') = (dm_key IS NOT NULL))
);

CREATE TABLE conversation_members (
    conversation_id uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            text        NOT NULL DEFAULT 'member',   -- 'admin' | 'member'
    joined_at       timestamptz NOT NULL DEFAULT now(),
    last_read_at    timestamptz,                             -- read receipts (Lot 5)

    PRIMARY KEY (conversation_id, user_id),
    CONSTRAINT conversation_members_role CHECK (role IN ('admin', 'member'))
);
CREATE INDEX conversation_members_user_idx ON conversation_members (user_id);

CREATE TABLE messages (
    id              uuid        PRIMARY KEY,          -- UUIDv7 (app-generated)
    conversation_id uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       uuid        REFERENCES users(id) ON DELETE SET NULL,
    -- The sender's device id, so recipients verify the wrapping against its key.
    sender_device   text        NOT NULL,
    -- Encrypted body + its nonce. Opaque to the server.
    ciphertext      bytea       NOT NULL,
    body_nonce      bytea       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
-- Keyset pagination within a conversation, newest first.
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at DESC, id DESC);

-- The per-recipient-device wrapped message key. One row per (message, device).
CREATE TABLE message_keys (
    message_id        uuid  NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    recipient_user_id uuid  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_device  text  NOT NULL,
    wrapped_key       bytea NOT NULL,   -- message key wrapped to the device (authenticated box)
    wrap_nonce        bytea NOT NULL,

    PRIMARY KEY (message_id, recipient_user_id, recipient_device)
);
CREATE INDEX message_keys_recipient_idx ON message_keys (recipient_user_id, recipient_device);
