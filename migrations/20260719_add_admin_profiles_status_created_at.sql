-- Adds status and created_at columns to admin_profiles.
-- Run after the initial 20260718_create_admin_profiles.sql migration.

ALTER TABLE `admin_profiles`
  ADD COLUMN `status` enum('active','inactive') NOT NULL DEFAULT 'active' AFTER `profile_image`,
  ADD COLUMN `created_at` datetime DEFAULT current_timestamp() AFTER `status`;
