-- Conversation-scoped custom soundboard blobs. The encrypted attachment itself
-- remains in the existing attachment pipeline; this table only supplies rolling
-- lifecycle management for blobs used as call sounds.
CREATE TABLE call_sound_assets (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    blob_id UUID PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days'
);

CREATE INDEX call_sound_assets_expiry_idx ON call_sound_assets (expires_at);
