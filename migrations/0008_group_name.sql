-- Phase 2 · Lot 4 — group conversations.
-- Groups need a display name (DMs derive theirs from the peer). Encryption needs
-- no change: each message is still keyed per-message and wrapped to the CURRENT
-- members' devices, so membership changes are handled at send time (a removed
-- member simply stops receiving wrapped keys — no shared group key to rotate).

ALTER TABLE conversations ADD COLUMN name text;
