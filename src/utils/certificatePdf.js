import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVerifyUrl } from "./qrCertificate.js";
import { certificateCodeFor } from "./certificateCode.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BLUE = "#175CD3";
const NAVY = "#123B73";
const INK = "#182230";
const MUTED = "#667085";
const LINE = "#D0D5DD";
const PALE = "#F5F9FF";
const GREEN = "#16875D";
const LOGO = path.join(ROOT, "assets", "dverif-logo.png");
const ARABIC_FONT = path.join(ROOT, "assets", "NotoNaskhArabic-Regular.ttf");

const PAGE_MARGIN = 56;
const rtlPattern = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

function usableLogo(value) {
  if (!value) return null;
  const raw = String(value);
  if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
  const file = path.basename(raw.replace(/\\/g, "/"));
  const candidate = path.join(ROOT, "uploads", "organizations", file);
  return fs.existsSync(candidate) ? candidate : null;
}
function dateTime(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString("en-PK", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Karachi" })
    : "—";
}

function displayText(doc, value, options = {}) {
  const text = String(value ?? "—");
  if (rtlPattern.test(text) && fs.existsSync(ARABIC_FONT)) doc.font(ARABIC_FONT);
  else doc.font(options.bold ? "Helvetica-Bold" : "Helvetica");
  return doc.text(text, options.x, options.y, {
    width: options.width,
    height: options.height,
    align: rtlPattern.test(text) ? "right" : options.align,
    lineGap: 1,
    ellipsis: options.ellipsis,
    link: options.link,
    underline: options.underline,
  });
}

function addSeal(doc, centerX, centerY) {
  doc.save();
  doc.circle(centerX, centerY, 39).lineWidth(1.5).strokeColor(BLUE).stroke();
  doc.circle(centerX, centerY, 34).lineWidth(0.7).strokeColor("#8BB7F4").stroke();
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BLUE)
    .text("VERIFIED", centerX - 31, centerY - 17, { width: 62, align: "center", characterSpacing: 1.5, lineBreak: false });
  doc.moveTo(centerX - 10, centerY + 3).lineTo(centerX - 2, centerY + 11).lineTo(centerX + 14, centerY - 7)
    .lineWidth(3).lineCap("round").lineJoin("round").strokeColor(GREEN).stroke();
  doc.restore();
}

export async function generateCertificatePdf({ request, organizationName, organizationLogoPath, requesterName }) {
  const verifyUrl = buildVerifyUrl(request.qr_token);
  const verifyHost = new URL(verifyUrl).host;
  const qr = await QRCode.toBuffer(verifyUrl, {
    errorCorrectionLevel: "M",
    type: "png",
    width: 720,
    margin: 4,
    color: { dark: NAVY, light: "#FFFFFF" },
  });

  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: { Title: "Certificate of Verification", Author: "Dverif" } });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on("end", resolve));
  const W = doc.page.width;
  const H = doc.page.height;
  const right = W - PAGE_MARGIN;
  const contentW = W - PAGE_MARGIN * 2;

  // Double-line page frame.
  doc.rect(20, 20, W - 40, H - 40).lineWidth(1.1).strokeColor(BLUE).stroke();
  doc.rect(25, 25, W - 50, H - 50).lineWidth(0.45).strokeColor("#A8C7F5").stroke();

  if (fs.existsSync(LOGO)) doc.image(LOGO, (W - 126) / 2, 43, { fit: [126, 45], align: "center", valign: "center" });
  else {
    doc.font("Helvetica-Bold").fontSize(25).fillColor(NAVY).text("Dverif", 60, 51, { width: W - 120, align: "center" });
  }
  doc.font("Helvetica-Bold").fontSize(14).fillColor(NAVY)
    .text("C E R T I F I C A T E   O F   V E R I F I C A T I O N", PAGE_MARGIN, 102, { width: contentW, align: "center", lineBreak: false });
  doc.font("Helvetica").fontSize(9.4).fillColor(MUTED)
    .text("This is to certify that the document below was officially verified through the Dverif network.", PAGE_MARGIN + 15, 127, { width: contentW - 30, align: "center" });
  doc.moveTo(PAGE_MARGIN, 157).lineTo(right, 157).lineWidth(1).strokeColor("#BFD4F5").stroke();

  const rows = [
    ["DOCUMENT TYPE", request.document_type],
    ["DOCUMENT OWNER", request.document_owner_name],
    ["CNIC", request.document_owner_cnic_masked],
    ["VERIFIED BY", organizationName],
    ["REQUESTED BY", requesterName],
    ["VERIFIED ON", dateTime(request.verified_at)],
    ["CERTIFICATE CODE", certificateCodeFor(request.qr_token)],
  ].filter(([, value]) => value != null && String(value).trim() !== "");
  let y = 178;
  const labelX = PAGE_MARGIN + 14;
  const valueX = PAGE_MARGIN + 158;
  const valueW = contentW - 178;
  rows.forEach(([label, rawValue], index) => {
    const value = String(rawValue);
    if (index % 2 === 0) doc.roundedRect(PAGE_MARGIN, y, contentW, 39, 6).fill(PALE);
    doc.font("Helvetica-Bold").fontSize(7.4).fillColor(MUTED)
      .text(label, labelX, y + 14, { width: 130, characterSpacing: 0.7, lineBreak: false });
    if (label === "VERIFIED BY") {
      const logo = usableLogo(organizationLogoPath);
      if (logo) {
        doc.image(logo, valueX, y + 7, { fit: [29, 25], align: "left", valign: "center" });
        displayText(doc, value, { x: valueX + 36, y: y + 11, width: valueW - 36, height: 26, bold: true, ellipsis: true });
      } else {
        displayText(doc, value, { x: valueX, y: y + 10, width: valueW, height: 30, bold: true, ellipsis: true });
      }
    } else {
      displayText(doc, value, { x: valueX, y: y + 10, width: valueW, height: 30, bold: true, ellipsis: true });
    }
    y += 42;
  });

  const sealCenterY = y + 34;
  addSeal(doc, W / 2, sealCenterY);

  const qrSize = 112;
  const qrX = (W - qrSize) / 2;
  const qrY = sealCenterY + 53;
  doc.image(qr, qrX, qrY, { width: qrSize, height: qrSize });
  doc.font("Helvetica-Bold").fontSize(9).fillColor(NAVY)
    .text("Scan to verify authenticity online", PAGE_MARGIN, qrY + qrSize + 8, { width: contentW, align: "center", lineBreak: false });
  doc.font("Helvetica").fontSize(7.1).fillColor(BLUE)
    .text(verifyUrl, PAGE_MARGIN + 12, qrY + qrSize + 24, { width: contentW - 24, align: "center", link: verifyUrl, underline: true, ellipsis: true, lineBreak: false });

  const footerY = H - 99;
  doc.moveTo(PAGE_MARGIN, footerY).lineTo(right, footerY).lineWidth(0.7).strokeColor("#BFD4F5").stroke();
  doc.font("Helvetica").fontSize(7.3).fillColor(MUTED)
    .text("Valid only if the QR resolves to a matching verified record online. Any alteration invalidates this certificate.", PAGE_MARGIN + 5, footerY + 9, { width: contentW - 10, align: "center" });
  const websiteUrl = new URL(verifyUrl).origin;
  doc.font("Helvetica-Bold").fontSize(7.8).fillColor(NAVY)
    .text(websiteUrl, PAGE_MARGIN, footerY + 24, { width: contentW, align: "center", link: websiteUrl, lineBreak: false });
  if (fs.existsSync(LOGO)) doc.image(LOGO, W / 2 - 131, footerY + 39, { fit: [26, 14] });
  doc.font("Helvetica").fontSize(6.4).fillColor(MUTED)
    .text(`Powered by Dverif | Generated ${dateTime(new Date())} | Page 1 of 1 | ${verifyHost}`, W / 2 - 101, footerY + 42, { width: 325, align: "left", lineBreak: false });
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
