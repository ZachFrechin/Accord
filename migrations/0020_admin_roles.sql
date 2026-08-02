-- Instance administration — server roles + reversible suspension.
-- role: 'member' | 'admin'. Admins see the in-app administration panel and the
-- /admin API. disabled_at: set when an admin suspends the account (NULL = usable);
-- suspension blocks login/refresh/token issue and revokes live sessions, but is
-- reversible, unlike deletion.

ALTER TABLE users
    ADD COLUMN role text NOT NULL DEFAULT 'member'
        CONSTRAINT users_role_valid CHECK (role IN ('member', 'admin')),
    ADD COLUMN disabled_at timestamptz;
