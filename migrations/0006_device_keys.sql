-- Phase 2 · Lot 2 — device identity keys (E2EE foundation).
-- Each device publishes an X25519 PUBLIC identity key. The matching PRIVATE key
-- never leaves the device (it lives in the OS keychain). The server stores only
-- public keys and hands a user's active bundle to their friends so a sender can
-- encrypt to every recipient device. The server never sees a private key or any
-- message plaintext — it is a blind store-and-forward for ciphertext.

CREATE TABLE device_keys (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Client-generated stable id for one device (a random UUID kept on-device).
    device_id  text        NOT NULL,
    -- X25519 public key (32 bytes).
    public_key bytea       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,

    CONSTRAINT device_keys_user_device_uniq UNIQUE (user_id, device_id)
);

-- Bundle lookups fetch a user's non-revoked devices.
CREATE INDEX device_keys_user_active_idx ON device_keys (user_id) WHERE revoked_at IS NULL;
