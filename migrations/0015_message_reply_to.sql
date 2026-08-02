-- Message replies (legacy X25519 path). A reply references its parent message by
-- id — metadata only, like reactions: the server learns "message B replies to A"
-- but never the plaintext of either. The quoted preview is rendered client-side
-- from the parent's already-decrypted content. If the parent is deleted, the
-- pointer nulls out (the reply survives as a normal message).
--
-- On the MLS path there is no server row: the reply pointer travels INSIDE the
-- encrypted application-frame envelope (server stays blind), so this column is
-- untouched there.
ALTER TABLE messages
    ADD COLUMN reply_to uuid REFERENCES messages(id) ON DELETE SET NULL;
