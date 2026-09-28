-- Document types become data instead of a hard-coded constant.
--
-- The catalogue of employee/verification document types used to live only in
-- dvarif-verified/src/lib/documentTypes.ts (a hard-coded array) and, separately,
-- in python-backend/app/core/document_schemas.py (the label -> schema map the
-- OCR/matching engine resolves against). Adding a type therefore meant a code
-- change and a redeploy of TWO services, which is why the list never grew.
--
-- This table is the single catalogue. Two things are stored per type:
--
--   name        the label shown in every dropdown (unchanged from the old
--               static array, so nothing a user has ever submitted becomes
--               invalid).
--   label_key   name lowercased with every non-alphanumeric run collapsed to a
--               single space -- the SAME normalization python's
--               document_schemas._normalize_key() performs. Storing it means the
--               document service can match a submitted label with one equality
--               test and never has to re-derive it.
--   schema_key  which canonical field schema the OCR/matching engine should use
--               for this type. This is the part that makes a new type actually
--               WORK rather than merely appear in a dropdown: the engine needs to
--               know which fields to extract and which of them are required.
--               'generic' is a real, safe value ({name required, cnic optional}),
--               so a type can never point at a schema that does not exist.
--
-- is_active allows a type to be hidden from new submissions without deleting the
-- historical rows that already carry it: verification_requests.document_type,
-- person_documents.document_type and employee_documents.document_type are all
-- plain VARCHAR columns, not foreign keys, so a hard delete leaves them readable
-- but makes the catalogue stop explaining the past. Disabling is the reversible
-- choice; deletion remains available for types that were never used.
--
-- The seed below is the exact 47-entry list from the old static array, each
-- mapped to the schema key its label already resolved to through
-- DOCUMENT_TYPE_ALIASES. Behaviour is therefore unchanged by this migration; what
-- changes is that the list can now be edited from the admin UI.

CREATE TABLE IF NOT EXISTS `document_types` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(150) NOT NULL,
  `label_key`     VARCHAR(150) NOT NULL,
  `schema_key`    VARCHAR(50) NOT NULL DEFAULT 'generic',
  `is_active`     TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order`    INT NOT NULL DEFAULT 0,
  `description`   VARCHAR(255) NULL,
  `created_by`    VARCHAR(64) NULL,
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_document_types_name` (`name`),
  UNIQUE KEY `uq_document_types_label_key` (`label_key`),
  KEY `idx_document_types_active` (`is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed: the previous static catalogue, with each label's existing schema mapping.
-- label_key values are pre-computed exactly as the application computes them
-- (lowercase, non-alphanumeric runs collapsed to one space).
INSERT INTO `document_types` (`name`, `label_key`, `schema_key`, `sort_order`) VALUES
  ('Employee Application Form',                          'employee application form',                          'application_form',     1),
  ('CV / Resume',                                       'cv resume',                                       'resume',               2),
  ('Recent Photograph',                                 'recent photograph',                                 'photo',                3),
  ('CNIC / National ID Copy',                           'cnic national id copy',                             'cnic',                 4),
  ('Passport Copy — if applicable',                     'passport copy if applicable',                        'passport',             5),
  ('Educational Certificates',                          'educational certificates',                          'education_certificate',6),
  ('Educational Transcripts / Mark Sheets',             'educational transcripts mark sheets',               'transcript',           7),
  ('Experience Certificates',                           'experience certificates',                           'experience_letter',    8),
  ('Previous Employment / Relieving Letter',           'previous employment relieving letter',               'relieving_letter',     9),
  ('Reference / Recommendation Letters',                'reference recommendation letters',                  'reference_letter',     10),
  ('Employee Information Form',                         'employee information form',                         'application_form',     11),
  ('Employment / Appointment Letter',                   'employment appointment letter',                     'appointment_letter',   12),
  ('Job Description',                                   'job description',                                   'job_description',      13),
  ('Offer Letter',                                      'offer letter',                                      'offer_letter',         14),
  ('Employment Contract / Agreement',                   'employment contract agreement',                     'employment_contract',  15),
  ('NDA — Non-Disclosure Agreement',                    'nda non disclosure agreement',                       'legal_agreement',      16),
  ('Company Policies Acknowledgment',                   'company policies acknowledgment',                    'policy_ack',           17),
  ('Code of Conduct Agreement',                         'code of conduct agreement',                         'legal_agreement',      18),
  ('IT / Computer Usage Policy Acknowledgment',         'it computer usage policy acknowledgment',           'policy_ack',           19),
  ('Data Privacy / Confidentiality Agreement',          'data privacy confidentiality agreement',            'legal_agreement',      20),
  ('Bank Account / Salary Details',                     'bank account salary details',                       'bank_details',         21),
  ('Tax Information / Tax Documents',                   'tax information tax documents',                     'tax_document',         22),
  ('Emergency Contact Form',                            'emergency contact form',                            'emergency_form',       23),
  ('Medical / Fitness Certificate — if required',       'medical fitness certificate if required',           'medical_certificate',  24),
  ('Background Verification Report — if applicable',    'background verification report if applicable',      'background_check',     25),
  ('Police / Character Certificate — if required',      'police character certificate if required',          'character_certificate',26),
  ('Joining / Onboarding Checklist',                    'joining onboarding checklist',                      'onboarding',           27),
  ('Employee ID Card Record',                           'employee id card record',                           'employee_id',          28),
  ('Asset Handover Form',                               'asset handover form',                               'asset_handover',       29),
  ('Laptop / Computer Handover Form',                   'laptop computer handover form',                     'asset_handover',       30),
  ('SIM / Mobile / Other Equipment Handover',           'sim mobile other equipment handover',               'asset_handover',       31),
  ('Leave Records',                                     'leave records',                                     'leave_record',         32),
  ('Attendance Records',                                'attendance records',                                'attendance_record',    33),
  ('Performance Evaluation Records',                    'performance evaluation records',                    'performance_review',   34),
  ('Training / Certification Records',                  'training certification records',                    'training_record',      35),
  ('Warning / Disciplinary Records — if applicable',    'warning disciplinary records if applicable',         'disciplinary',         36),
  ('Promotion / Salary Revision Letters',               'promotion salary revision letters',                 'promotion_letter',     37),
  ('Transfer / Department Change Records',              'transfer department change records',                'transfer_letter',      38),
  ('Increment Letter',                                  'increment letter',                                  'increment_letter',     39),
  ('Resignation Letter',                                'resignation letter',                                'resignation_letter',   40),
  ('Exit Interview Form',                               'exit interview form',                               'exit_form',            41),
  ('Clearance Form',                                    'clearance form',                                    'clearance_form',       42),
  ('Final Settlement Record',                           'final settlement record',                           'settlement',           43),
  ('Experience / Service Certificate',                  'experience service certificate',                    'experience_letter',    44),
  ('Relieving Letter',                                  'relieving letter',                                  'relieving_letter',     45),
  ('Company Asset Return Form',                         'company asset return form',                         'asset_handover',       46),
  ('Employee File Closing Checklist',                   'employee file closing checklist',                   'closing_checklist',    47)
ON DUPLICATE KEY UPDATE
  -- Re-seed on an already-populated table without clobbering an admin's edits:
  -- only fill what is missing, and never resurrect a type they disabled.
  `schema_key`  = IF(`schema_key` = 'generic' AND VALUES(`schema_key`) <> 'generic', VALUES(`schema_key`), `schema_key`),
  `sort_order`  = LEAST(`sort_order`, VALUES(`sort_order`));
