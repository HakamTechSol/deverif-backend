-- daily_request_usage.total_requests: count of ALL requests today (including
-- the free request), so the quota logic can detect the true "first of the day".
-- requests_used continues to track only PAID (quota-consuming) requests.
ALTER TABLE `daily_request_usage`
  ADD COLUMN IF NOT EXISTS `total_requests` int(11) NOT NULL DEFAULT 0 AFTER `requests_used`;
