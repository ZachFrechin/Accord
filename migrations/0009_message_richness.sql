-- Phase 2 · Lot 5 — message edit / delete.
-- An edit replaces the ciphertext + wrapped keys and stamps edited_at. A delete
-- is a tombstone: deleted_at is set and the ciphertext is cleared (the server
-- never had the plaintext anyway; this drops the ciphertext too). Read state
-- already lives on conversation_members.last_read_at (0007); this lot fills it.

ALTER TABLE messages ADD COLUMN edited_at  timestamptz;
ALTER TABLE messages ADD COLUMN deleted_at timestamptz;
