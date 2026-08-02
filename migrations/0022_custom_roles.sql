-- Custom instance roles: named, colored, ordered, carrying a permission bitset
-- (see backend/src/domain/permissions.rs for the bit meanings). Assignable to
-- users N-to-N. The legacy users.role = 'admin' remains the root override with
-- every permission, so existing admins lose nothing.
CREATE TABLE roles (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    color text,
    position integer NOT NULL DEFAULT 0,
    permissions bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);
CREATE INDEX user_roles_role_idx ON user_roles(role_id);
