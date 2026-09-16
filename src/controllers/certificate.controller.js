import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { assertUuid } from "../utils/publicResponse.js";
import { qrSigningConfigured } from "../utils/qrCertificate.js";
import { generateCertificatePdf } from "../utils/certificatePdf.js";

/**
 * Downloads the verified-request certificate PDF.
 * Allowed for: the requester, an org-admin of the verifying (issuing)
 * organization, or a platform admin.
 */
export async function downloadCertificate(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Request UUID");

  const [rows] = await pool.query(
    `SELECT vr.*, o.name AS issuing_org_name, uo.name AS unmatched_org_name,
            requester.full_name AS requester_name
     FROM verification_requests vr
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     LEFT JOIN users requester ON requester.id = vr.user_id
     WHERE vr.uuid=?`,
    [uuid]
  );

  if (!rows.length) throw new ApiError(404, "Request not found");
  const vr = rows[0];

  const isPlatformAdmin = Boolean(req.admin);
  const isRequester = req.user && vr.user_id === req.user.id;
  const isIssuingOrgAdmin =
    req.user && req.user.organization && vr.issuing_organization_id === req.user.organization;

  if (!isPlatformAdmin && !isRequester && !isIssuingOrgAdmin) {
    throw new ApiError(403, "You are not allowed to download this certificate");
  }

  if (vr.status !== "verified") {
    throw new ApiError(409, "Certificate is available once the request is verified");
  }

  if (!vr.qr_token || !qrSigningConfigured()) {
    throw new ApiError(409, "Certificate is not available yet. Contact support.");
  }

  const organizationName = vr.issuing_org_name || vr.unmatched_org_name || null;
  const pdf = await generateCertificatePdf({
    request: vr,
    organizationName,
    requesterName: vr.requester_name,
  });

  const filename = `dverif-certificate-${vr.uuid.slice(0, 8)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(pdf);
}