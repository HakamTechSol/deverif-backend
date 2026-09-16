-- Track the date of the last subscription-expiry reminder so that a reminder
-- can be sent at most once per day (starting 3 days before expiry).

ALTER TABLE organizations
  ADD COLUMN last_expiry_reminder_sent DATE DEFAULT NULL;
