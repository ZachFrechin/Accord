-- Comptes de jeu liés au profil (rangs LoL, CS2/FACEIT, plus tard Valorant/RL).
-- Le serveur stocke l'identité externe résolue et le dernier rang connu
-- (rank_payload, forme propre à chaque jeu) — les clés API restent en config.
CREATE TABLE game_accounts (
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game            text NOT NULL,
    external_id     text NOT NULL,
    external_name   text NOT NULL,
    region          text,
    rank_payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
    rank_updated_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, game)
);
