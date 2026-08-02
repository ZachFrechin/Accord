-- Journal d'audit des actions d'administration + tombstones de modération MLS.

-- Chaque action sensible du panel (rôles, suspensions, renommages, suppressions
-- de messages) laisse une trace consultable par les porteurs de VIEW_AUDIT.
-- Pas de FK sur les acteurs/cibles : le journal survit à la suppression du compte.
CREATE TABLE audit_log (
    id         uuid PRIMARY KEY,
    actor_id   uuid NOT NULL,
    action     text NOT NULL,
    target_id  uuid,
    detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

-- Modération d'un message MLS : le serveur ne voit pas le contenu (E2EE) et les
-- messages MLS n'ont pas de ligne serveur adressable — un modérateur publie donc
-- un tombstone portant l'id local du message ("mls:<seq>"). Diffusé en direct
-- (MessageDeleted) et rejoué à chaque chargement d'historique.
CREATE TABLE mls_tombstones (
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_ref     text NOT NULL,
    actor_id        uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, message_ref)
);
