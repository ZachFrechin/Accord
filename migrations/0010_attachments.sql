-- Phase 2 · Lot 6 — attachment blobs.
-- The client encrypts each file end-to-end and uploads the CIPHERTEXT to object
-- storage; the file key travels inside the E2EE message body. This table records
-- only what is needed to authorize presigned download URLs (who may fetch a blob)
-- and to size-limit uploads. The server never sees the file key or plaintext.

CREATE TABLE attachments (
    id              uuid        PRIMARY KEY,            -- UUIDv7; also the object-key suffix
    conversation_id uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    owner_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size_bytes      bigint      NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_conversation_idx ON attachments (conversation_id);
