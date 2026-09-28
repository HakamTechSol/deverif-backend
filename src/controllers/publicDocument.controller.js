import fs from "fs";
import ApiError from "../utils/ApiError.js";
import {
  loadVerifiedRequestForPublicToken,
  resolvePublicDocumentPath,
  classifyPublicDocument,
  publicVerifyDocumentEnabled,
  PUBLIC_PREVIEW_MIME,
} from "../utils/publicVerifyGuard.js";

/**
 * Public (no auth) access to the document behind a QR verification token.
 *   GET /api/v1/verify/:qr_token/document
 *
 * This is deliberately the ONLY public file route, and it is narrow on purpose:
 *
 *   - the filename is NEVER taken from the request. It is resolved from the
 *     database row the token authenticates, then basename'd and re-checked for
 *     containment inside the uploads root (see resolvePublicDocumentPath).
 *     /uploads is not statically served (see app.js) and this route does not
 *     reintroduce it.
 *   - the same fail-closed guard as the metadata endpoint, byte for byte,
 *     because both call loadVerifiedRequestForPublicToken().
 *   - Content-Type comes from a server-side extension allowlist, never from a
 *     client header and never from the document's own metadata.
 *   - a format outside the allowlist is simply not served.
 */
export async function streamPublicVerifiedDocument(req, res) {
  // The kill-switch is checked before the token is even looked at, so a
  // disabled deployment answers identically for valid and invalid tokens.
  if (!publicVerifyDocumentEnabled()) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const vr = await loadVerifiedRequestForPublicToken(req.params.qr_token);
  if (!vr) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const fileType = classifyPublicDocument(vr.document_path);
  if (fileType === "other") {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const filePath = resolvePublicDocumentPath(vr.document_path);
  if (!filePath) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  // Stop the browser from second-guessing the type we declare. Without nosniff
  // an attacker-influenced file served as image/* could be sniffed as HTML.
  res.setHeader("X-Content-Type-Options", "nosniff");
  // A verified document is personal data: never cached by a proxy, a CDN or an
  // intermediate browser cache.
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  // Only this site's own pages may frame the preview.
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  // NOTE: deliberately no `sandbox` directive. A CSP `sandbox` is what makes
  // Chrome refuse to display a PDF in an <iframe> — the built-in viewer is not
  // a plugin that survives being sandboxed — so the policy is set narrowly
  // instead: nothing loads, no framing by third parties, and the document
  // itself is allowed to be embedded as an object.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; object-src 'self'; frame-ancestors 'self'",
  );
  res.setHeader("Content-Type", PUBLIC_PREVIEW_MIME[fileType]);

  const filename = filePath.split(/[\\/]/).pop() || "document";
  // Render in place for what a browser can display; hand the DOCX over as a
  // download, because the client renders it from a blob rather than the browser
  // rendering it.
  res.setHeader(
    "Content-Disposition",
    `${fileType === "docx" ? "attachment" : "inline"}; filename="${filename}"`,
  );

  return res.sendFile(filePath);
}
