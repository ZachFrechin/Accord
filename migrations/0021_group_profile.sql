-- Group profile: a free-text description and a versioned public avatar,
-- mirroring user profiles (version 0 = none; the public URL derives from the
-- version, so bumping it invalidates caches).
ALTER TABLE conversations
  ADD COLUMN description TEXT,
  ADD COLUMN avatar_version INTEGER NOT NULL DEFAULT 0;
