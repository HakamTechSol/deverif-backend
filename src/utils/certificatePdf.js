import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { buildVerifyUrl } from "./qrCertificate.js";

const PRIMARY = "#0d9488"; // teal-600
const DARK = "#134e4a"; // teal-900
const MUTED = "#64748b";
const SUCCESS = "#15803d";

function formatCertDate(value) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-PK", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function labelValueRow(doc, label, value, y, valueColor = "#0f172a") {
  doc.fillColor(MUTED).fontSize(9).text(label, 50, y, { lineBreak: false, continued: true });
  doc.fillColor(valueColor).fontSize(11).text(`  ${value}`, { lineBreak: true });
}

/**
 * Builds a printable verification certificate PDF (A4) with the public
 * QR embedded. The QR points to https://portal.dverif.com/verify/<qr_token>.
 */
export async function generateCertificatePdf({ request, organizationName, requesterName }) {
  const verifyUrl = buildVerifyUrl(request.qr_token);
  const qrBuffer = await QRCode.toBuffer(verifyUrl, { width: 260, margin: 1, color: { dark: "#0f172a" } });

  const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: "Verification Certificate" } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", resolve));

  const pageWidth = doc.page.width;

  // Header band
  doc.rect(0, 0, pageWidth, 96).fill(DARK);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(22).text("Dverif", 50, 30);
  doc.font("Helvetica").fontSize(11).fillColor("#99f6e4").text("Document Verification Certificate", 50, 58);

  // Title
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(17).text("Verification Certificate", 50, 128);
  doc.moveTo(50, 152).lineTo(pageWidth - 50, 152).lineWidth(1.5).strokeColor(PRIMARY).stroke();

  // Details
  let y = 172;
  labelValueRow(doc, "Reference", request.uuid, y);
  y = 194;
  labelValueRow(doc, "Document type", request.document_type, y);
  y = 216;
  labelValueRow(doc, "Issued by", organizationName || "—", y);
  y = 238;
  labelValueRow(doc, "Verified on", formatCertDate(request.verified_at), y);
  y = 260;
  labelValueRow(doc, "Submitted by", requesterName || "—", y);
  y = 286;

  // Status badge
  doc.roundedRect(50, y, 130, 24, 12).fill(SUCCESS);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11).text("VERIFIED", 60, y + 6);

  // QR
  const qrY = 330;
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(12).text("Verify authenticity", 50, qrY);
  doc.image(qrBuffer, pageWidth / 2 - 110, qrY + 22, { width: 220, height: 220 });
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(verifyUrl, 50, qrY + 252, {
    align: "center",
    width: pageWidth - 100,
  });
  doc.fillColor(MUTED).fontSize(9).text(
    "Scan the QR code or open the link above to confirm this certificate on dverif.com.",
    50,
    qrY + 272,
    { align: "center", width: pageWidth - 100 }
  );

  // Footer
  const footerY = doc.page.height - 80;
  doc.moveTo(50, footerY).lineTo(pageWidth - 50, footerY).lineWidth(1).strokeColor("#e2e8f0").stroke();
  doc.fillColor(MUTED).fontSize(8).text(
    "This certificate was issued electronically and does not require a signature or stamp.",
    50,
    footerY + 10,
    { align: "center", width: pageWidth - 100 }
  );

  doc.end();
  await done;
  return Buffer.concat(chunks);
}