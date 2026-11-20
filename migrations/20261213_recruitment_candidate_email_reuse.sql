-- Candidate records may share an email (e.g. a returning applicant or an
-- email that is already registered to an employee). Offer creation/hiring applies
-- a stricter uniqueness check and requires a new, unused email address.
ALTER TABLE candidates DROP INDEX uk_candidates_opening_email;
CREATE INDEX idx_candidates_opening_email ON candidates (organization_id, job_opening_uuid, email);
