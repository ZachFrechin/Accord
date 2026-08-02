-- Message reactions (emoji). Reactions are metadata the server must aggregate
-- (a count per emoji, and whether *you* reacted), so — unlike message bodies —
-- the emoji + reactor are stored in the clear. This is a deliberate v1 tradeoff:
-- the server learns "user X reacted 🔥 to message Y" but never the message body.
-- Encrypting reactions per-recipient (which would defeat aggregation) is a
-- possible follow-up.
CREATE TABLE message_reactions (
    message_id  uuid        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    emoji       text        NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- One reaction per (message, user, emoji); a user may react with several.
    PRIMARY KEY (message_id, user_id, emoji)
);

-- Aggregation reads always scope by message.
CREATE INDEX message_reactions_message_idx ON message_reactions (message_id, created_at);
