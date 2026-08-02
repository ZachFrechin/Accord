-- Niveaux d'instance : XP par activité (messages, minutes d'appel).
-- Une ligne par utilisateur ; les fenêtres jour/semaine servent au plafond
-- quotidien anti-abus et au classement hebdomadaire, remises à zéro
-- paresseusement à la première attribution de la fenêtre suivante.
CREATE TABLE user_xp (
    user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    xp             bigint NOT NULL DEFAULT 0,
    week_xp        bigint NOT NULL DEFAULT 0,
    week_start     date   NOT NULL DEFAULT date_trunc('week', now())::date,
    day_xp         bigint NOT NULL DEFAULT 0,
    day            date   NOT NULL DEFAULT current_date,
    -- Anti-spam : au plus un gain "message" par fenêtre de 60 s.
    last_msg_xp_at timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_xp_top_idx ON user_xp (xp DESC);
CREATE INDEX user_xp_week_idx ON user_xp (week_start, week_xp DESC);
