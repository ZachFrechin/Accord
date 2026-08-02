-- Profile banner (a wide image/gif shown on the profile card), same public,
-- versioned-URL model as the avatar. 0 = none; bumped on each upload.
ALTER TABLE user_profiles ADD COLUMN banner_version integer NOT NULL DEFAULT 0;
