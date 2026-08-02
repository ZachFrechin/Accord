-- ============================================================================
-- Accord2 — migration initiale (Phase 0, placeholder).
--
-- Les tables metier (users, friendships, dms, groups, messages, ...) arrivent
-- en Phase 1. Cette migration ne pose que la table meta qui sert de sonde de
-- sante "schema present" et de journal des migrations applicatives.
--
-- Applique par sqlx-cli (`sqlx migrate run`) ou par le Job k8s de migration
-- (voir infra/k8s/templates/migrate-job.yaml) qui prend un verrou d'avis
-- Postgres (advisory lock) pour eviter les migrations concurrentes en
-- deploiement multi-replica.
-- ============================================================================

-- Extension pour la generation d'UUID cote base si besoin (gen_random_uuid).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Table meta: une seule ligne, tracee dans le temps. Le /health/ready du
-- backend fait un simple `SELECT 1`, mais cette table permet de verifier que
-- le schema a bien ete initialise.
CREATE TABLE IF NOT EXISTS _accord_meta (
    id          SMALLINT     PRIMARY KEY DEFAULT 1,
    schema_note TEXT         NOT NULL DEFAULT 'accord2 phase-0 init',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Contrainte: force une ligne unique (singleton).
    CONSTRAINT _accord_meta_singleton CHECK (id = 1)
);

INSERT INTO _accord_meta (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
