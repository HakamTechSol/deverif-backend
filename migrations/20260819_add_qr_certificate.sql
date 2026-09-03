-- QR verification certificate
-- Adds a public, tamper-evident verification token + HMAC signature to each
-- verified request. The token is what appears in the public QR URL
-- (https://portal.dverif.com/verify/<qr_token>); the signature binds the token
-- to immutable fields (request uuid, verified_at, issuing org id) using the
-- server-side QR_SIGNING_SECRET so nobody can forge a valid QR for a fake record.

ALTER TABLE verification_requests
  ADD COLUMN qr_token VARCHAR(64) NULL,
  ADD COLUMN qr_signature VARCHAR(128) NULL,
  ADD UNIQUE KEY uq_verification_requests_qr_token (qr_token);