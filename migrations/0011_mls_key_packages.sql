-- Phase 3 · Lot 2 — MLS (RFC 9420) KeyPackage directory.
--
-- A KeyPackage is a PUBLIC, opaque object (no secret material — the private
-- halves stay on the device, in the OS keychain). Each device publishes a POOL
-- of single-use KeyPackages plus exactly one "last-resort" fallback. Adding a
-- device to a group CLAIMS one KeyPackage; single-use is enforced HERE, since
-- RFC 9750 delegates that to the Delivery Service. The server never sees a
-- private key or any group secret — this is a blind directory, like device_keys.

CREATE TABLE mls_key_packages (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Client-generated stable device id (matches device_keys.device_id).
    device_id   text        NOT NULL,
    -- KeyPackageRef (hash ref) — the protocol identifier; unique per user so a
    -- re-published package is deduplicated rather than doubled.
    kp_ref      bytea       NOT NULL,
    -- Opaque TLS-serialized KeyPackage (public bytes only).
    kp_data     bytea       NOT NULL,
    -- A last-resort KeyPackage is REUSED (not consumed) when the pool is empty.
    last_resort boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- NULL = available; set on claim to enforce single-use.
    consumed_at timestamptz,

    CONSTRAINT mls_key_packages_user_ref_uniq UNIQUE (user_id, kp_ref)
);

-- Atomic claim driver: pick the oldest available single-use KeyPackage per device.
CREATE INDEX mls_key_packages_available_idx
    ON mls_key_packages (user_id, device_id, created_at)
    WHERE consumed_at IS NULL AND NOT last_resort;

-- Last-resort fallback lookup (one per device).
CREATE UNIQUE INDEX mls_key_packages_last_resort_idx
    ON mls_key_packages (user_id, device_id)
    WHERE last_resort;
