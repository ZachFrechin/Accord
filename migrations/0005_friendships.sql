-- Phase 2 · Lot 1 — friendships (social graph).
-- One row per unordered pair, canonicalised as (user_lo < user_hi) regardless of
-- who initiated. `requested_by` records the initiator: while `pending` it splits
-- incoming vs outgoing, and for a `blocked` pair it is the blocker. Friendship is
-- what gates DMs (Lot 2) and scopes presence visibility.

CREATE TABLE friendships (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_lo      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_hi      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state        text        NOT NULL,
    requested_by uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    -- Canonical ordering makes the pair unique in one direction only.
    CONSTRAINT friendships_ordered   CHECK (user_lo < user_hi),
    CONSTRAINT friendships_state     CHECK (state IN ('pending', 'accepted', 'blocked')),
    CONSTRAINT friendships_pair_uniq UNIQUE (user_lo, user_hi)
);

-- The (user_lo, user_hi) unique index already serves lookups by user_lo; add the
-- mirror so "all edges touching a user" is indexed from either side.
CREATE INDEX friendships_hi_idx ON friendships (user_hi);
