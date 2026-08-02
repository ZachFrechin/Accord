-- Appareils à réveiller quand aucune connexion temps réel n'est vive.
--
-- Le jeton est le secret que Google attribue à une installation ; il change à
-- la réinstallation, d'où l'unicité sur le jeton plutôt que sur l'appareil.
-- Rien de ce qui touche au contenu des messages n'apparaît ici : cette table ne
-- sert qu'à savoir où frapper pour réveiller un téléphone.
CREATE TABLE IF NOT EXISTS push_devices (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token         TEXT NOT NULL UNIQUE,
    platform      TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Le seul accès en lecture est « tous les appareils de cette personne ».
CREATE INDEX IF NOT EXISTS push_devices_user_idx ON push_devices (user_id);
