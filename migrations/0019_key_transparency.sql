-- Phase 3 · Lot 6: append-only key-transparency log.
--
-- Every identity<->key binding the server publishes is appended as one leaf. A
-- client verifies (a) that a peer's key is included in the log and (b) that a newer
-- signed tree head is an append-only extension of an older one (RFC 6962) — so a
-- server that equivocates on a key is detectable once heads are gossiped.
--
-- APPEND-ONLY BY CONTRACT: rows are never updated or deleted, and `seq` (the leaf
-- index) is stable — deleting or reordering a leaf would invalidate every proof.
-- `user_id` is therefore intentionally NOT a foreign key: the log is permanent
-- history and must outlive account deletion. A key rotation appends a NEW binding.
CREATE TABLE key_transparency_log (
    seq        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- RFC 6962 leaf hash of the canonical (user, device, key) encoding; UNIQUE so
    -- re-publishing an identical binding is idempotent (no duplicate leaf).
    leaf_hash  bytea       NOT NULL UNIQUE,
    user_id    uuid        NOT NULL,
    device_id  text        NOT NULL,
    public_key bytea       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Find a binding's leaf (for an inclusion proof) by who it belongs to.
CREATE INDEX key_transparency_binding_idx ON key_transparency_log (user_id, device_id);
