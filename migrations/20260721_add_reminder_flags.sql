-- Add reminder tracking columns to organizations table
-- Used by the expiry reminder system to avoid duplicate emails

ALTER TABLE organizations
  ADD COLUMN reminder_2d_sent ENUM('yes','no') DEFAULT 'no',
  ADD COLUMN reminder_2h_sent ENUM('yes','no') DEFAULT 'no';
