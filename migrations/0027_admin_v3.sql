-- Panel d'administration v3 : suspensions à échéance et rôles suspendables.

-- Une suspension définitive et une suspension d'une semaine se gèrent de la même
-- façon ; seule l'échéance change. `disabled_at` dit QUAND la sanction a été
-- posée, `disabled_until` jusqu'à quand elle court — NULL signifiant « sans
-- terme ». Un compte est donc bloqué si disabled_at est posé ET que
-- disabled_until est soit absent, soit encore à venir : la levée est
-- automatique, personne n'a à repasser derrière.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_until TIMESTAMPTZ;
-- La raison est montrée à la personne sanctionnée : une porte fermée sans
-- explication n'apprend rien et fait revenir la question au support.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

-- Un rôle suspendu conserve ses membres et ses permissions mais n'accorde plus
-- rien. Le supprimer perdrait la liste de ses titulaires, qu'il faudrait
-- reconstituer à la main pour le rétablir.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

-- Le tri et la recherche du panel portent sur ces colonnes.
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));
