-- Per-account UI language preference (en = English, ur = Urdu).
-- Backend email templates use this to render recipient-facing emails.
ALTER TABLE users
  ADD COLUMN preferred_language ENUM('en','ur') NOT NULL DEFAULT 'en' AFTER org_role;

ALTER TABLE admin_profiles
  ADD COLUMN preferred_language ENUM('en','ur') NOT NULL DEFAULT 'en' AFTER status;