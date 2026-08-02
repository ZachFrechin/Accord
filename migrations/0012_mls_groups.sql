-- Phase 3 · Lot 3 — MLS Delivery Service: group ordering + frame log + Welcome mailbox.
--
-- The server ORDERS handshake messages (assigns each group a monotonic epoch +
-- sequence) and store-and-forwards OPAQUE frames. It never reads plaintext nor
-- holds a group secret. Accepting the FIRST valid Commit per epoch — a single
-- atomic CAS on mls_groups — is exactly the tie-break RFC 9750 delegates to the
-- Delivery Service. Fan-out reuses the conversation membership (routing only).

CREATE TABLE mls_groups (
    group_id      uuid        PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    current_epoch bigint      NOT NULL DEFAULT 0,
    order_seq     bigint      NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- The single ordered log per group (handshake + application frames).
CREATE TABLE mls_frames (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id     uuid        NOT NULL REFERENCES mls_groups(group_id) ON DELETE CASCADE,
    order_seq    bigint      NOT NULL,   -- total order within the group
    epoch        bigint      NOT NULL,   -- epoch the frame was produced in
    content_type text        NOT NULL,   -- 'commit' | 'proposal' | 'application'
    sender_id    uuid        REFERENCES users(id) ON DELETE SET NULL,
    frame_data   bytea       NOT NULL,   -- opaque MLSMessage bytes
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT mls_frames_group_seq_uniq UNIQUE (group_id, order_seq)
);
CREATE INDEX mls_frames_replay_idx ON mls_frames (group_id, order_seq);

-- Store-and-forward mailbox so a device added while offline gets its Welcome.
CREATE TABLE mls_welcomes (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id            uuid        NOT NULL REFERENCES mls_groups(group_id) ON DELETE CASCADE,
    recipient_user_id   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_device_id text        NOT NULL,
    welcome_data        bytea       NOT NULL,   -- opaque Welcome bytes
    created_at          timestamptz NOT NULL DEFAULT now(),
    delivered_at        timestamptz
);
CREATE INDEX mls_welcomes_pending_idx
    ON mls_welcomes (recipient_user_id, recipient_device_id)
    WHERE delivered_at IS NULL;
