import { pool } from "../config/db.js";
import {
  qrSigningConfigured,
  verifyQrSignature,
} from "../utils/qrCertificate.js";
import { ok } from "../utils/response.js";

const QR_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Public (no auth) endpoint — validates a QR verification token and returns
 * ONLY the fields needed to confirm authenticity. Never exposes CNIC, the
 * document file, or requester identity. Fails closed (404) on any invalid /
 * forged / unverifiable token.
 */
export async function verifyPublicQr(req, res) {
  const { qr_token } = req.params;

  if (!QR_TOKEN_PATTERN.test(qr_token)) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  if (!qrSigningConfigured()) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const [rows] = await pool.query(
    `SELECT vr.uuid, vr.document_type, vr.status, vr.verified_at,
            vr.qr_token, vr.qr_signature,
            vr.issuing_organization_id, vr.unmatched_org_id,
            o.name AS org_name, uo.name AS unmatched_org_name
     FROM verification_requests vr
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     WHERE vr.qr_token=?`,
    [qr_token]
  );

  if (!rows.length) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const vr = rows[0];

  if (vr.status !== "verified" || !vr.qr_signature) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const signatureValid = verifyQrSignature({
    qrToken: vr.qr_token,
    requestUuid: vr.uuid,
    orgId: vr.issuing_organization_id,
    verifiedAtMillis: vr.verified_at ? new Date(vr.verified_at).getTime() : 0,
    signature: vr.qr_signature,
  });

  if (!signatureValid) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const organizationName = vr.org_name || vr.unmatched_org_name || null;

  return ok(
    res,
    {
      valid: true,
      status: vr.status,
      document_type: vr.document_type,
      organization_name: organizationName,
      verification_date: vr.verified_at ? new Date(vr.verified_at).toISOString() : null,
      request_reference: vr.uuid,
    },
    "Verification confirmed"
  );
}