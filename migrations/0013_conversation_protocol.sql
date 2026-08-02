-- Phase 3 · Lot 5 — per-conversation E2EE protocol (the authoritative cutover
-- flag). 'x25519' = legacy per-device key wrapping; 'mls' = MLS/RFC 9420 group.
-- Existing conversations stay legacy until an explicit cutover flips them to MLS.
ALTER TABLE conversations
    ADD COLUMN protocol TEXT NOT NULL DEFAULT 'x25519'
        CHECK (protocol IN ('x25519', 'mls'));
