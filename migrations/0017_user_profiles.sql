-- User profiles (1:1 with users). Kept separate from `users` so the auth hot path
-- (every query_as!(User,…)) stays untouched; JOINed only where profile data is
-- surfaced. All fields are optional customization; the account works without a row.
CREATE TABLE user_profiles (
    user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- A shown name distinct from the immutable @username (nullable = use @username).
    display_name   text,
    -- Short "about" text for the profile card.
    bio            text,
    -- Accent color as #RRGGBB (nullable = fall back to the name-derived hue).
    accent_color   text,
    -- Avatar object version: 0 = none; bumped on each upload so the stable public
    -- URL (avatars/{user_id}/{version}) cache-busts.
    avatar_version integer NOT NULL DEFAULT 0,
    updated_at     timestamptz NOT NULL DEFAULT now()
);
