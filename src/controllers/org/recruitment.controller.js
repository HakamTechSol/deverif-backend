import ApiError from "../../utils/ApiError.js";
import fs from "node:fs/promises";
import { ok, created } from "../../utils/response.js";
import { cnicError, isValidPhone, normalizeCnic } from "../../utils/contactFormat.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import { sendPdf } from "../../utils/exportBuilders.js";
import * as recruitment from "../../services/recruitment.service.js";

/**
 * Recruitment: job openings, the candidate pipeline, interviews, and offers.
 *
 * THIN BY DESIGN. Every rule — which stages a candidate may reach, the one-shot hire
 * guard, vacancy limits, tenant scoping — lives in recruitment.service.js and is
 * enforced by a WHERE clause or a foreign key. A handler here reads the request,
 * calls exactly one service function, and shapes the response. The one place this
 * file makes a decision of its own is pagination, because the wire shape
 * (totalPages) belongs to the transport and the service returns the raw numbers.
 *
 * THE ORGANIZATION IS NEVER READ FROM THE BODY. It comes from req.scopeOrgId, which
 * requireRole set from the JWT's organization claim and cross-checked against the
 * live row. A body-supplied orgId would let a caller address another tenant's
 * openings, candidates and interview feedback in one field.
 */

/** Read a query param only when it is actually a string. */
const str = (v) => (typeof v === "string" ? v : undefined);

// ---------------------------------------------------------------------------
// Job openings
// ---------------------------------------------------------------------------

export async function listJobOpenings(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await recruitment.listOpenings({
    orgId: req.scopeOrgId,
    status: str(req.query.status),
    page,
    limit,
    offset,
  });
  // Identical envelope to candidates and offers. The per-row vacancy counts this used
  // to be unpaged for travel with each opening anyway, so nothing is lost.
  return ok(res, paginatedResponse(result.items, result.total, result.page, result.limit), "Job openings");
}

export async function getJobOpening(req, res) {
  const opening = await recruitment.getOpening({
    orgId: req.scopeOrgId,
    openingUuid: req.params.uuid,
  });
  return ok(res, { opening }, "Job opening");
}

export async function createJobOpening(req, res) {
  const opening = await recruitment.createOpening({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    title: str(req.body?.title),
    departmentId: req.body?.department_id,
    designationId: req.body?.designation_id,
    departmentName: str(req.body?.department_name),
    designationName: str(req.body?.designation_name),
    location: str(req.body?.location),
    employmentType: str(req.body?.employment_type),
    description: str(req.body?.description),
    status: str(req.body?.status),
    vacancies: req.body?.vacancies,
  });

  logAudit({
    ...getActorFromReq(req),
    action: "job_opening.create",
    entityType: "job_opening",
    entityId: opening.uuid,
    details: { title: opening.title, status: opening.status, vacancies: opening.vacancies },
    req,
  });

  return created(res, { opening }, "Job opening created");
}

export async function updateJobOpening(req, res) {
  const opening = await recruitment.updateOpening({
    orgId: req.scopeOrgId,
    openingUuid: req.params.uuid,
    actorUuid: req.user?.uuid ?? null,
    title: str(req.body?.title),
    departmentId: req.body?.department_id,
    designationId: req.body?.designation_id,
    departmentName: str(req.body?.department_name),
    designationName: str(req.body?.designation_name),
    location: str(req.body?.location),
    employmentType: str(req.body?.employment_type),
    description: str(req.body?.description),
    status: str(req.body?.status),
    vacancies: req.body?.vacancies,
  });
  return ok(res, { opening }, "Job opening updated");
}

// ---------------------------------------------------------------------------
// Candidates
//
// /org/candidates and /org/applications address THE SAME ROWS. A candidate in this
// schema IS an application: one row per person per opening, carrying the stage. Two
// tables would mean two records for one fact, free to disagree — and the disagreeing
// one would be "who applied for what". See listOffers for the same reasoning applied
// to offers.
// ---------------------------------------------------------------------------

export async function listCandidates(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await recruitment.listCandidates({
    orgId: req.scopeOrgId,
    openingUuid: str(req.query.opening_uuid),
    stage: str(req.query.stage),
    search: str(req.query.search),
    page,
    limit,
    offset,
  });
  return ok(res, paginatedResponse(result.items, result.total, result.page, result.limit), "Candidates");
}

export async function getCandidate(req, res) {
  const candidate = await recruitment.getCandidate({
    orgId: req.scopeOrgId,
    candidateUuid: req.params.uuid,
  });
  return ok(res, { candidate }, "Candidate");
}

/**
 * File an application on someone's behalf.
 *
 * Takes an employee_uuid because this is the STAFF page: someone in HR entering an
 * application typed over the phone for a walk-in. The public careers form has its own
 * path that cannot supply one at all, which is the whole reason they differ.
 */
export async function createApplication(req, res) {
  /*
   * CNIC AND PHONE SHAPE, at the boundary.
   *
   * The candidate form had NO identity validation at all, while the employee form
   * had a rule the candidate's data would eventually have to satisfy on hire. So
   * a 12-digit CNIC could be filed as a candidate, survive screening, reach
   * `offered`, and only fail when the accepted offer tried to create the
   * employee — a refusal three stages downstream of the mistake, where the
   * recruiter who made it is long gone.
   *
   * The rule is the shared one. Absent values pass on purpose: a walk-in
   * candidate's CNIC is commonly not in hand at application time, and
   * `candidates.cnic` is nullable for exactly that. A wrongly-shaped value that
   * WAS typed is refused here, at the moment it is known to be wrong.
   */
  const cnicGiven = String(req.body?.cnic ?? "").trim();
  const cnicDigits = normalizeCnic(cnicGiven);
  if (cnicError(cnicGiven)) {
    throw new ApiError(400, "cnic must be 13 digits, e.g. 42101-2345678-9");
  }
  const phoneGiven = String(req.body?.phone ?? "").trim();
  if (phoneGiven && !isValidPhone(phoneGiven)) {
    throw new ApiError(400, "phone must be 7-15 digits and may contain spaces and + ( ) -");
  }

  const candidate = await recruitment.createCandidate({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    openingUuid: str(req.body?.opening_uuid) ?? str(req.body?.job_opening_uuid),
    fullName: str(req.body?.full_name),
    email: str(req.body?.email),
    phone: str(req.body?.phone),
    // Bare digits. The browser sends the mask, the column and every uniqueness
    // check want the number.
    cnic: cnicDigits || null,
    coverLetter: str(req.body?.cover_letter),
    notes: str(req.body?.notes),
  });

  logAudit({
    ...getActorFromReq(req),
    action: "candidate.create",
    entityType: "candidate",
    entityId: candidate.uuid,
    details: { opening_uuid: candidate.job_opening_uuid, email: candidate.email },
    req,
  });

  return created(res, { candidate }, "Application received");
}

export async function updateCandidate(req, res) {
  const cnicGiven = String(req.body?.cnic ?? "").trim();
  const cnicDigits = normalizeCnic(cnicGiven);
  if (cnicError(cnicGiven)) {
    throw new ApiError(400, "CNIC must contain 13 digits. Please check the number and try again.");
  }
  const phoneGiven = String(req.body?.phone ?? "").trim();
  if (phoneGiven && !isValidPhone(phoneGiven)) {
    throw new ApiError(400, "Phone number must contain 7–15 digits. Please check the number and try again.");
  }
  const candidate = await recruitment.updateCandidate({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    candidateUuid: req.params.uuid,
    fullName: str(req.body?.full_name),
    email: str(req.body?.email),
      phone: req.body?.phone === undefined ? undefined : phoneGiven || null,
      cnic: req.body?.cnic === undefined ? undefined : cnicDigits || null,
    coverLetter: str(req.body?.cover_letter),
    notes: str(req.body?.notes),
  });
  logAudit({
    ...getActorFromReq(req),
    action: "candidate.update",
    entityType: "candidate",
    entityId: candidate.uuid,
    details: { candidate_uuid: candidate.uuid },
    req,
  });
  return ok(res, { candidate }, "Candidate updated");
}

/**
 * Move a candidate along the pipeline.
 *
 * `hired` is NOT reachable here: it arrives through /hire, which also creates the
 * employee row and the offer letter. The service refuses it for the same reason, so
 * the two agree rather than one silently accepting what the other rejects.
 */
export async function moveApplicationStage(req, res) {
  const candidate = await recruitment.updateCandidateStage({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    candidateUuid: req.params.uuid,
    stage: str(req.body?.stage),
    rejectionReason: str(req.body?.rejection_reason),
    rating: req.body?.rating,
    notes: str(req.body?.notes),
  });

  logAudit({
    ...getActorFromReq(req),
    action: `candidate.stage.${candidate.stage}`,
    entityType: "candidate",
    entityId: candidate.uuid,
    details: { stage: candidate.stage },
    req,
  });

  return ok(res, { candidate }, `Candidate moved to ${candidate.stage}`);
}

/** Prepare an offer for direct dispatch to the candidate. */
export async function startOfferApplication(req, res) {
  const override = req.route?.path?.endsWith("/override") === true;
  const result = await recruitment.startCandidateOffer({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    candidateUuid: req.params.uuid,
    overrideFailedInterviewReason: str(req.body?.override_failed_interview_reason),
    overrideFailedInterviewAuthorized: override,
    offerTemplateUuid: str(req.body?.offer_template_uuid),
    offerValues: req.body?.offer_values ?? {},
  });
  return created(res, { candidate: result.candidate }, "Offer is ready to send");
}

export async function respondToOffer(req, res) {
  /*
   * `portal_access` is read from the body and deliberately not forwarded.
   *
   * An accepted offer creates the employee and stops there. Sending the
   * invitation is a separate, deliberate act on the employee row — see the
   * comment on respondToOffer in the service. Reading the field and dropping it
   * is what keeps a client that still sends it working: the request succeeds, the
   * decision simply moves to where it belongs. A 400 here would break a caller
   * that cannot know the field became vestigial.
   */
  const result = await recruitment.respondToOffer({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    candidateUuid: req.params.uuid,
    joiningDate: str(req.body?.joining_date),
    cnic: str(req.body?.cnic),
    designationId: req.body?.designation_id,
    departmentId: req.body?.department_id,
    emergencyContact: str(req.body?.emergency_contact),
    comments: str(req.body?.comments),
  });
  return ok(res, result, "Candidate hired and employee created");
}

export const hireOffer = respondToOffer;

// ---------------------------------------------------------------------------
// Pipeline (Kanban read)
// ---------------------------------------------------------------------------

/**
 * The board: columns with their counts, for one opening.
 *
 * Requires an opening, deliberately. The board's whole purpose is "how full is this
 * vacancy", and a cross-opening board answers a question nobody is asking while
 * quietly mixing a rejected candidate from one role into another's columns.
 */
export async function getPipeline(req, res) {
  const openingUuid = str(req.query.opening_uuid) ?? str(req.params.uuid);
  if (!openingUuid) {
    throw new ApiError(400, "opening_uuid is required");
  }
  const board = await recruitment.getPipelineBoard({
    orgId: req.scopeOrgId,
    openingUuid,
  });
  return ok(res, board, "Pipeline");
}

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

export async function listInterviews(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await recruitment.listInterviews({
    orgId: req.scopeOrgId,
    candidateUuid: str(req.query.candidate_uuid),
    interviewerUuid: str(req.query.interviewer_uuid),
    page,
    limit,
    offset,
  });
  // Identical envelope to candidates and offers. The agenda page asks for a limit
  // large enough to cover a working week; without one this silently defaulted to 20
  // and would have hidden today's meetings behind older completed ones.
  return ok(res, paginatedResponse(result.items, result.total, result.page, result.limit), "Interviews");
}

export async function scheduleInterview(req, res) {
  const interview = await recruitment.scheduleInterview({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    candidateUuid: str(req.body?.candidate_uuid),
    interviewerUuid: str(req.body?.interviewer_uuid),
    scheduledAt: str(req.body?.scheduled_at),
    mode: str(req.body?.mode),
    location: str(req.body?.location),
  });

  logAudit({
    ...getActorFromReq(req),
    action: "interview.schedule",
    entityType: "interview",
    entityId: interview.uuid,
    details: { candidate_uuid: interview.candidate_uuid, scheduled_at: interview.scheduled_at },
    req,
  });

  return created(res, { interview }, "Interview scheduled");
}

export async function recordInterviewFeedback(req, res) {
  const interview = await recruitment.recordInterviewFeedback({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    interviewUuid: req.params.uuid,
    status: str(req.body?.status),
    outcome: str(req.body?.outcome),
    rating: req.body?.rating,
    feedbackNotes: str(req.body?.feedback_notes),
  });

  logAudit({
    ...getActorFromReq(req),
    action: "interview.feedback",
    entityType: "interview",
    entityId: interview.uuid,
    details: { status: interview.status, outcome: interview.outcome },
    req,
  });

  return ok(res, { interview }, "Interview feedback recorded");
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export async function listOffers(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await recruitment.listOffers({
    orgId: req.scopeOrgId,
    openingUuid: str(req.query.opening_uuid),
    page,
    limit,
    offset,
  });
  return ok(res, paginatedResponse(result.items, result.total, result.page, result.limit), "Offers");
}

export async function getOfferPreparation(req, res) {
  const data = await recruitment.getOfferPreparation({ orgId: req.scopeOrgId, candidateUuid: req.params.uuid });
  return ok(res, data, "Offer preparation");
}

export async function previewOffer(req, res) {
  const preview = await recruitment.previewOffer({
    orgId: req.scopeOrgId,
    candidateUuid: req.params.uuid,
    templateUuid: str(req.body?.template_uuid),
    values: req.body?.values ?? {},
  });
  return ok(res, preview, "Offer preview");
}

export async function sendOffer(req, res) {
  const letter = await recruitment.sendOffer({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    candidateUuid: req.params.uuid,
    values: req.body?.values ?? {},
  });

  logAudit({
    ...getActorFromReq(req),
    action: "candidate.offer.send",
    entityType: "candidate",
    entityId: req.params.uuid,
    details: { candidate_uuid: letter.candidate_uuid, status: letter.status, sent_at: letter.sent_at },
    req,
  });

  return ok(res, { letter }, "Offer letter sent");
}

export async function downloadOfferPdf(req, res) {
  const pdf = await recruitment.downloadOfferPdf({
    orgId: req.scopeOrgId,
    candidateUuid: req.params.uuid,
  });
  return sendPdf(res, pdf);
}

// ---------------------------------------------------------------------------
// Resumes
//
// multipart, and routed through the shared attachments service with
// entity_type='candidate' — so tenant scoping, the traversal guard, soft delete and
// the audit entry all come from attachments.service.js rather than a second copy.
// ---------------------------------------------------------------------------

export async function uploadResume(req, res) {
  const rows = await recruitment.attachResume({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    candidateUuid: req.params.uuid,
    files: req.files ?? [],
    description: str(req.body?.description),
  });
  return ok(res, { items: rows }, "Resume uploaded");
}

export async function removeResume(req, res) {
  const result = await recruitment.removeResume({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    attachmentUuid: req.params.attachmentUuid,
  });
  return ok(res, result, "Resume removed");
}

export async function downloadResume(req, res) {
  const resolved = await recruitment.downloadResume({
    orgId: req.scopeOrgId,
    attachmentUuid: req.params.attachmentUuid,
  });
  res.setHeader("Content-Type", resolved.mime_type || "application/octet-stream");
  // file_name is original-upload text and attacker-influenced, so anything that could
  // break out of the header is replaced before it goes in.
  const safeName = String(resolved.file_name || "resume").replace(/[^\w.\- ]+/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  return res.sendFile(resolved.absolutePath);
}

/**
 * Parse a resume/CV file and extract candidate fields.
 *
 * Uses the shared Python document service (POST /ocr/extract) with the "resume"
 * schema. Returns the fields the OCR service actually extracts — name, cnic,
 * designation, email, phone — with their confidence levels. Cover letter and
 * internal notes are NOT extracted; the frontend leaves those for manual entry.
 *
 * The file is validated by uploadAttachments (isDocumentAllowed allow-list),
 * stored temporarily, sent to the Python service, then deleted. The file is
 * NOT persisted — this is a preview/parse endpoint only.
 */
export async function parseResume(req, res) {
  if (!req.file) {
    throw new ApiError(400, "A file is required");
  }
  /*
   * The parse file is a TEMPORARY upload, not an attachment — this endpoint
   * previews a CV, it does not store one. uploadAttachments already validated
   * the type against the same isDocumentAllowed allow-list the real resume route
   * uses, so no second gate is needed; what is needed is an unconditional unlink.
   * Without it, every attempted parse — including the ones that failed, which
   * are the common case when the OCR service is down — would accumulate in
   * ATTACHMENTS_DIR with no attachment row referencing it and no listing that
   * could ever see it. The service down for an afternoon would quietly consume
   * the volume. Swallowed because a file already gone is not the error worth
   * reporting over a parse that just succeeded.
   */
  try {
    const result = await recruitment.parseResumeFile({ filePath: req.file.path });
    return ok(res, { fields: result }, "Resume parsed");
  } finally {
    try {
      await fs.promises.unlink(req.file.path);
    } catch {}
  }
}

/** Exported for the route table's sake only — keeps the upload middleware import local. */
